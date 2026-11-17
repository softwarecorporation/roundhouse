#!/usr/bin/env python3
"""Linux-only, stdlib operations executor. See README.md for the trust boundary."""
import argparse
import contextlib
import fcntl
import hashlib
import hmac
import http.server
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import resource
import secrets
import selectors
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import time

MAX_BODY = 16384
MAX_COMMAND = 8192
REVISION = re.compile(r"[0-9a-f]{32}\Z")
KEY = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")
TOOLS = "bash cat chmod cp cut date dd dirname echo env false find grep head id ln ls mkdir mv printf pwd readlink rm rmdir sed seq sh sleep sort stat tail tee test touch tr true uname uniq wc yes".split()


class Rejected(Exception):
    pass


def encode(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode()


def durable_json(path, value):
    with open(path, "xb") as out:
        out.write(encode(value))
        out.flush()
        os.fsync(out.fileno())


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def tree_stats(root, max_bytes, max_files):
    """No symlinks, hardlinks, devices, sockets, or FIFOs in any snapshot."""
    if not stat.S_ISDIR(Path(root).lstat().st_mode):
        raise Rejected("snapshot root must be a real directory")
    def walk_error(error):
        raise error
    size = count = 0
    for parent, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        for name in dirs + files:
            p = Path(parent) / name
            s = p.lstat()
            if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
                raise Rejected("snapshot contains a special file or symlink")
            if stat.S_ISREG(s.st_mode) and s.st_nlink != 1:
                raise Rejected("snapshot contains a hardlink")
            size += s.st_size if stat.S_ISREG(s.st_mode) else 0
            count += 1
            if size > max_bytes or count > max_files:
                raise Rejected("workspace limit")
    return size, count


def freeze(root):
    for parent, dirs, files in os.walk(root):
        for name in files:
            p = Path(parent) / name
            executable = bool(p.stat().st_mode & 0o111)
            p.chmod(0o555 if executable else 0o444)
            with p.open("rb") as f:
                os.fsync(f.fileno())
        for name in dirs:
            (Path(parent) / name).chmod(0o555)
        sync_dir(parent)
    root.chmod(0o555)


def thaw(root):
    for parent, dirs, files in os.walk(root):
        Path(parent).chmod(0o700)
        for name in files:
            p = Path(parent) / name
            p.chmod(0o700 if p.stat().st_mode & 0o111 else 0o600)


def build_runtime(root):
    """Copy an explicit utility allowlist and its ELF libraries, not host directories."""
    (root / "bin").mkdir(parents=True)
    for name in TOOLS:
        source = shutil.which(name)
        if not source:
            raise Rejected("missing runtime tool: " + name)
        source = Path(source).resolve()
        shutil.copyfile(source, root / "bin" / name)
        (root / "bin" / name).chmod(0o555)
        info = subprocess.run(["ldd", str(source)], capture_output=True, text=True, timeout=5)
        for library in re.findall(r"(?:=>\s+)?(/[^\s()]+)", info.stdout):
            destination = root / library.lstrip("/")
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                shutil.copyfile(library, destination)
                destination.chmod(0o555)
    for name in ("work", "tmp", "proc", "dev", "etc"):
        (root / name).mkdir(exist_ok=True)
    freeze(root)


def limits(config):
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    for kind, value in ((resource.RLIMIT_CPU, math.ceil(config["timeout"]) + 1),
                        (resource.RLIMIT_AS, config["memory_bytes"]),
                        (resource.RLIMIT_FSIZE, config["file_bytes"]),
                        (resource.RLIMIT_NOFILE, 128), (resource.RLIMIT_NPROC, 256)):
        resource.setrlimit(kind, (value, value))


def run_bounded(argv, cwd, config, workspace=None):
    started = time.monotonic()
    output = bytearray()
    reason = None
    proc = subprocess.Popen(argv, cwd=cwd, env={"PATH": "/usr/bin:/bin", "LANG": "C"},
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, start_new_session=True,
                            preexec_fn=lambda: limits(config))
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    try:
        while selector.get_map() or proc.poll() is None:
            if time.monotonic() - started > config["timeout"]:
                reason = "timeout"
                break
            if workspace:
                try:
                    tree_stats(workspace, config["workspace_bytes"], config["workspace_files"])
                except (Rejected, OSError):
                    reason = "workspace_limit_or_unsafe_entry"
                    break
            for key, _ in selector.select(0.03):
                data = os.read(key.fileobj.fileno(), 4096)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                remaining = config["output_bytes"] - len(output)
                output.extend(data[:remaining])
                if len(data) > remaining:
                    reason = "output_limit"
                    break
            if reason:
                break
        # Always reap/kill the whole group, including descendants after shell exit.
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        selector.close()
        proc.stdout.close()
    return {"exit_code": proc.returncode, "reason": reason,
            "output": output.decode("utf-8", errors="replace")}


class Executor:
    def __init__(self, state):
        self.state = Path(state).resolve()
        self.config = json.loads((self.state / "config.json").read_text())

    @contextlib.contextmanager
    def locked(self):
        with (self.state / "lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with sqlite3.connect(self.state / "journal.sqlite") as db:
                db.execute("PRAGMA synchronous=FULL")
                yield db

    def event(self, db, kind, value):
        db.execute("INSERT INTO events(time,kind,payload) VALUES(?,?,?)",
                   (time.time(), kind, encode(value).decode()))
        db.commit()

    def current(self):
        target = os.readlink(self.state / "current")
        if not target.startswith("versions/") or not REVISION.fullmatch(target[9:]):
            raise Rejected("invalid current pointer")
        return target[9:]

    def activate(self, revision):
        link = self.state / "next"
        link.unlink(missing_ok=True)
        link.symlink_to("versions/" + revision)
        os.replace(link, self.state / "current")
        sync_dir(self.state)

    def sandbox(self, workspace, command, readonly=False):
        bwrap = shutil.which("bwrap")
        if not bwrap:
            raise Rejected("bubblewrap unavailable; refusing unsandboxed execution")
        return [bwrap, "--unshare-all", "--die-with-parent", "--new-session",
                "--cap-drop", "ALL", "--clearenv", "--ro-bind", str(self.state / "runtime"), "/",
                "--ro-bind" if readonly else "--bind", str(workspace), "/work",
                "--size", str(self.config["workspace_bytes"]), "--tmpfs", "/tmp", "--proc", "/proc",
                "--dev", "/dev", "--chdir", "/work", "--setenv", "PATH", "/bin",
                "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C",
                "/bin/bash", "--noprofile", "--norc", "-c", command]

    def execute(self, command, key):
        if not isinstance(command, str) or not command or len(command.encode()) > MAX_COMMAND or "\0" in command:
            raise Rejected("command must be a nonempty string of at most 8192 bytes")
        if not isinstance(key, str) or not KEY.fullmatch(key):
            raise Rejected("valid Idempotency-Key required")
        digest = hashlib.sha256(command.encode()).hexdigest()
        with self.locked() as db:
            prior = db.execute("SELECT digest FROM claims WHERE key=?", (key,)).fetchone()
            if prior:
                if prior[0] != digest:
                    raise Rejected("idempotency key reused with different command")
                row = db.execute("SELECT payload FROM events WHERE kind='result' AND json_extract(payload,'$.key')=? ORDER BY seq DESC LIMIT 1", (key,)).fetchone()
                if row:
                    return json.loads(row[0])["result"]
                return {"status": "uncertain", "revision": self.current(), "reason": "claimed_without_result; never replayed"}
            base = self.current()
            revision = secrets.token_hex(16)
            db.execute("INSERT INTO claims(key,digest,base,revision) VALUES(?,?,?,?)", (key, digest, base, revision))
            self.event(db, "claim", {"key": key, "base": base, "revision": revision, "digest": digest})
            candidate = self.state / "candidates" / revision
            result = {"status": "failed", "revision": base, "candidate": revision}
            try:
                source = self.state / "versions" / base
                tree_stats(source, self.config["workspace_bytes"], self.config["workspace_files"])
                shutil.copytree(source, candidate, symlinks=True)
                thaw(candidate)
                run = run_bounded(self.sandbox(candidate, command), self.state, self.config, candidate)
                result.update(run)
                if run["reason"] is None and run["exit_code"] == 0:
                    tree_stats(candidate, self.config["workspace_bytes"], self.config["workspace_files"])
                    freeze(candidate)
                    # Verification is host-configured but runs in the same isolation boundary.
                    verification = run_bounded(self.sandbox(candidate, self.config["verify"], readonly=True), self.state, self.config, candidate)
                    result["verification"] = verification
                    if verification["reason"] is None and verification["exit_code"] == 0 and self.config.get("host_verify"):
                        argv = [part.replace("{candidate}", str(candidate)) for part in self.config["host_verify"]]
                        host_check = run_bounded(argv, self.state, self.config)
                        result["host_verification"] = host_check
                        if host_check["reason"] is not None or host_check["exit_code"] != 0:
                            raise Rejected("host_verification_failed")
                    if verification["reason"] is None and verification["exit_code"] == 0:
                        tree_stats(candidate, self.config["workspace_bytes"], self.config["workspace_files"])
                        freeze(candidate)
                        # Moving a directory between parents requires write permission
                        # on its inode on Linux. No sandbox remains at this point.
                        candidate.chmod(0o700)
                        published = self.state / "versions" / revision
                        os.rename(candidate, published)
                        published.chmod(0o555)
                        sync_dir(published)
                        sync_dir(self.state / "candidates")
                        sync_dir(self.state / "versions")
                        self.event(db, "prepared", {"key": key, "revision": revision, "base": base})
                        self.activate(revision)
                        result.update(status="ok", revision=revision)
                    else:
                        result["reason"] = "verification_failed"
            except (Rejected, OSError, subprocess.SubprocessError) as error:
                result["reason"] = str(error)[:512]
            self.event(db, "result", {"key": key, "result": result})
            # Failed candidates stay quarantined for offline inspection; never reused.
            return result

    def rollback(self, revision, expected):
        if not isinstance(revision, str) or not REVISION.fullmatch(revision):
            raise Rejected("invalid revision")
        with self.locked() as db:
            current = self.current()
            if current != expected:
                raise Rejected("stale expected_current")
            if not (self.state / "versions" / revision).is_dir():
                raise Rejected("unknown revision")
            tree_stats(self.state / "versions" / revision, self.config["workspace_bytes"], self.config["workspace_files"])
            self.event(db, "rollback_intent", {"from": current, "to": revision})
            self.activate(revision)
            result = {"status": "ok", "revision": revision, "previous": current}
            self.event(db, "rollback", result)
            return result


def initialize(state, source, verify, timeout=5, output_bytes=16384, host_verify=None):
    state = Path(state).resolve()
    if state.exists():
        raise Rejected("state already exists")
    if source and state.is_relative_to(Path(source).resolve()):
        raise Rejected("state must not be inside the imported workspace")
    if not shutil.which("bwrap"):
        raise Rejected("bubblewrap required")
    if not verify:
        raise Rejected("an operator verification command is required")
    if host_verify is not None and (not isinstance(host_verify, list) or not host_verify
                                   or not all(isinstance(arg, str) and "\0" not in arg for arg in host_verify)
                                   or not Path(host_verify[0]).is_absolute()):
        raise Rejected("host verification must be an argv array with an absolute executable")
    state.mkdir(mode=0o700, parents=True)
    config = {"verify": verify, "host_verify": host_verify, "timeout": timeout, "output_bytes": output_bytes,
              "memory_bytes": 256 * 1024 * 1024, "file_bytes": 8 * 1024 * 1024,
              "workspace_bytes": 32 * 1024 * 1024, "workspace_files": 4096}
    durable_json(state / "config.json", config)
    for role in ("agent", "recovery"):
        path = state / (role + ".token")
        path.write_text(secrets.token_urlsafe(32))
        path.chmod(0o600)
    for directory in ("versions", "candidates"):
        (state / directory).mkdir(mode=0o700)
    build_runtime(state / "runtime")
    revision = secrets.token_hex(16)
    destination = state / "versions" / revision
    if source:
        tree_stats(Path(source), config["workspace_bytes"], config["workspace_files"])
        shutil.copytree(source, destination, symlinks=True)
    else:
        destination.mkdir()
    freeze(destination)
    with sqlite3.connect(state / "journal.sqlite") as db:
        db.executescript("""
            PRAGMA journal_mode=DELETE;
            PRAGMA synchronous=FULL;
            CREATE TABLE claims(key TEXT PRIMARY KEY,digest TEXT NOT NULL,base TEXT NOT NULL,revision TEXT NOT NULL);
            CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,time REAL NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TRIGGER no_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
            CREATE TRIGGER no_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
            CREATE TRIGGER no_claim_update BEFORE UPDATE ON claims BEGIN SELECT RAISE(ABORT,'append only'); END;
            CREATE TRIGGER no_claim_delete BEFORE DELETE ON claims BEGIN SELECT RAISE(ABORT,'append only'); END;
        """)
    executor = Executor(state)
    with executor.locked() as db:
        executor.event(db, "initialize", {"revision": revision})
        executor.activate(revision)
    return {"status": "ok", "revision": revision}


def handler_for(executor, role):
    token = (executor.state / (role + ".token")).read_text().strip()

    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(3)

        def log_message(self, *_):
            pass  # No command, authorization, or output in access logs.

        def send_json(self, code, value):
            data = encode(value)
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            try:
                auth = self.headers.get("Authorization", "")
                if not hmac.compare_digest(auth.encode(), ("Bearer " + token).encode()):
                    self.send_json(401, {"error": "unauthorized"})
                    return
                path = "/execute" if role == "agent" else "/rollback"
                if self.path != path:
                    self.send_json(404, {"error": "not found"})
                    return
                if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
                    raise Rejected("one Content-Length required; chunked encoding unsupported")
                length = int(self.headers["Content-Length"])
                if length < 1 or length > MAX_BODY:
                    raise Rejected("body size limit")
                body = self.rfile.read(length)
                if len(body) != length:
                    raise Rejected("incomplete body")
                value = json.loads(body)
                if not isinstance(value, dict):
                    raise Rejected("JSON object required")
                if role == "agent":
                    if set(value) != {"command"}:
                        raise Rejected("only command is accepted")
                    keys = self.headers.get_all("Idempotency-Key", [])
                    if len(keys) != 1:
                        raise Rejected("one Idempotency-Key required")
                    result = executor.execute(value["command"], keys[0])
                else:
                    if set(value) != {"revision", "expected_current"}:
                        raise Rejected("revision and expected_current required")
                    result = executor.rollback(value["revision"], value["expected_current"])
                self.send_json(200, result)
            except (Rejected, ValueError, TypeError, TimeoutError) as error:
                self.send_json(400, {"error": str(error)[:512]})
    return Handler


def ssh_execute(targets_file, target, command, key):
    targets = json.loads(Path(targets_file).read_text())
    if target not in targets:
        raise Rejected("unknown named SSH target")
    item = targets[target]
    for field in ("host", "user"):
        if not re.fullmatch(r"[A-Za-z0-9_.:-]+", item[field]) or item[field].startswith("-"):
            raise Rejected("invalid configured SSH " + field)
    for field in ("identity_file", "known_hosts"):
        if not Path(item[field]).is_absolute() or not Path(item[field]).is_file():
            raise Rejected("SSH requires existing absolute " + field)
    argv = ["ssh", "-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "UserKnownHostsFile=" + item["known_hosts"], "-o", "ConnectTimeout=5",
            "-i", item["identity_file"], "-p", str(int(item.get("port", 22))),
            item["user"] + "@" + item["host"], item["remote_command"]]
    # SSH stdout is also bounded; remote execution is never retried after transport failure.
    with subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env={"PATH": "/usr/bin:/bin"}, start_new_session=True) as process:
        try:
            process.stdin.write(encode({"command": command, "idempotency_key": key}))
            process.stdin.close()
            poller = selectors.DefaultSelector()
            poller.register(process.stdout, selectors.EVENT_READ)
            poller.register(process.stderr, selectors.EVENT_READ)
            outputs = {process.stdout: bytearray(), process.stderr: bytearray()}
            start = time.monotonic()
            while poller.get_map():
                if time.monotonic() - start > 60:
                    raise Rejected("SSH timeout; execution outcome may be uncertain")
                for selected, _ in poller.select(0.05):
                    data = os.read(selected.fileobj.fileno(), 4096)
                    if not data:
                        poller.unregister(selected.fileobj)
                    else:
                        outputs[selected.fileobj].extend(data)
                        if len(outputs[selected.fileobj]) > 262144:
                            raise Rejected("SSH output limit; execution outcome may be uncertain")
            if process.wait(timeout=2):
                raise Rejected("SSH failed; execution outcome may be uncertain: " + outputs[process.stderr].decode(errors="replace")[:256])
            return json.loads(outputs[process.stdout])
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", default="./executor-state")
    sub = parser.add_subparsers(dest="action", required=True)
    init = sub.add_parser("init")
    init.add_argument("--source")
    init.add_argument("--verify", required=True)
    init.add_argument("--host-verify", help="trusted host verifier argv as JSON; {candidate} expands to its path")
    serve = sub.add_parser("serve")
    serve.add_argument("--role", choices=["agent", "recovery"], required=True)
    serve.add_argument("--bind", default="127.0.0.1")
    serve.add_argument("--port", type=int, required=True)
    rollback = sub.add_parser("rollback")
    rollback.add_argument("--revision", required=True)
    rollback.add_argument("--expected-current", required=True)
    sub.add_parser("status")
    sub.add_parser("ssh-receive")
    ssh = sub.add_parser("ssh")
    ssh.add_argument("--targets", required=True)
    ssh.add_argument("--target", required=True)
    ssh.add_argument("--key", required=True)
    args = parser.parse_args()
    if args.action == "init":
        result = initialize(args.state, args.source, args.verify,
                            host_verify=json.loads(args.host_verify) if args.host_verify else None)
    elif args.action == "ssh":
        body = sys.stdin.buffer.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise Rejected("body size limit")
        value = json.loads(body)
        if not isinstance(value, dict) or set(value) != {"command"}:
            raise Rejected("only command is accepted")
        result = ssh_execute(args.targets, args.target, value["command"], args.key)
    else:
        executor = Executor(args.state)
        if args.action == "serve":
            if not ipaddress.ip_address(args.bind).is_loopback:
                raise Rejected("only loopback bind supported; use a trusted TLS tunnel")
            http.server.HTTPServer((args.bind, args.port), handler_for(executor, args.role)).serve_forever()
            return
        if args.action == "rollback":
            result = executor.rollback(args.revision, args.expected_current)
        elif args.action == "status":
            with executor.locked() as db:
                result = {"revision": executor.current(), "events": db.execute("SELECT count(*) FROM events").fetchone()[0]}
        else:
            body = sys.stdin.buffer.read(MAX_BODY + 1)
            if len(body) > MAX_BODY:
                raise Rejected("body size limit")
            value = json.loads(body)
            if not isinstance(value, dict) or set(value) != {"command", "idempotency_key"}:
                raise Rejected("command and idempotency_key required")
            result = executor.execute(value["command"], value["idempotency_key"])
    print(encode(result).decode())


if __name__ == "__main__":
    try:
        main()
    except (Rejected, OSError, ValueError, KeyError) as error:
        print(encode({"error": str(error)[:512]}).decode(), file=sys.stderr)
        sys.exit(1)

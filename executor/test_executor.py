"""Real Linux integration tests; no production hosts or third-party Python packages."""
import http.client
import json
import os
from pathlib import Path
import pwd
import shlex
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import executor as mod

SCRIPT = Path(mod.__file__).resolve()
SCRATCH = Path(os.environ.get("ROUNDHOUSE_TEST_SCRATCH", Path(__file__).resolve().parents[1] / ".amp/in/orb-backup"))


def remove(path):
    for parent, dirs, files in os.walk(path, followlinks=False):
        Path(parent).chmod(0o700)
        for name in dirs:
            child = Path(parent) / name
            if not child.is_symlink():
                child.chmod(0o700)
    shutil.rmtree(path)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_port(port, process):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("fixture exited: " + process.stderr.read().decode()[:512])
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=.1):
                return
        except OSError:
            time.sleep(.02)
    raise RuntimeError("fixture did not listen")


class ExecutorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        cls.root = Path(tempfile.mkdtemp(prefix="executor-tests-", dir=SCRATCH))
        cls.template = cls.root / "template"
        mod.initialize(cls.template, None, "test ! -e rejected", timeout=.6, output_bytes=2048)

    @classmethod
    def tearDownClass(cls):
        remove(cls.root)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="case-", dir=self.root))
        self.state = self.directory / "state"
        shutil.copytree(self.template, self.state, symlinks=True)
        self.executor = mod.Executor(self.state)
        self.initial = self.executor.current()

    def tearDown(self):
        remove(self.directory)

    def execute(self, command, key="test"):
        return self.executor.execute(command, key)

    def test_pipeline_file_mutation_and_replay(self):
        command = "printf 'z\\na\\n' | sort | tee data; mkdir nested; cp data nested/copy; sed -i 's/a/b/' nested/copy"
        result = self.execute(command)
        self.assertEqual(result["status"], "ok", result)
        current = self.state / "current"
        self.assertEqual((current / "data").read_text(), "a\nz\n")
        self.assertEqual((current / "nested/copy").read_text(), "b\nz\n")
        self.assertEqual((current / "data").stat().st_mode & 0o222, 0)
        self.assertFalse((self.state / "versions" / self.initial / "data").exists())
        self.assertEqual(self.execute(command), result)
        with self.assertRaises(mod.Rejected):
            self.execute("echo changed")

    def test_host_files_environment_network_and_metadata_inaccessible(self):
        secret = self.directory / "host-secret"
        secret.write_text("host-only-canary")
        os.environ["PROVIDER_CREDENTIAL_CANARY"] = "not-for-child"
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        try:
            command = (f"test ! -e {shlex.quote(str(secret))}; test ! -e /etc/passwd; "
                       "test ! -e /home; test ! -e /work/../config.json; "
                       "test -z \"${PROVIDER_CREDENTIAL_CANARY+x}\"; "
                       f"if (echo leak >/dev/tcp/127.0.0.1/{port}) 2>/dev/null; then exit 41; fi; "
                       "if (echo leak >/dev/tcp/1.1.1.1/53) 2>/dev/null; then exit 42; fi; "
                       "if touch /bin/poison 2>/dev/null; then exit 43; fi; "
                       "test ! -e /proc/1/root/home; echo isolated")
            result = self.execute("set -e; " + command)
            self.assertEqual(result["status"], "ok", result)
            self.assertEqual(secret.read_text(), "host-only-canary")
            listener.settimeout(.05)
            with self.assertRaises(socket.timeout):
                listener.accept()
        finally:
            listener.close()
            os.environ.pop("PROVIDER_CREDENTIAL_CANARY")

    def test_denied_and_nonzero_never_activate(self):
        for i, command in enumerate(("echo bad > /etc/host", "echo changed > data; exit 7")):
            result = self.execute(command, str(i))
            self.assertEqual(result["status"], "failed", result)
            self.assertEqual(self.executor.current(), self.initial)

    def test_symlinks_and_hardlinks_rejected(self):
        for i, command in enumerate(("ln -s /etc secret", "ln -s ../../config.json secret",
                                     "echo x > one; ln one two", "mkdir private; chmod 000 private")):
            result = self.execute(command, str(i))
            self.assertEqual(result["status"], "failed", result)
            self.assertEqual(self.executor.current(), self.initial)

    def test_workspace_cannot_poison_control_metadata(self):
        result = self.execute("echo fake > config.json; echo fake > journal.sqlite; mkdir versions; echo fake > agent.token")
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(json.loads((self.state / "config.json").read_text())["verify"], "test ! -e rejected")
        self.assertNotEqual((self.state / "agent.token").read_text(), "fake\n")

    def test_verification_failure_preserves_last_good(self):
        good = self.execute("echo good > data", "good")
        self.assertEqual(good["status"], "ok", good)
        bad = self.execute("echo bad > data; touch rejected", "bad")
        self.assertEqual(bad["reason"], "verification_failed", bad)
        self.assertEqual(self.executor.current(), good["revision"])
        self.assertEqual((self.state / "current/data").read_text(), "good\n")

    def test_verification_mount_is_readonly(self):
        self.executor.config["verify"] = "chmod u+w /work; touch /work/verifier-write"
        result = self.execute("echo data > data")
        self.assertEqual(result["reason"], "verification_failed", result)
        self.assertEqual(self.executor.current(), self.initial)

    def test_trusted_host_verification_gate(self):
        marker = self.directory / "operator-approved"
        self.executor.config["host_verify"] = ["/usr/bin/test", "-f", str(marker)]
        result = self.execute("echo candidate > data", "not-approved")
        self.assertEqual(result["reason"], "host_verification_failed", result)
        self.assertEqual(self.executor.current(), self.initial)
        marker.touch()
        result = self.execute("echo candidate > data", "approved")
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["host_verification"]["exit_code"], 0)

    def test_cross_mount_hardlinks_and_snapshot_root_escape_denied(self):
        result = self.execute("if ln /bin/bash /work/linked 2>/dev/null; then exit 23; fi; "
                              "if ln /work /tmp/work 2>/dev/null; then exit 24; fi; "
                              "if touch /work/../escape 2>/dev/null; then exit 25; fi")
        self.assertEqual(result["status"], "ok", result)

    def test_timeout_output_file_and_workspace_bounds(self):
        result = self.execute("sleep 20", "timeout")
        self.assertEqual(result["reason"], "timeout", result)
        result = self.execute("yes x", "output")
        self.assertEqual(result["reason"], "output_limit", result)
        self.assertLessEqual(len(result["output"].encode()), 2048)
        result = self.execute("dd if=/dev/zero of=large bs=1048576 count=12", "file")
        self.assertEqual(result["status"], "failed", result)
        self.executor.config["workspace_files"] = 10
        result = self.execute("for n in $(seq 1 100); do touch f$n; done", "files")
        self.assertEqual(result["status"], "failed", result)

    def test_background_process_terminated(self):
        result = self.execute("(sleep 1; echo escaped > late) >/dev/null 2>&1 & sleep 20")
        self.assertEqual(result["reason"], "timeout", result)
        time.sleep(1.1)
        self.assertFalse((self.state / "candidates" / result["candidate"] / "late").exists())

    def test_missing_bubblewrap_fails_closed(self):
        with mock.patch.object(mod.shutil, "which", return_value=None):
            result = self.execute("touch should-not-run")
        self.assertEqual(result["status"], "failed", result)
        self.assertIn("bubblewrap unavailable", result["reason"])
        self.assertFalse((self.state / "current/should-not-run").exists())

    def test_crash_after_claim_does_not_replay(self):
        command = "echo once >> count; sleep 20"
        process = subprocess.Popen([sys.executable, str(SCRIPT), "--state", str(self.state), "ssh-receive"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        process.stdin.write(mod.encode({"command": command, "idempotency_key": "crash"}))
        process.stdin.close()
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                candidates = list((self.state / "candidates").glob("*/count"))
                if candidates:
                    break
                time.sleep(.01)
            self.assertTrue(candidates, "real child did not start")
            process.kill()
            process.wait(timeout=3)
            time.sleep(.1)
            result = mod.Executor(self.state).execute(command, "crash")
            self.assertEqual(result["status"], "uncertain", result)
            self.assertEqual(candidates[0].read_text(), "once\n")
            self.assertEqual(self.executor.current(), self.initial)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
            process.stderr.close()

    def test_offline_recovery_without_daemon_and_stale_guard(self):
        good = self.execute("printf '#!/bin/sh\\necho healthy\\n' > controller; chmod +x controller", "good-code")
        self.assertEqual(good["status"], "ok", good)
        def probe():
            return mod.run_bounded(self.executor.sandbox(self.state / "current", "./controller", readonly=True), self.state, self.executor.config)
        self.assertEqual(probe()["output"], "healthy\n")
        broken = self.execute("printf '#!/bin/sh\\nexit 9\\n' > controller", "broken-code")
        self.assertEqual(broken["status"], "ok", broken)
        self.assertEqual(probe()["exit_code"], 9)
        command = [sys.executable, str(SCRIPT), "--state", str(self.state), "rollback",
                   "--revision", good["revision"], "--expected-current", broken["revision"]]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["revision"], good["revision"])
        self.assertEqual(probe()["exit_code"], 0)
        self.assertEqual(probe()["output"], "healthy\n")
        stale = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(stale.returncode, 0)
        with sqlite3.connect(self.state / "journal.sqlite") as db:
            self.assertGreater(db.execute("SELECT count(*) FROM events WHERE kind='rollback'").fetchone()[0], 0)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM events")

    def api(self, role):
        port = free_port()
        process = subprocess.Popen([sys.executable, str(SCRIPT), "--state", str(self.state), "serve",
                                    "--role", role, "--port", str(port)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        wait_port(port, process)
        self.addCleanup(process.stdout.close)
        self.addCleanup(process.stderr.close)
        self.addCleanup(process.wait)
        self.addCleanup(process.terminate)
        return port

    def post(self, port, path, body, token, key="api"):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request("POST", path, mod.encode(body), {"Authorization": "Bearer " + token,
                                                              "Idempotency-Key": key})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_bounded_http_contract_and_role_separation(self):
        port = self.api("agent")
        agent = (self.state / "agent.token").read_text()
        recovery = (self.state / "recovery.token").read_text()
        self.assertEqual(self.post(port, "/execute", {"command": "true"}, recovery)[0], 401)
        self.assertEqual(self.post(port, "/rollback", {}, agent)[0], 404)
        self.assertEqual(self.post(port, "/execute", {"command": "true", "host": "evil"}, agent)[0], 400)
        self.assertEqual(self.post(port, "/execute", {"command": "x" * 20000}, agent)[0], 400)
        status, result = self.post(port, "/execute", {"command": "printf api | tee data"}, agent)
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["output"], "api")

    def test_independent_recovery_api_main_agent_absent(self):
        good = self.execute("echo good > data")
        port = self.api("recovery")  # There is deliberately no agent server/controller.
        agent = (self.state / "agent.token").read_text()
        token = (self.state / "recovery.token").read_text()
        body = {"revision": self.initial, "expected_current": good["revision"]}
        self.assertEqual(self.post(port, "/rollback", body, agent)[0], 401)
        status, result = self.post(port, "/rollback", body, token)
        self.assertEqual(status, 200)
        self.assertEqual(result["revision"], self.initial)
        self.assertEqual(self.post(port, "/rollback", body, token)[0], 400)

    def test_real_ssh_fixture_and_host_authenticity(self):
        if not shutil.which("ssh-keygen") or not Path("/usr/sbin/sshd").exists():
            self.skipTest("OpenSSH server/client missing")
        if subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode:
            self.skipTest("local sshd fixture requires passwordless sudo")
        fixture = self.directory / "ssh"
        fixture.mkdir()
        for name in ("host", "client", "wrong"):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(fixture / name)], check=True)
        port = free_port()
        known = fixture / "known_hosts"
        host_public = (fixture / "host.pub").read_text().split()
        known.write_text(f"[127.0.0.1]:{port} {host_public[0]} {host_public[1]}\n")
        remote = shlex.join([sys.executable, str(SCRIPT), "--state", str(self.state), "ssh-receive"])
        config = fixture / "sshd_config"
        config.write_text(f"""Port {port}
ListenAddress 127.0.0.1
HostKey {fixture / 'host'}
PidFile {fixture / 'pid'}
AuthorizedKeysFile {fixture / 'client.pub'}
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
UsePAM yes
AllowUsers {pwd.getpwuid(os.getuid()).pw_name}
DisableForwarding yes
ForceCommand {remote}
LogLevel ERROR
""")
        process = subprocess.Popen(["sudo", "-n", "/usr/sbin/sshd", "-D", "-e", "-f", str(config)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            wait_port(port, process)
            targets = fixture / "targets.json"
            targets.write_text(json.dumps({"local": {"host": "127.0.0.1", "user": pwd.getpwuid(os.getuid()).pw_name,
                                  "port": port, "known_hosts": str(known), "identity_file": str(fixture / "client"),
                                  "remote_command": remote}}))
            result = mod.ssh_execute(targets, "local", "printf ssh-real > data; cat data", "ssh-real")
            self.assertEqual(result["status"], "ok", result)
            self.assertEqual(result["output"], "ssh-real")
            self.assertEqual((self.state / "current/data").read_text(), "ssh-real")
            wrong = (fixture / "wrong.pub").read_text().split()
            known.write_text(f"[127.0.0.1]:{port} {wrong[0]} {wrong[1]}\n")
            with self.assertRaisesRegex(mod.Rejected, "SSH failed"):
                mod.ssh_execute(targets, "local", "touch must-not-execute", "wrong-host")
            self.assertFalse((self.state / "current/must-not-execute").exists())
            with self.assertRaisesRegex(mod.Rejected, "unknown named"):
                mod.ssh_execute(targets, "model-chosen-host", "true", "unknown")
        finally:
            # sudo's child is root-owned; use its isolated, confirmed process group.
            subprocess.run(["sudo", "-n", "kill", "-TERM", "--", "-" + str(process.pid)], capture_output=True)
            process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

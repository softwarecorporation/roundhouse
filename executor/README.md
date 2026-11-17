# Linux operations executor

`executor.py` is an independent Python 3.9+ stdlib service and CLI. It runs arbitrary Bash syntax in a disposable copy of a versioned workspace. It has no model, provider SDK, controller, npm, or Rust dependency. Linux, Bubblewrap, Bash, `ldd`, and the utilities listed in `TOOLS` are required. OpenSSH is required only for SSH transport.

This executor changes workspace versions. It does **not** deploy services, change the host's live configuration, reverse external side effects, or provide a general host shell.

## Run a local executor

Run these commands from the repository root. Put state outside the source workspace. Import only files the command is allowed to read, with no secrets, symlinks, hardlinks, or special files.

```sh
python3 executor/executor.py --state /absolute/private/state init \
	--source /absolute/disposable/input \
	--verify 'test -s artifact.txt' \
	--host-verify '["/usr/bin/test","-f","/absolute/operator/allow-activation"]'
```

Omit `--source` to start empty. `init` refuses an existing state directory. It generates separate `agent.token` and `recovery.token` files with mode `0600` in a `0700` directory. Do not distribute the recovery token to the agent.

`--verify` is required. The host operator selects this command, which runs against a read-only candidate in another network-disabled sandbox. The optional `--host-verify` is a trusted, fixed argv array that runs on the host before activation. Every occurrence of `{candidate}` in an argument expands to the candidate's absolute path. There is no shell expansion. Host verification has a clean environment, bounded output, and the same time and process limits.

**The host verifier is trusted code outside the sandbox.** Never configure it to execute candidate scripts, load candidate plugins, evaluate candidate content, or use a candidate-controlled executable. A verifier that does those things gives the candidate host-code execution. Host verifiers should inspect data without changing it. Their external side effects cannot be rolled back by this executor.

Start these as two separate processes under your service supervisor:

```sh
python3 executor/executor.py --state /absolute/private/state serve --role agent --port 8788
python3 executor/executor.py --state /absolute/private/state serve --role recovery --port 8789
```

Both bind to `127.0.0.1` by default. Non-loopback binds are rejected. An authenticated TLS tunnel or reverse proxy is required for a Worker to reach the HTTP API from another machine. Never publish these cleartext listeners directly. Supervision and tunnel provisioning are operator tasks, not automatic deployment by this package.

## HTTP protocol

The agent listener accepts only `POST /execute`. Its headers are:

```text
Authorization: Bearer <agent token>
Content-Type: application/json
Content-Length: <body length>
Idempotency-Key: <stable unique operation key>
```

The Worker sends exactly this body, with no host, path, verification, or transport parameters:

```json
{"command":"printf 'ready\n' | tee artifact.txt"}
```

The body limit is 16,384 bytes. The nonempty command limit is 8,192 UTF-8 bytes, with no NUL. Keys contain 1–128 ASCII letters, digits, underscores, periods, colons, or hyphens. Chunked requests, duplicate length headers, extra JSON fields, and missing keys are rejected. Connections close after each response. Bearer-token comparison uses `hmac.compare_digest`.

An accepted operation returns HTTP 200 with one of these statuses:

- `ok`: the command and all configured checks succeeded, and the candidate became current.
- `failed`: the command, a resource limit, snapshot validation, or verification failed. The preceding current version remains active.
- `uncertain`: the durable key claim exists without a terminal result. The command is never automatically replayed.

Example successful result, with shortened revision values for readability:

```json
{"status":"ok","revision":"<32 hex characters>","candidate":"<same revision>","exit_code":0,"reason":null,"output":"ready\n","verification":{"exit_code":0,"reason":null,"output":""},"host_verification":{"exit_code":0,"reason":null,"output":""}}
```

`output` merges stdout and stderr. `host_verification` appears only when configured and reached. Failed results include the previous current revision and the isolated candidate ID. Authentication failures return 401, wrong listener paths return 404, and invalid input or stale recovery calls return 400. Callers must inspect `status`, not just HTTP success. CLI transport success also does not imply operation success.

A retry with the same key and same command returns the stored result, without execution. A retry with different command content is rejected. A stored result describes the original operation, not the current state after later executions or rollbacks. On transport failure, retain the original key. Never retry an uncertain operation under a new key without an operator decision.

## Recover without the agent or daemon

The recovery listener accepts only `POST /rollback`, authenticated with the separate recovery token:

```json
{"revision":"<known version>","expected_current":"<currently active version>"}
```

The agent token cannot authenticate to this listener. The recovery token cannot authenticate to the agent listener. Each listener is a separate process, so recovery does not depend on an available model or controller.

The offline CLI needs neither listener, Bubblewrap execution, nor a network connection:

```sh
python3 executor/executor.py --state /absolute/private/state status
python3 executor/executor.py --state /absolute/private/state rollback \
	--revision <known-version> --expected-current <current-version>
```

Offline access relies on OS ownership of state rather than a bearer token. The exact current revision must match `expected_current` under the same file lock used by execution. Stale calls fail without changing the pointer. A hung active operation holds that lock until its bounded execution ends. Recovery cannot preempt an active operation.

Rollback changes only the `current` symlink. It does not delete newer versions, failed candidates, idempotency claims, or audit events. It does not undo external effects of a host verifier or an external consumer of an earlier version. Processes that already opened files through an old version can retain those file descriptors.

## Use real SSH transport

The operator provides a private targets file outside all candidates:

```json
{
	"staging": {
		"host": "configured.example",
		"user": "executor",
		"port": 22,
		"identity_file": "/absolute/private/id_ed25519",
		"known_hosts": "/absolute/private/known_hosts",
		"remote_command": "python3 /opt/roundhouse/executor/executor.py --state /var/lib/roundhouse-executor ssh-receive"
	}
}
```

The CLI accepts a configured name, not a model-selected host, user, key, or remote command:

```sh
printf '%s' '{"command":"printf ssh-ready > artifact.txt"}' | \
	python3 executor/executor.py ssh --targets /absolute/private/targets.json \
	--target staging --key operation-123
```

This invokes the real `ssh` executable. It uses `BatchMode`, `IdentitiesOnly`, an explicit identity, no agent, no forwarding, no terminal, no SSH config, and strict checking against the configured known-hosts file. It neither downloads a key nor trusts the first host it sees. Provision and verify host keys out of band.

The remote command is fixed in operator configuration. Command text travels only in JSON stdin, as `{"command":"...","idempotency_key":"..."}`. The remote `ssh-receive` process uses the same journal and sandbox without an HTTP daemon. SSH authentication replaces the HTTP bearer token for this path. Restrict the SSH key on the server to this forced command with no forwarding or PTY. An unrestricted SSH account is a broader authority than this executor.

The SSH deadline is 60 seconds and each captured stream is limited to 262,144 bytes. Transport failure is not proof of remote non-execution. No automatic transport retry occurs.

## Isolation and persistence reference

- The runtime contains copies of explicitly listed binaries and their ELF libraries. No host root, `/usr`, `/etc`, home directory, provider environment, tokens, journal, SSH key, or configuration is mounted into the sandbox.
- Bubblewrap uses `--unshare-all`, a private PID namespace and procfs, a network namespace with no host connectivity, dropped capabilities, `--die-with-parent`, a clean environment, and a new session. Its setup failures never fall back to a host shell.
- The candidate is the only persistent writable mount. `/tmp` is an ephemeral 32 MiB tmpfs. `/dev` is a private device filesystem. The copied runtime is read-only. Cross-mount hardlinks fail.
- Snapshots reject all symlinks, multiply linked regular files, devices, sockets, and FIFOs. Unreadable directory traversal also fails closed. This deliberately sacrifices symlink support instead of attempting to resolve hostile links.
- Commands start from a fresh copy of current, never from a failed candidate. A candidate is writable only during execution. Verification receives a read-only mount. Published versions have write bits removed and never become writable command mounts again.
- Defaults are 5 seconds per command or check, 16 KiB raw output per stage, 256 MiB address space per process, 8 MiB per regular file, 128 file descriptors per process, 256 processes per real UID, and a CPU limit of 6 seconds per process. The executor kills and reaps the process group on completion or limit breach. PID-namespace teardown also kills detached sandbox descendants.
- The workspace limit is 32 MiB and 4,096 entries. It is polled during execution and checked before publication. It is **not a hard disk quota** and can overshoot between scans. Memory and process limits are per process or UID, not aggregate cgroup quotas. Run under a dedicated unprivileged OS account and an operator-managed cgroup and filesystem quota for hard aggregate resource guarantees.
- With defaults, the ASCII-escaped JSON response is bounded by three output buffers plus fixed metadata, below 300 KiB. Host-controlled configuration can change those bounds. No streaming output is exposed.
- `flock` serializes every execution and rollback across independent processes. SQLite FULL-synchronous claims commit before copying or launching commands. Append-only SQL triggers reject claim and event updates or deletes. These are application invariants, not protection against the state owner, root, or disk tampering.
- Data and directory fsync precede an atomic current-pointer replacement. The journal records initialization, claims, prepared revisions, results, rollback intents, and completed rollbacks. Claims record command hashes, not raw command text. Result output may contain workspace data, so the state directory remains private.
- A crash between pointer replacement and terminal journal insertion can leave a verified version active with an uncertain request. `status`, the pointer, and append-only prepared events support operator reconciliation. The key still never replays. An uncertain response is not a promise that no activation occurred.
- Versions, quarantined candidates, claims, and events accumulate. There is no automatic garbage collection or total history quota. Capacity monitoring and offline archival are operator responsibilities.

State, trusted runtime binaries, operator configuration, and imported source must not be writable concurrently by an untrusted host process. Kernel vulnerabilities, a malicious operator verifier, hostile files already in the explicitly imported input, and other processes running as the executor's host UID are outside this sandbox boundary. Do not run as root. Initialization can leave partial state on failure. Inspect and remove that incomplete directory before retrying initialization.

## Run the tests

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s executor -v
```

Tests execute real Bubblewrap commands, real HTTP requests, offline rollback processes, and a killed executor followed by a restart. The SSH test generates disposable client and host keys, starts a loopback-only sshd fixture, executes a sandboxed command over SSH, and rejects a changed host key. It needs existing OpenSSH and passwordless local sudo. If those prerequisites are missing, unittest reports an explicit skip. It does not contact an external host, alter the system sshd configuration, or install dependencies.

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

## Install on an always-on Linux host

These steps are for a dedicated, operator-managed host, not a development orb. They require root administration but run the executor as an unprivileged account. The commands install files and start services only when you run them. Nothing in this repository provisions a server, opens a tunnel, or changes production access.

### Prepare the host and persistent storage

1. Install Python 3.9+, Bubblewrap, Bash, `ldd`, and every utility in `TOOLS` in `executor.py` through your distribution's package manager. Use a supported kernel with user, mount, PID, and network namespaces. AppArmor, SELinux, container restrictions, and disabled unprivileged user namespaces can prevent Bubblewrap from starting. Do not disable isolation or run the service as root to work around a failure.
2. Create a dedicated system user and group named `roundhouse-executor`, with no login shell or other workloads. Keep `/opt/roundhouse-executor` root-owned. Install the reviewed `executor.py` there with mode `0644`, keeping a copy and checksum of the previous release outside state.
3. Create `/var/lib/roundhouse-executor` owned by `roundhouse-executor:roundhouse-executor` with mode `0700`. Use persistent local storage with working `flock`, SQLite locking, atomic rename, and fsync. The copied runtime in state must support execution. A `noexec` mount can prevent sandbox startup. Do not put state inside an imported workspace, ephemeral container layer, or network filesystem.
4. Apply a filesystem or project quota to the entire state tree, including future versions and the SQLite journal. Reserve free space for journal commits and recovery. Set byte and inode alerts below the hard quota. The 32 MiB workspace scan does not limit total history or prevent temporary overshoot.
5. Confirm that systemd can enforce memory, task, and CPU accounting on this host. The supplied units put the agent and recovery in separate cgroups. `MemoryMax=512M`, `TasksMax=256`, and `CPUQuota=100%` bound the agent service and its children. Recovery has separate limits of 128 MiB, 32 tasks, and 25% CPU. These are starting values, not workload sizing guarantees. They do not impose a disk quota or reserve memory and CPU for recovery against host-wide exhaustion.

After creating the account through your distribution's account tools, install the files from the repository root:

```sh
sudo install -d -o root -g root -m 0755 /opt/roundhouse-executor
sudo install -o root -g root -m 0644 executor/executor.py /opt/roundhouse-executor/executor.py
sudo install -d -o roundhouse-executor -g roundhouse-executor -m 0700 /var/lib/roundhouse-executor
```

Do not grant sudo, Docker socket access, application secrets, or unrestricted SSH access to this account. Both services own the same state and can read both token files. Separate listeners and tokens enforce protocol roles, not isolation from a compromised host process under this UID. Root and other processes using this UID remain trusted. The executor's per-UID process limit also spans both services, even though their cgroups are separate.

### Initialize once and test Bubblewrap

The `state` child below must not exist before initialization. Prepare a sanitized source directory at `/srv/roundhouse-executor-input` and replace the sample verifier with an operator-reviewed check for your artifact. An empty source can be omitted.

```sh
sudo -u roundhouse-executor env PATH=/usr/bin:/bin \
	/usr/bin/python3 /opt/roundhouse-executor/executor.py \
	--state /var/lib/roundhouse-executor/state init \
	--source /srv/roundhouse-executor-input --verify 'test -s artifact.txt'
sudo -u roundhouse-executor /usr/bin/python3 \
	/opt/roundhouse-executor/executor.py \
	--state /var/lib/roundhouse-executor/state status
```

Expect JSON with `status: "ok"` from `init`, then a revision and event count from `status`. Initialization copies runtime binaries but does not prove the sandbox can start. On this host, initialize a second disposable state and use `ssh-receive` locally to exercise actual execution and verification before enabling services:

```sh
printf '%s' '{"command":"printf ready > artifact.txt","idempotency_key":"preflight-1"}' | \
	sudo -u roundhouse-executor env PATH=/usr/bin:/bin \
	/usr/bin/python3 /opt/roundhouse-executor/executor.py \
	--state /absolute/disposable/preflight-state ssh-receive
```

Initialize that disposable state first with the same verifier. Require `status: "ok"` and verify that files outside the imported workspace are inaccessible. `ssh-receive` here is a local stdin protocol, not a network connection. The CLI can exit zero for a result whose status is `failed` or `uncertain`. Inspect the JSON. Initialization failure can leave partial state. Inspect that new directory rather than rerunning `init` against it or deleting established state.

### Review and enable independent units

Review [`roundhouse-executor-agent.service`](../deploy/executor/roundhouse-executor-agent.service) and [`roundhouse-executor-recovery.service`](../deploy/executor/roundhouse-executor-recovery.service). Confirm paths, account, quota, ports, and limits before installing them. They do not create or initialize state. Neither unit depends on the other, shares its cgroup, or restarts the other.

Do not copy `NoNewPrivileges`, `RestrictNamespaces`, `ProtectSystem`, syscall filters, or the native host's unit into these services without testing. Their interaction with Bubblewrap depends on the kernel, distribution policy, and whether Bubblewrap uses a setuid helper. The templates deliberately do not assert that those flags permit namespace creation. Check effective inherited settings and local drop-ins as well. A syntax check cannot prove sandbox compatibility.

```sh
systemd-analyze verify deploy/executor/roundhouse-executor-*.service
sudo install -m 0644 deploy/executor/roundhouse-executor-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now roundhouse-executor-agent roundhouse-executor-recovery
sudo systemctl status roundhouse-executor-agent roundhouse-executor-recovery
sudo ss -ltnp '( sport = :8788 or sport = :8789 )'
```

Require listeners only on `127.0.0.1:8788` and `127.0.0.1:8789`. There is no HTTP health endpoint. Check supervisor status and inspect the current revision with `status`. Repeat an authenticated disposable execution through the agent service to prove Bubblewrap works under the unit's effective restrictions and cgroup limits. Stop only the disposable agent unit and confirm recovery remains available. Do not fault-inject an active deployment.

Keep `agent.token` in the controller's secret store and `recovery.token` in a separate operator recovery store. Transfer them through an approved secret channel, not shell arguments, logs, Git, or the workspace. Do not send the recovery token to a model or configure it as the execution credential. Listeners load tokens at startup. To rotate, pause callers, replace each token atomically with a new high-entropy value while retaining ownership and mode `0600`, update its authorized caller, and restart that listener. Keep administrative access available during rotation.

### Expose only the agent through reviewed TLS

Before connecting a remote Worker, provision a TLS reverse proxy, trusted certificate with renewal, DNS, firewall rules, and an authenticated caller. Keep both executor ports on loopback and blocked from remote ingress. This is an external prerequisite, not an automatic tunnel supplied by the executor.

[`nginx-agent.conf.example`](../deploy/executor/nginx-agent.conf.example) is an optional nginx `http`-context example. Replace its hostname and certificate paths. Review the existing default server and virtual hosts, restrict ingress to your authorized callers where possible, and run `nginx -t` before any reload. The example exposes only `POST /execute` to port 8788, forwards the agent bearer token and idempotency key, caps the request body at 16 KiB, and disables upstream retries. The executor authenticates the agent token. The example does not provision certificates, implement a separate identity provider, or rate-limit callers. Add reviewed authentication or rate limits at your edge if required.

Configure the controller with this HTTPS origin and its agent token. The proxy must preserve the command JSON, `Authorization`, and `Idempotency-Key`, and forward a bounded body with a valid `Content-Length`. The executor rejects chunked upstream requests. Check that the chosen proxy buffers and frames the real caller's requests correctly. Do not put credentials or operation keys in proxy access logs. The example disables its access log.

The example was exercised locally with nginx 1.26.3, fixture TLS, and the real Bubblewrap executor. Ordinary and chunked HTTPS requests arrived with one valid `Content-Length` and no `Transfer-Encoding`. Authentication, durable replay, conflicting-key rejection, body limits, and denial of recovery paths passed. This does not verify another host's certificates, default virtual hosts, firewall rules, or service restrictions. Run syntax and request-framing checks against that host's complete configuration before reload.

Do not proxy port 8789 through the agent hostname, a wildcard route, or the same public credential. Keep recovery private to host administration by default. If remote recovery is required, separately review an authenticated private transport and its access policy. Offline rollback below remains available without either listener or proxy. A proxy timeout is an unknown outcome, not evidence that a command did not run.

### Back up and retain complete state

1. Pause callers and stop both units. Also stop any `ssh-receive` writers or offline administrative operations. Wait for active work to finish when possible. A forced stop can leave an uncertain claim.
2. Copy or snapshot the entire state tree coherently, including `current` as a symlink, `versions`, `candidates`, `runtime`, `config.json`, `journal.sqlite`, any SQLite sidecar files, and both token files. Preserve ownership, modes, and links. A live copy of SQLite alone is not a consistent workspace backup.
3. Encrypt the backup, restrict access, and store a copy off-host through your approved backup system. Result output and candidate files can contain sensitive data. Record the release checksum, current revision, and backup time without recording token values.
4. Test restore into an isolated directory without enabling listeners or network access. Run `status`, check the pointed-to version, and rehearse an offline rollback there. Restore the whole tree as one unit, not a pointer from one backup and a journal from another.
5. Restart the units and resume callers only after confirming state and listeners. Monitor backup age, restore results, filesystem bytes and inodes, cgroup OOM kills, and restart loops.

Set a retention period, storage budget, and backup-expiry policy before unattended operation. There is no supported online garbage collector. Do not delete claims or events to reclaim space, or delete revisions referenced by `current`, recovery plans, or unresolved operations. Archive complete stopped state instead. Do not reset the live state merely because a quota is nearly full. Pause execution and expand or archive storage through a reviewed procedure.

Restoring an older backup can lose newer idempotency claims. Fence callers and reconcile every request since that backup before accepting traffic. Otherwise, a retried key can run again because its claim no longer exists. A backup restore is not the ordinary rollback command.

### Reconcile unknown outcomes and roll back offline

Retain the original operation key after a disconnect, timeout, killed process, disk-full error, or `uncertain` result. Repeating the same command under that key can return the durable result, but a claimed operation without a result never replays. Do not invent a new key to bypass that claim.

Pause new execution. Use `status` and inspect `current`, the candidate, and prepared/result audit events in `journal.sqlite` with read-only tools. `status` reports only the current revision and event count, not an outcome lookup. A candidate may have become current before a terminal event was committed. Reconcile any trusted host-verifier or external-consumer effects separately.

To roll back without either HTTP process, stop or pause all writers and use the state owner's CLI:

```sh
sudo -u roundhouse-executor /usr/bin/python3 \
	/opt/roundhouse-executor/executor.py \
	--state /var/lib/roundhouse-executor/state status
sudo -u roundhouse-executor /usr/bin/python3 \
	/opt/roundhouse-executor/executor.py \
	--state /var/lib/roundhouse-executor/state rollback \
	--revision <known-good-revision> --expected-current <observed-current-revision>
```

Require `status: "ok"` and inspect `status` again. A stale `expected_current` must fail. Rollback requires neither a model, controller, proxy, Bubblewrap launch, nor recovery bearer token. It still requires readable state, write space, and the shared lock. Never unlink the lock or edit the current pointer to bypass an active operation. Already-open files and external side effects remain outside rollback.

For a code release rollback, stop both units, retain a coherent state backup, and restore the previous reviewed `executor.py`. Do not reinitialize state. Verify compatibility with the saved state format before restarting. There is no automatic schema downgrade or release manager.

### Troubleshoot without weakening isolation

- If either service exits at startup, inspect `journalctl -u roundhouse-executor-agent -u roundhouse-executor-recovery`, state ownership, configured paths, token permissions, and occupied ports. Do not print token files into diagnostics. After fixing a restart-limit failure, use `systemctl reset-failed` before starting the affected unit.
- If a command fails before Bash starts, check `bwrap` availability, user namespace policy, AppArmor or SELinux denials, inherited systemd restrictions, and the copied runtime. Reproduce in disposable state as the service UID and under the effective unit settings. Never replace Bubblewrap with a host shell.
- If recovery waits, an execution may hold `flock`. Host verification and command stages have deadlines, but copying, filesystem stalls, and lock waits are not covered by those deadlines. If you must stop the agent, treat its in-flight key as uncertain and reconcile before retrying. Recovery independence does not mean recovery can preempt the shared lock.
- If a process dies without a result, check cgroup memory events and systemd exit status as well as free bytes, inode availability, and quota usage. Resource exhaustion can affect journaling and recovery. Stop new work before the reserved capacity runs out.
- If HTTPS calls fail while local status works, check certificate validity, proxy path, method, auth forwarding, body framing, and deadlines. Do not expose the loopback listener as a workaround. A 200 response still requires inspection of the executor's result status.

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

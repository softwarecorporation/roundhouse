# Set up and verify Roundhouse

Start in a disposable Linux environment. The commands below build source and run local fixtures. They do not publish packages, deploy Workers, provision a server, or change an application.

## Choose the host

- Use **Workers** for Durable Object alarms, telemetry, and the extensible tool catalog. Its shell is a JavaScript interpreter with private versioned files. It cannot run native binaries or SSH.
- Add the **Linux executor** for real isolated Bash and optional configured SSH. It needs an always-on server with persistent storage and a separately secured transport. Workers calls it only after exact privileged approval.
- Use the **native Rust server** for the original health, diagnostic, and named recovery endpoint contract. It does not implement the Workers tool catalog or telemetry API. Follow the [native deployment guide](https://github.com/tschk/roundhouse/blob/main/deploy/README.md).
- Embed **roundhouse-core** only when you supply scheduling, persistence, network I/O, and authority yourself. It is not a monitoring daemon.

Neither deployed host depends on a laptop connection. Local Miniflare tests stop when their process exits and are not an always-on deployment.

## Prepare a disposable Linux environment

Use Bun 1.4.4, Rust 1.100.0, Python 3.9 or newer, and Git. Building needs a C compiler, pkg-config, OpenSSL development headers, and CA certificates. Full native execution checks also need bubblewrap, Bash, coreutils, findutils, grep, sed, libc utilities including `ldd`, and OpenSSH client and server.

On an operator-approved disposable Ubuntu host, install the missing packages:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev ca-certificates git python3 bash coreutils findutils grep sed libc-bin bubblewrap openssh-client openssh-server
```

Installing OpenSSH server can start a distribution service. Do not use these installation commands on a shared or production host without its operator's permission. Get Bun and rustup from their official installers if absent. Do not replace an existing third-party runtime to run this example.

Select the build tools:

```sh
. "$HOME/.cargo/env"
rustup toolchain install 1.100.0
rustup target add --toolchain 1.100.0 wasm32-unknown-unknown
rustup component add --toolchain 1.100.0 rust-docs
export RUSTUP_TOOLCHAIN=1.100.0
cargo install wasm-bindgen-cli --version 0.2.130 --locked
bun --version
rustc --version
wasm-bindgen --version
```

Expect `1.4.4`, `1.100.0`, and `0.2.130`. Rust's documentation component supplies license files included in the archive. Keep the selected toolchain and its `cargo` and `rustc` on `PATH` for the entire build.

Check namespace support before testing native execution:

```sh
bwrap --unshare-all --ro-bind / / -- /bin/true
sudo -n true
sudo install -d -m 0755 /run/sshd
```

The first command must exit successfully. The SSH fixture needs passwordless local sudo to start a generated loopback-only sshd, not to run agent commands as root. Do not grant new sudo access or disable a shared host's AppArmor policy for this test. Use a supported disposable environment instead. Missing SSH prerequisites cause a skip, which is not successful SSH verification.

## Build from committed source and consume the archive

```sh
git clone https://github.com/tschk/roundhouse.git
cd roundhouse
git rev-parse HEAD
bun install --cwd npm --frozen-lockfile
bun run --cwd npm build
bun run --cwd npm typecheck
bun run --cwd npm test
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s executor -v
bun pm --cwd npm pack
bun run --cwd npm test:package
git diff --exit-code
```

Record the printed commit. For a reproducible release, check out the reviewed full commit ID before installing. This build uses the committed lockfiles and published `rx4 = "=0.8.0"`. It does not modify dependency manifests or resolve a sibling Rotary checkout.

Expected results are six npm tests and seventeen executor tests passing, with no SSH skip on a fully prepared host. `test:package` prints `Installed client and Rotary Wasm exports passed`, runs the Worker suites against the fresh archive installation, then prints `Packed consumer passed`. The final Git command must show no tracked-source changes. An exit code of zero without the expected assertions or with skipped SSH is not equivalent evidence.

The archive is `npm/tschk-roundhouse-0.2.0.tgz`. Install it from another application with:

```sh
bun add /absolute/path/to/tschk-roundhouse-0.2.0.tgz
```

The archive contains compiled JS, declarations, Wasm, matching MPL-covered portable Rust source, and dependency notices. Installing or using it does not require Rust. It does not contain the Python executor, a deployed controller, credentials, or a hosted application. The `0.2.0` manifest version is not a registry release or a unique source identifier. Retain the source commit and archive checksum with a release.

Import `RoundhouseClient` from `@tschk/roundhouse` in server-side JS. Import `core` from `@tschk/roundhouse/node` in Node or Bun. The `@tschk/roundhouse/workers` export belongs in workerd, not a Node process. See the [package API and configuration](https://github.com/tschk/roundhouse/blob/main/npm/README.md).

## Configure a Workers deployment

Do this only after the operator approves the target account, deployment, and application authority. Use a dedicated provider key and provider-side spending cap. Local reservations are admission accounting, not an invoice limit.

The deployed ES-module layout must retain these paths:

```text
worker.js                       exports default and Roundhouse from ./dist/workers.js
dist/workers.js                 installed package's dist/workers.js
wasm/roundhouse_core_bg.wasm     installed package's wasm/roundhouse_core_bg.wasm
```

The entry module is:

```js
export { default, Roundhouse } from "./dist/workers.js";
```

Upload the Wasm file as `application/wasm` and both JS files as ES modules. Do not runtime-fetch Wasm, convert it into a JS buffer, or move it without preserving the relative import. Configure compatibility date `2026-11-15`, a SQLite Durable Object migration for class `Roundhouse`, and its binding named `ROUNDHOUSE`. The configuration binding `ROUNDHOUSE_CONFIG` is a JSON string matching the [package example](https://github.com/tschk/roundhouse/blob/main/npm/README.md#deploy-the-workers-host). It must not contain secret values. Choose supported model identifiers with tool calling enabled.

Required secret binding names are `PROVIDER_API_KEY`, `OPERATOR_TOKEN`, and a distinct `EVENT_TOKEN`. Optional names are `APPLICATION_TOKEN` for fixed diagnostic/recovery endpoints and `EXECUTOR_TOKEN` for `remote_exec`. Provider integrations use their own [connection secret names](https://github.com/tschk/roundhouse/blob/main/docs/integrations.md). Configure secrets through the deployment platform's secret manager. Do not put them in source, command arguments, reports, URLs, tool descriptions, or virtual files. Never give a Worker the executor's recovery token or SSH private key.

Use separate deployments and provider keys for distinct authority scopes. Expose the API only through TLS and intended network access. Review the configured health, diagnostics, action endpoints, and exact web-fetch destinations before injecting credentials. Do not send customer diagnostics to a model unless approved for that provider.

For an already authorized **disposable Cloudflare test account**, the existing [test deployment helper](https://github.com/tschk/roundhouse/blob/main/npm/README.md#exercise-a-disposable-deployment) uploads this module layout and records unique test deployment IDs. It requires `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID_UNDIVISIBLE`, and optionally `ANTHROPIC_API_KEY` for real-model mode. It creates external resources and is not part of the local setup command sequence. Do not adapt it to an existing production Worker by changing its name guards.

## Start, approve, and verify monitoring

These are HTTP operations against your explicitly authorized deployment, not shell commands containing tokens. Supply bearer headers through a server-side client or your secret manager:

1. Read public `GET /healthz`. Expect the Rotary runtime identity. This reports controller liveness, not monitored-application health.
2. With `OPERATOR_TOKEN`, read `GET /v1/status`. A new Worker reports `enabled: false`.
3. Send operator-authenticated `POST /v1/start` with `{}`. Expect `enabled: true`. Durable Object alarms now drive checks without a connected client.
4. With `EVENT_TOKEN`, send `POST /v1/events` with `{"monitor":"application"}` and a fresh `Idempotency-Key`. Reusing a key returns the same incident. Never put executable instructions in an event.
5. Read operator-authenticated `GET /v1/incidents` and the selected `/v1/incidents/{id}`. Review evidence and the actual pending operation before approving anything.
6. For a legacy recovery endpoint, send `POST /v1/incidents/{id}/approve` with `{"action":"configured_action_name"}`. For a registered privileged tool, read `GET /v1/invocations`, review its exact stored arguments and digest, and send `POST /v1/invocations/{id}/approve` with only `{"digest":"the_reviewed_digest"}`. Do not substitute the name-only approval for a tool invocation.
7. Check the independent health probe and persisted outcome. HTTP 202 or a successful tool return is not recovery. The incident resolves only after a successful probe.
8. To disable future checks, send operator-authenticated `POST /v1/stop` with `{}`. Expect `enabled: false`. Check `in_flight` and reconcile any already claimed action instead of assuming stop cancelled external work.

Set `auto_approve: true` on an authorized action or privileged tool to execute automatically, including production. Omitted or false keeps approval enabled for existing configurations. New managed workspaces default automatic; toggle **Require approval** in Settings. Mismatched, expired, repeated, or changed-configuration approvals fail closed. Unknown outcomes require inspecting the receiver's idempotency journal, not replaying commands.

## Add real commands and independent recovery

Follow the [executor installation and recovery guide](https://github.com/tschk/roundhouse/blob/main/executor/README.md#install-on-an-always-on-linux-host) and reviewed templates under `deploy/executor/`. They cover persistent state, dedicated service identity, separate supervised listeners, cgroup limits, TLS proxying, and a local rehearsal. Do not install or start those services on a development orb as a production substitute.

The agent listener runs approved commands in mandatory bubblewrap. It cannot see the host filesystem, network, provider keys, or recovery store. The separate recovery listener and offline CLI work without the Worker or model. Both host processes share the executor UID, so they are not isolated from a compromised host process under that identity.

Rollback restores retained workspace bytes and modes. It does not restart a deployed controller, reverse database writes, undo messages, or compensate remote SSH effects. Retain the previous executable release and deploy configuration outside agent-writable state. A separately authorized supervisor must restore and probe deployments. Optional SSH requires fixed target configuration, pinned host keys, a separate key, and a restricted remote receiver. No production target is preconfigured.

Before unattended use, configure hard aggregate cgroup and filesystem quotas, storage alerts, backups, and retention. The executor's file-size polling is not a hard disk quota. Virtual workspaces stop at 64 versions; incident history, native versions, claims, and reservations need separate storage planning. Do not delete authority records or reset the database to evade limits.

Keep the executor recovery listener private. Forward only `/execute` over an authenticated TLS or private connection from the controller. Set network/firewall egress outside application code. Exact HTTPS fetch allowlists are for trusted stable destinations and cannot defeat DNS rebinding alone. Custom adapters run as trusted Worker code and must preserve these authority boundaries.

## Verify a complete application loop

The [Facetime draft demo](https://github.com/cherthq/facetime/tree/feat/roundhouse-isolated-demo/examples/roundhouse-demo) fetches an immutable Roundhouse commit and runs a disposable queue application. Its README covers clean-clone setup, `prepare:runtime`, `test`, `demo`, `test:sandbox`, `test:executor`, reports, and cleanup.

Credential-free fixtures exercise actual alarms, Rotary Wasm, durable approval after eviction, six independently checked job hashes, virtual pipelines, failed-write discard, stale-restore rejection, real bubblewrap execution, independent health verification, and offline rollback. They prove execution and policy, not model intelligence. Live-model mode is separate and requires `ANTHROPIC_API_KEY`; authenticated telemetry-provider reads and real remote SSH targets also require their own credentialed verification.

## Troubleshoot and clean up

- If preparation cannot fetch source, verify GitHub access and the pinned commit. Do not substitute a sibling checkout or rewrite the dependency manifest.
- If wasm-bindgen reports a version mismatch, use exactly `0.2.130` with the selected toolchain. If license copying fails, install `rust-docs`. Do not suppress license collection.
- If the Worker cannot import Wasm, preserve the module layout above. Local Miniflare uses its supported date `2026-08-06`, while the tested cloud module uses `2026-11-15`.
- If native execution fails its sandbox preflight, fix the disposable host's namespace support. Never switch to an unsandboxed shell. If SSH skips, check `sshd`, `/run/sshd`, and fixture sudo access before claiming SSH coverage.
- If an approval returns 409, reread the current invocation and incident. Check digest, expiry, configuration, and whether it was consumed. Never regenerate authority by clearing SQLite records.
- If a limit blocks investigation, read status budgets and retained history. Increase limits only under the intended spending authority. A provider error still consumes its reservation.

Local test commands dispose their runtimes and temporary execution state in `finally` cleanup. `test:package` removes its fresh installed consumer. Build outputs remain ignored under `npm/dist`, `npm/wasm`, `npm/rust`, `npm/licenses`, and the tarball. Cargo caches and targets remain for subsequent builds. Do not run blanket cleanup commands in a working checkout containing user data.

To retire a real deployment, stop monitoring first, reconcile claimed operations, and export required evidence. Delete only explicitly approved test resources after retaining recovery material. Deleting a Worker or its state is not rollback. No production credentials, hosting, DNS, certificates, firewall rules, access grants, or provider budgets are created by this guide.

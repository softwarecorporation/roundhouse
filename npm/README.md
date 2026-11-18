# Roundhouse JavaScript and Workers package

This source package includes an API client and a Rust/Wasm Cloudflare Workers host. It does not wrap Docker or start a process on your laptop. Deploy the host once, configure secret bindings, then enable its Durable Object alarm scheduler.

The native Linux server embeds Rotary's native agent. Workers embeds the actual `rx4::lite::Agent`, with shared Rotary permissions and redaction. Roundhouse owns the host I/O and recovery policy, not a duplicate provider-conversation driver. See `UPSTREAM.md`. This package is not published to npm yet.

## Build and pack

Building requires Bun 1.4.4, Rust 1.100 with its documentation component, the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` 0.2.130. Full tests additionally require Linux, Python 3, bubblewrap, OpenSSH server, and working unprivileged user namespaces. See the [setup guide](https://github.com/tschk/roundhouse/blob/main/docs/setup.md) for prerequisites and secure hosting.

From the repository root:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
bun install --cwd npm --frozen-lockfile
bun run --cwd npm build
bun run --cwd npm typecheck
bun run --cwd npm test
bun pm --cwd npm pack
bun run --cwd npm test:package
```

Install the resulting tarball into a consumer with `bun add /path/to/tschk-roundhouse-0.2.0.tgz`. Consumers do not need Rust, wasm-bindgen, Python, or bubblewrap unless they rebuild or run the separate native executor. The package includes precompiled Wasm, declarations, the matching portable Rust source in `rust/`, and dependency notices in `licenses/`. The virtual shell interpreter and its JavaScript dependencies are bundled into the Worker. No external npm dependency resolution is needed at runtime.

`test:package` installs that archive into a fresh directory, checks imports and declarations through the installed package exports, and runs the Worker suites against its installed JS and Wasm. It does not publish or deploy anything. An optional first argument selects another tarball. Successful runs remove their disposable consumer directory.

See the [operations tool reference](https://github.com/tschk/roundhouse/blob/main/docs/tools.md) for the extensible catalog, virtual Bash, restricted fetch, exact privileged approvals, Linux execution, and rollback boundaries. The original recovery demo remains a test, not a capability ceiling.

## Use the client

```js
import { RoundhouseClient } from "@tschk/roundhouse";

const events = new RoundhouseClient({ url: process.env.ROUNDHOUSE_URL, token: process.env.EVENT_TOKEN });
await events.capture([{
	id: crypto.randomUUID(), service: "application", kind: "event", name: "job.queued",
	distinct_id: "worker", timestamp: Date.now(), properties: { environment: "staging" },
}]);
await events.event("application", crypto.randomUUID());

const operator = new RoundhouseClient({ url: process.env.ROUNDHOUSE_URL, token: process.env.OPERATOR_TOKEN });
const incidents = await operator.incidents();
```

Keep operator tokens server-side. The event client cannot read incidents or approve actions. `capture` only adds evidence; `event` requests an investigation for an existing monitor. API responses are `unknown` because the client also supports the separately versioned native host. Native does not expose Workers telemetry routes.

`telemetry` accepts the returned page's `before` and `cursor` values as strings, alongside the original time window and filters, to read subsequent pages. Optional filter values set to `undefined` are omitted. Telemetry batches containing credential-bearing object keys are rejected rather than silently renaming keys and risking collisions.

`@tschk/roundhouse/node` exports the Rust driver for Node and Bun. `@tschk/roundhouse/core` initializes a precompiled WebAssembly module in Workers-compatible bundlers. These are the same Rust contracts, not schedulers or credential stores.

## Deploy the Workers host

Your Worker entry module exports the runtime:

```js
export { default, Roundhouse } from "@tschk/roundhouse/workers";
```

Bundle this entry as an ES module and retain the external `wasm/roundhouse_core_bg.wasm` module with its relative import path. Do not runtime-fetch or compile a Wasm binary. Configure:

- Compatibility date `2026-11-15` for the tested cloud deployment.
- A SQLite Durable Object migration for class `Roundhouse`, bound as `ROUNDHOUSE`.
- `ROUNDHOUSE_CONFIG` containing JSON matching `src/types.ts` and the example below.
- Secret bindings `PROVIDER_API_KEY`, `OPERATOR_TOKEN`, and distinct `EVENT_TOKEN`.
- Optional secret `APPLICATION_TOKEN`, attached only to configured diagnostic and recovery endpoints, never provider telemetry reads.
- Optional secret `EXECUTOR_TOKEN`, attached only to the configured `remote_exec` endpoint. Keep its separate recovery credential off the Worker.
- Optional `CONNECTIONS_JSON` and dedicated provider credentials from the [connection guide](https://github.com/tschk/roundhouse/blob/main/docs/integrations.md).

Enable Workers logs and traces in your deployment settings. Do not log bindings or request Authorization headers. A deployment is disabled until an operator calls `POST /v1/start` with bearer authentication. `POST /v1/stop` disables future work and deletes its alarm. An in-flight provider call can finish, but a stop before an action claim prevents the action.

```json
{
	"provider": { "kind": "anthropic", "base_url": "https://api.anthropic.com/v1", "model": "claude-haiku-5-5", "max_output_tokens": 2048 },
	"limits": { "daily_budget_microusd": 1000000, "reserve_per_request_microusd": 100000, "daily_requests": 10, "requests_per_incident": 4, "daily_actions": 1, "investigation_timeout_seconds": 90 },
	"monitors": [{
		"id": "application", "health_url": "https://app.example/health", "interval_seconds": 60,
		"timeout_seconds": 5, "expected_status": 200, "environment": "production",
		"diagnostics": [{ "name": "worker", "url": "https://app.example/worker/status" }],
		"actions": [{ "name": "restart_worker", "description": "Restart the stopped application worker", "url": "https://app.example/worker/restart", "auto_approve": true }]
	}]
}
```

`openai_compatible` uses non-streaming `/chat/completions` with tool calls. Anthropic uses `/messages`. Set provider-side hard spending limits: micro-USD reservations control request admission, **not the provider invoice**. Output token caps, request limits, deadlines, and action limits add separate bounds.

The controller owns one deployment's incident database, global daily budget, and serial investigation. Use separate deployments for untrusted tenants or distinct provider accounts. Shared bearer roles are not multi-user RBAC. Configuration is operator-trusted; configure only endpoints that may receive the associated secret.

## Exercise a disposable deployment

The repository's `examples/worker-test/deploy.py` creates uniquely named test Workers through the Cloudflare REST API. It refuses to overwrite an existing Worker. It needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID_UNDIVISIBLE`, and, for a real-model run, `ANTHROPIC_API_KEY`. This helper targets the authorized personal test account, not arbitrary production infrastructure.

```sh
python3 examples/worker-test/deploy.py --fixture
python3 examples/worker-test/verify.py
# With explicit test-deployment authority and a dedicated Anthropic key:
python3 examples/worker-test/deploy.py
python3 examples/worker-test/verify.py --leave-running
```

The application has a stopped worker and three pending SHA-256 jobs. Verification asserts initial 503, scheduled detection without event enqueue, model investigation, one named restart, three correct job hashes, independent 200, and an exact-approval production-labelled test. Both applications are disposable; no actual production system is managed. The fixture mode verifies plumbing, not model reasoning.

Generated tokens live only in Git-ignored `.roundhouse-test-secrets.json` with mode 0600. Back them up in your secret manager if you keep the deployment. `verify.py` stops monitoring on failure and by default after success. `--leave-running` preserves scheduled monitoring. Stop a retained test through its authenticated `/v1/stop`; delete only the named disposable Workers through your Cloudflare account when no longer needed. Deleting the Workers can lose their test data and is not a production rollback.

## Operational limits

Only fresh successful probes resolve incidents. An accepted recovery POST or a provider webhook claiming resolution does not. Explicit `auto_approve: true` authorizes configured actions or privileged tools automatically. Omitted or false preserves manual approval, bound to an incident and configuration. Action claims and reservations persist before external I/O. Uncertain actions are not replayed. Restart interrupts investigation into `needs_attention` rather than reissuing side effects.

Alarms wake at roughly five-second intervals while enabled; monitor intervals are lower bounds, not timing SLAs. Probes and investigation are serial in one controller, so a long investigation delays other checks. There is no multi-region quorum, missed-check SLA calculation, automatic investigation retry, unrestricted network tool, or high-availability scheduler. Virtual Bash is an interpreter, not a native shell. Real Bash requires the separate Linux executor and configured automatic authority or exact privileged approval.

Local telemetry is capped at 100,000 records and 30 days, with exact-match queries and bounded aggregates. Probe history retains 10,000 observations. Incident history and action/budget records grow independently and require operator storage planning. There is no PostHog/Better Stack parity, session replay, OTLP receiver, counter/histogram support, or percentile inference. See the [coverage reference](https://github.com/tschk/roundhouse/blob/main/docs/observability.md).

Local tests run actual workerd, SQLite Durable Objects, and compiled Wasm, with fixture outbound provider APIs. The latest available Miniflare package supports compatibility date `2026-08-06`; cloud smoke tests use `2026-11-15`. External provider fixtures are not live account verification.

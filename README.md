# Roundhouse

Always-on agentic operations built on [Rotary](https://github.com/tschk/rotary). Roundhouse watches configured HTTP health endpoints, investigates failures with your model, and requests named recovery actions. Only independent health checks can resolve an incident.

Run it on a Linux server with persistent storage and a supervisor. No laptop, interactive agent session, or desktop connection is required. This is an API-first initial implementation, not a dashboard or a managed hosting service.

## What works

- Interval-based health checks and authenticated, idempotent event intake.
- SQLite incident history, investigation summaries, evidence, request reservations, approvals, and action outcomes across restarts.
- Rotary's actual agent loop, provider clients, scope filtering, tool registry, and permission gates. The dependency is pinned to an inspected commit.
- Two model tools: `inspect_system` and `request_recovery`. No shell, filesystem, arbitrary HTTP, MCP, or subagent tools.
- Separate event and operator credentials. Event credentials cannot read incident history or authorize recovery.
- Production recovery requires a single-use approval for the exact incident and named action. Configuration rejects production auto-approval.
- Persistent daily request and action limits, per-incident request limits, a request-reservation budget, context size limits, and investigation deadlines.
- One action attempt per incident, committed before network I/O. Unknown outcomes and interrupted investigations require operator reconciliation, not blind retries.
- A real-model demo against an isolated HTTP application, plus credential-free end-to-end failure tests.

## Build and test

Requires Rust 1.100, a C compiler for bundled SQLite, and Python 3 for the integration tests.

```sh
cargo build --locked
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
python3 tests/e2e.py
```

The Python suite starts the real Roundhouse binary and an HTTP application. Its scripted SSE provider exercises Rotary's real provider/tool path without a paid account. It does **not** test model intelligence. To test a real model, see [the live demo](examples/live_demo.py):

```sh
export ROUNDHOUSE_DEMO_KIND=anthropic
export ROUNDHOUSE_DEMO_BASE_URL=https://api.anthropic.com/v1
export ROUNDHOUSE_DEMO_MODEL=claude-haiku-5-5
export ROUNDHOUSE_DEMO_KEY_ENV=ANTHROPIC_API_KEY
python3 examples/live_demo.py
python3 examples/live_demo.py --require-approval
```

Set the API key in the named environment variable through your secret manager. The demo authorizes only a disposable test application's restart endpoint. It asserts HTTP 503 → model investigation → one recovery request → independently verified HTTP 200, and prints a redacted incident timeline. `--require-approval` labels the isolated monitor as production, checks that no action runs before approval, and submits one operator approval through the API. It does not contact a real production application.

## Configure an application

Copy `roundhouse.example.json` to a private configuration file. Replace the example health, diagnostic, and recovery URLs. Each monitor identifies one application or subsystem.

The provider configuration names a model, a base URL, and an environment variable containing the key:

- `openai_compatible`: an endpoint implementing streaming `/chat/completions` and tool calls, such as OpenAI or OpenRouter. Include `/v1` or the provider's equivalent in `base_url`.
- `anthropic`: Rotary's native Messages API adapter. Set `base_url` to `https://api.anthropic.com/v1` and use a supported Claude model ID.

Compatibility is not a claim that every provider or model has been tested. Configure a model with tool-call support. Local HTTP endpoints are allowed only on loopback. Remote endpoints require HTTPS. URLs cannot contain embedded credentials, query strings, or fragments.

Secrets are supplied only through environment variables. `ROUNDHOUSE_OPERATOR_TOKEN` and `ROUNDHOUSE_EVENT_TOKEN` must be distinct. Optional diagnostic and recovery credentials use `token_env` and are attached as bearer headers; omit `token_env` for an endpoint without authentication. Configuration never contains secret values.

Recovery actions are fixed POST endpoints controlled by the operator. The model supplies only an allowed action name, never a URL, command, or arbitrary request body. Roundhouse sends `{"incident_id":"…"}` and `Idempotency-Key: <incident-id>:<action-name>`. Implement idempotency in the receiving service too. An HTTP 2xx means accepted, not recovered.

Diagnostics are GET endpoints. Roundhouse reads at most 4 KiB from each response, redacts configured credential values and common secret patterns, and treats the result as untrusted evidence. Only expose diagnostic data you are willing to send to your model provider. Pattern redaction cannot guarantee removal of unknown secrets or personal data.

## Operate the API

`/healthz` is unauthenticated liveness, not a claim that every monitored application is healthy. All `/v1` endpoints require bearer authentication. Put the API behind TLS or keep it on a private network. The example server binds loopback.

- `GET /v1/incidents` with the operator token returns the latest 200 incidents, newest first.
- `GET /v1/incidents/{id}` with the operator token returns the persisted audit timeline.
- `POST /v1/events` with the event token accepts `{"monitor":"application"}` and requires an `Idempotency-Key` header (1–128 bytes). Duplicate keys return the same incident, including after restart. Unknown monitors are rejected. Events carry no executable instructions.
- `POST /v1/incidents/{id}/approve` with the operator token accepts `{"action":"restart_worker"}` only when that exact action is pending. Mismatched, repeated, or stale approvals return HTTP 409.

Incident states are `queued`, `investigating`, `awaiting_approval`, `needs_attention`, and `resolved`. One active incident per monitor coalesces repeated failures and events. A healthy observation after manual recovery resolves an incident awaiting approval or operator attention. A model's recovery claim cannot resolve it.

Healthy checks never invoke a model. Investigations run serially while the scheduler and API remain available. A monitor interval is a minimum delay after its preceding probe, not a wall-clock cron schedule; probes currently run serially. Size the monitor set and timeouts accordingly.

## Understand the spending boundary

Amounts are integer micro-USD: 1,000,000 = USD 1. Before every provider call, Roundhouse atomically reserves `reserve_per_request_microusd`. It refuses new calls beyond `daily_budget_microusd`, `daily_requests`, or `requests_per_incident`. Reservations are not refunded on errors or restart. Daily limits reset at midnight **UTC**, not the host or user's local timezone.

**This is an admission budget, not a guaranteed provider invoice cap.** Rotary's provider adapter does not expose a uniform hard per-call output cap. The configured reservation is operator-supplied and may understate a model's charge. Set a hard provider-account or gateway spending limit, use a dedicated limited key, and choose a conservative per-request reservation before unattended operation. Roundhouse cannot enforce limits on provider-side retries, billing policies, or other users of the same key. No claim of hard dollar isolation is made.

An incident's request limit includes its approved follow-up investigation. Leave enough requests for that follow-up. If the allowance runs out, the incident remains unresolved until external recovery is observed.

## Deploy on a server

See [the server deployment guide](deploy/README.md) for a systemd service and a hardened Docker Compose option. Both restart without a laptop and persist SQLite outside the process. A file lock prevents a second Roundhouse instance from opening the same database through the same path. Run one replica on local persistent storage, not a shared network filesystem.

No production target or credentials are configured in this repository. Deployment and production action authority remain operator decisions.

## Boundaries of this release

- No vendor-specific AWS, Kubernetes, Cloudflare, database, paging, or chat integrations. A service-specific adapter can expose a narrow authenticated recovery endpoint, but it must be configured and tested separately.
- No general arbitrary action executor, automatic rollback, dependency graph, consecutive-failure threshold, distributed scheduler, or high availability.
- No automatic investigation retry after `needs_attention`. The service keeps probing and detects external recovery. This avoids expensive loops and replay after uncertain changes.
- The API has two shared-token roles, not multi-user identity or a tamper-proof audit service. Keep operator tokens away from webhook senders and the model. OS or database administrators remain trusted.
- SQLite history grows until the operator archives it. Back up the database with SQLite's backup API or stop the service before copying all its files. Do not delete action or reservation history to bypass safety limits.
- Endpoint correctness and credential scopes are the operator's responsibility. Prompt injection cannot expand the registered tools, but could still influence which preauthorized test or staging action a model selects.

## License

MPL-2.0, matching Rotary. Rotary remains an unmodified pinned dependency; no engine source is copied into Roundhouse.

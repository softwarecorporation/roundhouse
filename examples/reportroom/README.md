# Run Reportroom, a monitored demo SaaS

Reportroom is a small sales-reporting application with a web UI, a real SQLite-backed export queue, downloadable CSV files, and Roundhouse monitoring. Its orders are synthetic. Its jobs, HTTP requests, alarms, report calculations, hashes, approvals, and incident history are real local execution.

The default provider is a deterministic fixture with no paid credentials. It follows the actual Rotary tool protocol but does not demonstrate model intelligence. Optional Anthropic mode calls a real model explicitly. There are no customer accounts, payments, emails, production targets, or connected shop integrations.

## Install and launch

Use a development host with Bun **1.4.4**, Rust **1.100.0**, and a C build toolchain. Local workerd supports Linux and macOS. The verified environment is a Linux orb. Native executor, Python, bubblewrap, SSH, Docker, and Cloudflare credentials are not required for this example.

If the Rust Wasm tools are missing, prepare them with rustup already installed:

```sh
. "$HOME/.cargo/env"
rustup toolchain install 1.100.0
rustup target add --toolchain 1.100.0 wasm32-unknown-unknown
rustup component add --toolchain 1.100.0 rust-docs
export RUSTUP_TOOLCHAIN=1.100.0
cargo install wasm-bindgen-cli --version 0.2.130 --locked
```

From a clean Roundhouse checkout:

```sh
bun install --cwd examples/reportroom --frozen-lockfile
bun run --cwd examples/reportroom prepare:runtime
bun run --cwd examples/reportroom start
```

Preparation builds the repository's own `npm` package and actual Rotary `rx4 = "=0.8.0"` Rust/Wasm core using committed lockfiles. No Facetime checkout, registry publication, manifest rewrite, or sibling-source override is involved. First-time preparation downloads dependencies. Subsequent launches use the compiled runtime without Rust.

Expect `Reportroom ready on port 3200. Provider mode: fixture. Synthetic data only.` Open port 3200 on that development host. The default listener is loopback-only. In an Amp orb, expose it through the orb's portal mechanism rather than sharing a sandbox-local URL. `PORT` changes the port; set `HOST=0.0.0.0` only for an explicitly intended development container or access-controlled portal. This is a single-user demo, not a publicly authenticated SaaS.

## Use the reporting workspace

1. Name your workspace. The hosted version creates an isolated guest tenant; standalone runs one local workspace.
2. Name a report, choose seven or thirty days, and group by day or week. **Generate report** queues real asynchronous work.
3. Open the completed report for its preview, totals, CSV download and SHA-256. History stays in SQLite.
4. Open **Sales overview** for seeded revenue, daily sales and recent orders. All 165 orders are explicitly synthetic.
5. Save the workspace name and report defaults in **Preferences**. Reload to confirm persistence. **Clear reports** removes reports, not preferences or incident history.

## Optional recovery test

Open **Roundhouse**, start monitoring if needed, then **Pause worker**. Rotary inspects the actual queue and requests only the configured `resume_exports` action. New workspaces execute automatically within their limits. A later independent healthy probe resolves the incident, not the recovery HTTP response.

Managed **Recovery drill → Require approval** enables a human gate. Existing initialized controllers without a saved policy retain manual behavior. The standalone `createRuntime({ requireApproval: true })` option selects manual mode for a fresh database; persisted policy wins on restart. Manual mode waits without acting until **Approve recovery**. Duplicate or stale approvals are rejected.

Ordinary report generation does not trigger a failure. The injected fault is explicit and limited to synthetic state. Reset is a manual demo operation, not a production rollback or a way to reset spending allowances. Capacity is bounded to 25 report jobs. Reset reports when that limit is reached.

## Verify from the command line

After preparation:

```sh
bun run --cwd examples/reportroom test
```

The suite uses actual workerd and SQLite. It checks onboarding preferences and reopen persistence, daily/weekly calculations, exact CSVs and hashes, report history/detail, legacy migration, route/body/auth rejection, and durable explicit-approval recovery. `platform/policy.test.js` additionally covers automatic recovery, manual mode, legacy policy migration and independent verification. `platform/reporting.test.js` covers the authenticated SaaS journey and tenant isolation. Live-provider mode is not used by the suite. Missing live credentials fail rather than falling back to fixtures.

The integration test starts its own loopback HTTP server and temporary database, then disposes both. It does not interact with the web demo's `.data` directory. To verify the UI, also exercise the steps above in a browser; a build or unit-test pass alone does not establish rendered behavior.

## Use a live provider deliberately

Stop the demo first. Supply `ANTHROPIC_API_KEY` through your secret manager or execution environment, never through a source file or pasted command value. Then run:

```sh
DEMO_PROVIDER=anthropic bun run --cwd examples/reportroom start
```

`DEMO_MODEL` optionally changes the model from `claude-haiku-5-5`. A model must support tool calls. The UI explicitly identifies live mode. It sends only this synthetic application's diagnostics to `https://api.anthropic.com/v1/messages`. Provider failures and exhausted allowances remain unresolved; there is no fixture fallback. Changing model/provider changes the configuration fingerprint and invalidates pending authority. Finish or manually reset a drill before changing mode.

Limits are twenty provider requests per UTC day, four per incident, five action claims per UTC day, 1,024 output tokens per request, and thirty seconds per investigation. Each admitted request reserves 25,000 micro-USD against a 500,000-micro-USD admission budget. This is **not a guaranteed $0.50 invoice cap**. Set a provider-side hard limit and use a dedicated limited key. Healthy checks do not call the provider. Provider usage counters are per process; durable budget counters survive restart. No live-provider run is required to use this example.

## Understand the boundaries

- `runtime.js` embeds the repository's real Roundhouse Worker and compiled Rotary Wasm. The application and controller have separate SQLite Durable Objects. Application egress is denied. Controller egress is restricted to the synthetic app and, only in live mode, the fixed Anthropic API.
- `app.js` owns synthetic orders, report jobs, alarm processing, fixed recovery, and idempotency claims. It is not a fake status screen. Its health remains unhealthy after accepted recovery until the queued report actually completes.
- `server.js` is a narrow backend-for-frontend. Operator, event, and application tokens are random server-side bindings, never browser code or configuration responses. There is no browser route to arbitrary Roundhouse endpoints, provider URLs, tools, or commands.
- Mutations require a non-safelisted `X-Reportroom-Demo` header and JSON. There is no cross-origin permission. This fences browser forms and cross-origin fetches; it is not user authentication. Anyone with network access to this demo can operate its synthetic workspace. Keep it on loopback or an access-controlled development portal.
- The action uses the tested named-HTTP recovery adapter. It does not run a native shell, SSH, or the separate Linux executor. See the [tool reference](../../docs/tools.md) for those opt-in capabilities and their authority requirements.
- The scheduler runs while this local process and host remain available. A laptop-hosted demo stops when the laptop stops. Actual always-on operation needs a separately authorized Workers or supervised server deployment. This example performs neither.

## Stop, retain evidence, and clean up

Press Ctrl+C for the foreground process, or stop its supervised orb service. Shutdown disables monitoring and disposes workerd. Persistent demo state lives only in ignored `examples/reportroom/.data/`; reports, pending approvals, histories, claims, and budget reservations survive a normal restart. The current UI displays the ten newest incidents and bounded event/probe observations, not an unlimited audit search.

**Reset reports** intentionally retains authority and history. Do not delete the database to bypass allowances. To retire this disposable workspace completely, stop the process, retain any CSV/evidence you need, confirm `.data` is the example's real directory and contains only demo state, then remove only that reviewed directory. Do not use blanket `git clean` or recursive cleanup against an unreviewed path. Retaining `.data` is safe if you plan to resume.

Tests clean their own temporary state. Dependency and Rust build caches remain for reuse. Source is MPL-2.0, matching Roundhouse; the existing package build supplies matching Rust source and dependency notices. No per-Mac installation, billing change, access grant, registry release, or production deployment is part of this example.

## Troubleshoot

- If the runtime is missing, run `prepare:runtime`, not only the example's Bun install.
- If wasm-bindgen versions differ, use exactly `0.2.130`. If license collection fails, install `rust-docs` for the selected toolchain.
- If port 3200 is occupied, choose another `PORT`; do not stop an unrelated process.
- If a drill remains `needs_attention`, inspect the incident timeline and daily limits. The fixture still obeys the same allowances. Reset reports can repair the synthetic worker manually, but it cannot erase claims or refund reservations.
- If a live investigation fails, check credential presence, model availability, and provider limits without logging key values. Default fixture mode needs no key.
- If a browser mutation is rejected, use the page's controls. Do not expose the raw internal Miniflare port or add permissive CORS as a workaround.

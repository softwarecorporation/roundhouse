# Run the Roundhouse platform

The platform runs on Cloudflare Workers, D1, and SQLite Durable Objects. No open laptop or persistent browser is required. Monitoring continues through Durable Object alarms. The browser polls snapshots; it does not run the scheduler.

The first managed release controls only synthetic Reportroom. Each authenticated tenant has a separate controller, app database, incident history, budget, analytics, logs, and status publication. Invited owners manage keys and provider mode. Guests get an isolated fixture-only session and a maximum 24-hour monitoring lease.

## Try the hosted service

Open [Roundhouse](https://roundhouse.tsc.hk/console?guest=1). Start monitoring, introduce a synthetic fault, and open Incidents. Read the inspection evidence, select the approval consent, and approve recovery. The queue alarm generates the CSV, then an independent health probe resolves the incident. Open [Reportroom](https://reportroom.roundhouse.tsc.hk) with the same session to download reports.

The deterministic fixture exercises the real agent protocol but does not demonstrate model intelligence. Owners can explicitly select Anthropic in Settings. The server uses its secret binding; this release does not collect customer provider keys in the browser. Live mode has ten daily requests, four requests per incident, three action claims, 1,024 maximum output tokens, a 30-second investigation deadline, and a $0.50 daily reservation allowance per controller. Reservations are admission accounting, not an invoice cap. Use dedicated provider-account limits as well.

## Run locally without credentials

Install Rust 1.100 with `wasm32-unknown-unknown`, wasm-bindgen-cli 0.2.130, Bun 1.4.4, and Node 22.18 or newer. Node hosts Miniflare and the Cloudflare CLI; Bun installs dependencies and runs project scripts.

```sh
bun install --cwd npm --frozen-lockfile
bun run --cwd npm build
bun install --cwd platform --frozen-lockfile
bun run --cwd platform build
bun run --cwd platform test
bun run --cwd platform dev
```

The last command serves the local console on port 3300. In an orb, use a supervised service and set `PUBLIC_ORIGIN` and `DEMO_ORIGIN` to the exact portal origin. Local fixture mode refuses external egress and never loads the provider key. State is stored in ignored `platform/.data`. The local registration invite is `local-development-only`; never use it for a public deployment.

## Deploy in your own Cloudflare account

The source is MPL-2.0 and has no Roundhouse license charge. Cloudflare quotas, hosting, browser use, and model usage are separate. This is not a promise of unlimited free hosting. Computer's optional Dynamic Worker and container backends require paid infrastructure and are not enabled here.

1. Copy `cloudflare.config.ts` and set your Worker name, domains, D1 name, trusted origins, and cookie domain. Update both Durable Object bindings to the Worker name. Never derive authentication links from forwarded headers.
2. Create a dedicated D1 database in that account. Set `ROUNDHOUSE_D1_ID` to its ID before the build. Apply `migrations/0001.sql` and `migrations/0002.sql` in order through D1's SQL migration tooling. Preserve the complete SQL trigger; do not split it at internal semicolons.
3. Configure a random `SETUP_INVITE` as a Worker secret. Optionally configure `ANTHROPIC_API_KEY` as a Worker secret. Never put either in Git, browser JavaScript, command-line arguments, screenshots, or build logs.
4. Run the build, tests, and `node node_modules/cf/bin/cf deploy --prebuilt --dry-run` from `platform`.
5. After reviewing the target account, bindings, and domain changes, deploy with `bun run deploy`. Use a trusted secret file with `--secrets-file` when creating the first version. Keep the file outside Git and remove it securely afterward.
6. Open the deployed page, create an invited account, run a fixture recovery drill, and confirm the health probe and CSV results. Only then enable a real provider for a bounded synthetic drill.

Roll back by activating the previous `roundhouse-platform` Worker version in Cloudflare. Stop affected controllers first if behavior is unsafe. Code rollback does not erase D1 data or reverse completed actions. For a first deployment with no previous version, remove only its custom-domain bindings to withdraw access; retain databases for inspection. Never delete shared storage to roll back code.

## Connect an agent and ingest evidence

Create a scoped key in Settings. Point a Streamable HTTP MCP client at `/mcp` with `Authorization: Bearer <key>`. This is stateless JSON-RPC with manual bearer authentication, not OAuth. Supported tools read systems, incidents, analytics, and logs, or start, stop, and request investigation. No MCP tool approves recovery, changes providers, publishes status, fetches arbitrary URLs, or runs shell commands.

`read`, `ingest`, and `control` are separate key scopes. Only authenticated browser sessions can approve their own synthetic recovery. Owner sessions alone administer keys and public status. Tenant IDs always come from authentication, never from ingestion payloads or tool arguments.

Send explicit JSON batches to `POST /api/ingest` using a server-side ingest key. The envelope is `{ "events": [...], "logs": [...] }`. Events require `id`, `kind` (`pageview` or `event`), `name`, and relative `path`. Logs require `id`, `service`, `level`, and `message`. Optional `at` is an ISO timestamp within one day; optional log `trace_id` correlates records. Exact replays are idempotent. Changed duplicate IDs reject the whole batch.

Limits: 50 records per 16 KiB batch, 1,000 records per UTC hour, 10,000 retained records per tenant, seven-day lazy retention, and bounded query/export results. Analytics and logs query the last 24 hours. No visitor identity, session replay, automatic instrumentation, or full-text archive is implied. Do not ingest credentials or personal data; arbitrary application log content cannot be guaranteed secret-free.

Owners can register an HTTPS site through `/api/sites`. Install `tracker.js` explicitly with `data-site` and `data-endpoint` pointing to the `/collect` base. Public collection accepts only origin-bound minimal events, has an additional 200/hour and 2,000-record site cap, and cannot submit logs or control instructions. It uses no cookies or persistent visitor IDs and respects Do Not Track and Global Privacy Control. Origin checking reduces accidental misuse; it is not proof that an event came from a human browser.

## Browser and execution boundaries

`POST /api/browser/evidence {}` is owner-only, limited to ten calls/hour, and explicitly selects `browser: "kitesurf"`. It renders server-generated synthetic health numbers, not an arbitrary URL, authenticated site, or customer DOM. The generated document contains no scripts and sets a deny-all Content Security Policy; no URLs or credentials are inserted, and network requests are rejected. Kitesurf does not implement the `setJavaScriptEnabled` Quick Action option, so this endpoint does not use it. Local mode fails closed because Kitesurf is unavailable in local workerd. There is no Chromium fallback. Browser failures do not assert recovery.

Kitesurf is experimental. Its Fetch interception can fail open; interception alone is not a network authority boundary. Arbitrary browsing remains disabled until final-transport egress enforcement is implemented and tested. See [reference and license notes](../docs/platform-references.md).

`@cloudflare/computer` was evaluated, not installed. Its durable workspace and stable Codemode APIs may be useful later. Experimental containers, replayable approval waits, and its Chrome-oriented browser adapter are not foundations of this release. The separate Roundhouse native executor remains opt-in; no customer shell or SSH access is exposed by the managed console.

## Security and operational limits

Passwords use salted PBKDF2-SHA256; D1 stores session and API-key hashes, not raw tokens. Cookies are Secure, HttpOnly, and SameSite=Lax. Mutations require same-origin requests and a non-safelisted header. Keys cannot grant `approve` or `admin`. Registration requires an operator-provisioned invitation. There is no email verification, password-reset service, billing, enterprise SSO, or account-management UI yet.

Public status pages are explicitly published operator updates, not computed uptime SLAs. No monitor automatically publishes an incident. Analytics and status are independently implemented small features, not drop-in Umami, PostHog, Better Stack, or OpenStatus compatibility.

Pending unknown action outcomes need operator reconciliation. The service never retries a claimed recovery blindly. General customer-system onboarding, per-user provider-key vaults, durable external browser sessions, arbitrary MCP servers, and unrestricted native execution are not part of this managed release.

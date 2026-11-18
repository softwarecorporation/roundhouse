# What Roundhouse can learn from Foglamp

Research date: 2026-11-18. Recommendation: add a bounded **investigation run view**, not a second observability platform. Make provider calls, tool outcomes, reservations, and independent verification legible in one place. Keep the product copy brief and recovery-first.

## Implemented follow-up

The comparison below records the inspected baseline. This wave adds owner-configured public HTTPS apps, per-action automatic/manual policy, scheduled and event-triggered execution, app-filtered incident history, and scoped MCP app selection. Real Miniflare tests exercise non-Reportroom recovery, tenant isolation, shared limits, restart persistence, redirects and credential boundaries.

Provider attempts now persist `provider_call` records with model, provider, start, duration, HTTP status, outcome and nullable reported token usage (`usage.input/output`). Eleven fixture scenarios cover both provider shapes, missing/invalid usage, HTTP errors, transport errors and timeout. No prompt/response capture or cost pricing is added. These records are available through tenant-scoped incident details; the console displays recorded evidence, not a Foglamp-style waterfall. Independent verification remains HTTP health verification, not response-quality evaluation.

Still missing: actual-cost pricing, agent-level rollups, response evals, threshold notification delivery, general distributed tracing and Vercel AI SDK instrumentation. No parity claim is made.

## Evidence and limits

Read the live [homepage](https://foglamp.dev), all six linked feature pages, the [documentation index](https://docs.foglamp.dev/llms.txt), SDK guides, dashboard guides, and ingest contract. Rendered the homepage in an isolated browser namespace, inspected its settled hero and cost section, recorded the visit, and closed both its tab and session. Reference screenshots and recording remain under `/home/user/workspace/.amp/in/orb-backup/foglamp-research/`, not user deliverables.

Foglamp findings below are advertised or documented capabilities, not independently exercised account features. No sign-up, paid model call, upstream source audit, or production request was performed. Roundhouse classifications come from the working-tree source, including concurrent uncommitted changes. No tests or builds were run for this research.

## Foglamp's advertised features and supported contracts

| Area | Advertised feature | Contract and qualification |
| --- | --- | --- |
| [Cost intelligence](https://foglamp.dev/features/cost-intelligence) | Cost per call, model, agent, workflow, and customer. | [Cost docs](https://docs.foglamp.dev/dashboard/cost.md): ingest-time pricing from reported usage, OpenRouter prices refreshed every 24 hours, stored costs never recomputed. Unknown prices remain unknown, not zero. Pricing source and percentage priced are exposed. The feature page mentions project overrides, but the cost guide does not explain their configuration. Attribution still requires the relevant SDK context. |
| [Distributed traces](https://foglamp.dev/features/distributed-traces) | A run waterfall with model and tool calls, prompts, responses, tokens, and cost. | [Trace guide](https://docs.foglamp.dev/dashboard/traces.md): parent-indented timing bars, filters, span inspector, scores, streaming replay, and provider signals. [SDK guide](https://docs.foglamp.dev/sdk/overview.md): a nested v7 model call inherits grouping context but remains its own trace, not a child span of the calling tool. This does not establish universal cross-service tracing or OTLP compatibility. |
| [Evals](https://foglamp.dev/features/evals) | Code checks and LLM judges on production traffic. | [Eval guide](https://docs.foglamp.dev/dashboard/evals.md): trace or span targets, agent/name/type/model filters, 1–100% sampling, deterministic presets such as JSON, non-empty, regex, PII, and secret patterns. These are documented presets, not evidence of arbitrary uploaded code execution. Judges use project-scoped, encrypted provider keys and report score, reason, pass rate, and judge spend. Without a usable key or server encryption configuration, judges do not run. Pattern checks are not a guarantee of privacy or correctness. |
| [Alerts](https://foglamp.dev/features/alerts) | Cost, latency, error, and eval thresholds with email or Slack. | [Alert guide](https://docs.foglamp.dev/dashboard/alerts.md): new-rule metrics are `cost`, `latency_p95`, `error_rate`, and `eval_pass_rate`; rolling windows are 5m, 15m, 1h, or 24h. Default sweep is 60s, repeated firing has a default 1h cooldown, and fired/resolved transitions persist. Email requires Resend configuration. **Slack is advertised but no setup or delivery contract is established by this guide.** |
| [Agents](https://foglamp.dev/features/agents) | Per-agent spend, latency, spans, and call flow. | [Agent guide](https://docs.foglamp.dev/dashboard/agents.md): spans, LLM spans, tokens, p95, cost, errors, trends, latest trace graph, recent runs, and inferred prompt versions. `agentName` supplies identity. Prompt versions require captured system prompts and can be regrouped as more runs arrive. Agents and workflows are separate dimensions. |
| [SDK](https://foglamp.dev/features/sdk) | Two-line instrumentation for Vercel AI SDK v4–v7. | [v7 collector](https://docs.foglamp.dev/sdk/overview.md) uses telemetry integrations. [v4–v6 wrapper](https://docs.foglamp.dev/sdk/wrap.md) wraps the `ai` module, with `with` and `run` context. Both cover text/object generation and agent classes. The [data model](https://docs.foglamp.dev/concepts/data-model.md) explicitly excludes useful embedding/rerank capture today, despite reserving an `embedding` span type. This is not automatic instrumentation of Roundhouse's direct Rotary/provider HTTP path. |

Additional contract details matter more than the short headline:

- **Identity:** each trace needs `traceName` or `agentName`. `workflowName` and `workflowRunId` must appear together. Sessions and customers are explicit optional grouping context, not automatically discovered identities. See [data model](https://docs.foglamp.dev/concepts/data-model.md).
- **Payload:** [ingest OpenAPI](https://docs.foglamp.dev/api-reference/openapi.json) describes `POST /ingest`, bearer or `x-api-key` authentication, `{version:"v1",traces:[...]}`, 1–1,000 traces, and 1–2,000 spans per trace. IDs are bounded strings, not required W3C hexadecimal IDs. Spans carry start/end milliseconds, model/provider, usage, optional text, and metadata. This is not Roundhouse's wire format.
- **Delivery:** [ingest reference](https://docs.foglamp.dev/api-reference/ingest/ingest-a-batch-of-traces.md) says `202` means accepted into memory, **not durable storage**. Default maximum body is 10 MiB. `429` with `Retry-After` means rate limit; quota exhaustion has no retry header. Shutdown can return `503`.
- **Privacy and loss:** [configuration](https://docs.foglamp.dev/sdk/configuration.md) captures input, output, and system prompts by default. Capture can be disabled without losing usage accounting. Default SDK text truncation is 100,000 characters per field; ingest caps each input/output at 1,000,000. Buffers are bounded, old traces can be dropped, and transport errors go to `onError`. Context validation can still throw. No key silently disables collection.
- **Runtime:** [flushing guide](https://docs.foglamp.dev/sdk/runtimes.md) requires Workers `ctx.waitUntil` or explicit flush; unflushed memory is lost. Node/Bun use a timer and shutdown drain. The page's overview suggests Lambda autodetection, while its concrete Lambda guidance says to await `flush()` before return. Follow the explicit example, not a blanket zero-setup claim.
- **Documentation drift:** the trace guide discusses `aborted` and `abandoned` states, but the published ingest span enum lists only `ok` and `error`. Do not invent a compatible wire encoding from the UI wording.

## Roundhouse: real, partial, or missing

**Real** means the source implements the stated smaller capability. **Partial** means relevant primitives exist, not Foglamp parity. **Missing** means no matching implementation was found in the inspected runtime and platform paths.

| Capability | npm Workers runtime | Managed platform |
| --- | --- | --- |
| Bounded evidence capture | **Real:** explicit events, logs, spans, and gauges. SQLite, 30-day retention, 100,000 records, atomic deduplication. | **Real, different contract:** D1 events/logs, 7-day lazy retention, 10,000 records per tenant. No public span or gauge ingest. |
| Cost intelligence | **Partial:** request admission uses fixed micro-USD reservations and daily request limits. No reported-token ledger or actual model pricing. | **Partial:** controller budgets surface reservations. They are not invoices, actual spend, or per-agent/customer cost analytics. |
| Distributed traces | **Partial:** explicit trace/span/parent IDs, durations, status, trace lookup. No automatic capture, waterfall, distributed reconstruction, or OTLP. | **Partial correlation only:** logs can carry `trace_id`; incident history records operations. No public span ingest or trace inspector. |
| Evals | **Missing:** no production-response scorer, sampling rules, judge-key vault, or score history. | **Missing:** independent HTTP recovery verification is real, but is not an answer-quality eval or LLM judge. |
| Alerts | **Partial:** scheduled health probes queue investigations. Not cost/p95/error/eval threshold rules or notification delivery. | **Partial:** autonomous monitoring and incident states are real. Published status updates are explicit operator messages, not automatic incident notifications. No Foglamp-style alert engine found. |
| Per-agent views | **Missing:** service and incident attribution exist, but no agent identity contract, token/cost rollups, or prompt versions. | **Missing:** tenant isolation and provider settings are not per-agent observability. |
| SDK integration | **Real:** API client, Workers controller, Rust/Wasm validation and provider protocol. **Missing:** AI SDK instrumentation integration. | **Real:** scoped keys, explicit ingest, bounded Streamable HTTP MCP tools. These do not instrument model calls automatically. |
| Existing providers | **Real, bounded adapters:** saved PostHog insight, Better Stack monitor, and fixed 15-minute log read. Fixture-tested, not live-delivery verified. | **Missing exposure:** inspected platform routes do not expose those configured connection reads as a managed integration UI. |
| Controlled recovery | **Real:** request/action limits, exact tool authority, persisted claims, policy-dependent approval, fresh health verification. | **Real:** isolated tenant controller and synthetic Reportroom recovery, with fixture-only guests. This is Roundhouse's distinction, not a Foglamp parity claim. |

### Source map

- [`npm/src/types.ts:51–57`](../npm/src/types.ts#L51-L57): current `Signal` union. Model identity, usage, agent identity, and costs are not typed fields.
- [`npm/src/telemetry.ts`](../npm/src/telemetry.ts): `TelemetryStore.capture`, `query`, `analytics`, and `evidence`. Analytics computes count, distinct actors, sum, mean, min, and max, not p95. Properties are not a cost aggregation engine.
- [`npm/src/workers.ts:167–179`](../npm/src/workers.ts#L167-L179): separate telemetry and connection routes. [`269–278`](../npm/src/workers.ts#L269-L278): `reserve` charges fixed admission reservations. [`332–349`](../npm/src/workers.ts#L332-L349): direct provider HTTP and `core.accept`, with no usage ledger.
- [`npm/src/connections.ts`](../npm/src/connections.ts): `parseConnections`, `readConnection`, and explicit receiver templates. No automatic polling, forwarding, Foglamp connection, or arbitrary upstream query.
- [`platform/index.js`](../platform/index.js): authenticated tenant routing and MCP tools. [`platform/data.js:72–90`](../platform/data.js#L72-L90): event/log contract; [`152–178`](../platform/data.js#L152-L178): pageview aggregates and bounded log filters, including substring matching.
- [`platform/controller.js:5–45`](../platform/controller.js#L5-L45): limits, synthetic target, and fixture/live provider transport. [`platform/README.md`](../platform/README.md) and [`docs/observability.md`](observability.md) document the distinct platform and npm contracts and their limits.
- Existing checks to extend, not results claimed here: [`npm/test/workers.test.ts`](../npm/test/workers.test.ts), [`platform/integration.test.js`](../platform/integration.test.js), [`platform/policy.test.js`](../platform/policy.test.js), and [`platform/data.test.js`](../platform/data.test.js).

## Recommended next increment: investigation runs

Choose a thin first-party view over general-purpose ingest or a Foglamp SDK dependency. Roundhouse already owns the request and tool execution boundaries. Its users first need to understand why recovery happened and whether it worked. This is an L-sized increment, roughly 1–2 days before pricing or broad external instrumentation.

1. **Persist bounded run steps.** In `npm/src/workers.ts`, extend the existing audit/read path around `investigate`, `providerFetch`, and `executeTool`. Record incident/run identity, stable step identity, start, duration, outcome, model/provider, and explicitly reported usage. Parse usage at the provider-response boundary before it is discarded, with tests in `npm/test/workers.test.ts` for Anthropic and OpenAI-compatible shapes, missing usage, timeout, and failure. Do not store prompts or responses by default. Do not mutate the generic `Signal` contract merely to smuggle run data through properties.
2. **Expose one tenant-scoped run detail.** Extend `platform/index.js`'s existing controller snapshot/detail pattern and its integration tests. Return bounded steps, current reservations, verification evidence, and `unknown` for missing usage. Prove tenant B cannot read tenant A's run. Preserve guest fixture-only mode, authority checks, and admission limits. Fixture usage must be labeled fixture, never evidence of real model economics.
3. **Draw the incident timeline.** Extend `platform/public/platform.js`, `console.html`, and `platform.css` with one compact, keyboard-accessible run panel. Show ordered model/tool/verification rows, measured duration, and explicit outcome. Show numeric detail on selection. Empty, ongoing, failed, and unknown-outcome states need text, not invented bars or zero values. Verify the fixture recovery end to end, approval-required behavior, narrow-screen scrolling, and unchanged analytics/reporting behavior.

Acceptance: a fixture recovery exposes its actual recorded calls and tools, the configured policy, the action outcome, and a later independent health observation. Reservations remain labeled **Reserved**, never **Spent**. The view remains useful without model text, pricing, or an external service.

Defer actual cost pricing, cross-run agent views, threshold notifications, and evals until these run records exist. A later pricing slice needs versioned rate provenance, cache-aware usage semantics, and unknown-price coverage before any spend chart. A later alert slice needs persistent fired/resolved transitions and no-data semantics before email or Slack claims. Recovery health checks should remain separate from optional answer-quality scores.

Alternative: keep Foglamp as an external observability system of record and add a deliberate export adapter later. That fits an existing customer Foglamp deployment, but requires ID translation, text/privacy choices, flush/loss semantics, and a real ingest compatibility test. Current PostHog/Better Stack connections neither provide that adapter nor prove Foglamp read-API availability.

## Graphics and brief copy

Borrow Foglamp's **information economy**, not its brand: one concrete promise, a product specimen that explains the mechanism, and short captions. Its live page uses large white type, dark surfaces, pill controls, overlapping product panels, three benefit-led feature sections, and animated specimens. Those samples are marketing illustrations, not evidence that Roundhouse has the same data.

Keep Roundhouse's existing [Signal desk direction](../DESIGN.md): Archivo, charcoal, restrained acid yellow, square controls, and the literal drawn roundhouse mark. Use a flat operational drawing of **Check → Investigate → Act → Verify**, with timestamped rows below it. For a real run, position bars only from measured start/duration. Mark waits, failures, and unknown outcomes with words and symbols as well as color. For a landing illustration, label it **Illustrative**. Do not show fake dollar totals, invented p95, customer logos, a copied mascot, stacked glass cards, glows, or decorative chart motion.

Suggested copy for existing behavior:

- Headline: **Keep systems running.**
- Supporting line: **Monitor. Investigate. Recover. Verify.**
- Action: **Open console**
- Mechanism labels: **Health check**, **Investigation**, **Recovery**, **Verification**.
- Runtime labels: **Requests**, **Reserved**, **Approval required**, **Verified healthy**, **Outcome unknown**.

Only add **Run details** when that view ships. Keep approval policy, synthetic scope, fixture mode, and reservation caveats beside the relevant control or value. No headline claims of automatic instrumentation, distributed traces, cost intelligence, evals, or alerts until their contracts and visible behavior exist.

Assumptions: first-party recovery remains the priority; no new paid service, universal telemetry backend, or Vercel AI SDK migration is intended. Existing explicit approval policies and tenant boundaries must remain unchanged.

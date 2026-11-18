# One platform for observability and recovery

Inspected official sites and documentation on 2026-11-18. Competitor capabilities below are documented claims, not independently tested accounts. This is a positioning comparison, not a compatibility promise.

Roundhouse's ambition is to consolidate the observability and operations stack. Today it is a smaller, working platform, not a drop-in replacement for every product below. “Never be on call again” describes the direction, not guaranteed autonomous reliability.

## What the reference products offer

| Product | Advertised positioning and capabilities | Sources |
| --- | --- | --- |
| Better Stack | “The AI SRE observability stack”: logs, tracing, error tracking, infrastructure, uptime, incident management, on-call, status pages, replay and product analytics. AI SRE can investigate and act, including validated code changes and pull requests. | [Homepage](https://betterstack.com), [AI SRE authority and MCP comparison](https://betterstack.com/docs/ai-sre/mcp-server-comparison/), [error-fix pull requests](https://betterstack.com/docs/ai-sre/writing-code/error-pull-requests/) |
| PostHog | “Your product’s context layer”: analytics, errors, replay and business data, plus feature flags, experiments, warehouse, AI observability and MCP. Self-driving workflows propose code fixes and measure outcomes after human-reviewed merges. | [Homepage](https://posthog.com), [AI observability](https://posthog.com/docs/ai-observability), [self-driving contract](https://posthog.com/docs/self-driving) |
| Sentry | Application monitoring: errors, logs, replays, spans, profiles and metrics correlated by trace. Agent monitoring includes runs, tools, models and usage. Seer automates root-cause analysis and can draft fixes and iterate on failing CI. | [Homepage](https://sentry.io/welcome/), [documentation](https://docs.sentry.io/), [Seer Autofix](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/) |
| Foglamp | Observability for Vercel AI SDK apps: provider usage, priced cost, latency, trace waterfalls, prompts/responses, evals, agent attribution and threshold notifications. The inspected sources do not document operational recovery execution. | [Homepage](https://foglamp.dev), [docs index](https://docs.foglamp.dev/llms.txt), [cost](https://docs.foglamp.dev/dashboard/cost.md), [alerts](https://docs.foglamp.dev/dashboard/alerts.md), [detailed inventory](foglamp-comparison.md) |

AI investigation, code fixes, MCP and checking outcomes are not exclusive to Roundhouse. Its current recovery path is specifically **configured HTTPS checks → diagnostic reads → authorized fixed POST actions → independent health verification**. This differs from a PR/merge/metric workflow without implying that competitors only send alerts.

## Available in the managed Roundhouse platform

| Category | Shipped contract | Boundary |
| --- | --- | --- |
| Monitoring | Scheduled public HTTPS health checks and explicit app events. Owners configure multiple apps. | Not full infrastructure metrics or arbitrary synthetic browser transactions. |
| Analytics and events | Minimal pageviews/custom events via an opt-in tracker or authenticated ingestion. 24-hour summaries. | No persistent visitor identity, funnels, replay, feature flags or experimentation. |
| Logs | Explicit structured ingestion, bounded filtering and correlation IDs. | Not an unlimited log archive, distributed trace store or automatic error grouping. |
| Incidents and recovery | Durable investigation and action history, configured diagnostics and recovery, subsequent independent health probes. | Actions target exact authorized endpoints. No general customer shell, SSH or browser authority in the managed console. |
| Automations | Health failures or explicit events trigger the configured recovery loop. Automatic by default for new managed actions; opt-in approval. | Not an arbitrary workflow builder. Explicit existing manual policies remain unchanged. |
| Status pages | Owner-published customer-facing status updates. | Not automatic incident publication, uptime SLA measurement or subscriber notifications. |
| MCP access | A scoped server lets external agents read evidence and control monitoring. | Not arbitrary upstream customer MCP connections; no MCP approval or provider administration. |
| Agent observability | Per-investigation provider timing/outcome and reported usage, requests and admission reservations. | No priced cost ledger, response evals, agent rollups or universal tracing. Unknown usage is not zero. |

Managed data bounds: 50 records per 16 KiB batch, 1,000 records per UTC hour, 10,000 retained records per tenant, seven-day lazy retention. Public tracker collection has separate smaller limits. See [setup and security contracts](../platform/README.md), [data implementation](../platform/data.js), [controller](../platform/controller.js), [scoped MCP routes](../platform/index.js) and [observability guide](observability.md). The native/npm runtime has additional bounded adapters; their existence does not establish managed UI integration or live credential verification.

## Alongside existing tools

Apps or operator-written bridges can explicitly send events and logs through Roundhouse's documented ingest API. Owners can configure public HTTPS diagnostic and recovery endpoints. External MCP clients can use scoped Roundhouse tools. These are real connection boundaries, not claims of automatic Sentry, Better Stack, PostHog or Foglamp import, plug-in compatibility or a universal upstream MCP connector.

Dedicated provider and application credentials remain operator-provisioned secrets. Guest demos are isolated and fixture-only. A live model and customer endpoint authority must be configured before external recovery; no paid calls are needed to try the Reportroom demonstration.

## Planned, not available

General error tracking, distributed tracing, session replay, funnels, priced AI usage, response-quality evals, notification delivery and upstream MCP connectors remain roadmap categories. There are no delivery dates or product-parity guarantees.

## Ways to run it

The managed service is hosted on Cloudflare and uses server-side scheduling, not the user's laptop. Owner registration requires an invitation; customer BYOK and self-service billing do not exist yet. Self-managed Roundhouse is MPL-2.0 with no Roundhouse license fee. Infrastructure and model-provider charges remain separate.

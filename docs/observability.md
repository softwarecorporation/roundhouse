# Observability coverage and limits

Roundhouse's Workers runtime stores bounded recent telemetry alongside health probes and recovery investigations. It is not a replacement for PostHog, Better Stack, or a full observability backend. Similar signal names do not imply compatible protocols, analytics, scale, or operational guarantees.

This document describes `npm/src/types.ts`, `npm/src/telemetry.ts`, `npm/src/workers.ts`, and `crates/roundhouse-core/src/telemetry.rs`. It does not claim that the native host exposes these Workers routes. [Connect existing providers](integrations.md) describes the optional PostHog and Better Stack adapters. Those integrations are fixture-tested only until the primary implementation owner verifies live credentials and provider delivery.

## Current signal model

Capture is explicit. Roundhouse does not install browser hooks, set analytics cookies, collect identity automatically, or record sessions.

| Signal | Accepted data | Current use | Not implemented |
| --- | --- | --- | --- |
| Event | Event name, operator-supplied `distinct_id`, timestamp, and bounded scalar properties | Recent event retrieval, counts, and distinct actors per time bucket | Identity merging, cohorts, funnels, retention analysis, journeys, attribution, or session replay |
| Log | Level, message, optional trace ID, and properties | Filtered recent records and correlation by exact trace ID | Full-text search language, indexing arbitrary fields, live tail, log pipelines, or a provider-compatible ingestion endpoint |
| Span | Trace ID, span ID, optional parent span ID, duration in milliseconds, status, and properties | Recent span records, exact trace lookup, and basic duration aggregates | OTLP ingestion, automatic instrumentation, trace waterfall UI, service maps, sampling, or distributed trace reconstruction |
| Metric | `metric_type: "gauge"`, finite value, unit, and properties | Gauge samples with count, sum, mean, minimum, and maximum | Counters, histograms, summaries, rate inference, Prometheus scraping, remote write, or PromQL |
| Probe observation | Service, observation time, healthy flag, HTTP status when available, and elapsed duration | Recorded scheduled checks and a summary of observed checks | Independent multi-region probes, regional consensus, maintenance-aware SLA accounting, or a wall-clock availability guarantee |

## Capture and storage contract

`POST /v1/telemetry` accepts a JSON array of 1 to 100 signals with `Authorization: Bearer <EVENT_TOKEN>`. The request body limit is 256 KiB. Common fields are `id`, `service`, `kind`, `name`, `timestamp`, and optional `properties`. Timestamps are Unix milliseconds, not seconds or ISO strings on this direct route.

For example, this is a single gauge batch. Replace the timestamp with the current Unix time in milliseconds before sending it.

```json
[
	{
		"id": "application-queue-sample-1",
		"service": "application",
		"kind": "metric",
		"name": "queue.depth",
		"timestamp": 1794744000000,
		"metric_type": "gauge",
		"value": 7,
		"unit": "jobs",
		"properties": {
			"environment": "production"
		}
	}
]
```

Unknown top-level fields and unknown signal kinds fail validation. Common identity strings must be nonempty and at most 128 bytes. An event's `distinct_id` has the same bound. Properties accept at most 32 entries and 2,048 serialized bytes. Keys must be nonempty, at most 64 bytes, and must not be credential-like names. Values must be scalar JSON values, with strings at most 512 bytes. Nested objects and arrays are rejected.

Log messages have a 4,096-byte limit. Log levels are `trace`, `debug`, `info`, `warn`, `error`, and `fatal`. Trace IDs are 32 hexadecimal characters, and span IDs are 16. All-zero IDs are invalid. Span durations must be finite and nonnegative. Span status is `ok`, `error`, or `unset`. Gauge values must be finite, and their units have a 32-byte limit.

Storage uses SQLite in the Roundhouse Durable Object. The cap is 100,000 records across signal kinds, not per service. Retention is 30 days by signal timestamp. Capture rejects older signals and timestamps more than five minutes in the future. Capture and enabled monitoring alarms delete expired records; this is not an independent, continuously running expiry service while monitoring is stopped.

An exact duplicate ID with the same stored, redacted payload increments `duplicates`. Reusing an ID with a different payload fails with HTTP 409. Invalid capture fails with 400, an oversized direct body with 413, and exhausted record capacity with 429. Capture runs in a synchronous transaction, so a failed batch does not leave earlier records from that batch inserted.

Redaction runs before payload storage and on connection read output. Credential-like property keys are rejected at validation. Neither measure replaces your data classification policy. Do not send credentials, private user content, or personal identifiers that you do not intend to store. Operator-supplied `distinct_id` values can identify people even without automatic browser collection.

## Retrieval and aggregates

The following reads require `Authorization: Bearer <OPERATOR_TOKEN>`:

| Route | Behavior |
| --- | --- |
| `GET /v1/telemetry` | Exact-match filters for `service`, `kind`, `name`, and `trace_id`. Returns up to 200 records per page, newest first. |
| `GET /v1/analytics` | Requires `service`, `kind`, and `name`. Returns bucketed count, distinct actors, sum, mean, minimum, and maximum. |
| `GET /v1/probes?service=<id>` | Returns up to 200 recent recorded checks and a summary for that service since the supplied time. |
| `GET /v1/connections/<id>` | Makes an on-demand read of one configured provider resource. Does not store the result as local telemetry. |

Telemetry and analytics accept integer millisecond `since` and `until` values. Their interval is inclusive at `since` and exclusive at `until`. The default is the preceding 24 hours. A requested interval cannot exceed 30 days. Querying an older interval does not restore expired data.

Telemetry pagination returns `next: { before, cursor }` or `null`. Pass both returned fields on the next request and keep the original filters and interval. The timestamp and ID together preserve records that share a timestamp. This is bounded recent retrieval, not an export cursor with a snapshot guarantee.

Analytics uses `bucket_seconds`, defaulting to 3,600. Buckets range from 60 through 86,400 seconds, with at most 1,000 bucket intervals in the requested range. Buckets align to Unix epoch boundaries. Empty buckets are not filled with zero records.

`distinct_actors` counts event distinct IDs within each bucket. Adding those counts across buckets is not a unique-person count for the whole period. Numeric aggregates use gauge values or span `duration_ms`. Events and logs do not acquire meaningful numeric values from their properties. A gauge sum is a sum of samples, not a counter delta or an integral over time. The API does not infer rates, percentiles, p95, p99, or distributions.

Recent investigation evidence includes at most ten local telemetry records for the monitor's service from the preceding 30 minutes. A provider connection read is separate and is not an automatic historical evidence import.

## Probes are observations, not an SLA

The Workers monitor checks its configured `health_url` with an HTTP request and timeout. Health means the response status exactly equals `expected_status`. Redirects are not followed automatically. Alarms schedule checks according to the monitor interval when monitoring is enabled. Execution delays, timeouts, and a stopped runtime affect when observations exist.

The runtime retains up to 10,000 probe observations across services. `GET /v1/probes` exposes `observed_checks`, `successful_checks`, and `mean_duration_ms`, with a default `since` of 24 hours ago. Any success ratio derived from those counts describes observed checks, not elapsed uptime. Missing checks are not proof of health. Retained records may cover less than the requested interval, and the API does not produce a percentile latency or multi-region SLA.

## Existing providers remain the systems of record

The PostHog adapter reads one saved insight with cache-only GET. It does not export event history through `/query/`, refresh the insight, or recreate PostHog analytics locally. A cached funnel result from PostHog remains a provider result, not a Roundhouse funnel engine.

The Better Stack adapters read one monitor or at most 100 logs in a fixed 15-minute window using its read-only SQL connection. The log read combines recent and historical storage sources within that window. It is not a historical migration or a complete export. Optional configured provider notifications become local events, not an incident synchronization system.

There is no automatic forwarding of local telemetry to PostHog or Better Stack, no automatic polling of configured connections, and no migration task. Existing instrumentation and collectors continue to send data to their existing destinations. Roundhouse's capture format is not OTLP, the PostHog capture API, the Better Stack ingestion API, or the Prometheus exposition format.

## Reference projects and licensing

These projects are useful references for the capabilities outside Roundhouse's scope. This is a comparison of purpose and license, not a claim of feature parity, a benchmark, or a compatibility guarantee. No code from these projects was copied for these guides or the provider connection examples. Provider API contracts and configuration templates are cited in the [connection guide](integrations.md).

| Project | Purpose of the reference | License and official source |
| --- | --- | --- |
| PostHog | Product analytics, including funnels, retention, and session replay that Roundhouse does not implement | MIT outside the separately licensed commercial `ee/` directory and third-party exceptions. See the [root license](https://github.com/PostHog/posthog/blob/master/LICENSE), [enterprise license](https://github.com/PostHog/posthog/blob/master/ee/LICENSE), and [product docs](https://posthog.com/docs). |
| SigNoz | A telemetry backend for logs, metrics, and traces rather than a bounded incident evidence store | MIT outside commercial `ee/` and `cmd/enterprise/`, with third-party exceptions. See the [root license](https://github.com/SigNoz/signoz/blob/main/LICENSE), [enterprise license](https://github.com/SigNoz/signoz/blob/main/ee/LICENSE), and [docs](https://signoz.io/docs/). |
| OpenObserve | Log, metric, and trace storage and queries beyond recent local retrieval | The open-source edition is AGPL-3.0. The enterprise edition has separate commercial terms. See the [license](https://github.com/openobserve/openobserve/blob/main/LICENSE) and [official repository](https://github.com/openobserve/openobserve). |
| Grafana | Dashboards and cross-backend data exploration, not provided by Roundhouse's bounded aggregate API | AGPL-3.0 for the open-source project. See the [license](https://github.com/grafana/grafana/blob/main/LICENSE) and [licensing overview](https://grafana.com/licensing/). |
| Grafana Loki | A log backend and log query model, not implemented by Roundhouse's exact-match record filters | AGPL-3.0 with component exceptions. See the [license](https://github.com/grafana/loki/blob/main/LICENSE) and [licensing details](https://github.com/grafana/loki/blob/main/LICENSING.md). |
| Grafana Tempo | A distributed tracing backend, not implied by accepting explicit span records | AGPL-3.0 for the project. See the [license](https://github.com/grafana/tempo/blob/main/LICENSE) and [docs](https://grafana.com/docs/tempo/latest/). |
| Prometheus | Time-series collection, PromQL, and alerting, not supported by Roundhouse gauge capture | Apache-2.0. See the [license](https://github.com/prometheus/prometheus/blob/main/LICENSE) and [overview](https://prometheus.io/docs/introduction/overview/). |
| Uptime Kuma | A dedicated self-hosted uptime monitoring reference, rather than a promise of equivalent monitor types or UI | MIT. See the [license](https://github.com/louislam/uptime-kuma/blob/master/LICENSE) and [official repository](https://github.com/louislam/uptime-kuma). |
| OpenTelemetry | Vendor-neutral instrumentation, telemetry protocols, and collection. It is not itself a storage backend | Apache-2.0 for the Collector. See the [Collector license](https://github.com/open-telemetry/opentelemetry-collector/blob/main/LICENSE) and [OpenTelemetry overview](https://opentelemetry.io/docs/what-is-opentelemetry/). Roundhouse does not currently receive OTLP. |
| Better Stack | A hosted observability and incident platform with much broader monitoring and operations scope | The hosted platform is proprietary, not an open-source backend covered by its collector license. See the [service terms](https://betterstack.com/terms) and [official docs](https://betterstack.com/docs/). The separate [Better Stack collector](https://github.com/BetterStackHQ/collector) is Apache-2.0 under its [license](https://github.com/BetterStackHQ/collector/blob/main/LICENSE.md). |

License labels apply to the referenced projects, not to Roundhouse. Directory exceptions, bundled dependencies, enterprise editions, and hosted-service terms can differ. Review the actual license at the revision you plan to use before copying, combining, modifying, or distributing code. An HTTP integration does not grant rights to a provider's implementation.

Use Roundhouse for bounded recent evidence and controlled recovery workflows. Keep a dedicated analytics or observability system when you need funnels, retention analysis, session replay, OTLP, PromQL, full-text log analysis, percentile latency, large history, or multi-region availability reporting. None of those capabilities is established by the integrations documented here.

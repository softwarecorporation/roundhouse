# Connect an existing PostHog or Better Stack account

Keep your existing provider as the system of record. Roundhouse reads a few operator-configured resources and can receive selected notifications as recent telemetry. These connections do not migrate data, backfill history, or automatically forward telemetry to either provider. Configuring a connection does not enable a provider destination.

These instructions describe the Workers runtime in `npm/src/connections.ts` and `npm/src/workers.ts`. They do not establish equivalent support in the native host. The integrations are fixture-tested only until the primary implementation owner verifies live credentials. Provider accounts, permissions, regional endpoints, cache behavior, and real webhook delivery remain live-verification requirements. Do not treat a fixture response as evidence that your account works.

For local capture limits and the features that Roundhouse does not implement, see [Observability coverage](observability.md).

## Configure fixed resources

1. Configure a Roundhouse monitor in `ROUNDHOUSE_CONFIG` for each service that you want to associate with a connection.
2. Set `CONNECTIONS_JSON` to a JSON-encoded array, not an object or a filename. An unset value means `[]`.
3. Use the monitor's exact `id` as the connection's `service`.
4. Store credentials as runtime secrets, separately from `CONNECTIONS_JSON` and `ROUNDHOUSE_CONFIG`.

For example, with an existing monitor named `application`, this is the value of `CONNECTIONS_JSON`:

```json
[
	{
		"kind": "posthog_insight",
		"id": "product_health",
		"service": "application",
		"base_url": "https://us.posthog.com",
		"project_id": "12345",
		"insight_id": "AbCd1234"
	},
	{
		"kind": "betterstack_uptime",
		"id": "public_health",
		"service": "application",
		"base_url": "https://incidents.betterstack.com",
		"monitor_id": "123456789"
	},
	{
		"kind": "betterstack_logs",
		"id": "recent_logs",
		"service": "application",
		"base_url": "https://eu-nbg-2-connect.betterstackdata.com",
		"table": "t123456_application"
	}
]
```

Replace the example IDs and regional hosts with values from your provider account. The Better Stack SQL host must be the connection endpoint shown in that account, not its ingestion endpoint.

The parser accepts at most 20 connections. Each connection ID must be unique and match `[a-zA-Z0-9_-]{1,64}`. Project and monitor IDs are digit-only strings, not JSON numbers. Insight IDs match `[a-zA-Z0-9_-]{1,64}`. A log table prefix matches `t\d+_[a-zA-Z0-9_]+`. Do not append `_logs` or `_s3`; Roundhouse appends those suffixes.

`base_url` must be an HTTPS origin with no path other than `/`, user information, query, or fragment. HTTP is accepted only for `localhost`, `127.0.0.1`, and `[::1]`, for local fixtures. Configure only origins that you trust to receive the corresponding credential. The parser does not enforce a provider-host allowlist. Redirects fail rather than forwarding credentials to a new location.

## Provision dedicated secrets

Use a distinct secret for each purpose. With Wrangler, run `bunx wrangler secret put NAME` in the Worker project and enter the value at its prompt. Do not put secret values in shell history, documentation, source control, or frontend code.

| Runtime secret | Credential contract |
| --- | --- |
| `POSTHOG_READ_KEY` | A PostHog personal API key with `insight:read`, restricted to the selected project where possible. Roundhouse sends `Authorization: Bearer <key>`. This is not the public project capture key. |
| `BETTERSTACK_UPTIME_TOKEN` | An Incidents API token for the relevant Better Stack team. Roundhouse sends `Authorization: Bearer <token>`. Do not assume that the token itself is read-only just because this adapter only reads. |
| `BETTERSTACK_LOGS_USER` | Username from a Better Stack **Connect ClickHouse HTTP client** connection. |
| `BETTERSTACK_LOGS_PASSWORD` | Password from the same read-only SQL connection. Roundhouse sends HTTP Basic authentication with that username and password. This is not a telemetry source ingestion token. |
| `POSTHOG_RECEIVER_TOKEN` | A new operator-generated random secret, configured identically in the PostHog destination's Authorization header. Not a PostHog API key. |
| `BETTERSTACK_RECEIVER_TOKEN` | A different operator-generated random secret, configured identically in the Better Stack outgoing webhook's Authorization header. Not an Incidents API token. |

Secrets are shared by all connections of the corresponding kind in this runtime. There is no per-connection credential selector. For different accounts with different credentials, use separate runtime deployments rather than adding an undocumented key field.

The official credential contracts are [PostHog personal API keys](https://posthog.com/docs/api/personal-api-keys), [PostHog insight permissions](https://posthog.com/docs/api/insights), [Better Stack Incidents API authentication](https://betterstack.com/docs/uptime/api/getting-started-with-uptime-api/), and [Better Stack read-only SQL connections](https://betterstack.com/docs/logs/query-api/connect-remotely/). Better Stack SQL connections can access all sources in the selected teams. Select only the teams that you need.

## Read one saved PostHog insight

1. Save an insight in PostHog and record its project and insight IDs.
2. Confirm that PostHog has calculated the insight. Roundhouse does not calculate or refresh it.
3. Add the `posthog_insight` connection and `POSTHOG_READ_KEY` secret.
4. Request the connection through Roundhouse with the operator token.

```sh
curl --fail-with-body \
	-H "Authorization: Bearer $OPERATOR_TOKEN" \
	"$ROUNDHOUSE_URL/v1/connections/product_health"
```

Roundhouse makes exactly this upstream request:

```text
GET {base_url}/api/projects/{project_id}/insights/{insight_id}/?refresh=force_cache
Authorization: Bearer <POSTHOG_READ_KEY>
```

The response contains `connection`, `observed_at`, `cache_only: true`, and an `insight` object. The adapter keeps only `id`, `short_id`, `name`, `result`, `last_refresh`, `is_cached`, and `next_allowed_client_refresh` when present. `observed_at` is the read time, not the insight calculation time. Check `last_refresh`; a successful read can contain stale or missing results.

This adapter uses the [saved insight retrieve endpoint](https://posthog.com/docs/api/insights), not the `/query/` endpoint. PostHog's [API queries policy](https://posthog.com/docs/api/queries) explicitly prohibits third-party export connectors built on `/query/`. Bulk or recurring event export belongs in PostHog batch exports or file download exports. Roundhouse implements neither export path and does not use query pagination to reconstruct history.

## Read one Better Stack monitor

1. Record the ID of an existing Better Stack monitor.
2. Add the `betterstack_uptime` connection and `BETTERSTACK_UPTIME_TOKEN` secret.
3. Request `GET /v1/connections/public_health` with `Authorization: Bearer <OPERATOR_TOKEN>`.

Roundhouse makes `GET {base_url}/api/v2/monitors/{monitor_id}`. The [official monitor API](https://betterstack.com/docs/uptime/api/get-a-single-monitor/) documents the Bearer credential and response.

The returned `monitor` contains its `id` and, when present, `status`, `pronounceable_name`, and `last_checked_at`. The adapter does not return monitor credentials, request headers, or the full monitor definition. It does not create monitors, retrieve response-time history, calculate availability, or change incident state.

## Read a fixed 15-minute Better Stack log window

1. In Better Stack Telemetry integrations, create a **Connect ClickHouse HTTP client** connection for the required team.
2. Copy its endpoint, username, password, and source table prefix from **Query with** or **Copy sample cURL**.
3. Add the `betterstack_logs` connection and both SQL secrets.
4. Request `GET /v1/connections/recent_logs` with the Roundhouse operator token.

Roundhouse POSTs plain-text SQL to `{base_url}/?output_format_pretty_row_numbers=0` using HTTP Basic authentication. POST is the SQL transport, not an upstream write. The connection itself is read-only.

The fixed statement selects `dt` and `raw` from `remote({table}_logs)` and unions historical `s3Cluster(primary, {table}_s3)` rows with `_row_type = 1`. It filters `dt` to the half-open interval from read time minus 900 seconds through read time, orders newest first, and limits the result to 100 `JSONEachRow` records. This follows Better Stack's [recent and historical log source contract](https://betterstack.com/docs/logs/query-api/connect-remotely/).

The response contains `connection`, `observed_at`, `window_seconds: 900`, `possibly_truncated`, and `records` with only `dt` and `raw`. Exactly 100 rows sets `possibly_truncated: true`; fewer rows do not prove that every source event has arrived. There is no pagination, custom SQL, arbitrary time range, span query, metric query, or continuous import. Reading a connection does not insert these records into Roundhouse telemetry.

## Configure a PostHog event destination

This is an optional, explicit push path. The read-only insight connection does not subscribe to events.

1. Provision `POSTHOG_RECEIVER_TOKEN` in Roundhouse.
2. In PostHog, create a [Webhook destination](https://posthog.com/docs/data-pipelines/destinations/webhook).
3. Set its method to POST and its URL to `https://<your-roundhouse-host>/v1/webhooks/posthog/product_health`.
4. Configure `Content-Type: application/json` and `Authorization: Bearer <the POSTHOG_RECEIVER_TOKEN value>` as outgoing headers. Store the authorization value as a secret input where available.
5. Replace the body with this exact flat destination template. Do not wrap it in `event` or send the default nested payload.

```json
{
	"uuid": "{event.uuid}",
	"event": "{event.event}",
	"distinct_id": "{event.distinct_id}",
	"timestamp": "{event.timestamp}"
}
```

6. Set destination filters to the selected events. Test the destination before enabling production delivery.
7. Confirm the rendered JSON, the Authorization header, and Roundhouse's `accepted` or `duplicates` response. Confirm the record with `GET /v1/telemetry` using the operator token.

PostHog documents these variables in [Customizing destinations](https://posthog.com/docs/data-pipelines/destinations/customizing-destinations). This is a configured template contract, not a drop-in PostHog capture API.

Roundhouse maps `uuid` to `ph:<connection-id>:<uuid>`, copies the event name and distinct ID, parses the timestamp, and stores no provider properties. The connection must be `posthog_insight`. The configured connection determines the Roundhouse service; the payload does not select it.

## Configure a Better Stack incident webhook

1. Provision `BETTERSTACK_RECEIVER_TOKEN` in Roundhouse.
2. In Better Stack Incidents integrations, add an [outgoing incident webhook](https://betterstack.com/docs/uptime/webhooks/).
3. Set POST to `https://<your-roundhouse-host>/v1/webhooks/betterstack/public_health`.
4. Configure `Content-Type: application/json` and `Authorization: Bearer <the BETTERSTACK_RECEIVER_TOKEN value>` as custom outgoing headers.
5. Select incident start, acknowledgment, and resolution notifications. Use the following minimal custom body template.

```json
{
	"data": {
		"id": "$INCIDENT_ID",
		"type": "incident",
		"attributes": {
			"started_at": "$STARTED_AT",
			"acknowledged_at": "$ACKNOWLEDGED_AT",
			"resolved_at": "$RESOLVED_AT"
		}
	}
}
```

The [outgoing webhook API](https://betterstack.com/docs/uptime/api/create-outgoing-webhook-integration/) documents `trigger_type: "incident_change"`, lifecycle flags, and `custom_webhook_template_attributes`. Its `headers_template` is an array of `{ "name": "...", "value": "..." }` objects. Set the Authorization header there if configuring through that API. Roundhouse does not create this integration for you.

A rendered start notification has this shape. Replace the example timestamp with the actual current incident timestamp when testing.

```json
{
	"data": {
		"id": "123456",
		"type": "incident",
		"attributes": {
			"started_at": "2026-11-15T12:00:00.000Z",
			"acknowledged_at": null,
			"resolved_at": null
		}
	}
}
```

6. Verify how your account renders unset lifecycle variables. They must be null or empty, not the literal text `"null"` or an unresolved placeholder.
7. Send start, acknowledgment, and resolution tests. Verify the resulting telemetry and repeat a delivery to check duplicate handling.

The receiver accepts `data.type: "incident"`, a string ID, and lifecycle attributes. It selects a truthy `resolved_at` first, then `acknowledged_at`, then `started_at`. The selected value must parse as a valid timestamp. It records `betterstack.incident.resolved`, `betterstack.incident.acknowledged`, or `betterstack.incident.started` with distinct ID `incident:<id>` and property `provider_incident`.

The record ID is `bs:<connection-id>:<incident-id>:<status>:<timestamp>`. Provider names, causes, screenshots, comments, and response bodies are not retained by this mapping. Reopened or commented notifications have no separate mapping. The receiver infers status from timestamps, not a top-level event label.

The connection must be `betterstack_uptime`. Configure provider routing to send only the intended monitor's incidents to this URL. The receiver does not verify a payload monitor relationship against `monitor_id`; it associates every accepted notification with the configured service.

## Verify limits before production use

Both receiver routes require their dedicated configured Bearer token. Neither route verifies an HMAC signature. Do not invent a signing secret or assume that a provider's default webhook authentication matches this contract. Missing receiver secrets disable authentication success rather than falling back to the operator or event token. Rotate the Roundhouse secret and provider header together.

Connection reads require `OPERATOR_TOKEN`. Direct `POST /v1/telemetry` uses `EVENT_TOKEN`. Do not reuse either as a provider receiver token. Webhook bodies are limited to 16 KiB. They pass through the same timestamp, identity, deduplication, capacity, and redaction rules as direct capture. Old notifications beyond 30 days and timestamps more than five minutes ahead are rejected. Long provider identifiers can also exceed the 128-byte final signal ID limit.

Upstream reads have a 15-second timeout, a 64 KiB response limit, and no redirect following. Non-success upstream responses return a sanitized result with `error: "upstream unavailable"`, upstream `status`, and `retry_after` when present. Inspect that body even when the Roundhouse HTTP request succeeds. There is no automatic retry or provider rate-limit scheduler.

Before declaring an account connected, verify all of the following with live credentials:

- Each configured read succeeds against the intended regional host and resource without broader permissions than necessary.
- PostHog returns cached results and exposes an understandable `last_refresh` value.
- Better Stack SQL returns recent and historical-source rows within the fixed window, without treating the 100-row limit as a complete export.
- Provider tests send the configured Authorization header and the exact expected body. Missing or incorrect tokens fail.
- Duplicate notification delivery does not create an extra record. Invalid timestamps fail rather than becoming evidence.
- Sensitive data does not appear in returned logs or local telemetry. Review `raw` log content in particular; redaction is not a guarantee of anonymity.

Notifications enrich recent investigation evidence. They do not enqueue a Roundhouse recovery incident, approve an action, assert recovery, or synchronize provider incident state. Scheduled Roundhouse health checks remain separate. No connection automatically polls, migrates, or forwards data. Enable provider destinations only after the live checks above pass.

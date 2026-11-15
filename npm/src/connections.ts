import type { Signal } from "./types.js";

interface Base { id: string; service: string; base_url: string }
export type Connection = Base & (
  | { kind: "posthog_insight"; project_id: string; insight_id: string }
  | { kind: "betterstack_uptime"; monitor_id: string }
  | { kind: "betterstack_logs"; table: string }
);
export interface ConnectionSecrets {
  POSTHOG_READ_KEY?: string;
  BETTERSTACK_UPTIME_TOKEN?: string;
  BETTERSTACK_LOGS_USER?: string;
  BETTERSTACK_LOGS_PASSWORD?: string;
  POSTHOG_RECEIVER_TOKEN?: string;
  BETTERSTACK_RECEIVER_TOKEN?: string;
}

export function parseConnections(json: string | undefined, services: string[]): Connection[] {
  const values: unknown = JSON.parse(json ?? "[]");
  if (!Array.isArray(values) || values.length > 20) throw new Error("invalid connections");
  const ids = new Set<string>();
  return values.map((value: unknown): Connection => {
    if (!value || typeof value !== "object" || !("kind" in value) || !("id" in value) || !("service" in value) || !("base_url" in value)) throw new Error("invalid connection");
    const { kind, id, service, base_url } = value;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id) || typeof service !== "string" || !services.includes(service) || typeof base_url !== "string") throw new Error("invalid connection identity");
    ids.add(id);
    const url = new URL(base_url);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid connection endpoint");
    const base = { id, service, base_url: url.origin };
    if (kind === "posthog_insight" && "project_id" in value && "insight_id" in value && typeof value.project_id === "string" && /^\d+$/.test(value.project_id) && typeof value.insight_id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value.insight_id)) return { ...base, kind, project_id: value.project_id, insight_id: value.insight_id };
    if (kind === "betterstack_uptime" && "monitor_id" in value && typeof value.monitor_id === "string" && /^\d+$/.test(value.monitor_id)) return { ...base, kind, monitor_id: value.monitor_id };
    if (kind === "betterstack_logs" && "table" in value && typeof value.table === "string" && /^t\d+_[a-zA-Z0-9_]+$/.test(value.table)) return { ...base, kind, table: value.table };
    throw new Error("invalid connection kind or resource");
  });
}

function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid upstream object");
  return v as Record<string, unknown>;
}
function fields(v: unknown, names: string[]): Record<string, unknown> {
  const source = object(v);
  return Object.fromEntries(names.filter(k => k in source).map(k => [k, source[k]]));
}
function required(v: string | undefined): string { if (!v) throw new Error("connection credential missing"); return v; }

/** Reads only fixed, operator-configured resources. No arbitrary query, URL or upstream write. */
export async function readConnection(c: Connection, secrets: ConnectionSecrets, read: (body: ReadableStream<Uint8Array> | null, limit: number) => Promise<string>, now = Date.now()): Promise<unknown> {
  const headers = new Headers();
  let url: string;
  let method = "GET";
  let body: string | undefined;
  switch (c.kind) {
    case "posthog_insight":
      headers.set("authorization", `Bearer ${required(secrets.POSTHOG_READ_KEY)}`);
      url = `${c.base_url}/api/projects/${c.project_id}/insights/${c.insight_id}/?refresh=force_cache`;
      break;
    case "betterstack_uptime":
      headers.set("authorization", `Bearer ${required(secrets.BETTERSTACK_UPTIME_TOKEN)}`);
      url = `${c.base_url}/api/v2/monitors/${c.monitor_id}`;
      break;
    case "betterstack_logs":
      headers.set("authorization", `Basic ${btoa(`${required(secrets.BETTERSTACK_LOGS_USER)}:${required(secrets.BETTERSTACK_LOGS_PASSWORD)}`)}`);
      headers.set("content-type", "text/plain");
      url = `${c.base_url}/?output_format_pretty_row_numbers=0`;
      method = "POST";
      body = `SELECT dt, raw FROM (SELECT dt, raw FROM remote(${c.table}_logs) UNION ALL SELECT dt, raw FROM s3Cluster(primary, ${c.table}_s3) WHERE _row_type = 1) WHERE dt >= toDateTime64(${(now - 900000) / 1000}, 3, 'UTC') AND dt < toDateTime64(${now / 1000}, 3, 'UTC') ORDER BY dt DESC LIMIT 100 FORMAT JSONEachRow`;
      break;
  }
  const r = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (!r.ok) { await r.body?.cancel(); return { connection: c.id, error: "upstream unavailable", status: r.status, retry_after: r.headers.get("retry-after") }; }
  const text = await read(r.body, 65536);
  if (c.kind === "betterstack_logs") {
    const lines = text.split("\n").filter(s => s.trim());
    if (lines.length > 100) throw new Error("upstream row limit");
    return { connection: c.id, observed_at: now, window_seconds: 900, possibly_truncated: lines.length === 100, records: lines.map(line => fields(JSON.parse(line), ["dt", "raw"])) };
  }
  const data: unknown = JSON.parse(text);
  if (c.kind === "posthog_insight") return { connection: c.id, observed_at: now, cache_only: true, insight: fields(data, ["id", "short_id", "name", "result", "last_refresh", "is_cached", "next_allowed_client_refresh"]) };
  const monitor = object(object(data).data);
  return { connection: c.id, observed_at: now, monitor: { id: monitor.id, ...fields(monitor.attributes, ["status", "pronounceable_name", "last_checked_at"]) } };
}

/** These receivers implement explicitly configured templates, not drop-in capture endpoints. */
export function receive(c: Connection, kind: "posthog" | "betterstack", input: unknown): Signal {
  const value = object(input);
  if (kind === "posthog") {
    if (c.kind !== "posthog_insight" || typeof value.uuid !== "string" || typeof value.event !== "string" || typeof value.distinct_id !== "string" || typeof value.timestamp !== "string") throw new Error("invalid PostHog template");
    return { id: `ph:${c.id}:${value.uuid}`, service: c.service, kind: "event", name: value.event, distinct_id: value.distinct_id, timestamp: Date.parse(value.timestamp), properties: {} };
  }
  if (c.kind !== "betterstack_uptime") throw new Error("invalid Better Stack connection");
  const data = object(value.data);
  const a = object(data.attributes);
  if (data.type !== "incident" || typeof data.id !== "string") throw new Error("invalid Better Stack template");
  const status = a.resolved_at ? "resolved" : a.acknowledged_at ? "acknowledged" : "started";
  const at = a.resolved_at || a.acknowledged_at || a.started_at;
  if (typeof at !== "string") throw new Error("missing lifecycle timestamp");
  return { id: `bs:${c.id}:${data.id}:${status}:${at}`, service: c.service, kind: "event", name: `betterstack.incident.${status}`, distinct_id: `incident:${data.id}`, timestamp: Date.parse(at), properties: { provider_incident: data.id } };
}

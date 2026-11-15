import { core } from "./core.js";
import type { Signal } from "./types.js";

export class TelemetryError extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }

/** Small-deployment recent store, not a ClickHouse replacement or OTLP receiver. */
export class TelemetryStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS telemetry(id TEXT PRIMARY KEY, service TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL, distinct_id TEXT, trace_id TEXT, value REAL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS telemetry_query ON telemetry(service,kind,name,at);
      CREATE INDEX IF NOT EXISTS telemetry_trace ON telemetry(trace_id,at);
      CREATE INDEX IF NOT EXISTS telemetry_retention ON telemetry(at);`);
  }
  capture(json: string, scrub: (value: unknown) => unknown): { accepted: number; duplicates: number } {
    let signals: Signal[];
    try { signals = core.telemetry(JSON.stringify(scrub(core.telemetry(json)))); } catch { throw new TelemetryError(400); }
    return this.storage.transactionSync(() => {
      const now = Date.now();
      this.storage.sql.exec("DELETE FROM telemetry WHERE at<?", now - 30 * 86400000);
      let accepted = 0;
      let duplicates = 0;
      for (const signal of signals) {
        if (signal.timestamp < now - 30 * 86400000 || signal.timestamp > now + 300000) throw new TelemetryError(400);
        const payload = JSON.stringify(signal);
        const prior = this.storage.sql.exec<{ payload: string }>("SELECT payload FROM telemetry WHERE id=?", signal.id).toArray()[0];
        if (prior) {
          if (prior.payload !== payload) throw new TelemetryError(409);
          duplicates++; continue;
        }
        const count = this.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM telemetry").one().count;
        if (count >= 100000) throw new TelemetryError(429);
        this.storage.sql.exec("INSERT INTO telemetry VALUES(?,?,?,?,?,?,?,?,?)", signal.id, signal.service, signal.kind, signal.name, signal.timestamp,
          signal.kind === "event" ? signal.distinct_id : null,
          signal.kind === "log" || signal.kind === "span" ? signal.trace_id ?? null : null,
          signal.kind === "metric" ? signal.value : signal.kind === "span" ? signal.duration_ms : null, payload);
        accepted++;
      }
      return { accepted, duplicates };
    });
  }

  private filter(params: URLSearchParams): { where: string; bindings: SqlStorageValue[]; since: number; until: number } {
    const until = Number(params.get("until") ?? Date.now());
    const since = Number(params.get("since") ?? until - 86400000);
    if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || since > until || until - since > 30 * 86400000) throw new TelemetryError(400);
    const clauses = ["at>=?", "at<?"];
    const bindings: SqlStorageValue[] = [since, until];
    for (const field of ["service", "kind", "name", "trace_id"]) {
      const value = params.get(field);
      if (value) { if (value.length > 128) throw new TelemetryError(400); clauses.push(`${field}=?`); bindings.push(value); }
    }
    return { where: clauses.join(" AND "), bindings, since, until };
  }
  query(params: URLSearchParams): unknown {
    const f = this.filter(params);
    const before = Number(params.get("before") ?? f.until);
    if (!Number.isSafeInteger(before) || before > f.until || before < f.since) throw new TelemetryError(400);
    // Cursor includes the ID to avoid losing records sharing an event timestamp.
    const cursor = params.get("cursor");
    const rows = cursor ? this.storage.sql.exec<{ id: string; at: number; payload: string }>(`SELECT id,at,payload FROM telemetry WHERE ${f.where} AND (at<? OR (at=? AND id<?)) ORDER BY at DESC,id DESC LIMIT 201`, ...f.bindings, before, before, cursor).toArray() : this.storage.sql.exec<{ id: string; at: number; payload: string }>(`SELECT id,at,payload FROM telemetry WHERE ${f.where} AND at<=? ORDER BY at DESC,id DESC LIMIT 201`, ...f.bindings, before).toArray();
    const page = rows.slice(0, 200);
    const last = page.at(-1);
    return { records: page.map(r => JSON.parse(r.payload)), next: rows.length > 200 && last ? { before: last.at, cursor: last.id } : null, since: f.since, until: f.until, retention_days: 30, capacity: 100000 };
  }
  analytics(params: URLSearchParams): unknown {
    for (const key of ["service", "kind", "name"]) if (!params.get(key)) throw new TelemetryError(400);
    const f = this.filter(params);
    const bucket = Number(params.get("bucket_seconds") ?? 3600) * 1000;
    if (!Number.isInteger(bucket) || bucket < 60000 || bucket > 86400000 || (f.until - f.since) / bucket > 1000) throw new TelemetryError(400);
    const buckets = this.storage.sql.exec(`SELECT CAST(at / ? AS INTEGER) * ? AS bucket, count(*) AS count, count(DISTINCT distinct_id) AS distinct_actors, sum(value) AS sum, avg(value) AS mean, min(value) AS min, max(value) AS max FROM telemetry WHERE ${f.where} GROUP BY bucket ORDER BY bucket`, bucket, bucket, ...f.bindings).toArray();
    return { since: f.since, until: f.until, bucket_ms: bucket, buckets, note: "metric values are gauge samples; span values are duration_ms; no rate or percentile inference" };
  }
  evidence(service: string): unknown {
    const rows = this.storage.sql.exec<{ payload: string }>("SELECT payload FROM telemetry WHERE service=? AND at>=? ORDER BY at DESC LIMIT 10", service, Date.now() - 1800000).toArray();
    return rows.map(r => JSON.parse(r.payload));
  }
  expire(): void { this.storage.sql.exec("DELETE FROM telemetry WHERE at<?", Date.now() - 30 * 86400000); }
}

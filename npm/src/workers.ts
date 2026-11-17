import { DurableObject } from "cloudflare:workers";
import { core } from "./core.js";
import { defaultTools, invocationDigest, type ToolRegistry } from "./operations.js";
import { WorkspaceStore } from "./workspace.js";
export { ToolRegistry, defaultTools } from "./operations.js";
import { TelemetryStore, TelemetryError } from "./telemetry.js";
import { parseConnections, readConnection, receive, type Connection, type ConnectionSecrets } from "./connections.js";
import type { Config, Monitor, Incident, IncidentState } from "./types.js";
export type { Config, Monitor } from "./types.js";

export interface Env extends ConnectionSecrets {
  ROUNDHOUSE: DurableObjectNamespace<Roundhouse>;
  ROUNDHOUSE_CONFIG: string;
  OPERATOR_TOKEN: string;
  EVENT_TOKEN: string;
  PROVIDER_API_KEY: string;
  APPLICATION_TOKEN?: string;
  CONNECTIONS_JSON?: string;
  EXECUTOR_TOKEN?: string;
}

class HttpError extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }

async function authorized(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!supplied || !token) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([supplied, token].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

async function bounded(body: ReadableStream<Uint8Array> | null, limit: number, truncate = false): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const available = limit - size;
      if (value.length > available) {
        if (!truncate) throw new HttpError(413);
        chunks.push(value.slice(0, available));
        size += available;
        break;
      }
      chunks.push(value); size += value.length;
      if (size === limit && truncate) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function oneField(request: Request, key: string): Promise<string> {
  let value: unknown;
  try { value = JSON.parse(await bounded(request.body, 4096)); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400); }
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !(key in value)) throw new HttpError(400);
  const field: unknown = Reflect.get(value, key);
  if (typeof field !== "string" || !field) throw new HttpError(400);
  return field;
}

/** One controller per deployment intentionally owns global budgets and serial investigation. */
export class Roundhouse extends DurableObject<Env> {
  readonly config: Config;
  readonly fingerprint: string;
  readonly connections: Connection[];
  readonly telemetry: TelemetryStore;
  readonly workspace: WorkspaceStore;
  readonly tools: ToolRegistry;
  private running = false;

  constructor(ctx: DurableObjectState, env: Env, tools = defaultTools()) {
    super(ctx, env);
    this.config = core.config(env.ROUNDHOUSE_CONFIG);
    this.connections = parseConnections(env.CONNECTIONS_JSON, this.config.monitors.map(m => m.id));
    this.telemetry = new TelemetryStore(ctx.storage);
    this.workspace = new WorkspaceStore(ctx.storage);
    this.tools = tools;
    for (const m of this.config.monitors) for (const tool of m.tools ?? []) this.tools.validate(tool);
    if (!env.OPERATOR_TOKEN?.trim() || !env.EVENT_TOKEN?.trim() || !env.PROVIDER_API_KEY?.trim() || env.OPERATOR_TOKEN === env.EVENT_TOKEN) throw new Error("missing or invalid secret bindings");
    this.fingerprint = JSON.stringify(this.config);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY, monitor TEXT NOT NULL, state TEXT NOT NULL, pending_action TEXT, approved_action TEXT, attempted INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_monitor ON incidents(monitor) WHERE state != 'resolved';
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT, incident TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(key TEXT PRIMARY KEY, monitor TEXT NOT NULL, incident TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily(day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0, actions INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS schedule(monitor TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY, incident TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, digest TEXT NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS probes(seq INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, at INTEGER NOT NULL, healthy INTEGER NOT NULL, status INTEGER, duration_ms INTEGER NOT NULL);
    `);
    ctx.storage.transactionSync(() => {
      const interrupted = this.rows<Incident>("SELECT * FROM incidents WHERE state='investigating'");
      ctx.storage.sql.exec("UPDATE invocations SET state='unknown' WHERE state='claimed'");
      for (const i of interrupted) {
        this.state(i.id, "needs_attention");
        this.audit(i.id, "interrupted", { note: "reconcile manually; no action or model replay" });
      }
    });
  }

  private rows<T extends object>(query: string, ...bindings: SqlStorageValue[]): T[] {
    // Rows originate in this class's private, typed SQL schema, never external input.
    return this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[];
  }
  private clean(text: string): string {
    if (this.env.BETTERSTACK_LOGS_USER && this.env.BETTERSTACK_LOGS_PASSWORD) {
      text = text.split(btoa(`${this.env.BETTERSTACK_LOGS_USER}:${this.env.BETTERSTACK_LOGS_PASSWORD}`)).join("[REDACTED]");
    }
    for (const s of [this.env.PROVIDER_API_KEY, this.env.OPERATOR_TOKEN, this.env.EVENT_TOKEN, this.env.APPLICATION_TOKEN, this.env.POSTHOG_READ_KEY, this.env.BETTERSTACK_UPTIME_TOKEN, this.env.BETTERSTACK_LOGS_USER, this.env.BETTERSTACK_LOGS_PASSWORD, this.env.POSTHOG_RECEIVER_TOKEN, this.env.BETTERSTACK_RECEIVER_TOKEN].filter((s): s is string => !!s).sort((a, b) => b.length - a.length)) text = text.split(s).join("[REDACTED]");
    if (this.env.EXECUTOR_TOKEN) text = text.split(this.env.EXECUTOR_TOKEN).join("[REDACTED]");
    return core.redact(text);
  }
  private scrub(value: unknown): unknown {
    if (typeof value === "string") return this.clean(value);
    if (Array.isArray(value)) return value.map(v => this.scrub(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      if (this.clean(k) !== k) throw new HttpError(400);
      return [k, this.scrub(v)];
    }));
    return value;
  }
  private audit(id: string, kind: string, detail: unknown): void {
    const text = JSON.stringify(this.scrub(detail));
    this.ctx.storage.sql.exec("INSERT INTO history(incident,kind,detail,at) VALUES(?,?,?,?)", id, kind, text.length <= 16384 ? text : JSON.stringify({ truncated: true, preview: text.slice(0, 8192) }), Date.now());
  }
  private state(id: string, state: IncidentState): void { this.ctx.storage.sql.exec("UPDATE incidents SET state=? WHERE id=?", state, id); }
  private enabled(): boolean { return this.rows<{ value: number }>("SELECT value FROM settings WHERE key='enabled'")[0]?.value === 1; }
  private incident(id: string): Incident {
    const i = this.rows<Incident>("SELECT * FROM incidents WHERE id=?", id)[0];
    if (!i) throw new HttpError(404);
    return i;
  }
  private enqueue(monitor: string, key?: string): string {
    return this.ctx.storage.transactionSync(() => {
      if (key) {
        const prior = this.rows<{ incident: string; monitor: string }>("SELECT incident,monitor FROM events WHERE key=?", key)[0];
        if (prior) { if (prior.monitor !== monitor) throw new HttpError(409); return prior.incident; }
      }
      const active = this.rows<Incident>("SELECT * FROM incidents WHERE monitor=? AND state!='resolved'", monitor)[0];
      const id = active?.id ?? crypto.randomUUID();
      if (!active) {
        this.ctx.storage.sql.exec("INSERT INTO incidents(id,monitor,state,config,created_at) VALUES(?,?,'queued',?,?)", id, monitor, this.fingerprint, Date.now());
        this.audit(id, "detected", { source: key ? "event" : "scheduled_probe" });
      }
      if (key) this.ctx.storage.sql.exec("INSERT INTO events(key,monitor,incident) VALUES(?,?,?)", key, monitor, id);
      return id;
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const event = path === "/v1/events";
      const receiver = path.match(/^\/v1\/webhooks\/(posthog|betterstack)\/([a-zA-Z0-9_-]+)$/);
      const receiverToken = receiver?.[1] === "posthog" ? this.env.POSTHOG_RECEIVER_TOKEN : this.env.BETTERSTACK_RECEIVER_TOKEN;
      if (!await authorized(request, receiver ? receiverToken ?? "" : event || (path === "/v1/telemetry" && request.method === "POST") ? this.env.EVENT_TOKEN : this.env.OPERATOR_TOKEN)) throw new HttpError(401);
      if (receiver && request.method === "POST") {
        const c = this.connections.find(c => c.id === receiver[2]);
        if (!c) throw new HttpError(404);
        let signal;
        try { signal = receive(c, receiver[1] === "posthog" ? "posthog" : "betterstack", JSON.parse(await bounded(request.body, 16384))); } catch { throw new HttpError(400); }
        const result = this.telemetry.capture(JSON.stringify([signal]), v => this.scrub(v));
        // Notifications enrich evidence; they never approve an action or assert recovery.
        return Response.json(result);
      }
      if (path === "/v1/telemetry" && request.method === "POST") return Response.json(this.telemetry.capture(await bounded(request.body, 262144), v => this.scrub(v)));
      if (path === "/v1/telemetry" && request.method === "GET") return Response.json(this.scrub(this.telemetry.query(url.searchParams)));
      if (path === "/v1/analytics" && request.method === "GET") return Response.json(this.telemetry.analytics(url.searchParams));
      if (path === "/v1/probes" && request.method === "GET") {
        const service = url.searchParams.get("service");
        const since = Number(url.searchParams.get("since") ?? Date.now() - 86400000);
        if (!service || !Number.isSafeInteger(since) || since < 0) throw new HttpError(400);
        return Response.json({ observations: this.rows("SELECT * FROM probes WHERE service=? AND at>=? ORDER BY seq DESC LIMIT 200", service, since), summary: this.rows("SELECT count(*) AS observed_checks,sum(healthy) AS successful_checks,avg(duration_ms) AS mean_duration_ms FROM probes WHERE service=? AND at>=?", service, since)[0], note: "up to 10000 retained observations; observed checks are not a wall-clock SLA" });
      }
      const connection = path.match(/^\/v1\/connections\/([a-zA-Z0-9_-]+)$/);
      if (connection && request.method === "GET") {
        const c = this.connections.find(c => c.id === connection[1]);
        if (!c) throw new HttpError(404);
        return Response.json(this.scrub(await readConnection(c, this.env, bounded)));
      }
      if (request.method === "GET" && path === "/v1/status") return Response.json({ enabled: this.enabled(), alarm: await this.ctx.storage.getAlarm(), schedule: this.rows("SELECT * FROM schedule"), budgets: this.rows("SELECT * FROM daily"), runtime: "rust-wasm-durable-object" });
      if (request.method === "POST" && path === "/v1/start") {
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO settings VALUES('enabled',1)");
        await this.ctx.storage.setAlarm(Date.now() + 1);
        return Response.json({ enabled: true });
      }
      if (request.method === "POST" && path === "/v1/stop") {
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO settings VALUES('enabled',0)");
        await this.ctx.storage.deleteAlarm();
        return Response.json({ enabled: false, in_flight: this.running });
      }
      if (request.method === "GET" && path === "/v1/incidents") return Response.json({ incidents: this.rows("SELECT id,monitor,state,pending_action,approved_action,attempted,requests,created_at FROM incidents ORDER BY created_at DESC LIMIT 200") });
      if (request.method === "GET" && path === "/v1/invocations") return Response.json(this.scrub(this.rows("SELECT * FROM invocations ORDER BY expires DESC LIMIT 200")));
      const invocation = path.match(/^\/v1\/invocations\/([^/]+)\/approve$/);
      if (invocation && request.method === "POST") {
        const digest = await oneField(request, "digest");
        this.ctx.storage.transactionSync(() => {
          const row = this.rows<{ incident: string; config: string; state: string; digest: string; expires: number }>("SELECT * FROM invocations WHERE id=?", invocation[1])[0];
          if (!row || row.state !== "pending" || row.digest !== digest || row.config !== this.fingerprint || row.expires < Date.now() || this.incident(row.incident).state !== "awaiting_approval") throw new HttpError(409);
          this.ctx.storage.sql.exec("UPDATE invocations SET state='approved' WHERE id=?", invocation[1]);
          this.ctx.storage.sql.exec("UPDATE incidents SET state='queued',pending_action=NULL WHERE id=?", row.incident);
          this.audit(row.incident, "invocation_approved", { id: invocation[1], digest });
        });
        if (this.enabled()) await this.ctx.storage.setAlarm(Date.now() + 1);
        return Response.json({ approved: invocation[1] });
      }
      const match = path.match(/^\/v1\/incidents\/([^/]+)(\/approve)?$/);
      if (match && request.method === "GET" && !match[2]) {
        const i = this.incident(match[1]);
        return Response.json({ incident_id: i.id, history: this.rows("SELECT kind,detail,at FROM history WHERE incident=? ORDER BY seq", i.id) });
      }
      if (match && request.method === "POST" && match[2]) {
        const action = await oneField(request, "action");
        this.ctx.storage.transactionSync(() => {
          const i = this.incident(match[1]);
          if (action.startsWith("invocation:") || i.state !== "awaiting_approval" || i.pending_action !== action || i.attempted || i.config !== this.fingerprint) throw new HttpError(409);
          this.ctx.storage.sql.exec("UPDATE incidents SET state='queued',approved_action=?,pending_action=NULL WHERE id=?", action, i.id);
          this.audit(i.id, "approved", { action });
        });
        if (this.enabled()) await this.ctx.storage.setAlarm(Date.now() + 1);
        return Response.json({ approved_action: action });
      }
      if (event && request.method === "POST") {
        const monitor = await oneField(request, "monitor");
        if (!this.config.monitors.some(m => m.id === monitor)) throw new HttpError(404);
        const key = request.headers.get("idempotency-key");
        if (!key || new TextEncoder().encode(key).length > 128) throw new HttpError(400);
        const id = this.enqueue(monitor, key);
        if (this.enabled()) await this.ctx.storage.setAlarm(Date.now() + 1);
        return Response.json({ incident_id: id });
      }
      throw new HttpError(404);
    } catch (e) { return Response.json({ error: e instanceof HttpError || e instanceof TelemetryError ? e.message : "request unavailable" }, { status: e instanceof HttpError || e instanceof TelemetryError ? e.status : 503 }); }
  }

  private async health(m: Monitor, signal?: AbortSignal): Promise<{ healthy: boolean; status?: number }> {
    try {
      const r = await fetch(m.health_url, { redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(m.timeout_seconds * 1000)]) : AbortSignal.timeout(m.timeout_seconds * 1000) });
      await r.body?.cancel();
      return { healthy: r.status === m.expected_status, status: r.status };
    } catch { return { healthy: false }; }
  }
  private async inspect(i: Incident, m: Monitor, signal: AbortSignal): Promise<unknown> {
    const health = await this.health(m, signal);
    const diagnostics = [];
    for (const d of m.diagnostics) {
      try {
        const r = await fetch(d.url, { headers: this.applicationHeaders(), redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(m.timeout_seconds * 1000)]) });
        diagnostics.push({ name: d.name, status: r.status, body: this.clean(await bounded(r.body, 4096, true)) });
      } catch { diagnostics.push({ name: d.name, error: "diagnostic unavailable" }); }
    }
    const evidence = this.scrub({ health, diagnostics, telemetry: this.telemetry.evidence(m.id) });
    this.audit(i.id, "inspection", evidence);
    return evidence;
  }
  private applicationHeaders(): Headers { const h = new Headers(); if (this.env.APPLICATION_TOKEN) h.set("authorization", `Bearer ${this.env.APPLICATION_TOKEN}`); return h; }

  private reserve(i: Incident): void {
    const l = this.config.limits;
    this.ctx.storage.transactionSync(() => {
      const day = new Date().toISOString().slice(0, 10);
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO daily(day) VALUES(?)", day);
      const d = this.rows<{ requests: number; reserved: number }>("SELECT * FROM daily WHERE day=?", day)[0];
      if (d.requests >= l.daily_requests || d.reserved + l.reserve_per_request_microusd > l.daily_budget_microusd || this.incident(i.id).requests >= l.requests_per_incident) throw new Error("request admission limit");
      this.ctx.storage.sql.exec("UPDATE daily SET requests=requests+1,reserved=reserved+? WHERE day=?", l.reserve_per_request_microusd, day);
      this.ctx.storage.sql.exec("UPDATE incidents SET requests=requests+1 WHERE id=?", i.id);
      this.audit(i.id, "request_reserved", { day, microusd: l.reserve_per_request_microusd });
    });
  }

  private async executeTool(i: Incident, m: Monitor, tool: NonNullable<Monitor["tools"]>[number], args: unknown, id: string, signal: AbortSignal, privileged: boolean): Promise<unknown> {
    core.validateTool(tool, args);
    this.ctx.storage.transactionSync(() => {
      const fresh = this.incident(i.id);
      if (!this.enabled() || fresh.config !== this.fingerprint || signal.aborted) throw new Error("execution stopped");
      if (privileged) {
        const row = this.rows<{ state: string; expires: number }>("SELECT state,expires FROM invocations WHERE id=?", id)[0];
        if (!row || row.state !== "approved" || row.expires < Date.now() || fresh.attempted) throw new Error("authority unavailable");
        const day = new Date().toISOString().slice(0, 10);
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO daily(day) VALUES(?)", day);
        if (this.rows<{ actions: number }>("SELECT actions FROM daily WHERE day=?", day)[0].actions >= this.config.limits.daily_actions) throw new Error("action limit");
        this.ctx.storage.sql.exec("UPDATE daily SET actions=actions+1 WHERE day=?", day);
        this.ctx.storage.sql.exec("UPDATE incidents SET attempted=1 WHERE id=?", i.id);
        this.ctx.storage.sql.exec("UPDATE invocations SET state='claimed' WHERE id=?", id);
      }
      this.audit(i.id, "tool_claimed", { id, tool: tool.name, args });
    });
    try {
      const value = this.scrub(await this.tools.execute(tool, args, { monitor: m.id, invocation: id, signal, workspace: this.workspace, executorToken: this.env.EXECUTOR_TOKEN }));
      if (privileged) this.ctx.storage.sql.exec("UPDATE invocations SET state='completed',result=? WHERE id=?", JSON.stringify(value), id);
      this.audit(i.id, "tool_result", { id, value });
      return value;
    } catch (e) {
      if (privileged) this.ctx.storage.sql.exec("UPDATE invocations SET state='unknown' WHERE id=?", id);
      this.audit(i.id, "tool_failed", { id, outcome: privileged ? "unknown; reconcile with executor before retry" : "failed" });
      throw e;
    }
  }

  private async investigate(i: Incident, m: Monitor): Promise<void> {
    const signal = AbortSignal.timeout(this.config.limits.investigation_timeout_seconds * 1000);
    let phase = "initial_evidence";
    try {
      const initial = await this.health(m, signal);
      if (initial.healthy) { this.audit(i.id, "verification", initial); this.state(i.id, "resolved"); return; }
      const approved = this.rows<{ id: string; tool: string; args: string; expires: number; config: string }>("SELECT * FROM invocations WHERE incident=? AND state='approved'", i.id);
      for (const row of approved) {
        const tool = m.tools?.find(t => t.name === row.tool);
        if (!tool || row.config !== this.fingerprint || row.expires < Date.now()) throw new Error("expired invocation");
        await this.executeTool(i, m, tool, JSON.parse(row.args), row.id, signal, true);
      }
      if (approved.length) {
        const verified = await this.health(m, signal);
        this.audit(i.id, "verification", verified);
        this.state(i.id, verified.healthy ? "resolved" : "needs_attention");
        return;
      }
      let session = core.start({ incident: i.id, environment: m.environment, actions: m.actions.map(a => ({ name: a.name, description: a.description, automatic: a.auto_approve })), approved_action: i.approved_action, evidence: await this.inspect(i, m, signal) });
      for (let turn = 0; turn < this.config.limits.requests_per_incident; turn++) {
        phase = "request_admission";
        if (signal.aborted || !this.enabled()) throw new Error("investigation stopped");
        const p = this.config.provider;
        const body = JSON.stringify(core.request(session, p, m.actions, m.tools ?? []));
        this.reserve(i);
        const headers = new Headers({ "content-type": "application/json" });
        if (p.kind === "anthropic") { headers.set("x-api-key", this.env.PROVIDER_API_KEY); headers.set("anthropic-version", "2023-06-01"); }
        else headers.set("authorization", `Bearer ${this.env.PROVIDER_API_KEY}`);
        phase = "provider_request";
        const response = await fetch(p.base_url.replace(/\/$/, "") + (p.kind === "anthropic" ? "/messages" : "/chat/completions"), { method: "POST", headers, body, signal, redirect: "manual" });
        if (!response.ok) { await response.body?.cancel(); this.audit(i.id, "provider_failed", { status: response.status }); throw new Error("provider unavailable"); }
        phase = "provider_response";
        const value: unknown = JSON.parse(await bounded(response.body, 65536));
        const accepted = core.accept(session, p.kind, value);
        session = accepted.session;
        this.audit(i.id, "investigation", { text: accepted.reply.text });
        phase = "tool_decision";
        if (!accepted.reply.calls.length) break;
        const results = [];
        let stop = false;
        for (const call of accepted.reply.calls) {
          const current = this.incident(i.id);
          const decision = core.decision(m, call, current.approved_action, !!current.attempted);
          if (decision === "registered") {
            const tool = m.tools?.find(t => t.name === call.name);
            if (!tool) throw new Error("unavailable tool");
            core.validateTool(tool, call.arguments);
            if (JSON.stringify(this.scrub(call.arguments)) !== JSON.stringify(call.arguments)) throw new Error("credential-bearing invocation rejected");
            if (tool.effect === "privileged") {
              const id = crypto.randomUUID();
              const digest = await invocationDigest({ id, incident: i.id, config: this.fingerprint, tool, args: call.arguments });
              this.ctx.storage.transactionSync(() => {
                if (this.incident(i.id).attempted) throw new Error("action already attempted");
                this.ctx.storage.sql.exec("INSERT INTO invocations VALUES(?,?,?,?,?,?,'pending',?,NULL)", id, i.id, tool.name, JSON.stringify(call.arguments), digest, this.fingerprint, Date.now() + 3600000);
                this.ctx.storage.sql.exec("UPDATE incidents SET pending_action=? WHERE id=?", `invocation:${id}`, i.id);
                this.audit(i.id, "invocation_pending", { id, digest, tool: tool.name, args: call.arguments });
              });
              stop = true; break;
            }
            try {
              const value = await this.executeTool(i, m, tool, call.arguments, crypto.randomUUID(), signal, false);
              results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(value) });
            } catch { results.push({ type: "tool_result", tool_use_id: call.id, content: "tool failed; inspect audit and workspace state before retry", is_error: true }); }
          }
          else if (decision === "inspect") results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(await this.inspect(i, m, signal)) });
          else if (decision === "execute" || decision === "approval_required") {
            const action = m.actions.find(a => typeof call.arguments === "object" && call.arguments !== null && "action" in call.arguments && a.name === call.arguments.action);
            if (!action) throw new Error("invalid driver action");
            if (decision === "approval_required") {
              this.ctx.storage.transactionSync(() => {
                this.ctx.storage.sql.exec("UPDATE incidents SET pending_action=? WHERE id=?", action.name, i.id);
                this.audit(i.id, "approval_required", { action: action.name });
              });
            } else {
              this.ctx.storage.transactionSync(() => {
                const fresh = this.incident(i.id);
                if (!this.enabled() || fresh.attempted || fresh.config !== this.fingerprint || signal.aborted) throw new Error("action unavailable");
                const day = new Date().toISOString().slice(0, 10);
                this.ctx.storage.sql.exec("INSERT OR IGNORE INTO daily(day) VALUES(?)", day);
                const count = this.rows<{ actions: number }>("SELECT actions FROM daily WHERE day=?", day)[0].actions;
                if (count >= this.config.limits.daily_actions) throw new Error("action limit");
                this.ctx.storage.sql.exec("UPDATE daily SET actions=actions+1 WHERE day=?", day);
                this.ctx.storage.sql.exec("UPDATE incidents SET attempted=1,approved_action=NULL WHERE id=?", i.id);
                this.audit(i.id, "action_claimed", { action: action.name });
              });
              let outcome = "unknown";
              try {
                const h = this.applicationHeaders(); h.set("content-type", "application/json"); h.set("idempotency-key", `${i.id}:${action.name}`);
                const r = await fetch(action.url, { method: "POST", headers: h, body: JSON.stringify({ incident_id: i.id }), redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(m.timeout_seconds * 1000)]) });
                outcome = r.ok ? "accepted" : "rejected"; await r.body?.cancel();
              } catch { /* The durable claim remains consumed when the outcome is unknown. */ }
              this.audit(i.id, "action_outcome", { outcome });
            }
            stop = true; break;
          } else {
            this.audit(i.id, "tool_denied", { name: call.name });
            results.push({ type: "tool_result", tool_use_id: call.id, content: "tool denied", is_error: true });
          }
        }
        if (stop) break;
        session = core.results(session, results);
      }
    } catch (e) { this.audit(i.id, "investigation_stopped", { phase, reason: e instanceof Error && ["unsupported provider content", "invalid provider response", "context limit reached", "request admission limit", "action limit", "investigation stopped"].includes(e.message) ? e.message : "provider error, timeout, configuration change or configured limit" }); }
    const health = await this.health(m);
    this.audit(i.id, "verification", health);
    const current = this.incident(i.id);
    this.state(i.id, health.healthy ? "resolved" : current.pending_action ? "awaiting_approval" : "needs_attention");
  }

  async alarm(): Promise<void> {
    if (!this.enabled()) return;
    // Persist the next wake-up before external I/O; a crash cannot silently stop monitoring.
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    if (this.running) return;
    this.running = true;
    try {
      this.telemetry.expire();
      for (const m of this.config.monitors) {
        if (!this.enabled()) break;
        const next = this.rows<{ next_at: number }>("SELECT next_at FROM schedule WHERE monitor=?", m.id)[0]?.next_at ?? 0;
        if (Date.now() >= next) {
          this.ctx.storage.sql.exec("INSERT OR REPLACE INTO schedule VALUES(?,?)", m.id, Date.now() + m.interval_seconds * 1000);
          const started = Date.now();
          const health = await this.health(m);
          this.ctx.storage.sql.exec("INSERT INTO probes(service,at,healthy,status,duration_ms) VALUES(?,?,?,?,?)", m.id, started, health.healthy ? 1 : 0, health.status ?? null, Date.now() - started);
          this.ctx.storage.sql.exec("DELETE FROM probes WHERE seq <= (SELECT max(seq)-10000 FROM probes)");
          if (!health.healthy) this.enqueue(m.id);
          else {
            for (const i of this.rows<Incident>("SELECT * FROM incidents WHERE monitor=? AND state IN ('queued','awaiting_approval','needs_attention')", m.id)) {
              this.audit(i.id, "verification", health); this.state(i.id, "resolved");
            }
          }
        }
      }
      const i = this.rows<Incident>("SELECT * FROM incidents WHERE state='queued' ORDER BY created_at LIMIT 1")[0];
      if (i && this.enabled()) {
        const m = this.config.monitors.find(m => m.id === i.monitor);
        if (!m || i.config !== this.fingerprint) { this.state(i.id, "needs_attention"); this.audit(i.id, "configuration_changed", {}); }
        else { this.state(i.id, "investigating"); await this.investigate(i, m); }
      }
    } finally {
      this.running = false;
      if (this.enabled()) await this.ctx.storage.setAlarm(Date.now() + 5000);
      else await this.ctx.storage.deleteAlarm();
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/healthz") return Response.json({ status: "ok", runtime: "rust-wasm-durable-object", engine: core.runtime() });
    return env.ROUNDHOUSE.getByName("controller").fetch(request);
  },
} satisfies ExportedHandler<Env>;

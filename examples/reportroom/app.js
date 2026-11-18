import { DurableObject } from "cloudflare:workers";

const MAX_JOBS = 25;
const MAX_BODY = 256;
const ALARM_DELAY = 1000;
const FIRST_DAY = Date.UTC(2026, 0, 1);
const DAY = 86400000;
const JOB_FIELDS = "id,period,state,created_at,completed_at,sha256,rows,order_count,revenue_cents";
const REPORT_FIELDS = `${JOB_FIELDS},title,group_by`;
const PREVIEW_ROWS = 10;

function safeText(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 80
    && value === value.trim() && !/[\p{Cc}\p{Cf}<>]/u.test(value);
}

function error(message, status) {
  return Response.json({ error: message }, { status });
}

async function jsonBody(request) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw error("application/json required", 415);
  }
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw error("body too large", 413);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw error("invalid JSON", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw error("object required", 400);
  return body;
}

export class ReportApplication extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims(key TEXT PRIMARY KEY, fault INTEGER NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,day TEXT NOT NULL,revenue_cents INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY,period INTEGER NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,
        completed_at TEXT,sha256 TEXT,rows INTEGER,order_count INTEGER,revenue_cents INTEGER,csv TEXT
      );
    `);
    const columns = ctx.storage.sql.exec("PRAGMA table_info(jobs)").toArray().map(column => column.name);
    if (!columns.includes("title")) ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN title TEXT NOT NULL DEFAULT 'Sales report'");
    if (!columns.includes("group_by")) ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN group_by TEXT NOT NULL DEFAULT 'day'");
    ctx.storage.transactionSync(() => {
      if (this.value("initialized")) return;
      let id = 1;
      for (let d = 0; d < 30; d++) {
        const day = new Date(FIRST_DAY + d * DAY).toISOString().slice(0, 10);
        for (let j = 0; j < 3 + d % 6; j++) {
          const cents = 1200 + d * 137 + j * 499 + (d * j % 7) * 83;
          ctx.storage.sql.exec("INSERT INTO orders VALUES(?,?,?)", id++, day, cents);
        }
      }
      this.put("running", 1);
      this.put("recovering", 0);
      this.put("recoveries", 0);
      this.put("fault", 0);
      this.put("initialized", 1);
    });
  }

  value(key) { return this.ctx.storage.sql.exec("SELECT value FROM settings WHERE key=?", key).toArray()[0]?.value; }
  put(key, value) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO settings VALUES(?,?)", key, String(value)); }
  jobs() { return this.ctx.storage.sql.exec(`SELECT ${JOB_FIELDS} FROM jobs ORDER BY created_at,id`).toArray(); }
  preferences() {
    const stored = this.value("preferences");
    return stored ? JSON.parse(stored) : { name: "My workspace", default_period: 30, default_group_by: "day", onboarded: false };
  }
  workspace() {
    const totals = this.ctx.storage.sql.exec("SELECT COUNT(*) AS orders,SUM(revenue_cents) AS revenue_cents FROM orders").toArray()[0];
    return {
      preferences: this.preferences(),
      dataset: { name: "Demo store sales", currency: "USD", from: "2026-01-01", to: "2026-01-30", synthetic: true },
      overview: { ...totals, average_order_cents: Math.round(totals.revenue_cents / totals.orders) },
      daily: this.ctx.storage.sql.exec("SELECT day,COUNT(*) AS order_count,SUM(revenue_cents) AS revenue_cents FROM orders GROUP BY day ORDER BY day").toArray(),
      recent_orders: this.ctx.storage.sql.exec("SELECT id,day,revenue_cents FROM orders ORDER BY day DESC,id DESC LIMIT 10").toArray(),
      reports: this.ctx.storage.sql.exec(`SELECT ${REPORT_FIELDS} FROM jobs ORDER BY created_at DESC,id DESC`).toArray(),
    };
  }
  status() {
    const jobs = this.jobs();
    const running = this.value("running") === "1";
    const recovering = this.value("recovering") === "1";
    return {
      healthy: running && !recovering && !jobs.some(job => job.state === "failed"),
      worker_running: running,
      recovering,
      recoveries: Number(this.value("recoveries")),
      orders: this.ctx.storage.sql.exec("SELECT COUNT(*) AS count,SUM(revenue_cents) AS revenue_cents FROM orders").toArray()[0],
      jobs,
    };
  }
  queue(period, title = "Sales report", groupBy = "day") {
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO jobs(id,period,state,created_at,title,group_by) VALUES(?,?,'queued',?,?,?)", id, period, new Date().toISOString(), title, groupBy);
    return this.ctx.storage.sql.exec(`SELECT ${JOB_FIELDS} FROM jobs WHERE id=?`, id).toArray()[0];
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!(url.pathname === "/health" && request.method === "GET")) {
      if (typeof this.env.APPLICATION_TOKEN !== "string" || !this.env.APPLICATION_TOKEN.length) return error("unauthorized", 401);
      const encode = new TextEncoder();
      const [actual, expected] = await Promise.all([
        crypto.subtle.digest("SHA-256", encode.encode(request.headers.get("authorization") ?? "")),
        crypto.subtle.digest("SHA-256", encode.encode(`Bearer ${this.env.APPLICATION_TOKEN}`)),
      ]);
      if (!crypto.subtle.timingSafeEqual(actual, expected)) return error("unauthorized", 401);
    }
    if (url.search) return error("query parameters not allowed", 400);
    const download = /^\/reports\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.csv$/.exec(url.pathname);
    const detail = /^\/reports\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
    const method = url.pathname === "/workspace" ? (request.method === "POST" ? "POST" : "GET")
      : ["/health", "/status"].includes(url.pathname) || download || detail ? "GET"
      : ["/reports", "/fault", "/recover", "/reset"].includes(url.pathname) ? "POST" : null;
    if (!method) return error("not found", 404);
    if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: url.pathname === "/workspace" ? "GET, POST" : method } });
    if (method === "GET") {
      if (request.body) return error("body not allowed", 400);
      if (url.pathname === "/health") {
        const { healthy } = this.status();
        return Response.json({ healthy }, { status: healthy ? 200 : 503 });
      }
      if (url.pathname === "/status") return Response.json(this.status());
      if (url.pathname === "/workspace") return Response.json(this.workspace());
      if (detail) {
        const job = this.ctx.storage.sql.exec(`SELECT ${REPORT_FIELDS},csv FROM jobs WHERE id=?`, detail[1]).toArray()[0];
        if (!job) return error("report not found", 404);
        const { csv, ...metadata } = job;
        const lines = job.state === "completed" ? csv.trimEnd().split("\n") : [];
        const columns = lines.length ? lines[0].split(",") : [];
        const rows = lines.slice(1, PREVIEW_ROWS + 1).map(line => {
          const values = line.split(",");
          return Object.fromEntries(columns.map((column, index) => [column, index === 0 ? values[index] : Number(values[index])]));
        });
        return Response.json({ ...metadata, preview: { columns, rows, truncated: job.rows > PREVIEW_ROWS },
          download_url: job.state === "completed" ? `/reports/${job.id}.csv` : null });
      }
      const job = this.ctx.storage.sql.exec("SELECT state,csv FROM jobs WHERE id=?", download[1]).toArray()[0];
      if (!job) return error("report not found", 404);
      if (job.state !== "completed") return error("report not completed", 409);
      return new Response(job.csv, { headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="report-${download[1]}.csv"`,
        "Cache-Control": "no-store",
      } });
    }
    let body;
    try { body = await jsonBody(request); }
    catch (response) { if (response instanceof Response) return response; throw response; }
    const keys = Object.keys(body);
    if (url.pathname === "/workspace") {
      if (keys.length !== 4 || keys.some(key => !["name", "default_period", "default_group_by", "onboarded"].includes(key))
        || !safeText(body.name) || ![7, 30].includes(body.default_period)
        || !["day", "week"].includes(body.default_group_by) || typeof body.onboarded !== "boolean") {
        return error("full valid workspace preferences required", 400);
      }
      this.put("preferences", JSON.stringify(body));
      return Response.json({ preferences: this.preferences() });
    }
    if (url.pathname === "/reports") {
      if (keys.some(key => !["period", "title", "group_by"].includes(key)) || ![7, 30].includes(body.period)
        || ("title" in body && !safeText(body.title)) || ("group_by" in body && !["day", "week"].includes(body.group_by))) {
        return error("period must be 7 or 30; optional valid title and day/week group_by required", 400);
      }
      if (this.jobs().length >= MAX_JOBS) return error("report limit reached; reset demo reports", 409);
      const job = this.queue(body.period, body.title, body.group_by);
      if (this.value("running") === "1") await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY);
      return Response.json(job, { status: 202 });
    }
    const recoveryMetadata = url.pathname === "/recover" && keys.length === 1 && keys[0] === "incident_id"
      && typeof body.incident_id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(body.incident_id);
    if (keys.length && !recoveryMetadata) return error("empty object or recovery incident metadata required", 400);
    if (url.pathname === "/fault") {
      if (this.value("running") !== "1" || this.value("recovering") === "1") return error("fault already active", 409);
      if (this.jobs().length >= MAX_JOBS) return error("report limit reached; reset demo reports", 409);
      this.ctx.storage.transactionSync(() => {
        this.put("running", 0);
        this.put("fault", Number(this.value("fault")) + 1);
        this.queue(7);
      });
      await this.ctx.storage.deleteAlarm();
      return Response.json(this.status());
    }
    if (url.pathname === "/recover") {
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return error("valid Idempotency-Key required", 400);
      const replay = this.ctx.storage.sql.exec("SELECT key FROM claims WHERE key=?", key).toArray().length > 0;
      if (replay) return Response.json({ accepted: true }, { status: 202 });
      const fault = Number(this.value("fault"));
      if (this.value("running") === "1" || this.ctx.storage.sql.exec("SELECT key FROM claims WHERE fault=?", fault).toArray().length) {
        return error("no unclaimed fault", 409);
      }
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("INSERT INTO claims VALUES(?,?)", key, fault);
        this.put("recoveries", Number(this.value("recoveries")) + 1);
        this.put("running", 1);
        this.put("recovering", 1);
      });
      await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY);
      return Response.json({ accepted: true }, { status: 202 });
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM jobs");
      this.put("running", 1);
      this.put("recovering", 0);
    });
    await this.ctx.storage.deleteAlarm();
    return Response.json(this.status());
  }

  async alarm() {
    if (this.value("running") !== "1") return;
    for (const job of this.ctx.storage.sql.exec("SELECT id,period,group_by FROM jobs WHERE state='queued'").toArray()) {
      const since = new Date(FIRST_DAY + (30 - job.period) * DAY).toISOString().slice(0, 10);
      let days = this.ctx.storage.sql.exec(`SELECT day,COUNT(*) AS order_count,SUM(revenue_cents) AS revenue_cents
        FROM orders WHERE day>=? GROUP BY day ORDER BY day`, since).toArray();
      if (job.group_by === "week") {
        const weeks = new Map();
        for (const day of days) {
          const date = new Date(`${day.day}T00:00:00Z`);
          const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
          const week = weeks.get(monday) ?? { day: monday, order_count: 0, revenue_cents: 0 };
          week.order_count += day.order_count;
          week.revenue_cents += day.revenue_cents;
          weeks.set(monday, week);
        }
        days = [...weeks.values()];
      }
      const csv = `${job.group_by === "week" ? "week_start" : "date"},order_count,revenue_cents\n`
        + days.map(day => `${day.day},${day.order_count},${day.revenue_cents}\n`).join("");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv));
      const sha256 = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("");
      if (this.value("running") !== "1") return;
      const count = days.reduce((sum, day) => sum + day.order_count, 0);
      const revenue = days.reduce((sum, day) => sum + day.revenue_cents, 0);
      this.ctx.storage.sql.exec(`UPDATE jobs SET state='completed',completed_at=?,sha256=?,rows=?,order_count=?,revenue_cents=?,csv=?
        WHERE id=? AND state='queued'`, new Date().toISOString(), sha256, days.length, count, revenue, csv, job.id);
    }
    if (this.value("running") !== "1") return;
    if (this.ctx.storage.sql.exec("SELECT id FROM jobs WHERE state='queued' LIMIT 1").toArray().length) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY);
    } else {
      this.put("recovering", 0);
    }
  }
}

export default {
  fetch(request, env) {
    return env.REPORTS.getByName("shop").fetch(request);
  },
};

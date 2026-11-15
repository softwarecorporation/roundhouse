import { DurableObject } from "cloudflare:workers";

export class TestApplication extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims(key TEXT PRIMARY KEY);`);
  }
  value(key) { return this.ctx.storage.sql.exec("SELECT value FROM settings WHERE key=?", key).toArray()[0]?.value; }
  put(key, value) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO settings VALUES(?,?)", key, String(value)); }
  status() {
    const jobs = this.ctx.storage.sql.exec("SELECT * FROM jobs ORDER BY id").toArray();
    const healthy = this.value("running") === "1" && jobs.length > 0 && jobs.every(j => j.result);
    return { healthy, worker_running: this.value("running") === "1", recoveries: Number(this.value("recoveries") ?? 0), jobs };
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") { const state = this.status(); return Response.json({ healthy: state.healthy }, { status: state.healthy ? 200 : 503 }); }
    const expected = path.endsWith("/chat/completions") ? this.env.FIXTURE_TOKEN : this.env.APP_TOKEN;
    const token = request.headers.get("authorization");
    const enc = new TextEncoder();
    const a = await crypto.subtle.digest("SHA-256", enc.encode(token ?? ""));
    const b = await crypto.subtle.digest("SHA-256", enc.encode(`Bearer ${expected}`));
    if (!crypto.subtle.timingSafeEqual(a, b)) return new Response("unauthorized", { status: 401 });
    if (path === "/status") return Response.json(this.status());
    if (path === "/fault" && request.method === "POST") {
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM jobs; DELETE FROM claims;");
        this.put("running", 0); this.put("recoveries", 0);
        for (const [id, payload] of ["alpha", "βeta", "gamma"].entries()) this.ctx.storage.sql.exec("INSERT INTO jobs VALUES(?,?,NULL)", id, payload);
      });
      return Response.json(this.status());
    }
    if (path === "/recover" && request.method === "POST") {
      const key = request.headers.get("idempotency-key");
      if (!key) return new Response("missing idempotency key", { status: 400 });
      this.ctx.storage.transactionSync(() => {
        if (!this.ctx.storage.sql.exec("SELECT key FROM claims WHERE key=?", key).toArray().length) {
          this.ctx.storage.sql.exec("INSERT INTO claims VALUES(?)", key);
          this.put("recoveries", Number(this.value("recoveries") ?? 0) + 1);
          this.put("running", 1);
        }
      });
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (path.endsWith("/chat/completions") && request.method === "POST") {
      const body = await request.json();
      const inspected = body.messages.some(m => m.role === "tool");
      const name = inspected ? "request_recovery" : "inspect_system";
      return Response.json({ choices: [{ message: { role: "assistant", content: "Fixture: stopped queue worker requires configured restart.", tool_calls: [{ id: crypto.randomUUID(), type: "function", function: { name, arguments: inspected ? '{"action":"restart_worker"}' : "{}" } }] }, finish_reason: "tool_calls" }] });
    }
    return new Response("not found", { status: 404 });
  }
  async alarm() {
    if (this.value("running") !== "1") return;
    for (const job of this.ctx.storage.sql.exec("SELECT * FROM jobs WHERE result IS NULL").toArray()) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(job.payload));
      const result = Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, "0")).join("");
      this.ctx.storage.sql.exec("UPDATE jobs SET result=? WHERE id=?", result, job.id);
    }
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const [, instance, ...parts] = url.pathname.split("/");
    if (!["auto", "approval"].includes(instance)) return new Response("not found", { status: 404 });
    url.pathname = "/" + parts.join("/");
    return env.APP.getByName(instance).fetch(new Request(url, request));
  },
};

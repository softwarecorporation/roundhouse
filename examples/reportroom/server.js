// SPDX-License-Identifier: MPL-2.0
import { resolve } from "node:path";
import { mkdir, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRuntime } from "./runtime.js";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function createDemo(options = {}) {
  const runtime = await createRuntime(options);
  let mutation = Promise.resolve();
  async function capture(name, properties = {}) {
    await runtime.json("/v1/telemetry", [{ id: randomUUID(), service: "reportroom", kind: "event", name, distinct_id: "demo-workspace", timestamp: Date.now(), properties }], { token: runtime.tokens.event });
  }
  async function snapshot() {
    const [app, status, list, telemetry, probes] = await Promise.all([
      runtime.app("/status"), runtime.json("/v1/status"), runtime.json("/v1/incidents"),
      runtime.json("/v1/telemetry?service=reportroom&kind=event"), runtime.json("/v1/probes?service=reportroom"),
    ]);
    const incidents = await Promise.all(list.incidents.slice(0, 10).map(async incident => ({ ...incident, history: (await runtime.json(`/v1/incidents/${encodeURIComponent(incident.id)}`)).history })));
    return {
      app, monitoring: { enabled: status.enabled, incidents, events: telemetry.records, probes: probes.observations, budgets: status.budgets },
      provider: { ...runtime.stats }, limits: runtime.limits,
      capabilities: { fault_allowed: app.healthy && !incidents.some(i => i.state !== "resolved"), reset_allowed: true },
    };
  }
  async function appMutation(path, body) {
    const response = await runtime.request(path, body, { app: true });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, response.status === 409 ? "The demo operation conflicts with the current queue state or report limit. Refresh or reset reports." : "The report request was rejected.");
    }
    return response.json();
  }
  async function mutate(path, body) {
    if (path === "/api/reports") {
      if (Object.keys(body).length !== 1 || ![7, 30].includes(body.period)) throw new HttpError(400, "Choose a 7-day or 30-day report.");
      const job = await appMutation("/reports", body);
      await capture("report.queued", { period: body.period });
      return job;
    }
    if (Object.keys(body).length) throw new HttpError(400, "This demo operation takes no arguments.");
    if (path === "/api/fault") {
      const state = await snapshot();
      if (!state.capabilities.fault_allowed) throw new HttpError(409, "Wait for the current incident to resolve before starting another drill.");
      const result = await appMutation("/fault", {});
      await capture("worker.paused", { reason: "operator_injected_demo_fault" });
      await capture("report.queued", { period: 7, source: "failure_drill" });
      await runtime.json("/v1/events", { monitor: "reportroom" }, { token: runtime.tokens.event, headers: { "idempotency-key": randomUUID() } });
      return result;
    }
    if (path === "/api/reset") {
      const result = await appMutation("/reset", {});
      await capture("demo.reports_reset", { history_retained: true });
      return result;
    }
    const approve = path.match(/^\/api\/incidents\/([a-zA-Z0-9_-]+)\/approve$/);
    if (approve) {
      const state = await snapshot();
      const incident = state.monitoring.incidents.find(i => i.id === approve[1]);
      if (state.app.worker_running || !incident || incident.state !== "awaiting_approval" || incident.pending_action !== "resume_exports") throw new HttpError(409, "This recovery is not pending approval. Refresh the incident.");
      const response = await runtime.request(`/v1/incidents/${approve[1]}/approve`, { action: "resume_exports" });
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(409, "Approval was stale, changed, or already consumed."); }
      await capture("recovery.approved", { incident_id: incident.id });
      return response.json();
    }
    throw new HttpError(404, "Demo route not found.");
  }
  const security = {
    "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  async function handle(request) {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && path === "/api/state") return Response.json(await snapshot());
      const csv = path.match(/^\/api\/reports\/([a-zA-Z0-9_-]+)\.csv$/);
      if (request.method === "GET" && csv) return runtime.request(`/reports/${csv[1]}.csv`, undefined, { app: true });
      if (request.method === "POST") {
        // This non-safelisted header plus no CORS prevents cross-site forms/fetches.
        // It is not authentication: this isolated single-user demo has no customer accounts.
        if (request.headers.get("x-reportroom-demo") !== "1" || request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Use the Reportroom demo controls from this page.");
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "Use application/json.");
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > 4096) throw new HttpError(413, "Demo request too large.");
        let body;
        try { body = JSON.parse(raw); } catch { throw new HttpError(400, "Invalid JSON."); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected a JSON object.");
        const next = mutation.then(() => mutate(path, body));
        mutation = next.catch(() => {});
        return Response.json(await next);
      }
      const assets = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
      if (request.method === "GET" && Object.hasOwn(assets, path)) return new Response(Bun.file(resolve(import.meta.dir, "public", assets[path])));
      throw new HttpError(404, "Demo route not found.");
    } catch (error) {
      return Response.json({ error: error instanceof HttpError ? error.message : "Demo operation failed. Refresh state and check that the local runtime is running." }, { status: error instanceof HttpError ? error.status : 500 });
    }
  }
  return {
    runtime, snapshot,
    async fetch(request) {
      const response = await handle(request);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(security)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    },
    async close() { await mutation; await runtime.close(); },
  };
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, ".data");
  try {
    try { if ((await lstat(directory)).isSymbolicLink()) throw new Error("State directory must not be a symlink"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const demo = await createDemo({ provider: process.env.DEMO_PROVIDER ?? "fixture", persistence: directory });
    const server = Bun.serve({ hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3200), maxRequestBodySize: 4096, fetch: demo.fetch });
    console.log(`Reportroom ready on port ${server.port}. Provider mode: ${demo.runtime.stats.mode}. Synthetic data only.`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      server.stop(true);
      await demo.close();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch {
    console.error("Reportroom could not start. Check the runtime build, local state, port, and provider configuration. No credentials were logged.");
    process.exit(1);
  }
}

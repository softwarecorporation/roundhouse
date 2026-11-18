// SPDX-License-Identifier: MPL-2.0
import { Miniflare } from "miniflare";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export async function createRuntime({ provider = "fixture", persistence = false, requireApproval = false, key = process.env.ANTHROPIC_API_KEY, model = process.env.DEMO_MODEL ?? "claude-haiku-5-5" } = {}) {
  if (typeof requireApproval !== "boolean") throw new Error("requireApproval must be a boolean");
  if (!["fixture", "anthropic"].includes(provider)) throw new Error("DEMO_PROVIDER must be fixture or anthropic");
  if (provider === "anthropic" && !key?.trim()) throw new Error("Live mode requires ANTHROPIC_API_KEY; use fixture mode without credentials");
  const root = fileURLToPath(new URL(".", import.meta.url));
  const packageRoot = resolve(root, "../../npm");
  try { await access(resolve(packageRoot, "dist/workers.js")); }
  catch { throw new Error("Roundhouse runtime missing. Run bun run prepare:runtime from examples/reportroom."); }
  const tokens = { operator: randomUUID(), event: randomUUID(), application: randomUUID() };
  const stats = { mode: provider, model: provider === "fixture" ? "scripted-fixture" : model, requests: 0, input_tokens: 0, output_tokens: 0 };
  const limits = { daily_budget_microusd: 500000, reserve_per_request_microusd: 25000, daily_requests: 20, requests_per_incident: 4, daily_actions: 5, investigation_timeout_seconds: 30 };
  const config = {
    provider: { kind: provider === "fixture" ? "openai_compatible" : "anthropic", base_url: provider === "fixture" ? "https://model.test/v1" : "https://api.anthropic.com/v1", model: stats.model, max_output_tokens: 1024 },
    limits,
    monitors: [{ id: "reportroom", health_url: "https://reportroom.test/health", expected_status: 200, interval_seconds: 5, timeout_seconds: 2,
      environment: "production", diagnostics: [{ name: "export_queue", url: "https://reportroom.test/status" }],
      actions: [{ name: "resume_exports", description: "Resume Reportroom's paused demo export worker. It only generates CSV files from synthetic shop orders. No external systems or customer data.", url: "https://reportroom.test/recover", auto_approve: false }],
    }],
  };
  let mf;
  mf = new Miniflare({ durableObjectsPersist: persistence, workers: [{
    name: "router", compatibilityDate: "2026-08-06", modules: true,
    script: `export default {fetch(request,env) {
      const path=new URL(request.url).pathname;
      if(path.startsWith('/__app/')) return env.APPLICATION.fetch(new Request('https://reportroom.test'+path.slice(6),request));
      return env.CONTROLLER.fetch(request);
    }};`,
    serviceBindings: { APPLICATION: "app", CONTROLLER: "roundhouse" },
    outboundService: () => { throw new Error("Router egress denied"); },
  }, {
    name: "app", compatibilityDate: "2026-08-06", modulesRoot: root, modules: [{ type: "ESModule", path: resolve(root, "app.js") }],
    durableObjects: { REPORTS: { className: "ReportApplication", useSQLite: true } },
    bindings: { APPLICATION_TOKEN: tokens.application },
    outboundService: () => { throw new Error("Application egress denied"); },
  }, {
    name: "roundhouse", compatibilityDate: "2026-08-06", modulesRoot: packageRoot,
    modules: [{ type: "ESModule", path: resolve(packageRoot, "reportroom-policy.js"), contents: `
      import worker, { Roundhouse as Controller } from './dist/workers.js';
      export default worker;
      export class Roundhouse extends Controller {
        constructor(ctx, env) {
          const sql = ctx.storage.sql;
          const initialized = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='incidents'").toArray().length > 0;
          sql.exec('CREATE TABLE IF NOT EXISTS reportroom_policy(key TEXT PRIMARY KEY,value INTEGER NOT NULL)');
          sql.exec("INSERT OR IGNORE INTO reportroom_policy VALUES('require_approval',?)", initialized || env.REQUIRE_APPROVAL ? 1 : 0);
          const manual = sql.exec("SELECT value FROM reportroom_policy WHERE key='require_approval'").toArray()[0].value === 1;
          const config = JSON.parse(env.ROUNDHOUSE_CONFIG);
          config.monitors[0].actions[0].auto_approve = !manual;
          super(ctx, { ...env, ROUNDHOUSE_CONFIG: JSON.stringify(config) });
        }
      }
    ` }, { type: "ESModule", path: resolve(packageRoot, "dist/workers.js") }, { type: "CompiledWasm", path: resolve(packageRoot, "wasm/roundhouse_core_bg.wasm") }],
    durableObjects: { ROUNDHOUSE: { className: "Roundhouse", useSQLite: true } },
    bindings: { ROUNDHOUSE_CONFIG: JSON.stringify(config), REQUIRE_APPROVAL: requireApproval, OPERATOR_TOKEN: tokens.operator, EVENT_TOKEN: tokens.event, APPLICATION_TOKEN: tokens.application, PROVIDER_API_KEY: provider === "fixture" ? randomUUID() : key },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.origin === "https://reportroom.test") return mf.dispatchFetch("https://router.test/__app" + url.pathname, {
        method: request.method, headers: { ...Object.fromEntries(request.headers), connection: "close" },
        body: request.method === "POST" ? await request.arrayBuffer() : undefined,
      });
      if (provider === "fixture" && request.url === "https://model.test/v1/chat/completions" && request.method === "POST") {
        stats.requests++;
        const body = await request.json();
        const inspected = body.messages.some(message => message.role === "tool");
        return Response.json({ choices: [{ message: { role: "assistant", content: "Deterministic fixture, not model reasoning: the export worker is paused; request its configured resume action after inspection.", tool_calls: [{ id: randomUUID(), type: "function", function: { name: inspected ? "request_recovery" : "inspect_system", arguments: inspected ? '{"action":"resume_exports"}' : "{}" } }] } }] });
      }
      if (provider === "anthropic" && request.url === "https://api.anthropic.com/v1/messages" && request.method === "POST") {
        stats.requests++;
        const response = await fetch(request.url, { method: "POST", headers: Object.fromEntries(request.headers), body: await request.arrayBuffer(), signal: request.signal, redirect: "error" });
        if (response.ok) {
          const body = await response.clone().json();
          stats.input_tokens += body.usage?.input_tokens ?? 0;
          stats.output_tokens += body.usage?.output_tokens ?? 0;
        }
        return response;
      }
      throw new Error("Roundhouse demo egress denied");
    },
  }] });
  async function request(path, body, { app = false, token = app ? tokens.application : tokens.operator, headers = {} } = {}) {
    const response = await mf.dispatchFetch(`https://router.test${app ? "/__app" : ""}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  }
  async function json(path, body, options) {
    const response = await request(path, body, options);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Demo upstream returned HTTP ${response.status}`); }
    return response.json();
  }
  try {
    await mf.ready;
    await json("/v1/start", {});
  } catch (error) { await mf.dispose(); throw error; }
  return { mf, tokens, stats, limits, request, json, app: (path, body) => json(path, body, { app: true }),
    async close() { try { await json("/v1/stop", {}); } finally { await mf.dispose(); } },
  };
}

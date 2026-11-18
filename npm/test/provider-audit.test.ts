import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";
import type { Config } from "../src/types.js";

type Fixture = {
  name: string;
  provider: Config["provider"]["kind"];
  usage?: unknown;
  mode?: "http_error" | "invalid_json" | "transport_error" | "timeout";
  input: number | null;
  output: number | null;
};

test("provider_call audits reported usage, timing and failures without request or response content", async () => {
  const root = process.env.ROUNDHOUSE_PACKAGE_DIR ?? resolve(import.meta.dir, "..");
  const fixtures: Fixture[] = [
    { name: "anthropic", provider: "anthropic", usage: { input_tokens: 123, output_tokens: 45, cache_creation_input_tokens: 900 }, input: 123, output: 45 },
    { name: "openai", provider: "openai_compatible", usage: { prompt_tokens: 67, completion_tokens: 0, total_tokens: 67 }, input: 67, output: 0 },
    { name: "anthropic-missing", provider: "anthropic", input: null, output: null },
    { name: "openai-missing", provider: "openai_compatible", usage: {}, input: null, output: null },
    { name: "anthropic-invalid", provider: "anthropic", usage: { input_tokens: -1, output_tokens: "4" }, input: null, output: null },
    { name: "openai-invalid", provider: "openai_compatible", usage: { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 1.5 }, input: null, output: null },
    { name: "openai-partial", provider: "openai_compatible", usage: { prompt_tokens: 19, completion_tokens: null }, input: 19, output: null },
    { name: "http-error", provider: "anthropic", mode: "http_error", input: null, output: null },
    { name: "invalid-json", provider: "openai_compatible", mode: "invalid_json", input: null, output: null },
    { name: "transport-error", provider: "anthropic", mode: "transport_error", input: null, output: null },
    { name: "timeout", provider: "openai_compatible", mode: "timeout", input: null, output: null },
  ];
  const calls = new Map<string, number>();
  const mf = new Miniflare({ workers: fixtures.map(fixture => {
    const config: Config = {
      provider: { kind: fixture.provider, base_url: "https://provider.test/v1", model: "audit-fixture", max_output_tokens: 64 },
      limits: { daily_budget_microusd: 20000, reserve_per_request_microusd: 5000, daily_requests: 2, requests_per_incident: 1, daily_actions: 0, investigation_timeout_seconds: 1 },
      monitors: [{ id: "service", health_url: "https://app.test/health", expected_status: 200, interval_seconds: 300, timeout_seconds: 1, environment: "production", diagnostics: [], actions: [] }],
    };
    return {
      name: fixture.name, compatibilityDate: "2026-08-06", modulesRoot: root,
      modules: [{ type: "ESModule", path: resolve(root, "provider-audit-fixture.js"), contents: `
        import worker, { Roundhouse as Controller } from './dist/workers.js';
        export default worker;
        export class Roundhouse extends Controller {
          async providerFetch(url, init) {
            if (this.env.TEST_TRANSPORT_ERROR) throw new Error('private transport error never audit');
            return super.providerFetch(url, init);
          }
        }
      ` }, { type: "ESModule", path: resolve(root, "dist/workers.js") }, { type: "CompiledWasm", path: resolve(root, "wasm/roundhouse_core_bg.wasm") }],
      durableObjects: { ROUNDHOUSE: { className: "Roundhouse", useSQLite: true } },
      bindings: { ROUNDHOUSE_CONFIG: JSON.stringify(config), OPERATOR_TOKEN: "audit-operator", EVENT_TOKEN: "audit-event", PROVIDER_API_KEY: "audit-provider-secret", TEST_TRANSPORT_ERROR: fixture.mode === "transport_error" },
      outboundService: async (request: Request) => {
        if (request.url === "https://app.test/health") return new Response("unhealthy", { status: 503 });
        expect(request.url).toBe(`https://provider.test/v1/${fixture.provider === "anthropic" ? "messages" : "chat/completions"}`);
        expect(request.method).toBe("POST");
        expect(request.headers.get(fixture.provider === "anthropic" ? "x-api-key" : "authorization")).toBe(fixture.provider === "anthropic" ? "audit-provider-secret" : "Bearer audit-provider-secret");
        calls.set(fixture.name, (calls.get(fixture.name) ?? 0) + 1);
        if (fixture.mode === "http_error") return new Response("private upstream failure never audit", { status: 429 });
        if (fixture.mode === "invalid_json") return new Response("private invalid json never audit");
        if (fixture.mode === "timeout") await new Promise(resolve => setTimeout(resolve, 1500));
        else await new Promise(resolve => setTimeout(resolve, 25));
        return Response.json({ ...(fixture.provider === "anthropic" ? { content: [{ type: "text", text: "fixture narrative" }] } : { choices: [{ message: { role: "assistant", content: "fixture narrative" } }] }),
          ...(fixture.usage === undefined ? {} : { usage: fixture.usage }), private_response_field: "private response never audit" });
      },
    };
  }) });
  try {
    await mf.ready;
    for (const fixture of fixtures) {
      const worker = await mf.getWorker(fixture.name);
      const api = async (path: string, body?: unknown) => {
        const response = await worker.fetch("https://controller.test" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer audit-operator", "content-type": "application/json", connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
        expect(response.status).toBe(200);
        return response.json();
      };
      await api("/v1/start", {});
      let incident;
      for (let n = 0; n < 100; n++) {
        incident = (await api("/v1/incidents")).incidents[0];
        if (incident?.state === "needs_attention") break;
        await Bun.sleep(25);
      }
      expect(incident?.state).toBe("needs_attention");
      const history = (await api(`/v1/incidents/${incident.id}`)).history;
      const audit = history.filter(h => h.kind === "provider_call");
      expect(audit, JSON.stringify({ fixture: fixture.name, history })).toHaveLength(1);
      const call = JSON.parse(audit[0].detail);
      const outcome = { http_error: "http_error", invalid_json: "invalid_response", transport_error: "error", timeout: "timeout" };
      expect(call).toEqual({
        provider: fixture.provider, model: "audit-fixture", started_at: expect.any(Number), duration_ms: expect.any(Number),
        status: fixture.mode === "transport_error" || fixture.mode === "timeout" ? null : fixture.mode === "http_error" ? 429 : 200,
        outcome: fixture.mode ? outcome[fixture.mode] : "success", usage: { input: fixture.input, output: fixture.output },
      });
      expect(call.started_at).toBeLessThanOrEqual(audit[0].at);
      expect(call.duration_ms).toBeGreaterThanOrEqual(0);
      if (fixture.mode === "timeout") expect(call.duration_ms).toBeGreaterThanOrEqual(900);
      expect(JSON.stringify(history)).not.toContain("private ");
      expect(JSON.stringify(history)).not.toContain("audit-provider-secret");
      expect(calls.get(fixture.name) ?? 0).toBe(fixture.mode === "transport_error" ? 0 : 1);
      const status = await api("/v1/status");
      expect(status.budgets[0].reserved).toBe(5000);
      expect(status.budgets[0].requests).toBe(1);
      expect(status.budgets[0].actions).toBe(0);
      await api("/v1/stop", {});
    }
  } finally { await mf.dispose(); }
}, 30000);

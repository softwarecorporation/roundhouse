import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("rotated credentials are redacted from historical telemetry in every model turn", async () => {
  const root = process.env.ROUNDHOUSE_PACKAGE_DIR ?? resolve(import.meta.dir, "..");
  const nextToken = "rotation-next-application";
  const providerBodies: string[] = [];
  const persistence = await mkdtemp(resolve(tmpdir(), "roundhouse-rotation-"));
  const config = {
    provider: { kind: "openai_compatible", base_url: "https://model.test/v1", model: "fixture", max_output_tokens: 64 },
    limits: { daily_budget_microusd: 100, reserve_per_request_microusd: 10, daily_requests: 10, requests_per_incident: 2, daily_actions: 0, investigation_timeout_seconds: 2 },
    monitors: [{ id: "service", health_url: "https://app.test/health", interval_seconds: 86400, timeout_seconds: 1, expected_status: 200, environment: "production", diagnostics: [], actions: [] }],
  };
  const options = (application: string) => ({
    compatibilityDate: "2026-08-06", modulesRoot: root, durableObjectsPersist: persistence,
    modules: [{ type: "ESModule" as const, path: resolve(root, "dist/workers.js") }, { type: "CompiledWasm" as const, path: resolve(root, "wasm/roundhouse_core_bg.wasm") }],
    durableObjects: { ROUNDHOUSE: { className: "Roundhouse", useSQLite: true } },
    bindings: { ROUNDHOUSE_CONFIG: JSON.stringify(config), OPERATOR_TOKEN: "rotation-operator", EVENT_TOKEN: "rotation-event", PROVIDER_API_KEY: "rotation-provider", APPLICATION_TOKEN: application },
    outboundService: async (request: Request) => {
      if (request.url === "https://app.test/health") return new Response("down", { status: 503 });
      if (request.url !== "https://model.test/v1/chat/completions") throw new Error("unexpected egress");
      providerBodies.push(await request.text());
      return Response.json({ choices: [{ message: providerBodies.length === 1 ? {
        role: "assistant", content: null,
        tool_calls: [{ id: "inspect", type: "function", function: { name: "inspect_system", arguments: "{}" } }],
      } : { role: "assistant", content: "Operator attention required" } }] });
    },
  });
  let mf = new Miniflare(options("rotation-previous-application"));
  const request = async (path: string, body?: unknown, token = "rotation-operator") => {
    const response = await mf.dispatchFetch("https://rotation.test" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "rotation-event" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    await mf.ready;
    await request("/v1/telemetry", [{ id: "historical", service: "service", kind: "log", level: "error", name: "queue", timestamp: Date.now() - 1000, message: nextToken }], "rotation-event");
    expect((await request("/v1/telemetry")).records[0].message).toBe(nextToken);
    await mf.dispose();
    mf = new Miniflare(options(nextToken));
    await mf.ready;
    expect((await request("/v1/telemetry")).records[0].message).toBe("[REDACTED]");
    const { incident_id } = await request("/v1/events", { monitor: "service" }, "rotation-event");
    await request("/v1/start", {});
    let state;
    for (let attempt = 0; attempt < 200; attempt++) {
      state = (await request("/v1/incidents")).incidents[0].state;
      if (state === "needs_attention") break;
      await Bun.sleep(25);
    }
    await request("/v1/stop", {});
    expect(state).toBe("needs_attention");
    expect(providerBodies).toHaveLength(2);
    for (const body of providerBodies) {
      expect(body).not.toContain(nextToken);
      expect(body).toContain("[REDACTED]");
    }
    expect(JSON.stringify(await request(`/v1/incidents/${incident_id}`))).not.toContain(nextToken);
  } finally {
    await mf.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
}, 15000);

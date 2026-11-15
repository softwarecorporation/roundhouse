import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";

const root = process.env.ROUNDHOUSE_PACKAGE_DIR ?? resolve(import.meta.dir, "..");
const now = Date.now() - 1000;
const tokens = { operator: "operator-fixture", event: "event-fixture", application: "application-fixture" };
let mf: Miniflare;
let healthy = false;
let actions = 0;
let providerCalls = 0;
let proposal = "restart";
let recovered = true;
let upstreamMode = "ok";
const reads: { url: string; method: string; body: string }[] = [];
const config = {
  provider: { kind: "openai_compatible", base_url: "https://model.test/v1", model: "fixture", max_output_tokens: 512 },
  limits: { daily_budget_microusd: 100, reserve_per_request_microusd: 10, daily_requests: 10, requests_per_incident: 3, daily_actions: 1, investigation_timeout_seconds: 5 },
  monitors: [{ id: "service", health_url: "https://app.test/health", interval_seconds: 5, timeout_seconds: 1, expected_status: 200, environment: "production", diagnostics: [{ name: "status", url: "https://app.test/status" }], actions: [{ name: "restart", description: "restart", url: "https://app.test/restart", auto_approve: false }] }],
};
const connections = [
  { id: "ph", kind: "posthog_insight", service: "service", base_url: "https://posthog.test", project_id: "1", insight_id: "abc" },
  { id: "bs", kind: "betterstack_uptime", service: "service", base_url: "https://uptime.test", monitor_id: "2" },
  { id: "logs", kind: "betterstack_logs", service: "service", base_url: "https://logs.test", table: "t123_source" },
];

beforeAll(async () => {
  const worker = (name: string) => ({
    // Registry's latest Miniflare pins workerd's maximum supported date. Cloud tests use today's date.
    name, compatibilityDate: "2026-08-06", modulesRoot: root,
    modules: [{ type: "ESModule" as const, path: resolve(root, "dist/workers.js") }, { type: "CompiledWasm" as const, path: resolve(root, "wasm/roundhouse_core_bg.wasm") }],
    durableObjects: { ROUNDHOUSE: { className: "Roundhouse", useSQLite: true } },
    bindings: { ROUNDHOUSE_CONFIG: JSON.stringify(config), OPERATOR_TOKEN: tokens.operator, EVENT_TOKEN: tokens.event, PROVIDER_API_KEY: "model-fixture", APPLICATION_TOKEN: tokens.application, CONNECTIONS_JSON: JSON.stringify(connections), POSTHOG_READ_KEY: "posthog-fixture", BETTERSTACK_UPTIME_TOKEN: "uptime-fixture", BETTERSTACK_LOGS_USER: "reader", BETTERSTACK_LOGS_PASSWORD: "password-fixture", POSTHOG_RECEIVER_TOKEN: "ph-receiver", BETTERSTACK_RECEIVER_TOKEN: "bs-receiver" },
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (url.host === "app.test") {
        if (url.pathname === "/health") return Response.json({ healthy }, { status: healthy ? 200 : 503 });
        expect(request.headers.get("authorization")).toBe("Bearer " + tokens.application);
        if (url.pathname === "/status") return Response.json({ healthy, secret: "model-fixture", message: "untrusted evidence" });
        if (url.pathname === "/restart") { actions++; expect(request.method).toBe("POST"); expect(request.headers.get("idempotency-key")).toContain(":restart"); if (recovered) healthy = true; return new Response("accepted", { status: 202 }); }
      }
      if (url.host === "model.test") {
        providerCalls++;
        expect(request.headers.get("authorization")).toBe("Bearer model-fixture");
        const body = await request.json();
        expect(JSON.stringify(body)).not.toContain("model-fixture");
        return Response.json({ choices: [{ message: { role: "assistant", content: "The configured worker is stopped", tool_calls: [{ id: "call", type: "function", function: { name: "request_recovery", arguments: JSON.stringify({ action: proposal }) } }] } }] });
      }
      reads.push({ url: request.url, method: request.method, body: await request.text() });
      if (upstreamMode === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } });
      if (upstreamMode === "large") return new Response("x".repeat(65537));
      if (upstreamMode === "limited") return new Response(null, { status: 429, headers: { "retry-after": "10" } });
      if (url.host === "posthog.test") { expect(request.headers.get("authorization")).toBe("Bearer posthog-fixture"); return Response.json({ id: 1, result: [{ count: 8 }], last_refresh: "2026-11-15T00:00:00Z", secret: "must not project" }); }
      if (url.host === "uptime.test") return Response.json({ data: { id: "2", attributes: { status: "down", auth_password: "DO NOT RETURN", request_headers: [{ secret: "DO NOT RETURN" }] } } });
      if (url.host === "logs.test") { expect(request.headers.get("authorization")).toBe("Basic " + btoa("reader:password-fixture")); return new Response('{"dt":"2026-11-15 00:00:00","raw":"plain text"}\n{"dt":"2026-11-15 00:00:01","raw":"{\\"level\\":\\"ERROR\\"}"}\n'); }
      throw new Error("unexpected egress " + request.url);
    },
  });
  mf = new Miniflare({ workers: [worker("edge"), worker("other")] });
  await mf.ready;
});
afterAll(async () => { await mf?.dispose(); });

async function request(path: string, body?: unknown, token = tokens.operator, expected = 200, worker = "edge", headers: Record<string, string> = {}) {
  const init = { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", connection: "close", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) };
  const r = worker === "edge" ? await mf.dispatchFetch("https://roundhouse.test" + path, init) : await (await mf.getWorker(worker)).fetch("https://roundhouse.test" + path, init);
  const text = await r.text();
  expect({ status: r.status, ...(r.status !== expected ? { text } : {}) }).toEqual({ status: expected });
  return JSON.parse(text);
}
const event = (id: string, distinct_id = "actor") => ({ id, distinct_id, kind: "event", service: "service", name: "signed_up", timestamp: now, properties: {} });

test("atomic durable capture, replay/conflict, bounded queries, correlation, aggregates and role/tenant isolation", async () => {
  expect((await request("/healthz")).engine).toEqual({ agent: "rx4::lite::Agent", rotary_version: "0.8.0" });
  await request("/v1/telemetry", [event("a"), event("b", "different"), event("c")], tokens.event);
  expect(await request("/v1/telemetry", [event("a")], tokens.event)).toEqual({ accepted: 0, duplicates: 1 });
  await request("/v1/telemetry", [event("rollback"), { ...event("a"), name: "changed" }], tokens.event, 409);
  expect((await request("/v1/telemetry")).records).toHaveLength(3);
  await request("/v1/telemetry", [{ ...event("bad"), properties: { api_key: "not-allowed" } }], tokens.event, 400);
  await request("/v1/telemetry", [{ ...event("bad"), timestamp: 0 }], tokens.event, 400);
  await request("/v1/telemetry", [{ ...event("bad"), timestamp: Date.now() + 600000 }], tokens.event, 400);
  await request("/v1/telemetry", [{ ...event("bad"), unexpected: true }], tokens.event, 400);
  await request("/v1/telemetry", undefined, tokens.event, 401);
  await request("/v1/telemetry", [event("bad")], tokens.operator, 401);
  expect((await request("/v1/telemetry", undefined, tokens.operator, 200, "other")).records).toHaveLength(0);
  const counts = await request(`/v1/analytics?service=service&kind=event&name=signed_up&until=${now+1}`);
  expect(counts.buckets).toHaveLength(1); expect(counts.buckets[0].count).toBe(3); expect(counts.buckets[0].distinct_actors).toBe(2);
  const trace = "a".repeat(32);
  await request("/v1/telemetry", [
    { id: "log", service: "service", name: "db", timestamp: now, kind: "log", level: "error", message: "model-fixture", trace_id: trace },
    { id: "span", service: "service", name: "db", timestamp: now, kind: "span", trace_id: trace, span_id: "b".repeat(16), duration_ms: 53, status: "error" },
    ...[3, 11, -2].map((value, i) => ({ id: "gauge-"+i, service: "service", name: "load", timestamp: now, kind: "metric", metric_type: "gauge", value, unit: "jobs" })),
  ], tokens.event);
  const correlated = await request(`/v1/telemetry?trace_id=${trace}`);
  expect(correlated.records).toHaveLength(2); expect(JSON.stringify(correlated)).not.toContain("model-fixture");
  const gauges = (await request("/v1/analytics?service=service&kind=metric&name=load")).buckets[0];
  expect([gauges.count,gauges.sum,gauges.mean,gauges.min,gauges.max]).toEqual([3,12,4,-2,11]);
  await request("/v1/telemetry", [{ id: "counter", service: "service", name: "load", timestamp: now, kind: "metric", metric_type: "counter", value: 1, unit: "jobs" }], tokens.event, 400);
  for (let page = 0; page < 3; page++) await request("/v1/telemetry", Array.from({length: 100}, (_,i) => event(`page-${page}-${i}`)), tokens.event);
  const first = await request(`/v1/telemetry?kind=event&until=${now+1}`);
  expect(first.records).toHaveLength(200); expect(first.next).not.toBeNull();
  const second = await request(`/v1/telemetry?kind=event&until=${now+1}&before=${first.next.before}&cursor=${first.next.cursor}`);
  expect(second.records).toHaveLength(103);
  expect(new Set([...first.records,...second.records].map(r => r.id)).size).toBe(303);
  await mf.unsafeEvictDurableObject("edge", "Roundhouse", { name: "controller" });
  expect((await request("/v1/telemetry?kind=event")).records).toHaveLength(200);
}, 20000);

test("fixed provider reads and authenticated template receivers preserve upstream authority", async () => {
  const ph = await request("/v1/connections/ph");
  expect(ph.cache_only).toBe(true); expect(ph.insight.result).toEqual([{count:8}]); expect(reads.at(-1)?.url).toContain("/api/projects/1/insights/abc/?refresh=force_cache");
  expect(JSON.stringify(await request("/v1/connections/bs"))).not.toContain("DO NOT RETURN");
  const logs = await request("/v1/connections/logs");
  expect(logs.records[0].raw).toBe("plain text"); expect(logs.possibly_truncated).toBe(false);
  expect(reads.at(-1)?.body).toContain("remote(t123_source_logs) UNION ALL");
  expect(reads.at(-1)?.body).toContain("_row_type = 1"); expect(reads.at(-1)?.body).toContain("LIMIT 100 FORMAT JSONEachRow");
  upstreamMode = "limited"; expect((await request("/v1/connections/ph")).status).toBe(429);
  upstreamMode = "large"; await request("/v1/connections/ph", undefined, tokens.operator, 413);
  upstreamMode = "redirect"; expect((await request("/v1/connections/ph")).status).toBe(302);
  expect(reads.every(r => !r.url.includes("evil.test"))).toBe(true); upstreamMode = "ok";
  const body = { uuid: "provider-event", event: "deployment", distinct_id: "user", timestamp: new Date(now).toISOString() };
  await request("/v1/webhooks/posthog/ph", body, tokens.event, 401);
  expect((await request("/v1/webhooks/posthog/ph", body, "ph-receiver")).accepted).toBe(1);
  expect((await request("/v1/webhooks/posthog/ph", body, "ph-receiver")).duplicates).toBe(1);
  const lifecycle = { data: { id: "25", type: "incident", attributes: { started_at: new Date(now).toISOString(), resolved_at: new Date(now+1).toISOString() } } };
  await request("/v1/webhooks/betterstack/bs", lifecycle, "bs-receiver");
  delete lifecycle.data.attributes.resolved_at;
  await request("/v1/webhooks/betterstack/bs", lifecycle, "bs-receiver");
  expect((await request("/v1/incidents")).incidents).toHaveLength(0);
  expect(actions).toBe(0); expect(providerCalls).toBe(0);
}, 10000);

test("real alarm scheduling, persisted exact approval, independent verification and durable action budget", async () => {
  const wait = async (state: string) => {
    for (let n = 0; n < 120; n++) {
      const i = (await request("/v1/incidents")).incidents.find(i => i.state === state);
      if (i) return i;
      await Bun.sleep(100);
    }
    throw new Error("incident did not reach " + state);
  };
  await request("/v1/start", {});
  const i = await wait("awaiting_approval");
  expect(actions).toBe(0);
  // Evict an idle object, not an alarm still completing its final storage write.
  for (let n = 0; n < 20; n++) {
    if (!(await request("/v1/stop", {})).in_flight) break;
    await Bun.sleep(50);
  }
  await mf.unsafeEvictDurableObject("edge", "Roundhouse", { name: "controller" });
  await request(`/v1/incidents/${i.id}/approve`, {action:"other"}, tokens.operator, 409);
  await request(`/v1/incidents/${i.id}/approve`, {action:"restart"}, tokens.event, 401);
  recovered = false;
  await request(`/v1/incidents/${i.id}/approve`, {action:"restart"});
  await request(`/v1/incidents/${i.id}/approve`, {action:"restart"}, tokens.operator, 409);
  await request("/v1/start", {});
  await wait("needs_attention"); expect(actions).toBe(1);
  // A successful action response was not recovery; only a subsequent good probe resolves.
  healthy = true; await wait("resolved");
  const history = await request(`/v1/incidents/${i.id}`);
  expect(history.history.filter(h => h.kind === "action_claimed")).toHaveLength(1);
  const status = await request("/v1/status"); expect(status.budgets[0].actions).toBe(1);
  await request("/v1/stop", {});
  healthy = false; recovered = true;
  const e = await request("/v1/events", {monitor:"service"}, tokens.event, 200, "edge", {"idempotency-key":"second"});
  expect((await request("/v1/events", {monitor:"service"}, tokens.event, 200, "edge", {"idempotency-key":"second"})).incident_id).toBe(e.incident_id);
  await request("/v1/start", {}); const pending = await wait("awaiting_approval");
  await request(`/v1/incidents/${pending.id}/approve`, {action:"restart"});
  await wait("needs_attention"); expect(actions).toBe(1);
  await request("/v1/stop", {});
  expect((await request("/v1/status")).alarm).toBeNull();
}, 45000);

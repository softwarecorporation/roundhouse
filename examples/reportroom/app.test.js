import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const token = "reportroom-test-application-token";
const daily = [
  [3, 5097], [4, 8840], [5, 13439], [6, 18562], [7, 24458], [8, 30795],
  [3, 8476], [4, 11630], [5, 17300], [6, 23411], [7, 30212], [8, 37371],
  [3, 10693], [4, 16163], [5, 20580], [6, 28260], [7, 35966], [8, 43947],
  [3, 12910], [4, 18953], [5, 26184], [6, 31947], [7, 41720], [8, 50523],
  [3, 15708], [4, 22324], [5, 30045], [6, 38539], [7, 45731], [8, 57099],
];
let mf;
let egress = 0;

beforeAll(async () => {
  mf = new Miniflare({
    compatibilityDate: "2026-08-06",
    modules: [{ type: "ESModule", path: resolve(import.meta.dir, "app.js") }],
    durableObjects: { REPORTS: { className: "ReportApplication", useSQLite: true } },
    bindings: { APPLICATION_TOKEN: token },
    outboundService: () => { egress++; throw new Error("Application network forbidden"); },
  });
  await mf.ready;
});
afterAll(async () => { await mf?.dispose(); });

function request(path, body, options = {}) {
  const { headers, ...rest } = options;
  return mf.dispatchFetch(`https://reportroom.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...rest,
  });
}
async function state() {
  const response = await request("/status");
  expect(response.status).toBe(200);
  return response.json();
}
async function complete(ids) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const status = await state();
    if (ids.every(id => status.jobs.find(job => job.id === id)?.state === "completed")) return status;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Real Durable Object alarm did not complete exports");
}
async function post(path, body = {}, headers = {}) {
  return request(path, body, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close", ...headers } });
}
async function verifyCSV(job) {
  const response = await request(`/reports/${job.id}.csv`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("content-disposition")).toContain(job.id);
  const csv = await response.text();
  const start = 30 - job.period;
  const expected = "date,order_count,revenue_cents\n" + daily.slice(start).map(([count, cents], offset) =>
    `2026-01-${String(start + offset + 1).padStart(2, "0")},${count},${cents}\n`).join("");
  expect(csv).toBe(expected);
  expect(job.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
  expect(job.rows).toBe(job.period);
  expect(job.order_count).toBe(job.period === 7 ? 41 : 165);
  expect(job.revenue_cents).toBe(job.period === 7 ? 259969 : 776883);
  expect(Number.isFinite(Date.parse(job.created_at))).toBe(true);
  expect(Date.parse(job.completed_at)).toBeGreaterThanOrEqual(Date.parse(job.created_at));
  expect(Object.keys(job).sort()).toEqual([
    "id", "period", "state", "created_at", "completed_at", "sha256", "rows", "order_count", "revenue_cents",
  ].sort());
}

test("initial health is public; real alarm exports asymmetric 7/30-day daily sales and SHA-256", async () => {
  expect((await mf.dispatchFetch("https://reportroom.test/health")).status).toBe(200);
  expect(await state()).toEqual({
    healthy: true, worker_running: true, recovering: false, recoveries: 0,
    orders: { count: 165, revenue_cents: 776883 }, jobs: [],
  });
  const ids = [];
  for (const period of [7, 30]) {
    const response = await post("/reports", { period });
    expect(response.status).toBe(202);
    const job = await response.json();
    expect(job.state).toBe("queued");
    expect(job.period).toBe(period);
    expect(job.sha256).toBeNull();
    expect((await request(`/reports/${job.id}.csv`)).status).toBe(409);
    expect((await request("/health")).status).toBe(200);
    ids.push(job.id);
  }
  const status = await complete(ids);
  for (const id of ids) await verifyCSV(status.jobs.find(job => job.id === id));
  expect(status.jobs[0].sha256).not.toBe(status.jobs[1].sha256);
  expect(egress).toBe(0);
}, 20000);

test("all non-public routes require bearer auth and explicit path/method/body allowlists", async () => {
  for (const [path, method] of [
    ["/status", "GET"], ["/reports", "POST"], ["/fault", "POST"], ["/recover", "POST"],
    ["/reset", "POST"], ["/health", "POST"], ["/not-allowed", "GET"],
    ["/reports/00000000-0000-0000-0000-000000000000.csv", "GET"],
  ]) {
    for (const authorization of ["", "Bearer wrong", `Basic ${token}`, `Bearer ${token}extra`]) {
      expect((await request(path, undefined, { method, headers: { authorization } })).status).toBe(401);
    }
  }
  for (const [path, method] of [["/health", "POST"], ["/status", "POST"], ["/reports", "GET"], ["/fault", "DELETE"], ["/recover", "PUT"], ["/reset", "PATCH"]]) {
    const response = await request(path, undefined, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(["/health", "/status"].includes(path) ? "GET" : "POST");
  }
  for (const path of ["/status/", "/commands", "/reports/no.csv", "/reports/../anything"]) {
    expect((await request(path)).status).toBe(404);
  }
  expect((await request("/status?target=https://elsewhere.test")).status).toBe(400);
  for (const body of [{}, { period: 1 }, { period: "7" }, { period: 7, target: "https://elsewhere.test" }, [], null]) {
    expect((await post("/reports", body)).status).toBe(400);
  }
  for (const path of ["/fault", "/recover", "/reset"]) {
    expect((await post(path, { command: "restart" })).status).toBe(400);
  }
  expect((await request("/reports", undefined, { method: "POST", body: "{", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })).status).toBe(400);
  expect((await request("/reports", undefined, { method: "POST", body: "{}", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" } })).status).toBe(415);
  expect((await post("/reports", { period: 7, extra: "x".repeat(300) })).status).toBe(413);
  expect((await post("/recover")).status).toBe(400);
  expect((await post("/recover", {}, { "idempotency-key": "bad key" })).status).toBe(400);
  expect((await post("/recover", {}, { "idempotency-key": "no-fault" })).status).toBe(409);
  const unchanged = await state();
  expect(unchanged.healthy).toBe(true);
  expect(unchanged.recoveries).toBe(0);
  expect(unchanged.jobs).toHaveLength(2);
  expect(JSON.stringify(unchanged)).not.toContain(token);
  expect(egress).toBe(0);
});

test("fault preserves reports and pauses alarms; recovery acceptance is not verification; durable claims survive reset", async () => {
  const previous = (await state()).jobs;
  const fault = await post("/fault");
  expect(fault.status).toBe(200);
  const paused = await fault.json();
  expect(paused.worker_running).toBe(false);
  expect(paused.healthy).toBe(false);
  expect(paused.jobs).toHaveLength(previous.length + 1);
  for (const job of previous) expect(paused.jobs).toContainEqual(job);
  const pending = paused.jobs.find(job => job.state === "queued");
  expect(pending.period).toBe(7);
  expect((await post("/fault")).status).toBe(409);
  expect((await request("/health")).status).toBe(503);
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect((await state()).jobs.find(job => job.id === pending.id).state).toBe("queued");
  const extra = await (await post("/reports", { period: 30 })).json();
  const [first, replay] = await Promise.all([
    post("/recover", {}, { "idempotency-key": "incident-1:resume" }),
    post("/recover", {}, { "idempotency-key": "incident-1:resume" }),
  ]);
  expect(first.status).toBe(202);
  expect(replay.status).toBe(202);
  expect(await first.json()).toEqual({ accepted: true });
  const accepted = await state();
  expect(accepted.worker_running).toBe(true);
  expect(accepted.recovering).toBe(true);
  expect(accepted.recoveries).toBe(1);
  expect(accepted.healthy).toBe(false);
  expect((await request("/health")).status).toBe(503);
  expect((await post("/recover", {}, { "idempotency-key": "different-key" })).status).toBe(409);
  expect((await post("/fault")).status).toBe(409);
  const completed = await complete([pending.id, extra.id]);
  expect(completed.recovering).toBe(false);
  expect(completed.healthy).toBe(true);
  expect((await request("/health")).status).toBe(200);
  await verifyCSV(completed.jobs.find(job => job.id === pending.id));
  await verifyCSV(completed.jobs.find(job => job.id === extra.id));
  const reset = await (await post("/reset")).json();
  expect(reset.jobs).toEqual([]);
  expect(reset.recoveries).toBe(1);
  expect(reset.healthy).toBe(true);
  expect(reset.orders).toEqual({ count: 165, revenue_cents: 776883 });
  expect((await request(`/reports/${pending.id}.csv`)).status).toBe(404);
  expect((await post("/recover", {}, { "idempotency-key": "incident-1:resume" })).status).toBe(202);
  expect((await state()).recoveries).toBe(1);
  await post("/fault");
  expect((await post("/recover", {}, { "idempotency-key": "incident-1:resume" })).status).toBe(202);
  expect((await state()).worker_running).toBe(false);
  expect((await request("/health")).status).toBe(503);
  expect((await post("/recover", {}, { "idempotency-key": "incident-2:resume" })).status).toBe(202);
  expect((await state()).recoveries).toBe(2);
  const resetDuringRecovery = await (await post("/reset")).json();
  expect(resetDuringRecovery.jobs).toEqual([]);
  expect(resetDuringRecovery.healthy).toBe(true);
  expect(resetDuringRecovery.recoveries).toBe(2);
  expect((await post("/recover", {}, { "idempotency-key": "incident-2:resume" })).status).toBe(202);
  expect((await state()).recoveries).toBe(2);
  expect(egress).toBe(0);
}, 20000);

test("job storage is bounded and reset frees report capacity without clearing recovery history", async () => {
  await post("/fault");
  for (let i = 1; i < 25; i++) expect((await post("/reports", { period: i % 2 ? 7 : 30 })).status).toBe(202);
  expect((await post("/reports", { period: 7 })).status).toBe(409);
  expect((await state()).jobs).toHaveLength(25);
  const reset = await (await post("/reset")).json();
  expect(reset.recoveries).toBe(2);
  expect(reset.jobs).toEqual([]);
  expect(reset.worker_running).toBe(true);
  expect((await request("/health")).status).toBe(200);
  expect((await post("/reports", { period: 7 })).status).toBe(202);
  expect(egress).toBe(0);
});

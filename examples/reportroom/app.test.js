import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";

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
  const submitted = await (await post("/reports", { period: 7, title: "Weekly reconciliation" })).json();
  const fault = await post("/fault");
  expect(fault.status).toBe(200);
  const paused = await fault.json();
  expect(paused.worker_running).toBe(false);
  expect(paused.healthy).toBe(false);
  expect(paused.jobs).toHaveLength(previous.length + 1);
  for (const job of previous) expect(paused.jobs).toContainEqual(job);
  const pending = paused.jobs.find(job => job.state === "queued");
  expect(pending.id).toBe(submitted.id);
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
  for (let i = 0; i < 25; i++) expect((await post("/reports", { period: i % 2 ? 7 : 30 })).status).toBe(202);
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

test("workspace has useful synthetic sales, full validated preferences, and bounded recent orders", async () => {
  await post("/reset");
  const workspace = await (await request("/workspace")).json();
  expect(workspace.preferences).toEqual({ name: "My workspace", default_period: 30, default_group_by: "day", onboarded: false });
  expect(workspace.dataset).toEqual({ name: "Demo store sales", currency: "USD", from: "2026-01-01", to: "2026-01-30", synthetic: true });
  expect(workspace.overview).toEqual({ orders: 165, revenue_cents: 776883, average_order_cents: 4708 });
  expect(workspace.daily).toEqual(daily.map(([order_count, revenue_cents], index) => ({
    day: `2026-01-${String(index + 1).padStart(2, "0")}`, order_count, revenue_cents,
  })));
  expect(workspace.reports).toEqual([]);
  expect(workspace.recent_orders).toHaveLength(10);
  expect(workspace.recent_orders[0]).toEqual({ id: 165, day: "2026-01-30", revenue_cents: 8666 });
  expect(workspace.recent_orders.map(order => order.id)).toEqual([165, 164, 163, 162, 161, 160, 159, 158, 157, 156]);
  const preferences = { name: "Northwind Studio", default_period: 7, default_group_by: "week", onboarded: true };
  expect(await (await post("/workspace", preferences)).json()).toEqual({ preferences });
  for (const invalid of [
    {}, { name: "Only name" }, { ...preferences, extra: true }, { ...preferences, default_period: "7" },
    { ...preferences, default_period: 14 }, { ...preferences, default_group_by: "month" },
    { ...preferences, onboarded: 1 }, { ...preferences, name: "" }, { ...preferences, name: "x".repeat(81) },
    { ...preferences, name: " padded " }, { ...preferences, name: "<script>" }, { ...preferences, name: "bad\nname" },
  ]) expect((await post("/workspace", invalid)).status).toBe(400);
  expect((await (await request("/workspace")).json()).preferences).toEqual(preferences);
  await post("/reset");
  expect((await (await request("/workspace")).json()).preferences).toEqual(preferences);
  expect(egress).toBe(0);
});

test("configured reports run via real alarms without a fault; stored previews match daily and Monday-week downloads", async () => {
  await post("/reset");
  const ids = [];
  for (const period of [7, 30]) {
    const response = await post("/reports", { period, title: `${period}-day weekly sales`, group_by: "week" });
    expect(response.status).toBe(202);
    const job = await response.json();
    ids.push(job.id);
    const detail = await (await request(`/reports/${job.id}`)).json();
    expect(detail.state).toBe("queued");
    expect(detail.title).toBe(`${period}-day weekly sales`);
    expect(detail.group_by).toBe("week");
    expect(detail.preview).toEqual({ columns: [], rows: [], truncated: false });
    expect(detail.download_url).toBeNull();
    expect((await request(`/reports/${job.id}.csv`)).status).toBe(409);
  }
  const defaultJob = await (await post("/reports", { period: 30 })).json();
  ids.push(defaultJob.id);
  const completed = await complete(ids);
  expect(completed.worker_running).toBe(true);
  expect(completed.recovering).toBe(false);
  const expectedWeeks = [
    [["2026-01-19", 11, 66231], ["2026-01-26", 30, 193738]],
    [["2025-12-29", 18, 45938], ["2026-01-05", 40, 146282], ["2026-01-12", 41, 192980],
      ["2026-01-19", 36, 197945], ["2026-01-26", 30, 193738]],
  ];
  for (let index = 0; index < 2; index++) {
    const job = completed.jobs.find(job => job.id === ids[index]);
    const expected = "week_start,order_count,revenue_cents\n" + expectedWeeks[index].map(row => row.join(",") + "\n").join("");
    expect(await (await request(`/reports/${job.id}.csv`)).text()).toBe(expected);
    expect(job.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(job.rows).toBe(index === 0 ? 2 : 5);
    expect(job.order_count).toBe(index === 0 ? 41 : 165);
    expect(job.revenue_cents).toBe(index === 0 ? 259969 : 776883);
    const detail = await (await request(`/reports/${job.id}`)).json();
    expect(detail).toMatchObject({ ...job, title: `${job.period}-day weekly sales`, group_by: "week", download_url: `/reports/${job.id}.csv` });
    expect(detail.preview).toEqual({ columns: ["week_start", "order_count", "revenue_cents"], truncated: false,
      rows: expectedWeeks[index].map(([week_start, order_count, revenue_cents]) => ({ week_start, order_count, revenue_cents })) });
    expect(detail.csv).toBeUndefined();
    expect(job.title).toBeUndefined();
    expect(job.group_by).toBeUndefined();
  }
  await verifyCSV(completed.jobs.find(job => job.id === defaultJob.id));
  const detail = await (await request(`/reports/${defaultJob.id}`)).json();
  expect(detail.title).toBe("Sales report");
  expect(detail.group_by).toBe("day");
  expect(detail.preview.columns).toEqual(["date", "order_count", "revenue_cents"]);
  expect(detail.preview.truncated).toBe(true);
  expect(detail.preview.rows).toEqual(daily.slice(0, 10).map(([order_count, revenue_cents], index) => ({
    date: `2026-01-${String(index + 1).padStart(2, "0")}`, order_count, revenue_cents,
  })));
  const workspace = await (await request("/workspace")).json();
  expect(workspace.reports).toHaveLength(3);
  expect(workspace.reports.find(job => job.id === ids[0])).toMatchObject({ title: "7-day weekly sales", group_by: "week", state: "completed" });
  expect(workspace.reports.every(job => job.csv === undefined)).toBe(true);
  expect(egress).toBe(0);
}, 15000);

test("new routes enforce auth, methods, query allowlists and safe report configuration", async () => {
  const unknown = "/reports/00000000-0000-0000-0000-000000000000";
  for (const path of ["/workspace", unknown]) {
    expect((await request(path, undefined, { headers: { authorization: "" } })).status).toBe(401);
    expect((await request(`${path}?extra=1`)).status).toBe(400);
    expect((await request(path, undefined, { method: "PUT" })).status).toBe(405);
  }
  expect((await request(unknown)).status).toBe(404);
  expect((await request("/reports/not-a-uuid")).status).toBe(404);
  expect((await request("/workspace", undefined, { method: "DELETE" })).headers.get("allow")).toBe("GET, POST");
  expect((await post("/workspace", {}, { authorization: "" })).status).toBe(401);
  const before = (await state()).jobs;
  for (const body of [
    { period: 7, title: "" }, { period: 7, title: null }, { period: 7, title: "x".repeat(81) },
    { period: 7, title: "<img>" }, { period: 7, title: "bad\u0000text" }, { period: 7, title: " padded " },
    { period: 7, group_by: "month" }, { period: 7, group_by: null }, { period: 7, group_by: "DAY" },
    { period: 7, group_by: "week", target: "elsewhere" }, { title: "Missing period" },
  ]) expect((await post("/reports", body)).status).toBe(400);
  expect((await state()).jobs).toEqual(before);
  expect((await post("/reports", { period: 7, title: "x".repeat(80), group_by: "day" })).status).toBe(202);
  expect(egress).toBe(0);
});

test("SQLite legacy jobs migrate without losing downloads; preferences and reports survive two runtime reopens", async () => {
  const root = resolve(import.meta.dir, "../../../.amp/in/orb-backup");
  mkdirSync(root, { recursive: true });
  const persist = mkdtempSync(resolve(root, "reportroom-persistence-"));
  const legacyID = "00000000-0000-0000-0000-000000000001";
  const csv = "date,order_count,revenue_cents\n2026-01-30,8,57099\n";
  const options = {
    compatibilityDate: "2026-08-06",
    durableObjects: { REPORTS: { className: "ReportApplication", useSQLite: true } },
    durableObjectsPersist: persist,
    bindings: { APPLICATION_TOKEN: token },
    outboundService: () => { egress++; throw new Error("Application network forbidden"); },
  };
  let instance;
  const call = (path, body) => instance.dispatchFetch(`https://reportroom.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    instance = new Miniflare({ ...options, modules: [{ type: "ESModule", path: resolve(import.meta.dir, "legacy-fixture.js"), contents: `
      import { DurableObject } from "cloudflare:workers";
      export class ReportApplication extends DurableObject {
        fetch() {
          this.ctx.storage.sql.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,period INTEGER NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT,sha256 TEXT,rows INTEGER,order_count INTEGER,revenue_cents INTEGER,csv TEXT)");
          this.ctx.storage.sql.exec("INSERT INTO jobs VALUES(?,30,'completed','2026-01-30T00:00:00Z','2026-01-30T00:00:01Z',?,1,8,57099,?)", ${JSON.stringify(legacyID)}, ${JSON.stringify(createHash("sha256").update(csv).digest("hex"))}, ${JSON.stringify(csv)});
          return new Response("seeded");
        }
      }
      export default { fetch(request, env) { return env.REPORTS.getByName("shop").fetch(request); } };
    ` }] });
    expect(await (await call("/seed")).text()).toBe("seeded");
    await instance.dispose();
    instance = undefined;
    const preferences = { name: "Persistent Studio", default_period: 7, default_group_by: "week", onboarded: true };
    let configuredID;
    for (let reopen = 0; reopen < 2; reopen++) {
      instance = new Miniflare({ ...options, modules: [{ type: "ESModule", path: resolve(import.meta.dir, "app.js") }] });
      const workspace = await (await call("/workspace")).json();
      expect(workspace.reports).toHaveLength(reopen === 0 ? 1 : 2);
      expect(workspace.reports.find(job => job.id === legacyID)).toMatchObject({ title: "Sales report", group_by: "day" });
      expect(workspace.overview.orders).toBe(165);
      expect(await (await call(`/reports/${legacyID}.csv`)).text()).toBe(csv);
      const detail = await (await call(`/reports/${legacyID}`)).json();
      expect(detail.preview.rows).toEqual([{ date: "2026-01-30", order_count: 8, revenue_cents: 57099 }]);
      if (reopen === 0) {
        expect((await call("/workspace", preferences)).status).toBe(200);
        const response = await call("/reports", { period: 7, title: "Persistent weekly sales", group_by: "week" });
        expect(response.status).toBe(202);
        configuredID = (await response.json()).id;
      } else {
        expect(workspace.preferences).toEqual(preferences);
        expect(workspace.reports.find(job => job.id === configuredID)).toMatchObject({ title: "Persistent weekly sales", group_by: "week" });
        const deadline = Date.now() + 10000;
        let generated;
        do {
          generated = await (await call(`/reports/${configuredID}`)).json();
          if (generated.state === "completed") break;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        expect(generated.state).toBe("completed");
        const expected = "week_start,order_count,revenue_cents\n2026-01-19,11,66231\n2026-01-26,30,193738\n";
        expect(await (await call(`/reports/${configuredID}.csv`)).text()).toBe(expected);
        expect(generated.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
        expect(generated.title).toBe("Persistent weekly sales");
      }
      await instance.dispose();
      instance = undefined;
    }
  } finally { await instance?.dispose(); }
  expect(egress).toBe(0);
}, 20000);

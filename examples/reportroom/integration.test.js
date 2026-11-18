// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createDemo } from "./server.js";

async function eventually(read, predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const value = await read();
    last = value;
    if (predicate(value)) return value;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

test("real SaaS HTTP flow: export, detected failure, approval across restart, actual recovery and retained history", async () => {
  const scratch = resolve(import.meta.dir, "../../../.amp/in/orb-backup");
  await mkdir(scratch, { recursive: true });
  const persistence = await mkdtemp(resolve(scratch, "reportroom-integration-"));
  let demo = await createDemo({ persistence, requireApproval: true });
  let server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: demo.fetch });
  async function api(path, body, expected = 200, headers = {}) {
    const response = await fetch(new URL(path, server.url), {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-reportroom-demo": "1", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(expected);
    return response.json();
  }
  const state = () => api("/api/state");
  try {
    const page = await fetch(server.url);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain("Reportroom");
    expect((await state()).app.healthy).toBe(true);
    expect((await state()).provider.mode).toBe("fixture");
    await api("/api/reports", { period: 31 }, 400);
    await api("/api/reports", { period: 7 }, 403, { "x-reportroom-demo": "" });
    await api("/api/fault", {}, 403, { "sec-fetch-site": "cross-site" });
    await api("/api/fault", { command: "anything" }, 400);
    expect((await fetch(new URL("/v1/incidents", server.url))).status).toBe(404);
    expect((await fetch(new URL("/.data/", server.url))).status).toBe(404);
    expect((await fetch(new URL("/../runtime.js", server.url))).status).toBe(404);

    await api("/api/reports", { period: 30 });
    const normal = await eventually(state, s => s.app.jobs.some(j => j.state === "completed"), "ordinary CSV export");
    const normalJob = normal.app.jobs.find(j => j.state === "completed");
    const download = await fetch(new URL(`/api/reports/${normalJob.id}.csv`, server.url));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("text/csv");
    const csv = await download.text();
    expect(createHash("sha256").update(csv).digest("hex")).toBe(normalJob.sha256);
    expect(normal.monitoring.incidents).toHaveLength(0);
    expect(normal.monitoring.events.some(event => event.name === "report.queued")).toBe(true);

    await api("/api/fault", {});
    await api("/api/fault", {}, 409);
    const pending = await eventually(state, s => s.monitoring.incidents[0]?.state === "awaiting_approval", "Rotary investigation and approval gate");
    const incident = pending.monitoring.incidents[0];
    expect(pending.app.worker_running).toBe(false);
    expect(pending.app.healthy).toBe(false);
    expect(pending.app.recoveries).toBe(0);
    expect(incident.history.some(h => h.kind === "inspection")).toBe(true);
    expect(incident.history.some(h => h.kind === "approval_required")).toBe(true);
    expect(JSON.parse(incident.history.find(h => h.kind === "detected").detail).source).toBe("event");
    expect(pending.monitoring.events.some(event => event.name === "worker.paused")).toBe(true);
    const queued = pending.app.jobs.find(j => j.state === "queued");
    expect(queued).toBeDefined();

    server.stop(true);
    await demo.close();
    demo = await createDemo({ persistence, requireApproval: true });
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: demo.fetch });
    const restored = await state();
    expect(restored.monitoring.incidents[0].id).toBe(incident.id);
    expect(restored.monitoring.incidents[0].state).toBe("awaiting_approval");
    expect(restored.app.jobs.some(j => j.id === queued.id && j.state === "queued")).toBe(true);
    await api(`/api/incidents/${incident.id}/approve`, { action: "different" }, 400);
    await api("/api/incidents/unknown/approve", {}, 409);
    await api(`/api/incidents/${incident.id}/approve`, {});
    await api(`/api/incidents/${incident.id}/approve`, {}, 409);
    const accepted = await eventually(state, s => s.app.worker_running && !s.app.healthy, "accepted action before independent verification");
    expect(accepted.monitoring.incidents[0].state).not.toBe("resolved");
    expect(accepted.app.recoveries).toBe(1);
    const resolved = await eventually(state, s => s.monitoring.incidents[0].state === "resolved", "independently verified recovery");
    expect(resolved.app.healthy).toBe(true);
    expect(resolved.app.jobs.find(j => j.id === queued.id).state).toBe("completed");
    expect(resolved.app.recoveries).toBe(1);
    expect(resolved.monitoring.incidents[0].history.some(h => h.kind === "verification" && JSON.parse(h.detail).healthy)).toBe(true);
    expect(resolved.monitoring.incidents[0].history.filter(h => h.kind === "action_claimed")).toHaveLength(1);
    const budget = resolved.monitoring.budgets.find(b => b.day === new Date().toISOString().slice(0, 10));
    expect(budget.actions).toBe(1);
    expect(budget.requests).toBe(4);
    const recoveredJob = resolved.app.jobs.find(j => j.id === queued.id);
    const recoveredCsv = await (await fetch(new URL(`/api/reports/${queued.id}.csv`, server.url))).text();
    expect(createHash("sha256").update(recoveredCsv).digest("hex")).toBe(recoveredJob.sha256);

    await api("/api/reset", {});
    const reset = await state();
    expect(reset.app.jobs).toHaveLength(0);
    expect(reset.app.healthy).toBe(true);
    expect(reset.app.recoveries).toBe(1);
    expect(reset.monitoring.incidents[0].id).toBe(incident.id);
    expect(reset.monitoring.budgets.find(b => b.day === budget.day)).toEqual(budget);
    const publicData = JSON.stringify(reset);
    for (const token of Object.values(demo.runtime.tokens)) expect(publicData).not.toContain(token);
    expect(publicData).not.toContain("PROVIDER_API_KEY");
  } finally {
    server.stop(true);
    await demo.close();
    await rm(persistence, { recursive: true, force: true });
  }
}, 60000);

test("live mode is explicit and never silently falls back to a fixture", async () => {
  await expect(createDemo({ provider: "anthropic", key: "" })).rejects.toThrow("ANTHROPIC_API_KEY");
  await expect(createDemo({ provider: "anything" })).rejects.toThrow("fixture or anthropic");
});

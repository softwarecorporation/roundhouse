// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// This command mutates only a newly created synthetic tenant on the selected deployment.
const origin = process.env.SMOKE_ORIGIN;
if (!origin || new URL(origin).protocol !== 'https:') throw new Error('SMOKE_ORIGIN must explicitly identify an HTTPS deployment');
const live = process.env.SMOKE_PROVIDER === 'anthropic';
if (live && !process.env.SETUP_INVITE) throw new Error('An owner invitation is required for live mode');
let cookie = '';
async function api(path, body, headers = {}) {
  return fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin,
    'content-type': 'application/json', 'x-roundhouse': '1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
}
async function value(response) {
  assert.equal(response.ok, true, `HTTP ${response.status}: ${await response.clone().text()}`);
  return response.json();
}
async function until(predicate) {
  const deadline = Date.now() + 100000;
  while (Date.now() < deadline) {
    const state = await value(await api('/api/state'));
    if (predicate(state)) return state;
    // Accepted recovery can briefly need attention while its asynchronous job
    // finishes. Only a later independent scheduled probe resolves the incident.
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Recovery state deadline exceeded');
}
try {
  const auth = process.env.SETUP_INVITE ? await api('/api/auth/register', {
    email: `release-${randomUUID()}@example.test`, password: randomUUID() + randomUUID(), invite: process.env.SETUP_INVITE,
  }) : await api('/api/auth/guest', {});
  await value(auth); cookie = auth.headers.get('set-cookie').split(';')[0];
  if (live) await value(await api('/api/provider', { mode: 'anthropic' }));
  const manual = process.env.SMOKE_APPROVAL === 'manual';
  assert.equal((await value(await api('/api/policy'))).require_approval, false);
  if (manual) await value(await api('/api/policy', { require_approval: true }));
  await value(await api('/api/monitor/start', {}));
  await value(await api('/api/demo/fault', {}));
  if (manual) {
    const pending = await until(s => s.monitoring.incidents[0]?.state === 'awaiting_approval');
    assert.equal(pending.app.recoveries, 0);
    assert.equal(pending.app.worker_running, false);
    assert.equal(pending.monitoring.incidents[0].history.some(h => h.kind === 'inspection'), true);
    const id = pending.monitoring.incidents[0].id;
    await value(await api(`/api/incidents/${id}/approve`, {}));
  }
  const recovered = await until(s => s.monitoring.incidents[0]?.state === 'resolved');
  const { id, history } = recovered.monitoring.incidents[0];
  assert.equal(history.some(h => h.kind === 'inspection'), true);
  assert.equal(history.filter(h => h.kind === 'action_claimed').length, 1);
  assert.equal(history.some(h => h.kind === 'verification' && JSON.parse(h.detail).healthy), true);
  assert.equal(history.some(h => h.kind === 'approval_required'), manual);
  assert.equal(recovered.app.recoveries, 1); assert.equal(recovered.app.healthy, true);
  const job = recovered.app.jobs[0];
  const response = await api(`/api/reports/${job.id}.csv`); assert.equal(response.status, 200);
  const csv = await response.text();
  assert.equal(job.sha256, createHash('sha256').update(csv).digest('hex'));
  let orders = 0, revenue = 0;
  for (let d = 23; d < 30; d++) for (let j = 0; j < 3 + d % 6; j++) { orders++; revenue += 1200 + d * 137 + j * 499 + (d * j % 7) * 83; }
  assert.equal(job.order_count, orders); assert.equal(job.revenue_cents, revenue); assert.equal(job.rows, 7);
  if (manual) assert.equal((await api(`/api/incidents/${id}/approve`, {})).status, 409);
  const report = { passed: true, origin, at: new Date().toISOString(), provider: recovered.provider, job,
    budgets: recovered.monitoring.budgets, incident: recovered.monitoring.incidents[0] };
  if (process.env.SMOKE_REPORT) await writeFile(process.env.SMOKE_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, provider: recovered.provider.mode, rows: job.rows, order_count: orders, revenue_cents: revenue, sha256: job.sha256, budgets: report.budgets }));
  if (process.env.SMOKE_BROWSER === '1') {
    const evidence = await value(await api('/api/browser/evidence', {}));
    assert.equal(evidence.engine, 'kitesurf'); assert.match(evidence.content, /Reportroom/);
    console.log('PASS deployed Kitesurf binding rendered synthetic evidence; no Chromium fallback');
  }
} finally {
  if (cookie) {
    await api('/api/monitor/stop', {}).catch(() => {});
    await api('/api/auth/logout', {}).catch(() => {});
  }
}

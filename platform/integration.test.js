// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './runtime.js';

test('tenant-isolated D1, MCP authority and actual alarm-based CSV recovery', { timeout: 90000 }, async () => {
  if (process.versions.bun) {
    const result = spawnSync('node', ['--test', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr); return;
  }
  const runtime = await createRuntime();
  let ip = 1;
  const api = (path, cookie, body, extra = {}) => runtime.mf.dispatchFetch(runtime.origin + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie: cookie || '', 'content-type': 'application/json',
      'x-roundhouse': '1', origin: runtime.origin, 'cf-connecting-ip': `192.0.2.${ip++}`, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = async response => { assert.equal(response.ok, true, `${response.status} ${await response.clone().text()}`); return response.json(); };
  const poll = async (cookie, predicate) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const state = await value(await api('/api/state', cookie));
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Expected durable state not reached');
  };
  try {
    assert.equal((await api('/api/state')).status, 401);
    const register = await api('/api/auth/register', '', { email: 'owner@example.test', password: 'synthetic-password', invite: 'local-test-invitation' });
    const owner = register.headers.get('set-cookie').split(';')[0]; await value(register);
    const guestResponse = await api('/api/auth/guest', '', {});
    const guest = guestResponse.headers.get('set-cookie').split(';')[0]; await value(guestResponse);
    assert.equal((await api('/api/provider', guest, { mode: 'anthropic' })).status, 403);
    assert.equal((await api('/api/keys', guest, { name: 'denied', scopes: ['read'] })).status, 403);
    const key = await value(await api('/api/keys', owner, { name: 'read only', scopes: ['read'] }));
    const control = await value(await api('/api/keys', owner, { name: 'operator', scopes: ['read', 'control'] }));
    const mcp = (token, name) => api('/mcp', '', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, { authorization: `Bearer ${token}` });
    assert.equal((await mcp(key.token, 'start_monitoring')).status, 403);
    const listed = await value(await api('/mcp', '', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${control.token}` }));
    assert.equal(listed.result.tools.some(t => /approve|exec|fetch/.test(t.name)), false);
    await value(await api('/api/policy', owner, { require_approval: true }));
    await value(await mcp(control.token, 'start_monitoring'));
    await value(await api('/api/reports', owner, { period: 7 }));
    await value(await api('/api/demo/fault', owner, {}));
    const pending = await poll(owner, s => s.monitoring.incidents.some(i => i.state === 'awaiting_approval'));
    const incident = pending.monitoring.incidents[0];
    assert.equal(pending.app.worker_running, false);
    assert.equal(pending.app.recoveries, 0);
    assert.equal(incident.history.some(h => h.kind === 'inspection'), true);
    const other = await value(await api('/api/state', guest));
    assert.equal(other.app.healthy, true);
    assert.equal(other.monitoring.incidents.length, 0);
    assert.equal((await api(`/api/incidents/${incident.id}/approve`, guest, {})).status, 404);
    assert.equal((await api(`/api/incidents/${incident.id}/approve`, '', {}, { authorization: `Bearer ${control.token}` })).status, 403);
    assert.equal((await api(`/api/incidents/${incident.id}/approve`, owner, {}, { origin: 'https://evil.test' })).status, 403);
    await value(await api(`/api/incidents/${incident.id}/approve`, owner, {}));
    const recovered = await poll(owner, s => s.monitoring.incidents[0]?.state === 'resolved');
    assert.equal(recovered.app.recoveries, 1);
    assert.equal(recovered.app.healthy, true);
    assert.equal(recovered.monitoring.incidents[0].history.some(h => h.kind === 'verification'), true);
    const job = recovered.app.jobs[0];
    assert.equal(job.state, 'completed');
    const csv = await (await api(`/api/reports/${job.id}.csv`, owner)).text();
    assert.equal(createHash('sha256').update(csv).digest('hex'), job.sha256);
    // Independent synthetic data construction, not the application's stored totals.
    let orders = 0, revenue = 0;
    for (let day = 23; day < 30; day++) for (let j = 0; j < 3 + day % 6; j++) { orders++; revenue += 1200 + day * 137 + j * 499 + (day * j % 7) * 83; }
    assert.equal(job.order_count, orders); assert.equal(job.revenue_cents, revenue); assert.equal(job.rows, 7);
    assert.equal((await api(`/api/reports/${job.id}.csv`, guest)).status, 404);
    assert.equal((await api(`/api/incidents/${incident.id}/approve`, owner, {})).status, 409);
    await value(await api('/api/monitor/stop', owner, {}));
    console.log('PASS real scheduled detection → Rotary Wasm inspection → pending approval → actual CSV recovery → independent verification; tenant isolation and MCP denial');
  } finally { await runtime.close(); }
});

test('live provider transport reaches the configured endpoint and refuses redirects', { timeout: 20000 }, async () => {
  if (process.versions.bun) return;
  const runtime = await createRuntime({ key: 'synthetic-key-not-a-provider-secret', providerTransport: async () => new Response(null, { status: 302, headers: { location: 'https://forbidden.test' } }) });
  let cookie = '';
  const api = (path, body) => runtime.mf.dispatchFetch(runtime.origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-roundhouse': '1', origin: runtime.origin }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const auth = await api('/api/auth/register', { email: 'transport@example.test', password: 'synthetic-password', invite: 'local-test-invitation' });
    assert.equal(auth.status, 201); cookie = auth.headers.get('set-cookie').split(';')[0];
    assert.equal((await api('/api/provider', { mode: 'anthropic' })).status, 200);
    await api('/api/monitor/start', {}); await api('/api/demo/fault', {}); await api('/api/monitor/investigate', {});
    let incident;
    for (let n = 0; n < 60; n++) {
      const state = await (await api('/api/state')).json(); incident = state.monitoring.incidents[0];
      if (incident?.history.some(h => h.kind === 'provider_failed')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(incident.history.some(h => h.kind === 'provider_failed' && JSON.parse(h.detail).status === 302), true);
    assert.equal((await (await api('/api/state')).json()).app.recoveries, 0);
  } finally { await api('/api/monitor/stop', {}).catch(() => {}); await runtime.close(); }
});

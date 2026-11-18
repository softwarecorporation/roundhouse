// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRuntime } from './runtime.js';

test('reporting SaaS journey uses isolated persistent workspace data and real asynchronous CSVs', { timeout: 30000 }, async () => {
  if (process.versions.bun) {
    const child = spawnSync('node', ['--test', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stdout + child.stderr); return;
  }
  const runtime = await createRuntime();
  const request = (path, cookie = '', body, headers = {}) => runtime.mf.dispatchFetch(runtime.origin + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'x-roundhouse': '1', 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async response => { assert.equal(response.ok, true, await response.clone().text()); return response.json(); };
  try {
    assert.equal((await request('/api/workspace')).status, 401);
    const a = await request('/api/auth/guest', '', {}); const first = a.headers.get('set-cookie').split(';')[0]; await json(a);
    const b = await request('/api/auth/guest', '', {}, { 'cf-connecting-ip': '192.0.2.45' }); const second = b.headers.get('set-cookie').split(';')[0]; await json(b);
    const initial = await json(await request('/api/workspace', first));
    assert.equal(initial.preferences.onboarded, false);
    assert.deepEqual(initial.overview, { orders: 165, revenue_cents: 776883, average_order_cents: 4708 });
    const prefs = { name: 'Quarter close', default_period: 7, default_group_by: 'week', onboarded: true };
    await json(await request('/api/workspace', first, prefs));
    assert.deepEqual((await json(await request('/api/workspace', first))).preferences, prefs);
    assert.equal((await json(await request('/api/workspace', second))).preferences.onboarded, false);
    const job = await json(await request('/api/reports', first, { title: 'Weekly close', period: 7, group_by: 'week' }));
    assert.equal(job.state, 'queued');
    assert.equal((await request(`/api/reports/${job.id}`, second)).status, 404);
    let detail;
    const deadline = Date.now() + 10000;
    do {
      detail = await json(await request(`/api/reports/${job.id}`, first));
      if (detail.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(detail.state, 'completed'); assert.equal(detail.title, 'Weekly close');
    assert.equal(detail.order_count, 41); assert.equal(detail.revenue_cents, 259969);
    const expected = 'week_start,order_count,revenue_cents\n2026-01-19,11,66231\n2026-01-26,30,193738\n';
    const csv = await request(`/api/reports/${job.id}.csv`, first);
    assert.match(csv.headers.get('content-disposition'), /attachment/);
    assert.equal(await csv.text(), expected);
    assert.equal(detail.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.equal((await json(await request('/api/workspace', first))).reports[0].title, 'Weekly close');
    assert.equal((await json(await request('/api/state', first))).monitoring.incidents.length, 0);
    assert.equal((await request('/api/workspace', first, { ...prefs, tenant_id: 'forged' })).status, 400);
    assert.equal((await request('/api/workspace', first, prefs, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await json(await request('/api/policy', first))).require_approval, false);
    await json(await request('/api/policy', first, { require_approval: true }));
    assert.equal((await json(await request('/api/policy', first))).require_approval, true);
    console.log('PASS onboard → configure → queued alarm → report preview → exact CSV download; tenant isolation, preferences, policy and CSRF');
  } finally { await runtime.close(); }
});

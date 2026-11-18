// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntime } from './runtime.js';

test('public app onboarding, scoped MCP and non-Reportroom automation remain tenant isolated', { timeout: 90000 }, async () => {
  if (process.versions.bun) {
    const child = spawnSync('node', ['--test', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stdout + child.stderr); return;
  }
  let healthy = false, actions = 0, ip = 1;
  const runtime = await createRuntime({ key: 'synthetic-provider-token',
    applicationTransport: async (url, init) => {
      assert.equal(new URL(url).origin, 'https://inventory.company.com');
      assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).has('authorization'), false);
      if (url.endsWith('/health')) return Response.json({ healthy }, { status: healthy ? 200 : 503 });
      if (url.endsWith('/status')) return Response.json({ worker: healthy ? 'running' : 'paused' });
      assert.equal(url, 'https://inventory.company.com/resume'); assert.equal(init.method, 'POST');
      actions++; healthy = true; return Response.json({ accepted: true });
    },
    providerTransport: async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const input = JSON.parse(init.body);
      const inspected = input.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
      return Response.json({ id: crypto.randomUUID(), type: 'message', role: 'assistant', model: input.model,
        content: [{ type: 'tool_use', id: crypto.randomUUID(), name: inspected ? 'request_recovery' : 'inspect_system', input: inspected ? { action: 'resume_inventory' } : {} }],
        stop_reason: 'tool_use', usage: { input_tokens: 19, output_tokens: 7 } });
    },
  });
  const request = (path, cookie = '', body, extra = {}) => runtime.mf.dispatchFetch(runtime.origin + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', 'x-roundhouse': '1', origin: runtime.origin, 'cf-connecting-ip': `192.0.2.${ip++}`, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async response => { assert.equal(response.ok, true, `${response.status}: ${await response.clone().text()}`); return response.json(); };
  const owner = async email => {
    const response = await request('/api/auth/register', '', { email, password: 'synthetic-password', invite: 'local-test-invitation' });
    await json(response); return response.headers.get('set-cookie').split(';')[0];
  };
  try {
    const first = await owner('inventory-owner@example.test'), second = await owner('second-owner@example.test');
    const guestResponse = await request('/api/auth/guest', '', {}); await json(guestResponse);
    const guest = guestResponse.headers.get('set-cookie').split(';')[0];
    const configuration = { id: 'inventory', name: 'Inventory', health_url: 'https://inventory.company.com/health', interval_seconds: 30,
      diagnostics: [{ name: 'queue', url: 'https://inventory.company.com/status' }],
      actions: [{ name: 'resume_inventory', description: 'Resume the inventory worker', url: 'https://inventory.company.com/resume' }] };
    assert.equal((await request('/api/apps', '', configuration)).status, 401);
    assert.equal((await request('/api/apps', guest, configuration)).status, 403);
    assert.equal((await request('/api/apps', first, configuration, { origin: 'https://evil.test' })).status, 403);
    await json(await request('/api/apps', first, configuration));
    const apps = await json(await request('/api/apps', first));
    const inventory = apps.apps.find(a => a.id === 'inventory');
    assert.equal(inventory.actions[0].auto_approve, true); assert.equal(inventory.kind, 'connected');
    assert.equal((await json(await request('/api/apps', second))).apps.some(a => a.id === 'inventory'), false);
    assert.equal((await request('/api/apps/inventory', second)).status, 404);
    const readKey = await json(await request('/api/keys', first, { name: 'Read apps', scopes: ['read'] }));
    const controlKey = await json(await request('/api/keys', first, { name: 'App operations', scopes: ['read', 'control'] }));
    const keyHeaders = token => ({ authorization: `Bearer ${token}` });
    assert.equal((await request('/api/apps', '', configuration, keyHeaders(controlKey.token))).status, 403);
    assert.equal((await request('/api/apps/inventory/events', '', {}, keyHeaders(readKey.token))).status, 403);
    const mcp = async (token, name, args = {}) => request('/mcp', '', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, keyHeaders(token));
    assert.equal((await json(await mcp(readKey.token, 'apps'))).result.structuredContent.apps.some(a => a.id === 'inventory'), true);
    assert.equal((await json(await mcp(readKey.token, 'systems', { app_id: 'inventory' }))).result.structuredContent.app.id, 'inventory');
    assert.equal((await request('/api/apps/inventory/config', first, { ...configuration, health_url: 'http://127.0.0.1/health' })).status, 400);
    await json(await request('/api/provider', first, { mode: 'anthropic' }));
    await json(await request('/api/apps/inventory/start', first, {}));
    assert.equal((await request('/api/apps/inventory/config', first, configuration)).status, 409);
    let detail;
    const deadline = Date.now() + 45000;
    do {
      detail = await json(await request('/api/apps/inventory', first));
      if (detail.monitoring.incidents.some(i => i.state === 'resolved')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(actions, 1, JSON.stringify(detail)); assert.equal(healthy, true);
    const recovered = detail.monitoring.incidents.find(i => i.state === 'resolved');
    assert.ok(recovered); assert.equal(recovered.monitor, 'inventory');
    assert.equal(recovered.history.some(h => h.kind === 'inspection'), true);
    assert.equal(recovered.history.some(h => h.kind === 'verification'), true);
    assert.equal(recovered.history.some(h => h.kind === 'approval_required'), false);
    assert.equal((await request(`/api/incidents/${recovered.id}`, second)).status, 404);
    const eventHeaders = { ...keyHeaders(controlKey.token), 'idempotency-key': 'inventory-deploy-1' };
    const event = await json(await request('/api/apps/inventory/events', '', {}, eventHeaders));
    assert.deepEqual(await json(await request('/api/apps/inventory/events', '', {}, eventHeaders)), event);
    await json(await request('/api/apps/inventory/stop', first, {}));
    console.log('PASS owner onboarding → scoped MCP → scheduled inventory recovery → verified health; guests/keys/other tenants denied config authority');
  } finally { await runtime.close(); }
});

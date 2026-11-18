// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appConfig, publicEndpoint } from './apps.js';
import { createRuntime } from './runtime.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const definition = (id, auto) => ({ id, name: id + ' service', health_url: `https://${id}.company.com/health`, interval_seconds: 5,
  diagnostics: [{ name: 'queue', url: `https://${id}.company.com/status` }],
  actions: [{ name: 'restart', description: 'Restart this application worker', url: `https://${id}.company.com/restart`, ...(auto === undefined ? {} : { auto_approve: auto }) }] });
async function eventually(read, predicate) {
  const until = Date.now() + 45000;
  let value;
  while (Date.now() < until) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(r => setTimeout(r, 80));
  }
  assert.fail('Timed out: ' + JSON.stringify(value));
}
async function harness(persistence, transport) {
  const output = await build({ stdin: { resolveDir: root, contents: `
    import { TenantController, ReportApplication } from './controller.js';
    export { ReportApplication };
    export class Controller extends TenantController {
      async fetch(r) {
        if (new URL(r.url).pathname === '/test/probe') {
          const b = await r.json();
          try { const result = await this.applicationFetch(b.url,b.init); return new Response(await result.text(),{status:result.status}); }
          catch { return new Response('denied',{status:403}); }
        }
        if (new URL(r.url).pathname === '/test/config') return Response.json({config:this.config,fingerprint:this.fingerprint,tenant:this.tenantId()});
        return super.fetch(r);
      }
    }
    export default {fetch(r,env) {
      if(r.headers.get('authorization') !== 'Bearer test-owner') return new Response('unauthorized',{status:401});
      const tenant = new URL(r.url).hostname.split('.')[0];
      const headers = new Headers(r.headers); headers.set('x-tenant-id',tenant);
      return env.CONTROLLERS.getByName(tenant).fetch(new Request(r,{headers}));
    }};
  ` }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'],
    plugins: [{ name: 'wasm', setup(b) { b.onResolve({ filter: /roundhouse_core_bg\.wasm$/ }, () => ({ path: './roundhouse_core_bg.wasm', external: true })); } }] });
  const mf = new Miniflare({ modulesRoot: root, modules: [
    { type: 'ESModule', path: root + 'apps-test-worker.js', contents: output.outputFiles[0].text },
    { type: 'CompiledWasm', path: root + 'roundhouse_core_bg.wasm', contents: await readFile(resolve(root, '../npm/wasm/roundhouse_core_bg.wasm')) },
  ], compatibilityDate: '2026-08-06', durableObjectsPersist: persistence,
    durableObjects: { CONTROLLERS: { className: 'Controller', useSQLite: true }, REPORTS: { className: 'ReportApplication', useSQLite: true } },
    bindings: { ANTHROPIC_API_KEY: 'fake-provider-secret', APP_SECRETS_JSON: JSON.stringify({ 'alpha/one': 'one-private-token', 'alpha/two': 'two-private-token', 'beta/one': 'beta-private-token' }) },
    outboundService: transport });
  await mf.ready;
  const request = (path, body, tenant = 'alpha', extra = {}) => mf.dispatchFetch(`https://${tenant}.test${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer test-owner', 'content-type': 'application/json', connection: 'close', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (...args) => { const r = await request(...args); assert.ok(r.ok, `${r.status}: ${await r.clone().text()}`); return r.json(); };
  return { mf, request, json };
}

test('strict app schema, defaults and public endpoint validation', () => {
  const a = appConfig({ id: 'worker', name: 'Worker', health_url: 'https://worker.company.com/health' });
  assert.deepEqual(a, { id: 'worker', name: 'Worker', health_url: 'https://worker.company.com/health', expected_status: 200, interval_seconds: 60, timeout_seconds: 5, environment: 'production', diagnostics: [], actions: [] });
  assert.equal(appConfig(definition('one')).actions[0].auto_approve, true);
  assert.equal(appConfig(definition('one', false)).actions[0].auto_approve, false);
  for (const url of ['http://public.com/health', 'https://localhost/health', 'https://a.internal/health', 'https://127.0.0.1/health', 'https://2130706433/health', 'https://[::1]/health', 'https://user:pass@public.com/health', 'https://public.com:8443/health', 'https://public.com/health?q=1', 'https://public.com/health#x', 'https://public.com/health?', 'https://public.com/health#', 'https://metadata.google.internal/health']) assert.throws(() => publicEndpoint(url), url);
  for (const changes of [{ tools: [] }, { provider: {} }, { token: 'secret' }, { id: 'reportroom' }, { id: 'UPPER' }, { name: '' }, { name: 'x'.repeat(81) }, { interval_seconds: 1 }, { timeout_seconds: 31 }, { expected_status: 600 }, { environment: null }, { actions: null }, { actions: Array(5).fill(definition('one').actions[0]) }, { diagnostics: Array(5).fill({name:'x',url:'https://public.com/'}) }, { actions: [{ ...definition('one').actions[0], auto_approve: 'true' }] }]) assert.throws(() => appConfig({ ...definition('one'), ...changes }));
  assert.throws(() => appConfig(definition('one'), 'two'));
});

test('real core + Miniflare: scheduled and authenticated event recovery, manual approval, tenant budgets, persistence and egress controls', { timeout: 180000 }, async () => {
  if (process.versions.bun) {
    const result = spawnSync('node', ['--test', '--test-name-pattern=real core', fileURLToPath(import.meta.url)], { encoding:'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr); return;
  }
  const scratch = resolve(root, '../../.amp/in/orb-backup');
  await mkdir(scratch, { recursive: true });
  const persistence = await mkdtemp(resolve(scratch, 'apps-'));
  const state = { one: { healthy: false, actions: 0 }, two: { healthy: false, actions: 0 } };
  const traffic = [], provider = [];
  const transport = async request => {
    if (request.url === 'https://api.anthropic.com/v1/messages') {
      const body = await request.json(); provider.push(body);
      assert.equal(JSON.stringify(body).includes('private-token'), false);
      const inspected = body.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
      return Response.json({ id: crypto.randomUUID(), type: 'message', role: 'assistant', model: 'fake-anthropic',
        content: [{ type: 'tool_use', id: crypto.randomUUID(), name: inspected ? 'request_recovery' : 'inspect_system', input: inspected ? { action: 'restart' } : {} }], stop_reason: 'tool_use', usage: { input_tokens: 0, output_tokens: 0 } });
    }
    const url = new URL(request.url), app = url.hostname.split('.')[0];
    traffic.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers) });
    assert.ok(state[app], 'No arbitrary endpoint traffic');
    const auth = request.headers.get('authorization');
    assert.ok(app === 'one' ? ['Bearer one-private-token', 'Bearer beta-private-token'].includes(auth) : auth === 'Bearer two-private-token');
    for (const secret of ['internal-reportroom', 'internal-controller-operator', 'internal-event-receiver', 'fake-provider-secret', 'cookie-secret']) assert.equal(JSON.stringify(Object.fromEntries(request.headers)).includes(secret), false);
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/steal' } });
    if (url.pathname === '/health') return new Response('', { status: state[app].healthy ? 200 : 503 });
    if (url.pathname === '/status') return Response.json({ queue: 'stopped', echoed: 'one-private-token two-private-token beta-private-token' });
    assert.equal(url.pathname, '/restart'); assert.equal(request.method, 'POST');
    state[app].actions++; state[app].healthy = true;
    return Response.json({ accepted: true });
  };
  let runtime = await harness(persistence, transport);
  try {
    const { json, request } = runtime;
    assert.equal((await request('/v1/events', { monitor: 'one' }, 'alpha', { authorization: 'wrong' })).status, 401);
    const original = await json('/test/config');
    assert.equal((await json('/platform/apps')).apps[0].kind, 'example');
    await json('/platform/apps', definition('one'));
    await json('/platform/apps', definition('two', false));
    assert.deepEqual((await json('/test/config')).config.monitors[0], original.config.monitors[0]);
    assert.notEqual((await json('/test/config')).fingerprint, original.fingerprint);
    assert.equal((await request('/platform/apps', definition('one'))).status, 409);
    assert.equal((await json('/platform/apps', undefined, 'beta')).apps.length, 1);
    await json('/platform/apps', { ...definition('one', false), actions: [] }, 'beta');
    assert.equal((await json('/platform/apps', undefined, 'beta')).apps[1].actions.length, 0);
    assert.equal((await request('/test/probe', { url:'https://one.company.com/status' }, 'beta')).status, 200);
    assert.equal(traffic.at(-1).headers.authorization, 'Bearer beta-private-token');
    for (let n = 2; n <= 10; n++) await json('/platform/apps', { id:`app${n}`, name:`App ${n}`, health_url:`https://app${n}.company.com/health` }, 'beta');
    assert.equal((await request('/platform/apps', { id:'overflow', name:'Overflow', health_url:'https://overflow.company.com/health' }, 'beta')).status, 409);
    // Exact endpoint/method controls and header reconstruction, including redirects.
    const probe = (url, init = {}) => request('/test/probe', { url, init });
    for (const [url, init] of [['https://one.company.com/unconfigured', {}], ['https://one.company.com/health?exfil=1', {}], ['https://127.0.0.1/health', {}], ['https://one.company.com/health', {method:'POST'}], ['https://one.company.com/restart', {method:'GET'}], ['https://one.company.com/restart', {method:'POST'}]]) assert.equal((await probe(url, init)).status, 403);
    assert.equal(state.one.actions, 0);
    await json('/platform/apps/one/config', { ...definition('one'), diagnostics: [...definition('one').diagnostics, { name:'redirect', url:'https://one.company.com/redirect' }] });
    assert.equal((await probe('https://one.company.com/redirect', { headers: { authorization:'Bearer internal-reportroom', cookie:'cookie-secret', 'x-api-key':'fake-provider-secret' }, redirect:'follow' })).status, 403);
    assert.equal((await probe('https://one.company.com/status', { headers: { authorization:'Bearer internal-reportroom', cookie:'cookie-secret' } })).status, 200);
    await json('/platform/provider', {mode:'anthropic'});
    await json('/v1/start', {});
    assert.equal((await request('/platform/apps/one/config', definition('one'))).status, 409);
    const auto = await eventually(async () => (await json('/v1/incidents')).incidents.find(i => i.monitor === 'one'), i => i?.state === 'resolved');
    const history = await json(`/v1/incidents/${auto.id}`);
    assert.equal(history.history.filter(h => h.kind === 'action_claimed').length, 1);
    assert.equal(history.history.some(h => h.kind === 'inspection'), true);
    assert.equal(history.history.some(h => h.kind === 'verification' && JSON.parse(h.detail).healthy), true);
    assert.equal(JSON.stringify(history).includes('private-token'), false);
    assert.equal(state.one.actions, 1);
    // Independent application state confirms actual recovery, not a model claim.
    assert.equal(state.one.healthy, true);
    const manual = await eventually(async () => (await json('/v1/incidents')).incidents.find(i => i.monitor === 'two'), i => i?.state === 'awaiting_approval');
    assert.equal(state.two.actions, 0);
    await json('/v1/stop', {});
    assert.equal((await request('/platform/apps/two/config', definition('two'))).status, 409);
    const saved = await json('/platform/apps');
    await runtime.mf.dispose(); runtime = await harness(persistence, transport);
    assert.deepEqual(await runtime.json('/platform/apps'), saved);
    assert.equal((await runtime.json('/test/config')).tenant, 'alpha');
    assert.equal((await runtime.json('/platform/apps')).apps[2].actions[0].auto_approve, false);
    await runtime.json(`/v1/incidents/${manual.id}/approve`, { action:'restart' });
    await runtime.json('/v1/start', {});
    await eventually(async () => (await runtime.json('/v1/incidents')).incidents.find(i => i.id === manual.id), i => i?.state === 'resolved');
    assert.equal(state.two.actions, 1);
    // Authenticated event detects a new fault before the next scheduled interval.
    state.one.healthy = false;
    const event = await runtime.json('/v1/events', {monitor:'one'}, 'alpha', {'idempotency-key':'one-event'});
    assert.equal((await runtime.json('/v1/events', {monitor:'one'}, 'alpha', {'idempotency-key':'one-event'})).incident_id, event.incident_id);
    await eventually(async () => (await runtime.json('/v1/incidents')).incidents.find(i => i.id === event.incident_id), i => i?.state === 'resolved');
    assert.equal(state.one.actions, 2);
    const status = await runtime.json('/v1/status');
    assert.equal(status.budgets.length, 1);
    assert.equal(status.budgets[0].actions, 3);
    assert.equal(status.schedule.length, 3);
    assert.equal((await runtime.json('/v1/status', undefined, 'beta')).budgets.length, 0);
    assert.equal((await runtime.json('/v1/incidents', undefined, 'beta')).incidents.length, 0);
    await runtime.json('/v1/stop', {});
    await runtime.json('/platform/provider', {mode:'fixture'});
    state.one.healthy = false;
    await runtime.json('/v1/events', {monitor:'one'}, 'alpha', {'idempotency-key':'fixture-event'});
    await runtime.json('/v1/start', {});
    const failed = await eventually(async () => (await runtime.json('/v1/incidents')).incidents.find(i => i.monitor === 'one' && i.state !== 'resolved'), i => i?.state === 'needs_attention');
    const failure = await runtime.json(`/v1/incidents/${failed.id}`);
    assert.match(JSON.stringify(failure), /External investigation requires Anthropic/);
    assert.equal(state.one.actions, 2);
    assert.ok(provider.length >= 6);
    assert.equal(traffic.some(t => t.url.includes('127.0.0.1')), false);
    await runtime.json('/v1/stop', {});
  } finally { await runtime.mf.dispose(); }
});

test('built BFF owner session and explicit applicationTransport run an independent app with no paid calls', { timeout: 90000 }, async () => {
  if (process.versions.bun) {
    const result = spawnSync('node', ['--test', '--test-name-pattern=built BFF', fileURLToPath(import.meta.url)], { encoding:'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr); return;
  }
  let healthy = false, actions = 0, calls = 0;
  const runtime = await createRuntime({ key:'fake-test-key', applicationTransport: async (url, init) => {
    assert.equal(init.headers.has('authorization'), false);
    assert.equal(init.headers.has('cookie'), false);
    assert.equal(init.headers.has('x-api-key'), false);
    assert.equal(init.redirect, 'manual');
    assert.ok(url.startsWith('https://three.company.com/'));
    if (url.endsWith('/health')) return new Response('', {status:healthy ? 200 : 503});
    if (url.endsWith('/status')) return Response.json({ worker:'paused' });
    assert.equal(url, 'https://three.company.com/restart'); assert.equal(init.method, 'POST');
    healthy = true; actions++; return Response.json({accepted:true});
  }, providerTransport: async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); calls++;
    assert.equal(typeof init.body, 'string');
    const body = JSON.parse(init.body);
    const inspected = body.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
    return Response.json({ id:crypto.randomUUID(), type:'message', role:'assistant', model:'fake-anthropic',
      content:[{ type:'tool_use', id:crypto.randomUUID(), name:inspected ? 'request_recovery' : 'inspect_system', input:inspected ? {action:'restart'} : {} }],
      stop_reason:'tool_use', usage:{input_tokens:0,output_tokens:0} });
  } });
  let cookie = '';
  const api = (path, body, extra = {}) => runtime.mf.dispatchFetch(runtime.origin + path, { method:body === undefined ? 'GET' : 'POST',
    headers:{ cookie, origin:runtime.origin, 'x-roundhouse':'1', 'content-type':'application/json', ...extra }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  const json = async (path, body) => { const r = await api(path, body); assert.ok(r.ok, `${r.status}: ${await r.clone().text()}`); return r.json(); };
  try {
    assert.equal((await api('/api/apps')).status, 401);
    const registration = await api('/api/auth/register', {email:'apps-owner@example.test',password:'synthetic-test-password',invite:'local-test-invitation'});
    assert.equal(registration.status, 201);
    cookie = registration.headers.get('set-cookie').split(';')[0];
    assert.equal((await api('/api/apps', definition('three'), {origin:'https://evil.company.com'})).status, 403);
    await json('/api/apps', definition('three'));
    await json('/api/provider', {mode:'anthropic'});
    await json('/api/apps/three/events', {});
    await json('/api/apps/three/start', {});
    const app = await eventually(() => json('/api/apps/three'), value => value.incidents?.some(i => i.state === 'resolved') || value.monitoring?.incidents?.some(i => i.state === 'resolved'));
    assert.equal(healthy, true); assert.equal(actions, 1); assert.equal(calls, 2);
    assert.match(JSON.stringify(app), /verification/);
    await json('/api/apps/three/stop', {});
  } finally { await runtime.close(); }
});

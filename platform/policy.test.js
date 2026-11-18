// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createRuntime as createStandalone } from '../examples/reportroom/runtime.js';

const root = fileURLToPath(new URL('.', import.meta.url));
async function eventually(read, predicate) {
  const deadline = Date.now() + 45000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`State not reached: ${JSON.stringify(last)}`);
}
async function checked(response) {
  assert.equal(response.ok, true, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}
async function controllerRuntime(persistence) {
  const output = await build({ stdin: { resolveDir: root, contents: `
    import { TenantController, ReportApplication } from './controller.js';
    export { TenantController, ReportApplication };
    export class LegacyController extends TenantController {
      constructor(ctx, env) {
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY, monitor TEXT NOT NULL, state TEXT NOT NULL, pending_action TEXT, approved_action TEXT, attempted INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, created_at INTEGER NOT NULL)");
        super(ctx, env);
      }
    }
    export default {fetch(request,env) {
      const url = new URL(request.url);
      const legacy = url.hostname === 'legacy.test';
      const controller = (legacy ? env.LEGACY : env.CONTROLLERS).getByName('tenant');
      if (url.pathname.startsWith('/app/')) {
        const id = (legacy ? env.LEGACY : env.CONTROLLERS).idFromName('tenant').toString();
        const headers = new Headers(request.headers); headers.set('authorization','Bearer internal-reportroom');
        return env.REPORTS.getByName(id).fetch(new Request('https://reportroom.internal/'+url.pathname.slice(5), {method:request.method,headers,body:request.body}));
      }
      return controller.fetch(request);
    }};
  ` }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'],
  plugins: [{ name: 'wasm', setup(b) { b.onResolve({ filter: /roundhouse_core_bg\.wasm$/ }, () => ({ path: './roundhouse_core_bg.wasm', external: true })); } }] });
  const mf = new Miniflare({ modulesRoot: root, modules: [
    { type: 'ESModule', path: root + 'policy-worker.js', contents: output.outputFiles[0].text },
    { type: 'CompiledWasm', path: root + 'roundhouse_core_bg.wasm', contents: await readFile(resolve(root, '../npm/wasm/roundhouse_core_bg.wasm')) },
  ], compatibilityDate: '2026-08-06', durableObjectsPersist: persistence,
  durableObjects: { CONTROLLERS: { className: 'TenantController', useSQLite: true }, LEGACY: { className: 'LegacyController', useSQLite: true }, REPORTS: { className: 'ReportApplication', useSQLite: true } },
  bindings: { APPLICATION_TOKEN: 'internal-reportroom' }, outboundService: () => { throw new Error('External egress denied'); } });
  await mf.ready;
  const request = (path, body, host = 'tenant.test') => mf.dispatchFetch(`https://${host}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { mf, request, json: async (...args) => checked(await request(...args)) };
}
async function verifyRecovery(json, appPrefix) {
  const incident = await eventually(async () => (await json('/v1/incidents')).incidents[0], i => i?.state === 'resolved');
  const history = await json(`/v1/incidents/${incident.id}`);
  assert.equal(history.history.some(h => h.kind === 'inspection'), true);
  assert.equal(history.history.some(h => h.kind === 'verification' && JSON.parse(h.detail).healthy), true);
  assert.equal(history.history.filter(h => h.kind === 'action_claimed').length, 1);
  assert.equal(history.history.some(h => h.kind === 'approval_required'), false);
  const app = await json(appPrefix + '/status');
  assert.equal(app.healthy, true);
  assert.equal(app.recoveries, 1);
  const job = app.jobs.find(j => j.state === 'completed');
  assert.ok(job);
  let orders = 0, revenue = 0;
  for (let day = 23; day < 30; day++) for (let j = 0; j < 3 + day % 6; j++) { orders++; revenue += 1200 + day * 137 + j * 499 + day * j % 7 * 83; }
  assert.equal(job.order_count, orders);
  assert.equal(job.revenue_cents, revenue);
  return job;
}

test('automatic recovery, explicit approval, and persistent legacy policy on real Miniflare', { timeout: 180000 }, async () => {
  if (process.versions.bun) {
    const result = spawnSync('node', ['--test', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr); return;
  }
  const scratch = resolve(root, '../../.amp/in/orb-backup');
  await mkdir(scratch, { recursive: true });
  const persistence = await mkdtemp(resolve(scratch, 'policy-'));
  let runtime;
  let standalone;
  try {
    runtime = await controllerRuntime(resolve(persistence, 'platform'));
    assert.deepEqual(await runtime.json('/platform/policy'), { require_approval: false });
    assert.deepEqual(await runtime.json('/platform/policy', undefined, 'legacy.test'), { require_approval: true });
    for (const body of [null, [], {}, { require_approval: 'false' }, { require_approval: false, extra: true }]) assert.equal((await runtime.request('/platform/policy', body)).status, 400);
    assert.equal((await runtime.mf.dispatchFetch('https://tenant.test/platform/policy', { method: 'POST', body: '{' })).status, 400);
    assert.equal((await runtime.mf.dispatchFetch('https://tenant.test/platform/policy', { method: 'PUT' })).status, 405);
    await runtime.json('/app/fault', {});
    await runtime.json('/v1/start', {});
    const job = await verifyRecovery(runtime.json, '/app');
    const csv = await (await runtime.request(`/app/reports/${job.id}.csv`)).text();
    assert.equal(createHash('sha256').update(csv).digest('hex'), job.sha256);
    await runtime.json('/v1/stop', {});
    assert.deepEqual(await runtime.json('/platform/policy', { require_approval: true }), { require_approval: true });
    await runtime.mf.dispose();
    runtime = await controllerRuntime(resolve(persistence, 'platform'));
    assert.deepEqual(await runtime.json('/platform/policy'), { require_approval: true });
    await runtime.json('/app/fault', {});
    await runtime.json('/v1/start', {});
    // Use scheduled detection, not a synthetic incident inserted by the test.
    const pending = await eventually(async () => (await runtime.json('/v1/incidents')).incidents.find(i => i.state !== 'resolved'), i => i?.state === 'awaiting_approval');
    assert.equal((await runtime.json('/app/status')).recoveries, 1);
    assert.equal((await runtime.request('/platform/policy', { require_approval: false })).status, 409);
    const detail = await runtime.json(`/v1/incidents/${pending.id}`);
    assert.equal(detail.history.some(h => h.kind === 'approval_required'), true);
    assert.equal(detail.history.some(h => h.kind === 'action_claimed'), false);
    await runtime.json('/v1/stop', {});
    await runtime.mf.dispose(); runtime = undefined;

    standalone = await createStandalone();
    await standalone.app('/fault', {});
    const json = (path, body) => path.startsWith('/app/') ? standalone.app(path.slice(4), body) : standalone.json(path, body);
    await verifyRecovery(json, '/app');
    assert.equal((await standalone.request('/v1/status', undefined, { token: 'wrong' })).status, 401);
    await standalone.close(); standalone = undefined;
    const standalonePersistence = resolve(persistence, 'standalone');
    standalone = await createStandalone({ persistence: standalonePersistence, requireApproval: true });
    await standalone.app('/fault', {});
    const readPending = async () => (await standalone.json('/v1/incidents')).incidents[0];
    const manual = await eventually(readPending, i => i?.state === 'awaiting_approval');
    assert.equal((await standalone.app('/status')).recoveries, 0);
    await standalone.close(); standalone = undefined;
    // Default false on restart must not overwrite explicit persisted true.
    standalone = await createStandalone({ persistence: standalonePersistence });
    assert.equal((await readPending()).state, 'awaiting_approval');
    assert.equal((await standalone.app('/status')).recoveries, 0);
    await standalone.json(`/v1/incidents/${manual.id}/approve`, { action: 'resume_exports' });
    await eventually(readPending, i => i?.state === 'resolved');
    assert.equal((await standalone.app('/status')).recoveries, 1);
  } finally {
    await standalone?.close();
    await runtime?.mf.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
});

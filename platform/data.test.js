// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
let Miniflare;
try { ({ Miniflare } = require('miniflare')); }
catch { ({ Miniflare } = require('../examples/reportroom/node_modules/miniflare')); }
const owner = tenant_id => ({ tenant_id, role: 'owner', kind: 'session', scopes: ['read', 'ingest', 'admin'] });
const page = (id, extra = {}) => ({ id, kind: 'pageview', name: 'pageview', path: '/docs', ...extra });
const entry = (id, extra = {}) => ({ id, service: 'api', level: 'info', message: 'ordinary message', ...extra });
const wrapper = `
import { dataRoute, summary } from './data.js';
export default { async fetch(request, env) {
  const principal = JSON.parse(request.headers.get('x-test-principal') || 'null');
  if (new URL(request.url).pathname === '/test/summary') return Response.json(await summary(env, principal.tenant_id));
  return await dataRoute(request, env, principal) || Response.json({error:'Not found'}, {status:404});
}};`;

test('data slice on actual Miniflare Worker/D1', { timeout: 60000 }, async t => {
  if (process.versions.bun) {
    const result = spawnSync('node', ['--test', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return;
  }
  const root = fileURLToPath(new URL('.', import.meta.url));
  const mf = new Miniflare({ modulesRoot: root, modules: [
    { type: 'ESModule', path: `${root}data-test-worker.js`, contents: wrapper },
    { type: 'ESModule', path: `${root}data.js`, contents: await readFile(new URL('./data.js', import.meta.url), 'utf8') },
  ], compatibilityDate: '2026-01-01', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    const authMigration = await readFile(new URL('./migrations/0001.sql', import.meta.url), 'utf8');
    for (const statement of authMigration.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    const migration = await readFile(new URL('./migrations/0002.sql', import.meta.url), 'utf8');
    const trigger = migration.match(/CREATE TRIGGER[\s\S]*?\nEND;/)[0];
    for (const statement of migration.replace(trigger, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    await db.prepare(trigger).run();
    const tenants = ['a', 'b', 'validation', 'duplicate', 'quota', 'sites', 'status', 'retention', 'retention-other', 'capacity', 'site-capacity'];
    for (const tenant of tenants) await db.prepare('INSERT INTO tenants(id,name,kind,created_at) VALUES(?,?,?,?)').bind(tenant, tenant, 'owner', Date.now()).run();
    async function api(path, { body, principal = owner('a'), headers = {}, method, raw } = {}) {
      return mf.dispatchFetch(`https://app.roundhouse.test${path}`, {
        method: method || (body !== undefined || raw !== undefined ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', ...(principal ? { 'x-test-principal': JSON.stringify(principal) } : {}), ...headers },
        duplex: 'half', ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    }
    async function post(tenant, batch, expected = 200) {
      const response = await api('/api/ingest', { body: batch, principal: owner(tenant) });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      if (expected !== 200) assert.deepEqual(Object.keys(result), ['error']);
      return result;
    }
    const count = async tenant => (await db.prepare('SELECT count(*) AS n FROM data_records WHERE tenant_id = ?').bind(tenant).first()).n;
    const used = async tenant => (await db.prepare('SELECT coalesce(sum(used),0) AS n FROM data_quotas WHERE tenant_id = ?').bind(tenant).first()).n;

    await t.test('tenant isolation, URL privacy, supplied time, last-24h summary', async () => {
      const at = new Date(Date.now() - 3600000).toISOString();
      const accepted = await post('a', { events: [page('shared', { path: '/docs?email=private#secret', referrer: 'https://search.example/path?q=private#secret', at }),
        page('custom', { kind: 'event', name: 'clicked' })], logs: [entry('log-a', { trace_id: 'trace-a' })] });
      assert.equal(accepted.accepted, 3);
      await post('b', { events: [page('shared', { path: '/other' })], logs: [entry('log-b', { message: 'tenant b private' })] });
      const a = await (await api('/test/summary')).json();
      const b = await (await api('/test/summary', { principal: owner('b') })).json();
      assert.equal(a.analytics.pageviews, 1);
      assert.equal(a.analytics.events, 1);
      assert.deepEqual(a.analytics.paths, [{ path: '/docs', count: 1 }]);
      assert.deepEqual(a.analytics.referrers, [{ referrer: 'search.example', count: 1 }]);
      assert.equal(a.analytics.series.reduce((n, row) => n + row.count, 0), 1);
      assert.equal(a.logs[0].id, 'log-a');
      assert.equal(b.logs[0].id, 'log-b');
      assert.deepEqual(b.analytics.paths, [{ path: '/other', count: 1 }]);
      assert.deepEqual(a.status, { published: false, slug: null, title: '', updates: [] });
      const stored = await db.prepare('SELECT * FROM data_records WHERE tenant_id = ? AND id = ?').bind('a', 'shared').first();
      assert.equal(stored.at, Date.parse(at));
      assert.ok(stored.received_at > stored.at);
      assert.equal(stored.path, '/docs');
      assert.equal(stored.referrer, 'search.example');
      assert.ok(!JSON.stringify(stored).includes('private'));
      assert.ok(!('ip' in stored) && !('user_agent' in stored) && !('visitor_id' in stored));
      await db.prepare('UPDATE data_records SET at = ? WHERE tenant_id = ?').bind(Date.now() - 86400001, 'b').run();
      const old = await (await api('/test/summary', { principal: owner('b') })).json();
      assert.equal(old.analytics.pageviews, 0);
      assert.equal(old.logs.length, 0);
    });

    await t.test('authorization and method boundaries', async () => {
      assert.equal((await api('/api/analytics', { principal: null })).status, 401);
      assert.equal((await api('/api/analytics', { principal: { ...owner('a'), scopes: ['ingest'] } })).status, 403);
      assert.equal((await api('/api/ingest', { body: { events: [page('denied')] }, principal: { ...owner('a'), scopes: ['read'] } })).status, 403);
      assert.equal((await api('/api/analytics', { method: 'DELETE' })).status, 405);
      assert.equal((await api('/unowned')).status, 404);
      for (const principal of [{ ...owner('a'), kind: 'key' }, { ...owner('a'), role: 'guest' }, { ...owner('a'), scopes: ['read', 'ingest'] }]) {
        for (const [path, body] of [['/api/status', { published: true, title: 'Denied' }], ['/api/status/updates', { message: 'Denied', state: 'resolved' }], ['/api/sites', { origin: 'https://denied.example' }]]) {
          assert.equal((await api(path, { principal, body })).status, 403);
        }
        assert.equal((await api('/api/export', { principal })).status, 403);
      }
    });

    await t.test('strict validation consumes no quota or records; bounded streaming body', async () => {
      const invalid = [
        {}, { events: [] }, { events: {} }, { events: null }, { logs: 'bad' },
        { tenant_id: 'a', events: [page('bad')] }, { events: [page('bad', { tenant_id: 'a' })] },
        { events: [page('bad', { visitor_id: 'persistent' })] }, { events: [page('bad', { properties: { visitor_id: 'persistent' } })] },
        { events: [page('bad', { properties: { nested: { user_agent: 'private' } } })] },
        { events: [page('bad', { properties: [] })] }, { events: [page('bad', { properties: null })] },
        { events: [page('bad', { kind: 'log' })] }, { events: [page('bad', { path: '//evil.example' })] },
        { events: [page('bad', { path: 'https://evil.example' })] }, { events: [page('bad', { referrer: 'http://search.example/' })] },
        { events: [page('bad', { at: new Date(Date.now() - 86410000).toISOString() })] },
        { events: [page('bad', { at: new Date(Date.now() + 86410000).toISOString() })] },
        { logs: [entry('bad', { level: 'fatal' })] }, { logs: [entry('bad', { extra: true })] },
        { events: Array.from({ length: 51 }, (_, i) => page(`bad-${i}`)) },
        { events: [page('valid')], logs: [entry('invalid', { service: '' })] },
      ];
      for (const value of invalid) await post('validation', value, 400);
      assert.equal((await api('/api/ingest', { raw: '{', principal: owner('validation') })).status, 400);
      assert.equal((await api('/api/ingest', { body: {}, headers: { 'content-type': 'text/plain' }, principal: owner('validation') })).status, 415);
      const chunks = [new Uint8Array(10000).fill(32), new Uint8Array(10000).fill(32)];
      const raw = new ReadableStream({ pull(controller) { const chunk = chunks.shift(); chunk ? controller.enqueue(chunk) : controller.close(); } });
      assert.equal((await api('/api/ingest', { raw, principal: owner('validation') })).status, 413);
      assert.equal(await count('validation'), 0);
      assert.equal(await used('validation'), 0);
    });

    await t.test('idempotency and conflicting duplicate rollback are transactional', async () => {
      const original = page('one', { properties: { z: 2, a: 1 } });
      assert.equal((await post('duplicate', { events: [original, original] })).accepted, 1);
      const originalTime = await db.prepare('SELECT at,received_at FROM data_records WHERE tenant_id = ?').bind('duplicate').first();
      assert.equal((await post('duplicate', { events: [page('one', { path: '/docs?ignored#ignored', properties: { a: 1, z: 2 } })] })).accepted, 0);
      assert.deepEqual(await db.prepare('SELECT at,received_at FROM data_records WHERE tenant_id = ?').bind('duplicate').first(), originalTime);
      assert.equal(await used('duplicate'), 1);
      await post('duplicate', { events: [page('new'), page('one', { name: 'conflict' })] }, 409);
      assert.equal(await count('duplicate'), 1);
      assert.equal(await used('duplicate'), 1);
      await post('duplicate', { events: [page('same'), page('same', { name: 'conflict' })] }, 409);
      assert.equal(await count('duplicate'), 1);
      assert.equal(await used('duplicate'), 1);
      const parallel = await Promise.all([post('duplicate', { events: [page('race')] }), post('duplicate', { events: [page('race')] })]);
      assert.equal(parallel.reduce((sum, r) => sum + r.accepted, 0), 1);
      assert.equal(await used('duplicate'), 2);
    });

    await t.test('atomic tenant hourly quota survives concurrent boundary attempts', async () => {
      for (let batch = 0; batch < 19; batch++) await post('quota', { events: Array.from({ length: 50 }, (_, i) => page(`q-${batch}-${i}`)) });
      await post('quota', { events: Array.from({ length: 49 }, (_, i) => page(`q-last-${i}`)) });
      assert.equal(await used('quota'), 999);
      const responses = await Promise.all([
        api('/api/ingest', { principal: owner('quota'), body: { events: [page('overflow-1'), page('overflow-2')] } }),
        api('/api/ingest', { principal: owner('quota'), body: { logs: [entry('final-log')] } }),
      ]);
      assert.deepEqual(responses.map(r => r.status), [429, 200]);
      assert.equal(await used('quota'), 1000);
      assert.equal(await count('quota'), 1000);
      assert.equal((await post('quota', { events: [page('q-0-0')] })).accepted, 0);
      await post('quota', { events: [page('no-room')] }, 429);
      await post('quota', { events: [page('malformed', { extra: true })] }, 400);
      assert.equal(await used('quota'), 1000);
    });

    await t.test('explicit public status is sanitized, stable, minimal and unpublishable by keys/guests', async () => {
      const principal = owner('status');
      const configured = await (await api('/api/status', { principal, body: { published: false, title: '<img onerror=alert(1)> & service' } })).json();
      assert.match(configured.slug, /^[a-f0-9]{32}$/);
      assert.equal((await api(`/public/status/${configured.slug}`, { principal: null })).status, 404);
      await api('/api/status/updates', { principal, body: { message: '<script>bad</script> & investigating', state: 'investigating' } });
      const published = await (await api('/api/status', { principal, body: { published: true, title: '<b>Service</b>' } })).json();
      assert.equal(published.slug, configured.slug);
      const response = await api(`/public/status/${configured.slug}`, { principal: null });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['title', 'updates']);
      assert.equal(body.title, '&lt;b&gt;Service&lt;/b&gt;');
      assert.deepEqual(Object.keys(body.updates[0]).sort(), ['at', 'message', 'state']);
      assert.ok(!JSON.stringify(body).includes('<script>'));
      assert.ok(!JSON.stringify(body).includes('tenant_id'));
      assert.equal((await (await api('/api/status', { principal: owner('a') })).json()).published, false);
      await api('/api/status', { principal, body: { published: false, title: 'Service' } });
      assert.equal((await api(`/public/status/${configured.slug}`, { principal: null })).status, 404);
    });

    await t.test('registered public collection is origin-bound, credentialless, minimal and budgeted', async () => {
      const principal = owner('sites');
      const credentialed = new URL('https://customer.example');
      credentialed.username = 'synthetic-user';
      credentialed.password = 'synthetic-password';
      for (const origin of ['http://customer.example', 'https://customer.example/path', 'https://customer.example?secret=1', credentialed.href]) {
        assert.equal((await api('/api/sites', { principal, body: { origin } })).status, 400);
      }
      const site = await (await api('/api/sites', { principal, body: { origin: 'https://customer.example' } })).json();
      assert.match(site.write_id, /^[a-f0-9]{32}$/);
      const repeated = await (await api('/api/sites', { principal, body: { origin: 'https://customer.example/' } })).json();
      assert.equal(repeated.write_id, site.write_id);
      const listed = await (await api('/api/sites', { principal })).json();
      assert.equal(listed.sites.length, 1);
      assert.equal((await (await api('/api/sites', { principal: owner('a') })).json()).sites.length, 0);
      const path = `/collect/${site.write_id}`;
      const collect = (body, headers = {}, method) => api(path, { principal: null, body, method, headers: { origin: site.origin, ...headers } });
      for (const origin of ['https://evil.example', 'https://customer.example.evil', 'null', '']) {
        const response = await collect(page('bad-origin'), { origin });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
      }
      for (const headers of [{ cookie: 'session=secret' }, { authorization: 'Bearer secret' }]) assert.equal((await collect(page('credentials'), headers)).status, 403);
      for (const payload of [page('extra', { properties: { ok: true } }), { ...page('extra'), published: true }, { logs: [entry('extra')] }, { events: [page('extra')] }]) {
        assert.equal((await collect(payload)).status, 400);
      }
      assert.equal((await collect(page('wrong-type'), { 'content-type': 'text/plain' })).status, 415);
      const preflight = await collect(undefined, { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }, 'OPTIONS');
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), site.origin);
      assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
      assert.equal((await collect(undefined, { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' }, 'OPTIONS')).status, 403);
      assert.equal((await collect(page('public-one', { path: '/?secret=value#private' }))).status, 200);
      assert.equal((await collect(page('public-one', { path: '/?secret=value#private' }))).status, 200);
      for (let i = 1; i < 200; i++) assert.equal((await collect(page(`public-${i}`))).status, 200);
      const limited = await collect(page('too-many'));
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('access-control-allow-origin'), site.origin);
      assert.equal(await count('sites'), 200);
      assert.equal(await used('sites'), 200);
      const stored = await db.prepare('SELECT tenant_id,path FROM data_records WHERE tenant_id = ? AND id = ?').bind('sites', 'public-one').first();
      assert.deepEqual(stored, { tenant_id: 'sites', path: '/' });
      assert.equal((await api('/api/status', { principal: { tenant_id: 'sites', role: 'owner', kind: 'key', scopes: ['admin'] }, body: { published: true, title: 'Cannot escalate' } })).status, 403);
    });

    await t.test('bounded retention purge, filtered literal LIKE and bounded export', async () => {
      const now = Date.now();
      for (const tenant of ['retention', 'retention-other']) {
        await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<150)
          INSERT INTO data_records(tenant_id,id,kind,path,name,at,received_at,fingerprint)
          SELECT ?, 'old-'||x, 'pageview','/old','pageview',?,?, 'old-'||x FROM n`).bind(tenant, now - 8 * 86400000, now - 8 * 86400000).run();
      }
      await api('/test/summary', { principal: owner('retention') });
      assert.equal(await count('retention'), 50);
      assert.equal(await count('retention-other'), 150);
      await api('/test/summary', { principal: owner('retention') });
      assert.equal(await count('retention'), 0);
      const logRows = [entry('percent', { message: '100% done' }), entry('under', { message: 'under_score' }), entry('slash', { message: 'back\\slash' }), entry('not-percent', { message: '100x done' })];
      await post('retention', { logs: logRows });
      for (let n = 0; n < 3; n++) await post('retention', { logs: Array.from({ length: 50 }, (_, i) => entry(`bound-${n}-${i}`)) });
      for (const [q, expected] of [['%', 'percent'], ['_', 'under'], ['\\', 'slash']]) {
        const result = await (await api(`/api/logs?level=info&service=api&q=${encodeURIComponent(q)}`, { principal: owner('retention') })).json();
        assert.deepEqual(result.logs.map(row => row.id), [expected]);
      }
      assert.equal((await api('/api/logs?q=a&q=b', { principal: owner('retention') })).status, 400);
      assert.equal((await api('/api/logs?tenant_id=a', { principal: owner('retention') })).status, 400);
      assert.equal((await (await api('/api/logs', { principal: owner('retention') })).json()).logs.length, 100);
      const exported = await (await api('/api/export', { principal: owner('retention') })).json();
      assert.equal(exported.records.length, 100);
      assert.equal(exported.limits.rows, 100);
      assert.match(exported.note, /not a complete archive/);
      assert.ok(exported.records.every(row => !('tenant_id' in row) && !('fingerprint' in row)));
    });

    await t.test('combined tenant cap is enforced by real transactional storage', async () => {
      const now = Date.now();
      await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO data_records(tenant_id,id,kind,path,name,at,received_at,fingerprint)
        SELECT 'capacity','cap-'||x,CASE WHEN x%2=0 THEN 'event' ELSE 'pageview' END,'/cap','cap',?,
          ? - CAST((x-1)/1000 AS INTEGER)*3600000,'cap-'||x FROM n`).bind(now, now).run();
      assert.equal(await count('capacity'), 10000);
      await post('capacity', { logs: [entry('overflow')] }, 429);
      assert.equal(await count('capacity'), 10000);
    });

    await t.test('site storage cap is independent of the tenant and hourly caps', async () => {
      const site = await (await api('/api/sites', { principal: owner('site-capacity'), body: { origin: 'https://capped.example' } })).json();
      const now = Date.now();
      await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
        INSERT INTO data_records(tenant_id,id,kind,path,name,at,received_at,site_id,fingerprint)
        SELECT 'site-capacity','cap-'||x,'pageview','/cap','cap',?,
          ? - (1+CAST((x-1)/200 AS INTEGER))*3600000,?,'cap-'||x FROM n`).bind(now, now, site.write_id).run();
      assert.equal(await count('site-capacity'), 2000);
      const response = await api(`/collect/${site.write_id}`, { principal: null, headers: { origin: site.origin }, body: page('overflow') });
      assert.equal(response.status, 429);
      assert.equal(await count('site-capacity'), 2000);
      await post('site-capacity', { logs: [entry('tenant-still-has-room')] });
      assert.equal(await count('site-capacity'), 2001);
    });
  } finally { await mf.dispose(); }
});

test('explicitly installed tracker is anonymous, opt-out aware, navigation aware and credentialless', async () => {
  const script = await readFile(new URL('./public/tracker.js', import.meta.url), 'utf8');
  function browser({ dnt, gpc, installed = true } = {}) {
    const calls = [];
    const listeners = {};
    const location = { href: 'https://customer.example/start?private=1#secret', pathname: '/start' };
    const context = { document: { currentScript: installed ? { dataset: { site: 'a'.repeat(32), endpoint: 'https://app.roundhouse.test/collect' } } : null,
      referrer: 'https://search.example/query?private=1#secret' }, navigator: { doNotTrack: dnt, globalPrivacyControl: gpc },
      location, history: { pushState(_s, _t, path) { location.pathname = new URL(path, location.href).pathname; } },
      addEventListener(name, callback) { listeners[name] = callback; },
      fetch(url, options) { calls.push({ url, options, body: JSON.parse(options.body) }); return Promise.resolve(); },
      crypto: { randomUUID }, URL, Date, window: {} };
    runInNewContext(script, context);
    return { calls, listeners, context, location };
  }
  for (const options of [{ dnt: '1' }, { gpc: true }, { installed: false }]) {
    const result = browser(options);
    assert.equal(result.calls.length, 0);
    assert.equal(result.context.window.roundhouse, undefined);
  }
  const { calls, listeners, context, location } = browser();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://app.roundhouse.test/collect/${'a'.repeat(32)}`);
  assert.equal(calls[0].body.path, '/start');
  assert.equal(calls[0].body.referrer, 'https://search.example');
  assert.equal(calls[0].options.credentials, 'omit');
  context.history.pushState(null, '', '/next?private=2#secret');
  context.history.pushState(null, '', '/next?query-only=1');
  assert.equal(calls.length, 2);
  location.pathname = '/back'; listeners.popstate();
  context.window.roundhouse.track('checkout');
  assert.equal(calls.length, 4);
  assert.equal(calls[3].body.kind, 'event');
  assert.equal(calls[3].body.name, 'checkout');
  assert.equal(new Set(calls.map(c => c.body.id)).size, calls.length);
  assert.ok(calls.every(c => !JSON.stringify(c.body).includes('private')));
  context.navigator.globalPrivacyControl = true;
  context.window.roundhouse.track('no-consent');
  assert.equal(calls.length, 4);
});

// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let Miniflare;
try { ({ Miniflare } = require('miniflare')); }
catch { ({ Miniflare } = require('../examples/reportroom/node_modules/miniflare')); }
const digest = value => createHash('sha256').update(value).digest('hex');
const password = 'local-test-password-only';
const invite = 'local-test-invitation-only';

// These helper endpoints exist only in this in-memory test Worker, never in production.
const wrapper = `
import { authRoute, authenticate, issueKey, revokeKey, requireScope, AuthError } from './auth.js';
export default { async fetch(request, env) {
  try {
    const path = new URL(request.url).pathname;
    if (path === '/test/keys') return Response.json(await issueKey(env, await authenticate(request, env), await request.json()), {status:201});
    if (path === '/test/revoke') {
      await revokeKey(env, await authenticate(request, env), (await request.json()).hash);
      return Response.json({ok:true});
    }
    if (path.startsWith('/test/scope/')) {
      const principal = await authenticate(request, env);
      requireScope(principal, path.split('/').pop());
      return Response.json(principal);
    }
    return await authRoute(request, env) || new Response('Not found', {status:404});
  } catch (error) {
    if (error instanceof AuthError) return Response.json({error:error.message}, {status:error.status});
    throw error;
  }
}};`;

test('authentication against actual Worker crypto and Miniflare D1', async t => {
  if (process.versions.bun) {
    // Miniflare's Node host is required even when the surrounding suite uses Bun.
    const result = spawnSync('node', ['--test', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return;
  }
  const root = new URL('.', import.meta.url).pathname;
  const mf = new Miniflare({
    modulesRoot: root,
    modules: [
      { type: 'ESModule', path: `${root}auth-test-worker.js`, contents: wrapper },
      { type: 'ESModule', path: `${root}auth.js`, contents: await readFile(new URL('./auth.js', import.meta.url), 'utf8') },
    ],
    compatibilityDate: '2026-01-01',
    d1Databases: ['DB'],
    bindings: { SETUP_INVITE: invite, SESSION_COOKIE_DOMAIN: 'roundhouse.test' },
  });
  try {
    const db = await mf.getD1Database('DB');
    const migration = await readFile(new URL('./migrations/0001.sql', import.meta.url), 'utf8');
    for (const statement of migration.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    let ip = 1;
    async function api(path, { body, cookie, headers = {}, method, raw, host = 'app.roundhouse.test' } = {}) {
      return mf.dispatchFetch(`https://${host}${path}`, {
        method: method || (body !== undefined || raw !== undefined ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', 'x-roundhouse': '1', 'cf-connecting-ip': `192.0.2.${ip++}`, ...(cookie ? { cookie } : {}), ...headers },
        duplex: 'half',
        ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    }
    const register = (email, extra = {}) => api('/api/auth/register', { body: { email, password, invite, ...extra } });
    const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
    let owner, ownerCookie, other, otherCookie, guest, guestCookie, key;

    await t.test('invitation required; unique owners, password hashing and cookie flags', async () => {
      assert.equal((await register('one@example.test', { invite: 'wrong' })).status, 403);
      assert.equal((await register('one@example.test', { invite: null })).status, 403);
      const response = await register('One@EXAMPLE.test');
      assert.equal(response.status, 201);
      owner = await response.json();
      ownerCookie = cookieOf(response);
      const setCookie = response.headers.get('set-cookie');
      for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=604800', 'Domain=roundhouse.test']) assert.ok(setCookie.includes(flag));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.deepEqual(owner.scopes, ['read', 'ingest', 'control', 'approve', 'admin']);
      const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind('one@example.test').first();
      assert.ok(row.password_hash !== password);
      assert.equal(row.password_hash, pbkdf2Sync(password, row.salt, 100000, 32, 'sha256').toString('hex'));
      const storedSession = await db.prepare('SELECT * FROM sessions WHERE hash = ?').bind(digest(ownerCookie.split('=')[1])).first();
      assert.equal(storedSession.tenant_id, owner.tenant_id);
      assert.ok(storedSession.expires > Date.now() / 1000 + 604790);
      const countBefore = await db.prepare('SELECT COUNT(*) AS n FROM tenants').first();
      assert.equal((await register('one@example.test')).status, 409);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tenants').first()).n, countBefore.n, 'duplicate registration rolls back its tenant');
      const second = await register('two@example.test', { tenant_id: owner.tenant_id, role: 'guest' });
      other = await second.json(); otherCookie = cookieOf(second);
      assert.notEqual(other.tenant_id, owner.tenant_id);
      assert.equal(other.role, 'owner');
    });

    await t.test('login, unknown and wrong passwords, me, bearer precedence', async () => {
      assert.equal((await api('/api/auth/login', { body: { email: 'one@example.test', password: 'wrong-password' } })).status, 401);
      assert.equal((await api('/api/auth/login', { body: { email: 'unknown@example.test', password } })).status, 401);
      const login = await api('/api/auth/login', { body: { email: 'ONE@example.test', password } });
      assert.equal(login.status, 200);
      assert.equal((await login.json()).tenant_id, owner.tenant_id);
      assert.notEqual(cookieOf(login), ownerCookie);
      assert.deepEqual(await (await api('/api/auth/me', { cookie: ownerCookie })).json(), owner);
      assert.equal((await api('/api/auth/me')).status, 401);
      assert.equal((await api('/api/auth/me', { cookie: ownerCookie, headers: { authorization: 'Bearer invalid' } })).status, 401);
      assert.equal((await api('/api/auth/me', { cookie: `${ownerCookie}; ${otherCookie}` })).status, 401);
      assert.equal((await api('/unknown')).status, 404);
      assert.equal((await api('/api/auth/login')).status, 405);
    });

    await t.test('guest isolated synthetic tenants cannot administer keys', async () => {
      const response = await api('/api/auth/guest', { body: { tenant_id: owner.tenant_id, role: 'owner', scopes: ['admin'] } });
      assert.equal(response.status, 201);
      guest = await response.json(); guestCookie = cookieOf(response);
      assert.ok(response.headers.get('set-cookie').includes('Max-Age=86400'));
      assert.equal(guest.role, 'guest');
      assert.notEqual(guest.tenant_id, owner.tenant_id);
      assert.deepEqual(guest.scopes, ['read', 'ingest', 'control', 'approve']);
      assert.equal((await db.prepare('SELECT kind FROM tenants WHERE id = ?').bind(guest.tenant_id).first()).kind, 'guest');
      const nextGuest = await (await api('/api/auth/guest', { body: {} })).json();
      assert.notEqual(nextGuest.tenant_id, guest.tenant_id);
      assert.equal((await api('/test/scope/admin', { cookie: guestCookie })).status, 403);
      assert.equal((await api('/test/scope/approve', { cookie: guestCookie })).status, 200);
      assert.equal((await api('/test/keys', { cookie: guestCookie, body: { name: 'guest', scopes: ['read'] } })).status, 403);
    });

    await t.test('key scopes, one-time plaintext, tenant isolation, revoked and expired keys', async () => {
      for (const scopes of [['approve'], ['admin'], ['read', 'admin'], [], ['unknown']]) {
        assert.equal((await api('/test/keys', { cookie: ownerCookie, body: { name: 'invalid', scopes } })).status, 400);
      }
      const issued = await api('/test/keys', { cookie: ownerCookie, body: { name: 'test ingest', scopes: ['read', 'ingest'], tenant_id: other.tenant_id } });
      assert.equal(issued.status, 201);
      key = await issued.json();
      assert.ok(key.id === digest(key.token));
      const stored = await db.prepare('SELECT * FROM api_keys WHERE hash = ?').bind(key.id).first();
      assert.equal(stored.tenant_id, owner.tenant_id);
      assert.ok(!JSON.stringify(stored).includes(key.token));
      const headers = { authorization: `Bearer ${key.token}` };
      const principal = await (await api('/api/auth/me', { headers, cookie: otherCookie })).json();
      assert.equal(principal.tenant_id, owner.tenant_id);
      assert.equal(principal.kind, 'key');
      assert.deepEqual(principal.scopes, ['read', 'ingest']);
      assert.equal((await api('/test/scope/read', { headers })).status, 200);
      for (const scope of ['control', 'approve', 'admin']) assert.equal((await api(`/test/scope/${scope}`, { headers })).status, 403);
      assert.equal((await api('/test/keys', { headers, body: { name: 'no', scopes: ['read'] } })).status, 403);
      assert.equal((await api('/test/revoke', { cookie: otherCookie, body: { hash: key.id } })).status, 404);
      assert.equal((await api('/test/revoke', { cookie: guestCookie, body: { hash: key.id } })).status, 403);
      await db.prepare('UPDATE api_keys SET expires = 1 WHERE hash = ?').bind(key.id).run();
      assert.equal((await api('/api/auth/me', { headers })).status, 401);
      await db.prepare('UPDATE api_keys SET expires = NULL WHERE hash = ?').bind(key.id).run();
      assert.equal((await api('/test/revoke', { cookie: ownerCookie, body: { hash: key.id } })).status, 200);
      assert.equal((await api('/api/auth/me', { headers, cookie: ownerCookie })).status, 401);
    });

    await t.test('malformed JSON, bounded streaming reads, content type, CSRF, cookie configuration', async () => {
      for (const raw of ['{', 'null', '[]', '"string"']) assert.equal((await api('/api/auth/guest', { raw })).status, 400);
      assert.equal((await api('/api/auth/guest', { raw: 'x'.repeat(8193) })).status, 413);
      const chunks = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(4096))); controller.enqueue(new TextEncoder().encode('x'.repeat(4097))); controller.close(); } });
      assert.equal((await api('/api/auth/guest', { raw: chunks })).status, 413);
      assert.equal((await api('/api/auth/guest', { body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
      assert.equal((await api('/api/auth/guest', { body: {}, headers: { 'x-roundhouse': '' } })).status, 403);
      for (const origin of ['https://evil.test', 'null', 'https://roundhouse.test', 'https://app.roundhouse.test.evil.test']) {
        assert.equal((await api('/api/auth/guest', { body: {}, headers: { origin } })).status, 403);
      }
      assert.equal((await api('/api/auth/guest', { body: {}, headers: { origin: 'https://app.roundhouse.test', 'content-type': 'application/json; charset=utf-8' } })).status, 201);
      assert.equal((await api('/api/auth/guest', { body: {}, host: 'roundhouse.test.evil.test' })).status, 500);
    });

    await t.test('atomic per-IP route limiter allows exactly ten concurrent attempts and resets', async () => {
      const headers = { 'cf-connecting-ip': '198.51.100.1' };
      const results = await Promise.all(Array.from({ length: 16 }, () => api('/api/auth/guest', { body: {}, headers })));
      assert.equal(results.filter(r => r.status === 201).length, 10);
      assert.equal(results.filter(r => r.status === 429).length, 6);
      assert.equal((await api('/api/auth/login', { body: { email: 'unknown@example.test', password }, headers })).status, 401, 'buckets are route-specific');
      const bucket = digest('198.51.100.1\n/api/auth/guest');
      await db.prepare('UPDATE auth_attempts SET expires = 0 WHERE bucket = ?').bind(bucket).run();
      assert.equal((await api('/api/auth/guest', { body: {}, headers })).status, 201);
      for (const path of ['/api/auth/register', '/api/auth/login']) {
        const statuses = await Promise.all(Array.from({ length: 11 }, () => api(path, { body: { email: 'missing@example.test', password, invite: 'wrong' }, headers: { 'cf-connecting-ip': '198.51.100.2' } })));
        assert.equal(statuses.filter(r => r.status === 429).length, 1);
        assert.equal(statuses.filter(r => r.status === (path.endsWith('register') ? 403 : 401)).length, 10);
      }
    });

    await t.test('global guest budget shared across IPs', async () => {
      await db.prepare('UPDATE auth_attempts SET attempts = 999 WHERE bucket = ?').bind(digest('guest-global')).run();
      assert.equal((await api('/api/auth/guest', { body: {} })).status, 201);
      assert.equal((await api('/api/auth/guest', { body: {} })).status, 429);
      await db.prepare('UPDATE auth_attempts SET expires = 0 WHERE bucket = ?').bind(digest('guest-global')).run();
      assert.equal((await api('/api/auth/guest', { body: {} })).status, 201);
    });

    await t.test('logout invalidates persisted session, expiry denies session', async () => {
      assert.equal((await api('/api/auth/logout', { body: {}, cookie: ownerCookie, headers: { origin: 'https://evil.test' } })).status, 403);
      assert.equal((await api('/api/auth/me', { cookie: ownerCookie })).status, 200);
      const logout = await api('/api/auth/logout', { body: {}, cookie: ownerCookie });
      assert.equal(logout.status, 200);
      assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
      assert.equal((await api('/api/auth/me', { cookie: ownerCookie })).status, 401);
      assert.equal((await api('/api/auth/me', { cookie: otherCookie })).status, 200);
      await db.prepare('UPDATE sessions SET expires = 1 WHERE tenant_id = ?').bind(other.tenant_id).run();
      assert.equal((await api('/api/auth/me', { cookie: otherCookie })).status, 401);
    });
  } finally { await mf.dispose(); }
});

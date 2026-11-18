// SPDX-License-Identifier: MPL-2.0
const encoder = new TextEncoder();
const OWNER_SCOPES = ['read', 'ingest', 'control', 'approve', 'admin'];
const GUEST_SCOPES = ['read', 'ingest', 'control', 'approve'];
const KEY_SCOPES = ['read', 'ingest', 'control'];
const ITERATIONS = 100000;
const now = () => Math.floor(Date.now() / 1000);

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(value) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

function equal(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: ITERATIONS }, key, 256));
}

function sessionToken(request) {
  const cookies = (request.headers.get('cookie') || '').split(';');
  const matches = cookies.map(c => c.trim()).filter(c => c.startsWith('rh_session='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice('rh_session='.length);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export async function authenticate(request, env) {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(authorization);
    if (!match) throw new AuthError(401, 'Unauthorized');
    const key = await env.DB.prepare(`SELECT k.tenant_id, k.scopes FROM api_keys k
      JOIN tenants t ON t.id = k.tenant_id WHERE k.hash = ? AND k.revoked = 0
      AND (k.expires IS NULL OR k.expires > ?) AND t.kind = 'owner'`)
      .bind(await hashToken(match[1]), now()).first();
    if (!key) throw new AuthError(401, 'Unauthorized');
    const scopes = JSON.parse(key.scopes);
    return { tenant_id: key.tenant_id, role: 'owner', kind: 'key', scopes: scopes.filter(s => KEY_SCOPES.includes(s)) };
  }
  const token = sessionToken(request);
  if (!token) throw new AuthError(401, 'Unauthorized');
  const session = await env.DB.prepare(`SELECT s.tenant_id, s.role FROM sessions s
    JOIN tenants t ON t.id = s.tenant_id WHERE s.hash = ? AND s.expires > ? AND s.role = t.kind`)
    .bind(await hashToken(token), now()).first();
  if (!session) throw new AuthError(401, 'Unauthorized');
  return { tenant_id: session.tenant_id, role: session.role, kind: 'session', scopes: [...(session.role === 'owner' ? OWNER_SCOPES : GUEST_SCOPES)] };
}

export function requireScope(principal, scope) {
  if (!principal.scopes.includes(scope)) throw new AuthError(403, 'Insufficient scope');
}

function requireKeyAdmin(principal) {
  requireScope(principal, 'admin');
  if (principal.kind !== 'session' || principal.role !== 'owner') throw new AuthError(403, 'Owner session required');
}

export async function issueKey(env, principal, { name, scopes }) {
  requireKeyAdmin(principal);
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || !Array.isArray(scopes)
    || !scopes.length || scopes.some(s => !KEY_SCOPES.includes(s))) {
    throw new AuthError(400, 'Invalid key name or scopes');
  }
  const token = randomToken();
  const id = await hashToken(token);
  await env.DB.prepare('INSERT INTO api_keys (hash, tenant_id, name, scopes, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, principal.tenant_id, name.trim(), JSON.stringify([...new Set(scopes)]), now()).run();
  return { token, id };
}

export async function revokeKey(env, principal, hash) {
  requireKeyAdmin(principal);
  const result = await env.DB.prepare('UPDATE api_keys SET revoked = 1 WHERE hash = ? AND tenant_id = ?')
    .bind(hash, principal.tenant_id).run();
  if (!result.meta.changes) throw new AuthError(404, 'Key not found');
}

function cookie(request, env, token, maxAge) {
  let domain = '';
  if (env.SESSION_COOKIE_DOMAIN) {
    const trusted = env.SESSION_COOKIE_DOMAIN.toLowerCase().replace(/^\./, '');
    const host = new URL(request.url).hostname;
    if (!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(trusted)
      || !(host === trusted || host.endsWith(`.${trusted}`))) {
      throw new AuthError(500, 'Invalid cookie domain configuration');
    }
    domain = `; Domain=${trusted}`;
  }
  return `rh_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}${domain}`;
}

async function readBody(request) {
  if (request.headers.get('x-roundhouse') !== '1') throw new AuthError(403, 'Request header required');
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) throw new AuthError(403, 'Origin denied');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) {
    throw new AuthError(415, 'JSON required');
  }
  if (Number(request.headers.get('content-length')) > 8192) throw new AuthError(413, 'Body too large');
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, 'JSON object required');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 8192) {
      await reader.cancel();
      throw new AuthError(413, 'Body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new AuthError(400, 'Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError(400, 'JSON object required');
  return body;
}

async function limit(env, bucket, period, max) {
  const time = now();
  const row = await env.DB.prepare(`INSERT INTO auth_attempts (bucket, attempts, expires) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      attempts = CASE WHEN expires <= ? THEN 1 ELSE attempts + 1 END,
      expires = CASE WHEN expires <= ? THEN excluded.expires ELSE expires END
    RETURNING attempts`).bind(bucket, time + period, time, time).first();
  if (row.attempts > max) throw new AuthError(429, 'Too many attempts');
}

function credentials(body) {
  if (typeof body.email !== 'string' || body.email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())
    || typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 1024) {
    throw new AuthError(400, 'Invalid email or password');
  }
  return { email: body.email.trim().toLowerCase(), password: body.password };
}

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

export async function authRoute(request, env) {
  const path = new URL(request.url).pathname;
  if (!['/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/guest'].includes(path)) return null;
  try {
    if (request.method !== (path === '/api/auth/me' ? 'GET' : 'POST')) throw new AuthError(405, 'Method not allowed');
    if (path === '/api/auth/me') return json(await authenticate(request, env));
    const body = await readBody(request);
    if (['/api/auth/register', '/api/auth/login', '/api/auth/guest'].includes(path)) {
      // CF-Connecting-IP is set by the edge; never trust client-forwarded IP headers.
      await limit(env, await hashToken(`${request.headers.get('cf-connecting-ip') || 'unknown'}\n${path}`), 3600, 10);
    }
    if (path === '/api/auth/logout') {
      await authenticate(request, env);
      const token = sessionToken(request);
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE hash = ?').bind(await hashToken(token)).run();
      return json({ ok: true }, 200, { 'set-cookie': cookie(request, env, '', 0) });
    }
    const guest = path === '/api/auth/guest';
    const register = path === '/api/auth/register';
    let tenantId;
    let email;
    let password;
    if (guest) {
      await limit(env, await hashToken('guest-global'), 86400, 1000);
    } else {
      ({ email, password } = credentials(body));
      if (register) {
        if (!env.SETUP_INVITE || typeof body.invite !== 'string'
          || !equal(await hashToken(body.invite), await hashToken(env.SETUP_INVITE))) {
          throw new AuthError(403, 'Invalid invitation');
        }
      } else {
        const user = await env.DB.prepare('SELECT tenant_id, password_hash, salt FROM users WHERE email = ?').bind(email).first();
        // Unknown accounts do the same expensive derivation as known accounts.
        const derived = await passwordHash(password, user?.salt || '00000000000000000000000000000000');
        if (!equal(derived, user?.password_hash || '0'.repeat(64)) || !user) throw new AuthError(401, 'Invalid email or password');
        tenantId = user.tenant_id;
      }
    }
    const token = randomToken();
    const hash = await hashToken(token);
    const role = guest ? 'guest' : 'owner';
    const maxAge = guest ? 86400 : 604800;
    // Validate configuration before writing anything to D1.
    const setCookie = cookie(request, env, token, maxAge);
    const statements = [];
    if (guest || register) {
      tenantId = crypto.randomUUID();
      statements.push(env.DB.prepare('INSERT INTO tenants (id, name, kind, created_at) VALUES (?, ?, ?, ?)')
        .bind(tenantId, guest ? 'Guest workspace' : email, role, now()));
      if (register) {
        const salt = randomToken();
        statements.push(env.DB.prepare('INSERT INTO users (id, tenant_id, email, password_hash, salt) VALUES (?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), tenantId, email, await passwordHash(password, salt), salt));
      }
    }
    statements.push(env.DB.prepare('INSERT INTO sessions (hash, tenant_id, role, expires) VALUES (?, ?, ?, ?)')
      .bind(hash, tenantId, role, now() + maxAge));
    try { await env.DB.batch(statements); }
    catch (error) {
      if (register && String(error.message).includes('UNIQUE constraint failed: users.email')) throw new AuthError(409, 'Email already registered');
      throw error;
    }
    return json({ tenant_id: tenantId, role, kind: 'session', scopes: [...(guest ? GUEST_SCOPES : OWNER_SCOPES)] }, register || guest ? 201 : 200, { 'set-cookie': setCookie });
  } catch (error) {
    if (error instanceof AuthError) return json({ error: error.message }, error.status);
    throw error;
  }
}

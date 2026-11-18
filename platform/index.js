// SPDX-License-Identifier: MPL-2.0
import { TenantController, ReportApplication, limits } from './controller.js';
import { authenticate, authRoute, AuthError, requireScope, issueKey, revokeKey } from './auth.js';
import { dataRoute, summary } from './data.js';
export { TenantController, ReportApplication };

const json = (value, status = 200) => Response.json(value, { status });
const appToken = 'internal-reportroom';
function controller(env, principal) { return env.CONTROLLERS.getByName(principal.tenant_id); }
async function read(response) {
  if (!response.ok) throw new AuthError(response.status, 'Operation rejected');
  return response.json();
}
function call(env, principal, path, body) {
  return controller(env, principal).fetch(new Request('https://controller.internal' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-tenant-kind': principal.role },
    body: body === undefined ? undefined : JSON.stringify(body) }));
}
function app(env, principal, path, body) {
  const id = env.CONTROLLERS.idFromName(principal.tenant_id).toString();
  return env.REPORTS.getByName(id).fetch(new Request('https://reportroom.internal' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) }));
}
async function body(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AuthError(415, 'JSON required');
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, 'Object required');
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.byteLength;
    if (bytes > 16384) { await reader.cancel(); throw new AuthError(413, 'Body too large'); }
    text += decoder.decode(value, { stream: true });
  }
  let value; try { value = JSON.parse(text + decoder.decode()); } catch { throw new AuthError(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError(400, 'Object required');
  return value;
}
async function snapshot(env, principal) {
  const [target, status, list, probes, provider, data, keys, tenant] = await Promise.all([
    read(await app(env, principal, '/status')), read(await call(env, principal, '/v1/status')),
    read(await call(env, principal, '/v1/incidents')), read(await call(env, principal, '/v1/probes?service=reportroom')),
    read(await call(env, principal, '/platform/provider')), summary(env, principal.tenant_id),
    env.DB.prepare('SELECT hash,name,scopes,revoked,created_at,expires FROM api_keys WHERE tenant_id=?').bind(principal.tenant_id).all(),
    env.DB.prepare('SELECT id,name,kind FROM tenants WHERE id=?').bind(principal.tenant_id).first(),
  ]);
  const incidents = await Promise.all(list.incidents.slice(0, 10).map(async i => ({ ...i,
    history: (await read(await call(env, principal, `/v1/incidents/${i.id}`))).history })));
  return { tenant, app: target, provider, limits, keys: keys.results.map(k => ({ ...k, scopes: JSON.parse(k.scopes), created_at: k.created_at * 1000, expires: k.expires ? k.expires * 1000 : null })),
    monitoring: { enabled: status.enabled, incidents, probes: probes.observations, budgets: status.budgets, events: [] },
    ...data, capabilities: { fault_allowed: target.healthy && !list.incidents.some(i => i.state !== 'resolved'), reset_allowed: true } };
}
const tools = [
  ['systems', 'Read synthetic application status and monitoring limits.', 'read'],
  ['incidents', 'Read recent incidents and investigation history.', 'read'],
  ['analytics', 'Read last 24 hours of tenant analytics.', 'read'],
  ['logs', 'Read recent tenant logs.', 'read'],
  ['start_monitoring', 'Start scheduled health checks.', 'control'],
  ['stop_monitoring', 'Stop scheduled health checks.', 'control'],
  ['investigate', 'Queue a bounded investigation of the synthetic Reportroom application. Cannot approve recovery.', 'control'],
];
async function mcp(request, env, principal) {
  if (principal.kind !== 'key') throw new AuthError(403, 'MCP requires a scoped bearer key');
  if (request.method !== 'POST') return json({ error: 'Stateless MCP supports POST only' }, 405);
  const input = await body(request);
  const reply = (result, error) => json({ jsonrpc: '2.0', id: input.id ?? null, ...(error ? { error } : { result }) });
  if (input.jsonrpc !== '2.0' || typeof input.method !== 'string') return reply(null, { code: -32600, message: 'Invalid request' });
  if (input.method === 'notifications/initialized' && input.id === undefined) return new Response(null, { status: 202 });
  if (input.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'roundhouse', version: '0.1.0' } });
  if (input.method === 'ping') return reply({});
  if (input.method === 'tools/list') return reply({ tools: tools.filter(t => principal.scopes.includes(t[2])).map(([name, description]) => ({ name, description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } })) });
  if (input.method !== 'tools/call') return reply(null, { code: -32601, message: 'Method not found' });
  const tool = tools.find(t => t[0] === input.params?.name);
  if (!tool) return reply(null, { code: -32602, message: 'Unknown tool' });
  requireScope(principal, tool[2]);
  const args = input.params.arguments ?? {};
  if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length) return reply(null, { code: -32602, message: 'Tool takes no arguments' });
  let result;
  if (['systems', 'incidents'].includes(tool[0])) result = await snapshot(env, principal);
  else if (['analytics', 'logs'].includes(tool[0])) result = await read(await dataRoute(new Request(`https://data.internal/api/${tool[0]}`), env, principal));
  else result = await read(await call(env, principal, tool[0] === 'investigate' ? '/v1/events' : tool[0] === 'start_monitoring' ? '/v1/start' : '/v1/stop', tool[0] === 'investigate' ? { monitor: 'reportroom' } : {}));
  return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
}

async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (![env.PUBLIC_ORIGIN, env.DEMO_ORIGIN].includes(url.origin)) throw new AuthError(421, 'Unknown origin');
  if (path === '/health' && request.method === 'GET') return json({ service: 'roundhouse', healthy: true });
  const auth = await authRoute(request, env); if (auth) return auth;
  const publicPage = /^\/status\/([a-f0-9]{32})$/.exec(path);
  if (publicPage && request.method === 'GET') {
    const result = await dataRoute(new Request(env.PUBLIC_ORIGIN + '/public/status/' + publicPage[1]), env, null);
    if (!result.ok) return result;
    const page = await result.json();
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${page.title} · Status</title><link rel="stylesheet" href="/platform.css"></head><body><main class="landing-section"><p>ROUNDHOUSE / PUBLIC STATUS</p><h1>${page.title}</h1><p>Operator-published updates, not an automated uptime guarantee.</p>${page.updates.map(u => `<article class="panel"><p>${u.state} · ${new Date(u.at).toISOString()}</p><h2>${u.message}</h2></article>`).join('') || '<p>No updates published.</p>'}</main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (path.startsWith('/public/status/') || path.startsWith('/collect/')) {
    return await dataRoute(request, env, null) ?? json({ error: 'Not found' }, 404);
  }
  if (path.startsWith('/api/') || path === '/mcp') {
    const principal = await authenticate(request, env);
    if (request.method !== 'GET' && request.method !== 'HEAD' && principal.kind === 'session') {
      if (request.headers.get('x-roundhouse') !== '1' && !(url.origin === env.DEMO_ORIGIN && request.headers.get('x-reportroom-demo') === '1')) throw new AuthError(403, 'Request header required');
      if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) throw new AuthError(403, 'Origin denied');
    }
    if (path === '/mcp') return mcp(request, env, principal);
    if (request.method === 'GET') requireScope(principal, 'read');
    const data = await dataRoute(request, env, principal); if (data) return data;
    if (request.method === 'GET') {
      if (['/api/overview', '/api/state'].includes(path)) return json(await snapshot(env, principal));
      const csv = /^\/api\/reports\/([a-f0-9-]{36})\.csv$/.exec(path);
      if (csv) return app(env, principal, `/reports/${csv[1]}.csv`);
      if (path === '/api/keys') return json({ keys: (await snapshot(env, principal)).keys });
    }
    if (request.method === 'POST') {
      const value = await body(request);
      if (path === '/api/keys') return json(await issueKey(env, principal, value), 201);
      if (path === '/api/keys/revoke') { await revokeKey(env, principal, value.hash); return json({ revoked: true }); }
      const revoke = /^\/api\/keys\/([a-f0-9]{64})\/revoke$/.exec(path);
      if (revoke) { await revokeKey(env, principal, revoke[1]); return json({ revoked: true }); }
      if (path === '/api/provider') {
        requireScope(principal, 'admin');
        return call(env, principal, '/platform/provider', value);
      }
      if (path === '/api/browser/evidence') {
        requireScope(principal, 'admin');
        if (Object.keys(value).length) throw new AuthError(400, 'No arguments required');
        const slot = Math.floor(Date.now() / 3600000);
        const quota = await env.DB.prepare(`INSERT INTO auth_attempts(bucket,attempts,expires) VALUES(?,1,?)
          ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`).bind(`browser:${principal.tenant_id}:${slot}`, (slot + 1) * 3600).first();
        if (quota.attempts > 10) throw new AuthError(429, 'Browser evidence limit reached');
        if (!env.BROWSER) throw new AuthError(503, 'Kitesurf binding unavailable; no fallback');
        const target = await read(await app(env, principal, '/status'));
        // Only server-constructed booleans and integers reach the browser: no remote URLs,
        // user HTML, script, cookies or credentials. Interception is not an authority boundary.
        const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>Reportroom evidence</title></head><body><h1>Reportroom</h1><p id="health">healthy=${target.healthy === true}</p><p>recoveries=${Number(target.recoveries)}</p><p>completed=${target.jobs.filter(j => j.state === 'completed').length}</p></body></html>`;
        const rendered = await env.BROWSER.quickAction('content', { browser: 'kitesurf', html, rejectRequestPattern: ['.*'] });
        if (!rendered.ok) {
          const detail = await rendered.json().catch(() => ({}));
          const code = detail.errors?.[0]?.code;
          throw new AuthError(502, `Kitesurf returned HTTP ${rendered.status}${typeof code === 'number' ? ` (code ${code})` : ''}; no fallback`);
        }
        return json({ engine: 'kitesurf', source: 'internal-synthetic-snapshot', content: (await rendered.text()).slice(0, 16384) });
      }
      requireScope(principal, 'control');
      if (path === '/api/reports') return app(env, principal, '/reports', value);
      if (Object.keys(value).length) throw new AuthError(400, 'No arguments required');
      const monitor = /^\/api\/monitor\/(start|stop|investigate)$/.exec(path);
      if (monitor) return call(env, principal, monitor[1] === 'investigate' ? '/v1/events' : `/v1/${monitor[1]}`, monitor[1] === 'investigate' ? { monitor: 'reportroom' } : {});
      if (['/api/demo/fault', '/api/fault'].includes(path)) {
        const state = await snapshot(env, principal);
        if (!state.capabilities.fault_allowed) throw new AuthError(409, 'Resolve the current incident first');
        return app(env, principal, '/fault', {});
      }
      if (['/api/demo/reset', '/api/reset'].includes(path)) return app(env, principal, '/reset', {});
      const approval = /^\/api\/incidents\/([a-f0-9-]{36})\/approve$/.exec(path);
      if (approval) {
        requireScope(principal, 'approve');
        return call(env, principal, `/v1/incidents/${approval[1]}/approve`, { action: 'resume_exports' });
      }
    }
    return json({ error: 'Not found' }, 404);
  }
  if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
  const demo = url.origin === env.DEMO_ORIGIN && env.DEMO_ORIGIN !== env.PUBLIC_ORIGIN;
  if (demo && path === '/') {
    try { await authenticate(request, env); } catch { return Response.redirect(env.PUBLIC_ORIGIN + '/console?demo=1', 302); }
  }
  const assets = demo ? { '/': '/reportroom/index.html', '/app.js': '/reportroom/app.js', '/style.css': '/reportroom/style.css' } : { '/': '/index.html', '/console': '/console.html', '/platform.js': '/platform.js', '/platform.css': '/platform.css', '/tracker.js': '/tracker.js', '/docs/setup': '/setup.html' };
  if (!Object.hasOwn(assets, path)) return json({ error: 'Not found' }, 404);
  return env.ASSETS.fetch(new Request(new URL(assets[path], env.PUBLIC_ORIGIN), request));
}

export default { async fetch(request, env) {
  let response;
  try { response = await route(request, env); }
  catch (error) { response = json({ error: error instanceof AuthError ? error.message : 'Service unavailable' }, error instanceof AuthError ? error.status : 503); }
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" })) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
} };

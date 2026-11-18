// SPDX-License-Identifier: MPL-2.0
const DAY = 86400000;
const LEVELS = ['debug', 'info', 'warn', 'error'];
const STATES = ['investigating', 'monitoring', 'resolved'];
const MAX_BODY = 16384;
const json = (value, status = 200, headers = {}) => Response.json(value, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
});
class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new InputError(message, status); };
const sql = (env, query, ...args) => env.DB.prepare(query).bind(...args);
const rows = async (env, query, ...args) => (await sql(env, query, ...args).all()).results;
const iso = n => new Date(n).toISOString();
const token = () => crypto.randomUUID().replaceAll('-', '');

function object(value, fields, required = fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object');
  if (Object.keys(value).some(k => !fields.includes(k)) || required.some(k => !Object.hasOwn(value, k))) {
    fail('Unexpected or missing field');
  }
  return value;
}
function text(value, max, min = 1) {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('Invalid text field');
  }
  return value;
}
function identifier(value) {
  text(value, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) fail('Invalid record id');
  return value;
}
function timestamp(value, now) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value)) fail('Invalid timestamp');
  const at = Date.parse(value);
  if (!Number.isFinite(at) || Math.abs(now - at) > DAY) fail('Timestamp must be within one day');
  return at;
}
function pathName(value) {
  text(value, 2048);
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) fail('Path must be relative');
  const path = new URL(value, 'https://path.invalid').pathname;
  if (path.length > 512) fail('Path is too long');
  return path;
}
function referrer(value) {
  if (value === undefined || value === '') return '';
  text(value, 2048);
  let url;
  try { url = new URL(value); } catch { fail('Invalid referrer'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('Referrer must be HTTPS');
  return url.host;
}
function canonical(value, depth = 0) {
  if (depth > 5) fail('Properties are too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => canonical(v, depth + 1));
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (['ip', 'ipaddress', 'useragent', 'visitorid', 'userid', 'deviceid', 'sessionid', 'clientid', 'cookie', 'authorization', 'email'].includes(normalized)) {
      fail('Identifying properties are not accepted');
    }
    result[key] = canonical(value[key], depth + 1);
  }
  return result;
}
function event(value, now, minimal = false) {
  const fields = ['id', 'kind', 'name', 'path', 'referrer', 'at', ...(minimal ? [] : ['properties'])];
  object(value, fields, ['id', 'kind', 'name', 'path']);
  if (!['pageview', 'event'].includes(value.kind)) fail('Invalid event kind');
  let properties = null;
  if (value.properties !== undefined) {
    object(value.properties, Object.keys(value.properties ?? {}), []);
    properties = JSON.stringify(canonical(value.properties));
    if (properties.length > 2048) fail('Properties are too large');
  }
  return { id: identifier(value.id), kind: value.kind, name: text(value.name, 80), path: pathName(value.path),
    referrer: referrer(value.referrer), properties, at: timestamp(value.at, now) };
}
function log(value, now) {
  object(value, ['id', 'service', 'level', 'message', 'at', 'trace_id'], ['id', 'service', 'level', 'message']);
  if (!LEVELS.includes(value.level)) fail('Invalid log level');
  return { id: identifier(value.id), kind: 'log', service: text(value.service, 80), level: value.level,
    message: text(value.message, 2000), trace_id: value.trace_id === undefined ? null : text(value.trace_id, 100),
    at: timestamp(value.at, now) };
}

async function body(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail('Content-Type must be application/json', 415);
  }
  if (!request.body) fail('JSON body required');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) { await reader.cancel(); fail('Body exceeds 16 KiB', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('Invalid JSON'); }
}

function purgeStatements(env, tenant, now) {
  return [
    sql(env, `DELETE FROM data_records WHERE tenant_id = ? AND id IN
      (SELECT id FROM data_records WHERE tenant_id = ? AND received_at < ? ORDER BY received_at LIMIT 100)`, tenant, tenant, now - 7 * DAY),
    sql(env, `DELETE FROM data_quotas WHERE tenant_id = ? AND bucket IN
      (SELECT bucket FROM data_quotas WHERE tenant_id = ? AND bucket < ? LIMIT 100)`, tenant, tenant, Math.floor(now / 3600000) - 168),
    sql(env, `DELETE FROM data_site_quotas WHERE rowid IN (SELECT q.rowid FROM data_site_quotas q
      JOIN data_sites s ON s.write_id = q.site_id WHERE s.tenant_id = ? AND q.bucket < ? LIMIT 100)`, tenant, Math.floor(now / 3600000) - 168),
    sql(env, `DELETE FROM data_status_updates WHERE tenant_id = ? AND id IN
      (SELECT id FROM data_status_updates WHERE tenant_id = ? AND at < ? ORDER BY at LIMIT 100)`, tenant, tenant, now - 7 * DAY),
  ];
}
async function ingest(env, tenant, records, now, site = null) {
  const statements = purgeStatements(env, tenant, now);
  for (const record of records) {
    const fingerprint = JSON.stringify({ ...record, site_id: site });
    statements.push(sql(env, `INSERT INTO data_records
      (tenant_id,id,kind,name,path,referrer,properties,service,level,message,trace_id,at,received_at,site_id,fingerprint)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS
      (SELECT 1 FROM data_records WHERE tenant_id = ? AND id = ? AND fingerprint = ?) RETURNING id`,
    tenant, record.id, record.kind, record.name ?? null, record.path ?? null, record.referrer ?? null,
    record.properties ?? null, record.service ?? null, record.level ?? null, record.message ?? null,
    record.trace_id ?? null, record.at ?? now, now, site, fingerprint, tenant, record.id, fingerprint));
  }
  try {
    const results = await env.DB.batch(statements);
    return { accepted: results.slice(statements.length - records.length).reduce((sum, r) => sum + r.results.length, 0) };
  } catch (error) {
    const message = String(error.message);
    if (/UNIQUE constraint failed: data_records/.test(message)) fail('Conflicting record id', 409);
    if (/CHECK constraint failed: used|data_tenant_capacity|data_site_capacity/.test(message)) fail('Record limit exceeded', 429);
    throw error;
  }
}

async function analytics(env, tenant, now) {
  const since = now - DAY;
  const counts = await sql(env, `SELECT coalesce(sum(kind = 'pageview'), 0) AS pageviews,
    coalesce(sum(kind = 'event'), 0) AS events FROM data_records WHERE tenant_id = ? AND at >= ? AND at <= ?`, tenant, since, now).first();
  const [paths, referrers, series] = await Promise.all([
    rows(env, `SELECT path, count(*) AS count FROM data_records WHERE tenant_id = ? AND kind = 'pageview'
      AND at >= ? AND at <= ? GROUP BY path ORDER BY count DESC, path LIMIT 100`, tenant, since, now),
    rows(env, `SELECT referrer, count(*) AS count FROM data_records WHERE tenant_id = ? AND kind = 'pageview'
      AND referrer != '' AND at >= ? AND at <= ? GROUP BY referrer ORDER BY count DESC, referrer LIMIT 100`, tenant, since, now),
    rows(env, `SELECT strftime('%Y-%m-%dT%H:00:00.000Z', at / 1000, 'unixepoch') AS bucket, count(*) AS count
      FROM data_records WHERE tenant_id = ? AND kind = 'pageview' AND at >= ? AND at <= ?
      GROUP BY bucket ORDER BY bucket LIMIT 100`, tenant, since, now),
  ]);
  return { ...counts, paths, referrers, series };
}
async function logs(env, tenant, now, filters = {}) {
  let query = `SELECT id,service,level,message,at,trace_id FROM data_records
    WHERE tenant_id = ? AND kind = 'log' AND at >= ? AND at <= ?`;
  const params = [tenant, now - DAY, now];
  for (const key of ['level', 'service']) {
    if (filters[key]) { query += ` AND ${key} = ?`; params.push(filters[key]); }
  }
  if (filters.q) {
    query += " AND message LIKE ? ESCAPE '\\'";
    params.push(`%${filters.q.replace(/[\\%_]/g, '\\$&')}%`);
  }
  return (await rows(env, query + ' ORDER BY at DESC, id LIMIT 100', ...params)).map(row => ({ ...row, at: iso(row.at) }));
}
async function status(env, tenant, now) {
  const row = await sql(env, 'SELECT published,slug,title FROM data_status WHERE tenant_id = ?', tenant).first();
  if (!row) return { published: false, slug: null, title: '', updates: [] };
  const updates = await rows(env, `SELECT id,message,state,at FROM data_status_updates
    WHERE tenant_id = ? AND at >= ? ORDER BY at DESC,id LIMIT 100`, tenant, now - 7 * DAY);
  return { ...row, published: Boolean(row.published), updates: updates.map(u => ({ ...u, at: iso(u.at) })) };
}
export async function summary(env, tenant_id) {
  const now = Date.now();
  await env.DB.batch(purgeStatements(env, tenant_id, now));
  const [a, l, s] = await Promise.all([analytics(env, tenant_id, now), logs(env, tenant_id, now), status(env, tenant_id, now)]);
  return { analytics: a, logs: l, status: s };
}
function admin(principal) {
  if (!principal || principal.role !== 'owner' || principal.kind !== 'session' || !principal.scopes.includes('admin')) {
    fail('Owner browser session with admin scope required', 403);
  }
}
const publicText = value => value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

async function publicStatus(env, slug) {
  const page = await sql(env, 'SELECT tenant_id,title FROM data_status WHERE slug = ? AND published = 1', slug).first();
  if (!page) fail('Not found', 404);
  const updates = await rows(env, `SELECT message,state,at FROM data_status_updates
    WHERE tenant_id = ? AND at >= ? ORDER BY at DESC,id LIMIT 100`, page.tenant_id, Date.now() - 7 * DAY);
  return json({ title: publicText(page.title), updates: updates.map(u => ({ message: publicText(u.message), state: u.state, at: iso(u.at) })) });
}
function siteOrigin(value) {
  text(value, 512);
  let url;
  try { url = new URL(value); } catch { fail('Invalid site origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('Site origin must be an HTTPS origin');
  }
  return url.origin;
}
async function collect(request, env, writeid) {
  const site = await sql(env, 'SELECT write_id,tenant_id,origin FROM data_sites WHERE write_id = ?', writeid).first();
  if (!site) fail('Not found', 404);
  if (request.headers.get('origin') !== site.origin) fail('Origin not allowed', 403);
  if (request.headers.has('cookie') || request.headers.has('authorization')) fail('Collection does not accept credentials', 403);
  const cors = { 'access-control-allow-origin': site.origin, vary: 'Origin' };
  if (request.method === 'OPTIONS') {
    if (request.headers.get('access-control-request-method') !== 'POST' ||
        (request.headers.get('access-control-request-headers') || '').split(',').some(h => h.trim() && h.trim().toLowerCase() !== 'content-type')) {
      fail('Preflight not allowed', 403);
    }
    return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'Content-Type' } });
  }
  if (request.method !== 'POST') fail('Method not allowed', 405);
  try {
    const now = Date.now();
    const record = event(await body(request), now, true);
    return json(await ingest(env, site.tenant_id, [record], now, site.write_id), 200, cors);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status, cors);
    throw error;
  }
}

export async function dataRoute(request, env, principal) {
  const url = new URL(request.url);
  const path = url.pathname;
  const publicMatch = /^\/public\/status\/([a-f0-9]{32})$/.exec(path);
  const collectMatch = /^\/collect\/([a-f0-9]{32})$/.exec(path);
  const protectedPaths = ['/api/ingest', '/api/analytics', '/api/logs', '/api/status', '/api/status/updates', '/api/export', '/api/sites'];
  if (!publicMatch && !collectMatch && !protectedPaths.includes(path)) return null;
  try {
    if (publicMatch) {
      if (request.method !== 'GET') fail('Method not allowed', 405);
      return await publicStatus(env, publicMatch[1]);
    }
    if (collectMatch) return await collect(request, env, collectMatch[1]);
    if (!principal) fail('Authentication required', 401);
    const tenant = principal.tenant_id;
    const now = Date.now();
    if (request.method === 'GET' && !principal.scopes.includes('read')) fail('Read scope required', 403);
    if (path === '/api/ingest' && request.method === 'POST') {
      if (!principal.scopes.includes('ingest')) fail('Ingest scope required', 403);
      const value = object(await body(request), ['events', 'logs'], []);
      if ((value.events !== undefined && !Array.isArray(value.events)) || (value.logs !== undefined && !Array.isArray(value.logs))) fail('Expected record arrays');
      const count = (value.events?.length ?? 0) + (value.logs?.length ?? 0);
      if (count < 1 || count > 50) fail('Batch must contain 1 to 50 records');
      const records = [...(value.events ?? []).map(v => event(v, now)), ...(value.logs ?? []).map(v => log(v, now))];
      return json(await ingest(env, tenant, records, now));
    }
    if (request.method === 'GET' && ['/api/analytics', '/api/logs', '/api/status'].includes(path)) {
      await env.DB.batch(purgeStatements(env, tenant, now));
      if (path === '/api/analytics') return json(await analytics(env, tenant, now));
      if (path === '/api/status') return json(await status(env, tenant, now));
      const filters = {};
      for (const [key, value] of url.searchParams) {
        if (!['level', 'service', 'q'].includes(key) || Object.hasOwn(filters, key)) fail('Unexpected log filter');
        filters[key] = text(value, key === 'q' ? 200 : 80, 0);
      }
      if (filters.level && !LEVELS.includes(filters.level)) fail('Invalid log level');
      return json({ logs: await logs(env, tenant, now, filters) });
    }
    if (path === '/api/status' && request.method === 'POST') {
      admin(principal);
      const value = object(await body(request), ['published', 'title']);
      if (typeof value.published !== 'boolean') fail('Published must be boolean');
      text(value.title, 160);
      await sql(env, `INSERT INTO data_status(tenant_id,slug,title,published) VALUES(?,?,?,?)
        ON CONFLICT(tenant_id) DO UPDATE SET title = excluded.title,published = excluded.published`, tenant, token(), value.title, Number(value.published)).run();
      return json(await status(env, tenant, now));
    }
    if (path === '/api/status/updates' && request.method === 'POST') {
      admin(principal);
      const value = object(await body(request), ['message', 'state']);
      text(value.message, 2000);
      if (!STATES.includes(value.state)) fail('Invalid update state');
      if (!await sql(env, 'SELECT tenant_id FROM data_status WHERE tenant_id = ?', tenant).first()) fail('Configure status first', 409);
      await env.DB.batch([
        ...purgeStatements(env, tenant, now),
        sql(env, 'INSERT INTO data_status_updates(id,tenant_id,message,state,at) VALUES(?,?,?,?,?)', token(), tenant, value.message, value.state, now),
        sql(env, `DELETE FROM data_status_updates WHERE tenant_id = ? AND id NOT IN
          (SELECT id FROM data_status_updates WHERE tenant_id = ? ORDER BY at DESC,id LIMIT 100)`, tenant, tenant),
      ]);
      return json(await status(env, tenant, now));
    }
    if (path === '/api/sites' && request.method === 'GET') {
      return json({ sites: await rows(env, 'SELECT write_id,origin,created_at FROM data_sites WHERE tenant_id = ? ORDER BY created_at LIMIT 100', tenant) });
    }
    if (path === '/api/sites' && request.method === 'POST') {
      admin(principal);
      const value = object(await body(request), ['origin']);
      const origin = siteOrigin(value.origin);
      await sql(env, `INSERT INTO data_sites(write_id,tenant_id,origin,created_at)
        SELECT ?,?,?,? WHERE (SELECT count(*) FROM data_sites WHERE tenant_id = ?) < 100
        ON CONFLICT(tenant_id,origin) DO NOTHING`, token(), tenant, origin, now, tenant).run();
      const site = await sql(env, 'SELECT write_id,origin,created_at FROM data_sites WHERE tenant_id = ? AND origin = ?', tenant, origin).first();
      if (!site) fail('Site limit exceeded', 429);
      return json(site);
    }
    if (path === '/api/export' && request.method === 'GET') {
      admin(principal);
      await env.DB.batch(purgeStatements(env, tenant, now));
      const records = await rows(env, `SELECT id,kind,name,path,referrer,properties,service,level,message,trace_id,at,received_at
        FROM data_records WHERE tenant_id = ? AND received_at >= ? ORDER BY received_at DESC,id LIMIT 100`, tenant, now - 7 * DAY);
      return json({ records: records.map(r => ({ ...r, at: iso(r.at), received_at: iso(r.received_at), properties: r.properties ? JSON.parse(r.properties) : null })),
        status: await status(env, tenant, now), limits: { rows: 100, retention_days: 7, tenant_records: 10000, records_per_hour: 1000 },
        note: 'Bounded export: newest 100 retained records, not a complete archive. Analytics and logs show the last 24 hours.' });
    }
    fail('Method not allowed', 405);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status);
    throw error;
  }
}

// SPDX-License-Identifier: MPL-2.0
import { Roundhouse } from '../npm/dist/workers.js';
import { core } from '../npm/dist/core.js';
import { appConfig, appMonitors, publicEndpoint } from './apps.js';
import { pausedWorker } from '../examples/reportroom/fixture.js';
export { ReportApplication } from '../examples/reportroom/app.js';

export const limits = { daily_budget_microusd: 500000, reserve_per_request_microusd: 50000,
  daily_requests: 10, requests_per_incident: 4, daily_actions: 3, investigation_timeout_seconds: 30 };
const config = { provider: { kind: 'anthropic', base_url: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', max_output_tokens: 1024 }, limits,
  monitors: [{ id: 'reportroom', health_url: 'https://reportroom.internal/health', expected_status: 200,
    interval_seconds: 30, timeout_seconds: 3, environment: 'production',
    diagnostics: [{ name: 'export_queue', url: 'https://reportroom.internal/status' }],
    actions: [{ name: 'resume_exports', description: 'Resume the paused synthetic Reportroom export worker; generates CSV from synthetic orders only.', url: 'https://reportroom.internal/recover', auto_approve: false }] }] };

function policyConfig(requireApproval, apps = []) {
  const effective = structuredClone(config);
  effective.monitors[0].actions[0].auto_approve = !requireApproval;
  effective.monitors.push(...appMonitors(apps));
  return effective;
}

export class TenantController extends Roundhouse {
  constructor(ctx, env) {
    const sql = ctx.storage.sql;
    const initialized = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='incidents'").toArray().length > 0;
    sql.exec('CREATE TABLE IF NOT EXISTS platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    sql.exec("INSERT OR IGNORE INTO platform_settings VALUES('require_approval',?)", String(initialized));
    const requireApproval = sql.exec("SELECT value FROM platform_settings WHERE key='require_approval'").toArray()[0].value === 'true';
    const apps = JSON.parse(sql.exec("SELECT value FROM platform_settings WHERE key='apps'").toArray()[0]?.value || '[]');
    super(ctx, { ...env, ROUNDHOUSE_CONFIG: JSON.stringify(policyConfig(requireApproval, apps)),
      PROVIDER_API_KEY: env.ANTHROPIC_API_KEY || 'fixture-provider', OPERATOR_TOKEN: 'internal-controller-operator',
      EVENT_TOKEN: 'internal-event-receiver', APPLICATION_TOKEN: 'internal-reportroom' });
  }
  async applicationFetch(url, init) {
    const parsed = new URL(url);
    if (parsed.origin === 'https://reportroom.internal' && ['/health', '/status', '/recover'].includes(parsed.pathname) && !parsed.search) {
      return this.env.REPORTS.getByName(this.ctx.id.toString()).fetch(new Request(url, init));
    }
    publicEndpoint(url);
    const method = init?.method || 'GET';
    const app = this.apps().find(a => method === 'GET' ? a.health_url === url || a.diagnostics.some(d => d.url === url) : method === 'POST' && a.actions.some(a => a.url === url));
    if (!app || !['GET', 'POST'].includes(method)) throw new Error('Application route denied');
    if (method === 'POST' && this.mode() !== 'anthropic') throw new Error('External recovery requires Anthropic mode');
    const headers = new Headers();
    const token = this.appSecrets()[`${this.tenantId()}/${app.id}`];
    if (typeof token === 'string' && token) headers.set('authorization', `Bearer ${token}`);
    if (method === 'POST') {
      headers.set('content-type', 'application/json');
      const key = new Headers(init?.headers).get('idempotency-key');
      if (key) headers.set('idempotency-key', key);
    }
    const response = await fetch(url, { method, headers, redirect: 'manual', signal: init?.signal, ...(method === 'POST' ? { body: init?.body } : {}) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('Application redirects denied');
    }
    return response;
  }
  apps() { return JSON.parse(this.rows("SELECT value FROM platform_settings WHERE key='apps'")[0]?.value || '[]'); }
  tenantId() { return this.rows("SELECT value FROM platform_settings WHERE key='tenant_id'")[0]?.value; }
  appSecrets() {
    try {
      const value = JSON.parse(this.env.APP_SECRETS_JSON || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  clean(text) {
    for (const token of Object.values(this.appSecrets()).filter(s => typeof s === 'string' && s).sort((a,b) => b.length-a.length)) text = text.split(token).join('[REDACTED]');
    return super.clean(text);
  }
  async investigate(i, m) {
    this.audit(i.id, 'provider_mode', { mode: this.mode() });
    if (m.id !== 'reportroom' && this.mode() !== 'anthropic') {
      this.audit(i.id, 'investigation_stopped', { reason: 'External investigation requires Anthropic mode; fixture cannot inspect or recover connected apps' });
      this.state(i.id, 'needs_attention');
      return;
    }
    return super.investigate(i, m);
  }
  async providerFetch(url, init) {
    if (url !== 'https://api.anthropic.com/v1/messages') throw new Error('Provider route denied');
    if (this.mode() === 'anthropic') {
      if (!this.env.ANTHROPIC_API_KEY) throw new Error('Provider not configured');
      return fetch(url, { ...init, redirect: 'manual' });
    }
    const body = JSON.parse(init.body);
    const inspected = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).findLast(c => c.type === 'tool_result');
    const resume = inspected && pausedWorker(inspected.content);
    return Response.json({ id: crypto.randomUUID(), type: 'message', role: 'assistant', model: 'scripted-fixture',
      content: inspected && !resume ? [{ type: 'text', text: 'No paused worker confirmed.' }] : [{ type: 'tool_use', id: crypto.randomUUID(), name: resume ? 'request_recovery' : 'inspect_system', input: resume ? { action: 'resume_exports' } : {} }],
      stop_reason: inspected && !resume ? 'end_turn' : 'tool_use', usage: { input_tokens: 0, output_tokens: 0 } });
  }
  mode() { return this.ctx.storage.sql.exec("SELECT value FROM platform_settings WHERE key='provider'").toArray()[0]?.value || 'fixture'; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const tenantId = request.headers.get('x-tenant-id');
    if (tenantId) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tenantId) || (this.tenantId() && this.tenantId() !== tenantId)) return Response.json({ error: 'Tenant mismatch' }, { status: 403 });
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO platform_settings VALUES('tenant_id',?)", tenantId);
    }
    const appRoute = path.match(/^\/platform\/apps(?:\/([a-z][a-z0-9_-]{0,47})\/config)?$/);
    if (appRoute) {
      const listing = () => ({ apps: [{ ...this.config.monitors[0], name: 'Reportroom', kind: 'example' }, ...this.apps().map(a => ({ ...a, kind: 'connected' }))], enabled: this.enabled() });
      if (request.method === 'GET' && !appRoute[1]) return Response.json(listing());
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      if (!this.tenantId()) return Response.json({ error: 'Tenant identity required' }, { status: 403 });
      let app;
      try {
        const reader = request.body?.getReader();
        let size = 0, chunks = [];
        if (!reader) throw new Error('Missing config');
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 32768) throw new Error('Config too large');
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        app = appConfig(JSON.parse(await new Blob(chunks).text()), appRoute[1]);
      } catch { return Response.json({ error: 'Invalid application configuration' }, { status: 400 }); }
      // Recheck after reading the body: another request may have started monitoring.
      if (this.enabled() || this.running || this.rows("SELECT id FROM incidents WHERE state!='resolved' LIMIT 1").length) return Response.json({ error: 'Stop monitoring and resolve all incidents before changing apps' }, { status: 409 });
      const apps = this.apps(), index = apps.findIndex(a => a.id === app.id);
      if (appRoute[1] && index < 0) return Response.json({ error: 'Application not found' }, { status: 404 });
      if (!appRoute[1] && (index >= 0 || apps.length >= 10)) return Response.json({ error: 'Duplicate application or application limit' }, { status: 409 });
      if (index >= 0) apps[index] = app; else apps.push(app);
      // Shared endpoint ownership would make application-secret selection ambiguous.
      const owners = new Map();
      for (const a of apps) for (const url of [a.health_url, ...a.diagnostics.map(d => d.url), ...a.actions.map(a => a.url)]) {
        if (owners.has(url) && owners.get(url) !== a.id) return Response.json({ error: 'Endpoint already owned by another app' }, { status: 400 });
        owners.set(url, a.id);
      }
      let effective;
      try { effective = core.config(JSON.stringify(policyConfig(!this.config.monitors[0].actions[0].auto_approve, apps))); }
      catch { return Response.json({ error: 'Invalid core configuration' }, { status: 400 }); }
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO platform_settings VALUES('apps',?)", JSON.stringify(apps));
      this.config = effective;
      this.fingerprint = JSON.stringify(effective);
      return Response.json(listing(), { status: appRoute[1] ? 200 : 201 });
    }
    if (path === '/platform/policy') {
      const policy = () => ({ require_approval: !this.config.monitors[0].actions[0].auto_approve });
      if (request.method === 'GET') return Response.json(policy());
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: 'Invalid policy' }, { status: 400 }); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.require_approval !== 'boolean') {
        return Response.json({ error: 'Expected require_approval boolean' }, { status: 400 });
      }
      if (this.ctx.storage.sql.exec("SELECT id FROM incidents WHERE state!='resolved' LIMIT 1").toArray().length) return Response.json({ error: 'Resolve the current incident before changing policy' }, { status: 409 });
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO platform_settings VALUES('require_approval',?)", String(body.require_approval));
      const effective = policyConfig(body.require_approval, this.apps());
      this.config.monitors[0].actions[0].auto_approve = effective.monitors[0].actions[0].auto_approve;
      this.fingerprint = JSON.stringify(this.config);
      return Response.json(policy());
    }
    if (path === '/platform/provider') {
      if (request.method === 'GET') return Response.json({ mode: this.mode(), model: this.config.provider.model, configured: !!this.env.ANTHROPIC_API_KEY });
      const { mode } = await request.json();
      if (!['fixture', 'anthropic'].includes(mode)) return Response.json({ error: 'Invalid provider mode' }, { status: 400 });
      if (mode === 'anthropic' && !this.env.ANTHROPIC_API_KEY) return Response.json({ error: 'Provider not configured' }, { status: 503 });
      if (this.ctx.storage.sql.exec("SELECT id FROM incidents WHERE state!='resolved' LIMIT 1").toArray().length) return Response.json({ error: 'Resolve the current incident before changing provider' }, { status: 409 });
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO platform_settings VALUES('provider',?)", mode);
      return Response.json({ mode });
    }
    if (path === '/v1/start' && request.method === 'POST' && request.headers.get('x-tenant-kind') === 'guest') {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO platform_settings VALUES('guest_lease',?)", String(Date.now() + 86400000));
    }
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${path === '/v1/events' ? 'internal-event-receiver' : 'internal-controller-operator'}`);
    return super.fetch(new Request(request, { headers }));
  }
  async alarm() {
    const lease = this.ctx.storage.sql.exec("SELECT value FROM platform_settings WHERE key='guest_lease'").toArray()[0];
    if (lease && Number(lease.value) < Date.now()) {
      await super.fetch(new Request('https://controller.internal/v1/stop', { method: 'POST', headers: { authorization: 'Bearer internal-controller-operator' } }));
      return;
    }
    return super.alarm();
  }
}

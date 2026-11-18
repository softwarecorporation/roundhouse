// SPDX-License-Identifier: MPL-2.0
import { Roundhouse } from '../npm/dist/workers.js';
export { ReportApplication } from '../examples/reportroom/app.js';

export const limits = { daily_budget_microusd: 500000, reserve_per_request_microusd: 50000,
  daily_requests: 10, requests_per_incident: 4, daily_actions: 3, investigation_timeout_seconds: 30 };
const config = { provider: { kind: 'anthropic', base_url: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', max_output_tokens: 1024 }, limits,
  monitors: [{ id: 'reportroom', health_url: 'https://reportroom.internal/health', expected_status: 200,
    interval_seconds: 30, timeout_seconds: 3, environment: 'production',
    diagnostics: [{ name: 'export_queue', url: 'https://reportroom.internal/status' }],
    actions: [{ name: 'resume_exports', description: 'Resume the paused synthetic Reportroom export worker; generates CSV from synthetic orders only.', url: 'https://reportroom.internal/recover', auto_approve: false }] }] };

export class TenantController extends Roundhouse {
  constructor(ctx, env) {
    super(ctx, { ...env, ROUNDHOUSE_CONFIG: JSON.stringify(config),
      PROVIDER_API_KEY: env.ANTHROPIC_API_KEY || 'fixture-provider', OPERATOR_TOKEN: 'internal-controller-operator',
      EVENT_TOKEN: 'internal-event-receiver', APPLICATION_TOKEN: 'internal-reportroom' });
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  }
  async applicationFetch(url, init) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://reportroom.internal' || !['/health', '/status', '/recover'].includes(parsed.pathname) || parsed.search) throw new Error('Application route denied');
    return this.env.REPORTS.getByName(this.ctx.id.toString()).fetch(new Request(url, init));
  }
  async providerFetch(url, init) {
    if (url !== 'https://api.anthropic.com/v1/messages') throw new Error('Provider route denied');
    if (this.mode() === 'anthropic') {
      if (!this.env.ANTHROPIC_API_KEY) throw new Error('Provider not configured');
      return fetch(url, { ...init, redirect: 'manual' });
    }
    const body = JSON.parse(init.body);
    const inspected = body.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
    return Response.json({ id: crypto.randomUUID(), type: 'message', role: 'assistant', model: 'scripted-fixture',
      content: [{ type: 'tool_use', id: crypto.randomUUID(), name: inspected ? 'request_recovery' : 'inspect_system', input: inspected ? { action: 'resume_exports' } : {} }],
      stop_reason: 'tool_use', usage: { input_tokens: 0, output_tokens: 0 } });
  }
  mode() { return this.ctx.storage.sql.exec("SELECT value FROM platform_settings WHERE key='provider'").toArray()[0]?.value || 'fixture'; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
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

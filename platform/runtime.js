// SPDX-License-Identifier: MPL-2.0
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function createRuntime({ port, origin = 'https://roundhouse.test', demoOrigin = 'https://reportroom.roundhouse.test',
  invite = 'local-test-invitation', persistence = false, key, providerTransport = fetch } = {}) {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const bundle = root + '.cloudflare/output/v1/workers/default/bundle/';
  const mf = new Miniflare({ port, ...(port ? { upstream: origin } : {}), modulesRoot: bundle,
    modules: [{ type: 'ESModule', path: bundle + 'index.js' }, { type: 'CompiledWasm', path: bundle + 'roundhouse_core_bg.wasm' }],
    compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { CONTROLLERS: { className: 'TenantController', useSQLite: true }, REPORTS: { className: 'ReportApplication', useSQLite: true } },
    d1Databases: ['DB'], d1Persist: persistence, durableObjectsPersist: persistence,
    bindings: { PUBLIC_ORIGIN: origin, DEMO_ORIGIN: demoOrigin, SETUP_INVITE: invite,
      ...(origin.endsWith('.test') ? { SESSION_COOKIE_DOMAIN: 'roundhouse.test' } : {}), APPLICATION_TOKEN: 'internal-reportroom', ...(key ? { ANTHROPIC_API_KEY: key } : {}) },
    serviceBindings: { ASSETS: async request => {
      const path = new URL(request.url).pathname;
      if (!/^\/[a-zA-Z0-9/._-]+$/.test(path) || path.includes('..')) return new Response(null, { status: 404 });
      try { return new Response(await readFile(root + '.cloudflare/output/v1/workers/default/assets' + path), { headers: {
        'content-type': path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css' : 'text/javascript' } }); }
      catch { return new Response(null, { status: 404 }); }
    } },
    outboundService: async request => {
      if (!key || request.url !== 'https://api.anthropic.com/v1/messages' || request.method !== 'POST') throw new Error('External egress denied');
      return providerTransport(request.url, { method: request.method, headers: request.headers, body: await request.arrayBuffer(), redirect: 'error', signal: request.signal });
    },
  });
  try {
    await mf.ready;
    const db = await mf.getD1Database('DB');
    for (const name of ['0001.sql', '0002.sql']) {
      const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name === '0001.sql' ? 'tenants' : 'data_records').first();
      if (!exists) {
        const migration = await readFile(root + 'migrations/' + name, 'utf8');
        const trigger = migration.match(/CREATE TRIGGER[\s\S]*?\nEND;/)?.[0];
        for (const statement of migration.replace(trigger || '', '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
        if (trigger) await db.prepare(trigger).run();
      }
    }
    return { mf, db, origin, async close() { await mf.dispose(); } };
  } catch (error) { await mf.dispose(); throw error; }
}

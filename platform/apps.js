// SPDX-License-Identifier: MPL-2.0
const identifier = /^[a-z][a-z0-9_-]{0,47}$/;
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw new Error('Invalid fields');
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid text');
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error('Invalid identifier');
  return value;
}
export function publicEndpoint(value) {
  text(value, 2048);
  const u = new URL(value);
  const host = u.hostname;
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || value.includes('?') || value.includes('#') ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || /^\d+(?:\.\d+)*$/.test(host) ||
      host.split('.').some(p => p.startsWith('-') || p.endsWith('-')) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(host)) throw new Error('Public HTTPS endpoint required');
  if (u.href !== value) throw new Error('Canonical HTTPS endpoint required');
  return value;
}
export function appConfig(value, fixedId) {
  object(value, ['id', 'name', 'health_url', 'expected_status', 'interval_seconds', 'timeout_seconds', 'environment', 'diagnostics', 'actions']);
  if (Object.values(value).some(v => v === null)) throw new Error('Null fields are not defaults');
  const app = { id: id(value.id ?? fixedId), name: text(value.name, 80), health_url: publicEndpoint(value.health_url),
    expected_status: value.expected_status ?? 200, interval_seconds: value.interval_seconds ?? 60,
    timeout_seconds: value.timeout_seconds ?? 5, environment: value.environment ?? 'production', diagnostics: [], actions: [] };
  if (app.id === 'reportroom' || (fixedId && app.id !== fixedId)) throw new Error('Reserved or changed identifier');
  for (const [field, min, max] of [['expected_status',100,599], ['interval_seconds',5,86400], ['timeout_seconds',1,30]]) {
    if (!Number.isInteger(app[field]) || app[field] < min || app[field] > max) throw new Error('Invalid ' + field);
  }
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(text(app.environment, 32))) throw new Error('Invalid environment');
  for (const field of ['diagnostics', 'actions']) {
    const entries = value[field] ?? [];
    if (!Array.isArray(entries) || entries.length > 4) throw new Error('Too many ' + field);
    const names = new Set();
    app[field] = entries.map(entry => {
      object(entry, field === 'actions' ? ['name', 'description', 'url', 'auto_approve'] : ['name', 'url']);
      const item = { name: id(entry.name), url: publicEndpoint(entry.url) };
      if (names.has(item.name)) throw new Error('Duplicate name');
      names.add(item.name);
      if (field === 'actions') {
        item.description = text(entry.description, 500);
        item.auto_approve = entry.auto_approve === undefined ? true : entry.auto_approve;
        if (typeof item.auto_approve !== 'boolean') throw new Error('Invalid approval');
      }
      return item;
    });
  }
  return app;
}
export function appMonitors(apps) {
  return apps.map(({ name, ...monitor }) => monitor);
}

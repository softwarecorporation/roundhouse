"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((value || 0) / 100);
  const stamp = value => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  let workspace, state, busy = false, connected = false, detailId = null, timer, refreshPromise, prefDirty = false, reportDirty = false, detailSignature, historySignature;
  function notify(text, error = false) { const n = $(error ? 'error' : 'message'); n.textContent = text; n.hidden = false; }
  async function api(path, body) {
    const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(12000),
      headers: { 'content-type': 'application/json', 'x-reportroom-demo': '1', 'x-roundhouse': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json();
    if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; throw e; } return data;
  }
  function navigate() {
    const view = ['reports', 'overview', 'preferences', 'roundhouse'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'reports';
    for (const n of document.querySelectorAll('.view')) n.hidden = n.id !== `view-${view}`;
    for (const n of document.querySelectorAll('[data-view]')) { if (n.dataset.view === view) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); }
    document.title = `${view === 'overview' ? 'Sales overview' : view[0].toUpperCase() + view.slice(1)} | Reportroom`;
  }
  function controls() {
    document.querySelectorAll('form button, #fault, #reset, #monitor-start').forEach(n => n.disabled = busy || !connected);
    $('start-demo').disabled = busy;
    $('fault').disabled = busy || !connected || !state?.capabilities?.fault_allowed;
    $('monitor-start').disabled = busy || !connected || state?.monitoring?.enabled;
  }
  function reportRows() {
    const signature = JSON.stringify(workspace.reports);
    if (signature === historySignature) return;
    historySignature = signature;
    const rows = workspace.reports.map(report => {
      const tr = node('tr');
      const title = node('td'); const link = node('a', report.title, 'report-title'); link.href = `#report-${report.id}`;
      link.addEventListener('click', event => { event.preventDefault(); void showDetail(report.id); });
      title.append(link, node('span', stamp(report.created_at), 'cell-note'));
      const status = node('td'); status.append(node('span', report.state === 'completed' ? 'Ready' : report.state === 'queued' ? 'Generating' : 'Failed', `state ${report.state}`));
      const output = node('td'); const links = node('div', null, 'row-links');
      const view = node('a', 'View'); view.href = link.href; view.addEventListener('click', event => { event.preventDefault(); void showDetail(report.id); }); links.append(view);
      if (report.state === 'completed') { const csv = node('a', 'CSV'); csv.href = `/api/reports/${report.id}.csv`; csv.setAttribute('download', ''); csv.setAttribute('aria-label', `Download ${report.title}`); links.append(csv); }
      output.append(links);
      tr.append(title, node('td', `${report.period} days / ${report.group_by}`), status, node('td', report.revenue_cents == null ? '—' : money(report.revenue_cents), 'numeric'), output); return tr;
    });
    $('reports').replaceChildren(...rows); $('empty').hidden = rows.length > 0; $('report-count').textContent = `${rows.length} / 25 reports`;
  }
  function renderOverview() {
    $('revenue').textContent = money(workspace.overview.revenue_cents); $('orders').textContent = workspace.overview.orders;
    $('average').textContent = money(workspace.overview.average_order_cents);
    if (!$('chart').children.length) {
      const maximum = Math.max(...workspace.daily.map(d => d.revenue_cents));
      $('chart').replaceChildren(...workspace.daily.map(d => { const b = node('div', null, 'chart-bar'); b.style.height = `${d.revenue_cents / maximum * 100}%`; b.title = `${d.day}: ${money(d.revenue_cents)}, ${d.order_count} orders`; return b; }));
      $('recent-orders').replaceChildren(...workspace.recent_orders.map(order => { const tr = node('tr'); tr.append(node('td', `#${order.id}`), node('td', order.day), node('td', money(order.revenue_cents), 'numeric')); return tr; }));
    }
  }
  function renderOperations() {
    $('worker').textContent = state.app.worker_running ? 'Running' : 'Paused';
    $('monitor').textContent = state.monitoring.enabled ? 'On' : 'Off';
    $('provider').textContent = state.provider.mode === 'anthropic' ? 'Anthropic' : 'Fixture';
    const signature = JSON.stringify(state.monitoring.incidents);
    if ($('incidents').dataset.signature === signature) return;
    $('incidents').dataset.signature = signature;
    $('incidents').replaceChildren(...state.monitoring.incidents.map(incident => {
      const section = node('article', null, 'incident'); section.append(node('h2', incident.state.replaceAll('_', ' ')));
      if (incident.state === 'awaiting_approval') {
        const approve = node('button', 'Approve recovery'); approve.type = 'button'; approve.addEventListener('click', () => { if (confirm('Resume the synthetic report worker?')) void mutate(`/api/incidents/${incident.id}/approve`, {}); }); section.append(approve);
      }
      const details = node('details'); details.append(node('summary', 'Evidence')); const list = node('ol');
      for (const entry of incident.history || []) { const li = node('li'); li.append(node('time', stamp(typeof entry.at === 'number' && entry.at < 1e12 ? entry.at * 1000 : entry.at)), node('strong', entry.kind)); const raw = node('pre', typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail)); li.append(raw); list.append(li); }
      details.append(list); section.append(details); return section;
    }));
  }
  function render() {
    const prefs = workspace.preferences;
    $('welcome').hidden = true; $('onboarding').hidden = prefs.onboarded; $('workspace').hidden = !prefs.onboarded;
    $('workspace-name').textContent = prefs.name;
    if (!prefDirty) { $('pref-name').value = prefs.name; $('pref-period').value = prefs.default_period; $('pref-group').value = prefs.default_group_by; }
    if (!reportDirty) { $('report-period').value = prefs.default_period; $('report-group').value = prefs.default_group_by; }
    reportRows(); renderOverview(); renderOperations(); navigate(); controls();
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const [nextWorkspace, nextState] = await Promise.all([api('/api/workspace'), api('/api/state')]);
        workspace = nextWorkspace; state = nextState; connected = true;
        $('connection').textContent = 'Connected'; if ($('error').dataset.poll === '1') { $('error').hidden = true; delete $('error').dataset.poll; }
        render(); if (detailId) await showDetail(detailId, true);
      } catch (error) {
        connected = false; $('connection').textContent = 'Offline';
        if (error.status === 401) { $('welcome').hidden = false; $('workspace').hidden = true; $('onboarding').hidden = true; }
        else { notify(`Refresh failed. ${error.message}`, true); $('error').dataset.poll = '1'; }
        controls();
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  async function mutate(path, body, message = 'Saved.') {
    if (busy) return null;
    busy = true; controls(); $('error').hidden = true; notify('Saving…');
    try { const result = await api(path, body); notify(message); await refresh(); return result; }
    catch (error) { notify(`${error.message} Refresh before retrying.`, true); $('message').hidden = true; return null; }
    finally { busy = false; controls(); }
  }
  async function showDetail(id, background = false) {
    if (!background) { detailId = id; detailSignature = null; $('report-detail').hidden = false; $('detail-title').textContent = 'Loading report…'; $('detail-content').replaceChildren(); }
    try {
      const report = await api(`/api/reports/${id}`); if (detailId !== id) return;
      const signature = JSON.stringify(report); if (signature === detailSignature) return; detailSignature = signature;
      $('detail-title').textContent = report.title; $('detail-meta').textContent = `${report.period} days / ${report.group_by} / ${report.state === 'completed' ? 'Ready' : report.state}`;
      const content = $('detail-content'); content.replaceChildren();
      if (report.state !== 'completed') { content.append(node('p', report.state === 'queued' ? 'Generating. This view updates automatically.' : 'Generation failed. Check worker status in Roundhouse.')); }
      else {
        const download = node('a', 'Download CSV'); download.href = `/api/reports/${id}.csv`; download.setAttribute('download', '');
        content.append(download, node('p', `${report.order_count} orders / ${money(report.revenue_cents)} / ${report.rows} rows`, 'detail-meta'));
        const region = node('div', null, 'table-scroll'); region.tabIndex = 0; region.setAttribute('role', 'region'); region.setAttribute('aria-label', 'Report preview');
        const table = node('table'), head = node('thead'), header = node('tr');
        ['Date', 'Orders', 'Revenue'].forEach(label => { const th = node('th', label); th.scope = 'col'; header.append(th); }); head.append(header);
        const body = node('tbody');
        for (const row of report.preview.rows) { const tr = node('tr'); tr.append(node('td', row.date || row.week_start), node('td', row.order_count), node('td', money(row.revenue_cents), 'numeric')); body.append(tr); }
        table.append(head, body); region.append(table); content.append(region);
        if (report.preview.truncated) content.append(node('p', 'Preview: first 10 rows.', 'hint'));
        const digest = node('details'); digest.append(node('summary', 'SHA-256'), node('code', report.sha256)); content.append(digest);
      }
      if (!background) $('report-detail').scrollIntoView({ block: 'nearest' });
    } catch (error) { if (!background) { $('detail-title').textContent = 'Report unavailable'; $('detail-content').replaceChildren(node('p', error.message)); } }
  }
  $('start-demo').addEventListener('click', async () => { const result = await mutate('/api/auth/guest', {}, 'Workspace ready.'); if (result) await refresh(); });
  $('onboard-form').addEventListener('submit', async event => { event.preventDefault(); await mutate('/api/workspace', { ...workspace.preferences, name: $('onboard-name').value.trim(), onboarded: true }, 'Workspace ready.'); });
  $('report-form').addEventListener('input', () => { reportDirty = true; });
  $('report-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!connected) return;
    const report = await mutate('/api/reports', { title: $('report-title').value.trim(), period: Number($('report-period').value), group_by: $('report-group').value }, 'Report queued.');
    if (report) { reportDirty = false; $('report-title').value = ''; await showDetail(report.id); }
  });
  $('preferences-form').addEventListener('input', () => { prefDirty = true; });
  $('preferences-form').addEventListener('submit', async event => { event.preventDefault(); const result = await mutate('/api/workspace', { name: $('pref-name').value.trim(), default_period: Number($('pref-period').value), default_group_by: $('pref-group').value, onboarded: true }); if (result) { prefDirty = false; render(); } });
  $('close-detail').addEventListener('click', () => { detailId = null; $('report-detail').hidden = true; });
  $('refresh').addEventListener('click', () => { void refresh(); });
  $('monitor-start').addEventListener('click', () => { void mutate('/api/monitor/start', {}, 'Monitoring on.'); });
  $('fault').addEventListener('click', () => { if (confirm('Pause this demo worker? Reports wait until recovery.')) void mutate('/api/fault', {}, 'Worker paused.'); });
  $('reset').addEventListener('click', () => { if (confirm('Clear this workspace’s reports? Preferences and incident history stay.')) void mutate('/api/reset', {}, 'Reports cleared.'); });
  addEventListener('hashchange', navigate);
  async function loop() { if (!document.hidden && !busy) await refresh(); timer = setTimeout(loop, 2000); }
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) void loop(); });
  navigate(); void loop();
})();

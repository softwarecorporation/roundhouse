"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const views = ["apps", "systems", "incidents", "analytics", "logs", "status", "settings"];
  const state = { session: null, snapshot: null, generation: 0, busy: false, authBusy: false, registering: false, poll: null, reading: null,
    apps: null, appsEnabled: null, appsError: "", selectedApp: null, appDetail: null, editingApp: null };
  const fingerprints = new WeakMap();
  const incidentPanels = new Map();
  const dirtyForms = new Set();
  const numberFormat = new Intl.NumberFormat();
  let noticeTimer;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  function setText(id, value) {
    const element = $(id);
    const text = String(value ?? "—");
    if (element.textContent !== text) element.textContent = text;
  }

  function printable(value) {
    return typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value ?? "—");
  }

  function count(value) {
    return typeof value === "number" && Number.isFinite(value) ? numberFormat.format(value) : "—";
  }

  function timestamp(value) {
    if (value === undefined || value === null || value === "") return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function isGuest() { return state.session?.role === "guest" && state.session?.kind !== "key"; }
  function isOwner() { return state.session?.role === "owner" && !isGuest() && state.session?.kind !== "key"; }
  function canControl() { return isOwner() || isGuest(); }

  function notify(message, error = false) {
    clearTimeout(noticeTimer);
    const box = $("notice");
    box.textContent = message;
    box.classList.toggle("is-error", error);
    box.hidden = false;
    noticeTimer = setTimeout(() => { box.hidden = true; }, error ? 14000 : 6500);
  }

  async function api(path, body, signal) {
    const mutation = body !== undefined;
    let response;
    try {
      response = await fetch(path, {
        method: mutation ? "POST" : "GET",
        credentials: "include",
        cache: "no-store",
        headers: mutation ? { "Content-Type": "application/json", "x-roundhouse": "1" } : { Accept: "application/json" },
        ...(mutation ? { body: JSON.stringify(body) } : {}),
        signal: signal || AbortSignal.timeout(60000),
      });
    } catch (cause) {
      if (cause.name === "AbortError") throw cause;
      throw new Error(mutation ? "Connection lost. The action may have completed. Refresh and inspect the current state before trying again." : "Could not reach Roundhouse. Check your connection and refresh.");
    }
    let result;
    try { result = await response.json(); } catch {
      throw new Error(mutation ? "The server returned an unreadable response. The action may have completed; refresh before retrying." : "The server did not return JSON. Please refresh or check the deployment.");
    }
    if (!response.ok) {
      const error = new Error(typeof result.error === "string" ? result.error : `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function empty(title, description) {
    const box = node("div", null, "empty-state");
    box.append(node("strong", title), node("p", description));
    return box;
  }

  function replaceRegion(id, data, build) {
    const container = typeof id === "string" ? $(id) : id;
    const fingerprint = JSON.stringify(data);
    if (fingerprints.get(container) === fingerprint || container.contains(document.activeElement)) return;
    const children = build();
    const scrollLeft = container.querySelector(".data-table-wrap")?.scrollLeft || 0;
    const scrollTop = container.scrollTop;
    container.replaceChildren(...(Array.isArray(children) ? children : [children]));
    fingerprints.set(container, fingerprint);
    container.scrollTop = scrollTop;
    const tableWrap = container.querySelector(".data-table-wrap");
    if (tableWrap) tableWrap.scrollLeft = scrollLeft;
  }

  function badge(text, tone = "") { return node("span", text, `badge ${tone}`); }

  function table(headers, rows) {
    const wrap = node("div", null, "data-table-wrap");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", `${headers.join(", ")} table; scroll horizontally if needed`);
    const element = node("table", null, "data-table");
    const head = node("thead");
    const heading = node("tr");
    for (const label of headers) {
      const cell = node("th", label);
      cell.scope = "col";
      heading.append(cell);
    }
    head.append(heading);
    const body = node("tbody");
    for (const values of rows) {
      const row = node("tr");
      for (const value of values) {
        const cell = node("td");
        if (value instanceof Node) cell.append(value);
        else cell.textContent = String(value ?? "—");
        row.append(cell);
      }
      body.append(row);
    }
    element.append(head, body);
    wrap.append(element);
    return wrap;
  }

  function metric(label, value, note, tone = "") {
    const box = node("article", null, "metric");
    box.append(node("span", label, "metric-label"), node("strong", value, `metric-value ${tone}`), node("p", note, "metric-note"));
    return box;
  }

  function boolLabel(value, yes, no) { return value === true || value === 1 ? yes : value === false || value === 0 ? no : "Unknown"; }

  function selectedApp() { return state.apps?.find((app) => app.id === state.selectedApp); }
  function canOperateApp() { return canControl() && (selectedApp()?.kind === "example" || isOwner()); }

  function renderApps() {
    $("apps-error").hidden = !state.appsError;
    setText("apps-error", state.appsError);
    $("apps-access").hidden = isOwner();
    setText("apps-scheduler", state.appsEnabled === true ? "Tenant scheduler running" : state.appsEnabled === false ? "Tenant scheduler stopped" : "Scheduler unavailable");
    const apps = state.apps || [];
    replaceRegion("app-list", [apps, state.selectedApp], () => {
      if (!state.apps) return empty("Apps unavailable", "Refresh to load your apps.");
      if (!apps.length) return empty("No apps connected", isOwner() ? "Connect a health endpoint to start." : "No apps in this workspace.");
      const list = table(["App", "Environment", "Connection", ""], [...apps].sort((a, b) => Number(a.kind === "example") - Number(b.kind === "example")).map((app) => {
        const name = node("div", app.name);
        name.append(node("span", app.id, "trace-id"));
        const button = node("button", state.selectedApp === app.id ? "Selected" : "Open", "quiet-button");
        button.type = "button";
        button.dataset.selectApp = app.id;
        button.setAttribute("aria-label", `Open ${app.name}`);
        button.setAttribute("aria-pressed", String(state.selectedApp === app.id));
        button.addEventListener("click", () => {
          if (state.busy || state.selectedApp === app.id) return;
          state.selectedApp = app.id;
          state.appDetail = null;
          state.generation += 1;
          discardRead();
          renderApps();
          updateControls();
          void refresh();
        });
        return [name, app.environment, app.kind === "example" ? "Example" : "Connected", button];
      }));
      return list;
    });
    const detail = state.appDetail;
    const app = detail?.app ? { ...selectedApp(), ...detail.app } : null;
    $("app-detail").hidden = !app || app.id !== state.selectedApp;
    if (!app || app.id !== state.selectedApp) return;
    setText("app-detail-name", app.name || app.id);
    setText("app-detail-kind", app.kind === "example" ? "Example" : "Connected app");
    setText("app-detail-endpoint", app.health_url);
    const probes = detail.monitoring?.probes || [];
    const latest = [...probes].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
    replaceRegion("app-health", [app.id, latest, detail.monitoring?.enabled], () => [
      metric("Health", latest ? boolLabel(latest.healthy, "Healthy", "Unhealthy") : "Not checked", latest ? timestamp(latest.at) : "No recorded probe", latest?.healthy === true ? "good" : latest?.healthy === false ? "bad" : ""),
      metric("Scheduler", boolLabel(detail.monitoring?.enabled, "Running", "Stopped"), "Tenant-wide"),
    ]);
    replaceRegion("app-probes", [app.id, probes], () => probes.length ? table(["Observed", "Health", "Status", "Duration"], probes.map((probe) => [timestamp(probe.at), boolLabel(probe.healthy, "Healthy", "Unhealthy"), probe.status, probe.duration_ms == null ? "—" : `${count(probe.duration_ms)} ms`])) : empty("No probes", "Start the tenant scheduler to monitor health."));
    replaceRegion("app-actions", [app.id, app.actions], () => (app.actions || []).length ? table(["Action", "Description", "Execution"], app.actions.map((action) => [action.name, action.description, action.auto_approve === true ? "Automatic" : "Approval required"])) : empty("Observe only", "No recovery actions configured."));
    const incidents = detail.monitoring?.incidents || [];
    replaceRegion("app-incidents", [app.id, incidents], () => incidents.length ? table(["Incident", "State", "Latest evidence"], incidents.map((incident) => {
      const history = incident.history || [];
      return [incident.id, incident.state, history.length ? timestamp(history[history.length - 1].at) : "No history"];
    })) : empty("No incidents", "No failures recorded for this app."));
    setText("app-config-json", JSON.stringify(app, null, 2));
    setText("app-limits", JSON.stringify(detail.limits || {}, null, 2));
    setText("app-provider-boundary", app.kind === "example" ? "Synthetic example. Fixture investigations are available." : state.snapshot?.provider?.mode === "anthropic" ? "External actions use the live provider and can incur costs." : "External actions cannot run with the fixture provider. Choose Anthropic in Settings.");
  }

  function resetAppForm() {
    state.editingApp = null;
    $("app-form").reset();
    $("app-id").readOnly = false;
    $("app-extra-config").hidden = true;
    dirtyForms.delete("app-form");
    setText("app-editor-title", "Connect an app");
    setText("app-save", "Connect app");
  }

  function editApp(app) {
    if (!isOwner() || app?.kind === "example") return;
    if (dirtyForms.has("app-form") && !window.confirm("Discard unsaved app changes?")) return;
    resetAppForm();
    if (app) {
      state.editingApp = structuredClone(app);
      for (const [input, field] of [["app-id", "id"], ["app-name", "name"], ["app-url", "health_url"], ["app-status", "expected_status"], ["app-interval", "interval_seconds"], ["app-timeout", "timeout_seconds"], ["app-environment", "environment"]]) $(input).value = app[field];
      const diagnostic = app.diagnostics?.[0];
      const action = app.actions?.[0];
      $("app-diagnostic-name").value = diagnostic?.name || "";
      $("app-diagnostic-url").value = diagnostic?.url || "";
      $("app-action-name").value = action?.name || "";
      $("app-action-description").value = action?.description || "";
      $("app-action-url").value = action?.url || "";
      $("app-action-approval").checked = action ? action.auto_approve !== true : false;
      $("app-id").readOnly = true;
      $("app-extra-config").hidden = (app.diagnostics?.length || 0) < 2 && (app.actions?.length || 0) < 2;
      for (const disclosure of $("app-form").querySelectorAll("details")) disclosure.open = true;
      setText("app-editor-title", `Configure ${app.name}`);
      setText("app-save", "Save configuration");
    }
    $("app-editor").open = true;
    $("app-name").focus();
  }

  function appConfigFromForm() {
    const value = (id) => $(id).value.trim();
    const endpoint = (id) => {
      const url = new URL(value(id));
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) throw new Error("Use public HTTPS URLs without credentials, query strings, fragments or ports.");
      return url.href;
    };
    const config = { id: value("app-id"), name: value("app-name"), health_url: endpoint("app-url"), expected_status: Number(value("app-status")),
      interval_seconds: Number(value("app-interval")), timeout_seconds: Number(value("app-timeout")), environment: value("app-environment"), diagnostics: [], actions: [] };
    if (value("app-diagnostic-name") || value("app-diagnostic-url")) {
      if (!value("app-diagnostic-name") || !value("app-diagnostic-url")) throw new Error("Enter both diagnostic name and URL.");
      config.diagnostics.push({ name: value("app-diagnostic-name"), url: endpoint("app-diagnostic-url") });
    }
    if (value("app-action-name") || value("app-action-url") || value("app-action-description")) {
      if (!value("app-action-name") || !value("app-action-url") || !value("app-action-description")) throw new Error("Enter action name, description and URL.");
      config.actions.push({ name: value("app-action-name"), description: value("app-action-description"), url: endpoint("app-action-url"), auto_approve: !$("app-action-approval").checked });
    }
    config.diagnostics.push(...(state.editingApp?.diagnostics || []).slice(1));
    config.actions.push(...(state.editingApp?.actions || []).slice(1));
    return config;
  }

  function renderSystems(data) {
    const app = data.app || {};
    const monitoring = data.monitoring || {};
    const approval = data.policy?.require_approval;
    setText("recovery-mode", approval === true ? "Approval required" : approval === false ? "Automatic recovery" : "Policy unavailable");
    setText("recovery-description", approval === true ? "Review proposed recovery in Incidents." : approval === false ? "Permitted recovery runs automatically. Check evidence in Incidents." : "Recovery policy could not be read.");
    replaceRegion("system-metrics", [app.healthy, app.worker_running, app.recoveries, monitoring.enabled], () => [
      metric("Target health", boolLabel(app.healthy, "Healthy", "Unhealthy"), "Synthetic Reportroom", app.healthy === true ? "good" : app.healthy === false ? "bad" : ""),
      metric("Monitoring", boolLabel(monitoring.enabled, "Running", "Stopped"), "Recovery loop"),
      metric("Worker", boolLabel(app.worker_running, "Running", "Stopped"), "Report jobs"),
      metric("Recoveries", count(app.recoveries), "Recorded outcomes"),
    ]);
    replaceRegion("budget-summary", monitoring.budgets || [], () => {
      const budgets = monitoring.budgets || [];
      return budgets.length ? table(["Day", "Requests", "Reserved", "Actions"], budgets.map((b) => [b.day, count(b.requests), count(b.reserved), count(b.actions)])) : empty("No reservations", "Start monitoring to record activity.");
    });
    setText("limits", JSON.stringify(data.limits || {}, null, 2));
    replaceRegion("probe-list", monitoring.probes || [], () => {
      const probes = monitoring.probes || [];
      return probes.length ? table(["Observed at", "Health", "Status", "Duration"], probes.map((p) => [timestamp(p.at), badge(boolLabel(p.healthy, "Healthy", "Unhealthy"), p.healthy ? "good" : "bad"), p.status, p.duration_ms == null ? "—" : `${count(p.duration_ms)} ms`])) : empty("No probes", "Start monitoring to check target health.");
    });
  }

  function historyList(history) {
    const list = node("ol", null, "timeline");
    for (const entry of history) {
      const item = node("li");
      const header = node("div", null, "timeline-header");
      header.append(node("strong", entry.kind || entry.state || "Update"), node("time", timestamp(entry.at)));
      item.append(header, node("p", printable(entry.detail ?? entry.message)));
      list.append(item);
    }
    return list;
  }

  function createIncident(id) {
    const panel = node("article", null, "panel incident-panel");
    const heading = node("div", null, "panel-heading");
    const title = node("h2", "Recovery");
    const status = badge("Loading");
    heading.append(title, status);
    const incidentId = node("p", id, "incident-id");
    const pending = node("div");
    const disclosure = node("details");
    disclosure.open = true;
    disclosure.append(node("summary", "Evidence and action history"));
    const history = node("div");
    disclosure.append(history);
    panel.append(heading, incidentId, pending, disclosure);
    return { panel, title, status, pending, history, signature: undefined };
  }

  function renderIncidents(incidents) {
    const list = $("incident-list");
    const active = incidents.filter((i) => !["resolved", "closed", "recovered"].includes(i.state));
    setText("incident-count", active.length ? active.length : "");
    const ids = new Set(incidents.map((incident) => String(incident.id)));
    for (const [id, parts] of incidentPanels) {
      if (!ids.has(id)) { parts.panel.remove(); incidentPanels.delete(id); }
    }
    if (!incidents.length) {
      replaceRegion(list, [], () => empty("No incidents", "Select an app to inspect its recorded evidence."));
      return;
    }
    list.querySelector(".empty-state")?.remove();
    fingerprints.delete(list);
    for (const incident of incidents) {
      const id = String(incident.id);
      let parts = incidentPanels.get(id);
      if (!parts) { parts = createIncident(id); incidentPanels.set(id, parts); list.append(parts.panel); }
      parts.title.textContent = incident._appName || "Recovery";
      parts.status.textContent = incident.state || "Unknown";
      const canApprove = canControl() && (isOwner() || incident._kind === "example");
      const providerBlocked = incident._kind === "connected" && state.snapshot?.provider?.mode !== "anthropic";
      const signature = JSON.stringify([incident.pending_action, incident.state, canApprove, incident._appName, providerBlocked]);
      if (parts.signature !== signature) {
        parts.pending.replaceChildren();
        if (incident.pending_action) {
          const proposed = node("div", null, "pending-action");
          proposed.append(node("span", "Proposed action", "tiny-label"), node("pre", printable(incident.pending_action)));
          parts.pending.append(proposed);
          if (canApprove && incident.state === "awaiting_approval") {
            const form = node("form", null, "approval-form");
            const label = node("label", null, "checkbox-label");
            const consent = node("input");
            consent.type = "checkbox";
            consent.required = true;
            label.append(consent, node("span", `I approve this exact proposal for ${incident._appName || "this app"}.`));
            const approve = node("button", "Approve recovery", "button primary");
            approve.type = "submit";
            approve.dataset.approval = "1";
            approve.dataset.requiresApps = String(incident._kind === "connected");
            approve.disabled = state.busy || providerBlocked || (incident._kind === "connected" && !!state.appsError);
            form.append(label, approve);
            form.addEventListener("submit", (event) => {
              event.preventDefault();
              if (!canApprove || (incident._kind === "connected" && (state.appsError || state.snapshot?.provider?.mode !== "anthropic")) || !consent.checked) return;
              void mutate(`/api/incidents/${encodeURIComponent(id)}/approve`, {}, "Approved. Check the recorded outcome.");
            });
            parts.pending.append(form);
            if (providerBlocked) parts.pending.append(node("p", "External actions require Anthropic in Settings.", "fine-print"));
          } else if (!canApprove) {
            parts.pending.append(node("p", "Browser owner approval only. Guests can approve the example. Not bearer keys.", "fine-print"));
          } else {
            parts.pending.append(node("p", "Processing proposal.", "fine-print"));
          }
        } else {
          parts.pending.append(node("p", "No pending action.", "fine-print"));
        }
        parts.signature = signature;
      }
      replaceRegion(parts.history, incident.history || [], () => (incident.history || []).length ? historyList(incident.history) : empty("No evidence yet", "Waiting for investigation."));
    }
  }

  function renderAnalytics(analytics) {
    replaceRegion("analytics-metrics", [analytics.pageviews, analytics.events], () => [
      metric("Pageviews", count(analytics.pageviews), "Explicitly captured pageviews"),
      metric("Events", count(analytics.events), "Explicitly captured events"),
    ]);
    replaceRegion("analytics-series", analytics.series || [], () => {
      const series = analytics.series || [];
      if (!series.length) return empty("No activity", "Ingest events from your server. No sample traffic.");
      const max = Math.max(0, ...series.map((item) => Number(item.count) || 0));
      return series.map((item) => {
        const row = node("div", null, "series-row");
        const track = node("div", null, "series-track");
        track.setAttribute("aria-hidden", "true");
        const fill = node("div", null, "series-fill");
        const percent = max ? Math.min(100, Math.max(0, Number(item.count) / max * 100)) : 0;
        fill.style.width = `${Number.isFinite(percent) ? percent : 0}%`;
        track.append(fill);
        row.append(node("span", item.bucket, "series-label"), track, node("span", count(item.count), "series-count"));
        return row;
      });
    });
    for (const [id, field, header] of [["analytics-paths", "paths", "Path"], ["analytics-referrers", "referrers", "Referrer"]]) {
      const values = analytics[field] || [];
      replaceRegion(id, values, () => values.length ? table([header, "Count"], values.map((item) => [item.path ?? item.referrer ?? "(none)", count(item.count)])) : empty(`No ${field}`, "No captured records."));
    }
  }

  function renderLogs() {
    if (!state.snapshot) return;
    const logs = state.snapshot.logs || [];
    const query = $("log-search").value.trim().toLowerCase();
    const matches = logs.filter((entry) => [entry.message, entry.service, entry.level, entry.trace_id].some((value) => String(value ?? "").toLowerCase().includes(query)));
    setText("log-count", `${count(matches.length)} of ${count(logs.length)} loaded records${query ? " match this search" : ""}`);
    replaceRegion("log-list", [matches, query], () => {
      if (!matches.length) return empty(query ? "No matches" : "No logs", query ? "Try another search. Loaded records only." : "Ingest logs or run monitoring.");
      return table(["Time", "Level", "Service", "Message / trace"], matches.map((entry) => {
        const message = node("div", entry.message, "log-message");
        if (entry.trace_id) message.append(node("span", `trace / ${entry.trace_id}`, "trace-id"));
        return [timestamp(entry.at), badge(entry.level || "unknown", ["error", "fatal"].includes(entry.level) ? "bad" : ""), entry.service, message];
      }));
    });
  }

  function seedForm(id, fill) {
    if (dirtyForms.has(id) || $(id).contains(document.activeElement)) return;
    fill();
  }

  function renderStatus(status) {
    replaceRegion("status-summary", [status.published, status.slug, status.title], () => {
      const content = node("div");
      content.append(node("strong", status.published ? "Published" : "Not published"), node("p", status.title || "No status title configured."));
      if (status.published && status.slug) {
        const link = node("a", "Open public page");
        link.href = `/status/${encodeURIComponent(status.slug)}`;
        link.target = "_blank";
        link.rel = "noopener";
        content.append(link);
      } else content.append(node("p", "Publish to get a public link."));
      return content;
    });
    seedForm("status-form", () => {
      $("status-title-input").value = status.title || "";
      $("status-published").checked = status.published === true;
    });
    replaceRegion("status-updates", status.updates || [], () => (status.updates || []).length ? historyList(status.updates) : empty("No updates", "Owner-posted updates appear here."));
  }

  function renderKeys(keys) {
    replaceRegion("key-list", [keys, isOwner()], () => {
      if (!isOwner()) return empty("Owner-only", "Guests cannot manage bearer keys.");
      if (!keys.length) return empty("No keys", "Create a scoped key. Tokens are shown once.");
      return table(["Name / hash", "Scopes", "Created", "Expires", "State"], keys.map((key) => {
        const name = node("div", key.name);
        name.append(node("span", key.hash, "trace-id"));
        const action = node("div");
        if (key.revoked) action.append(badge("Revoked"));
        else {
          const button = node("button", "Revoke", "quiet-button danger-text");
          button.type = "button";
          button.dataset.revoke = "1";
          button.disabled = state.busy;
          button.addEventListener("click", () => {
            if (window.confirm(`Revoke “${key.name}”? Clients using this key will lose access.`)) void mutate("/api/keys/revoke", { hash: key.hash }, "Key revoked.");
          });
          action.append(button);
        }
        return [name, (key.scopes || []).join(", "), timestamp(key.created_at), key.expires ? timestamp(key.expires) : "No expiry", action];
      }));
    });
  }

  function renderSettings(data) {
    const session = state.session;
    seedForm("policy-form", () => { $("require-approval").checked = data.policy?.require_approval === true; });
    setText("session-summary", `Tenant: ${session.tenant_id} · Role: ${session.role} · Session: ${session.kind} · Scopes: ${(session.scopes || []).join(", ") || "none reported"}`);
    setText("provider-summary", `Current provider: ${data.provider?.mode || "unknown"} · Model: ${data.provider?.model || "not reported"}`);
    seedForm("provider-form", () => { $("provider-mode").value = data.provider?.mode === "anthropic" ? "anthropic" : "fixture"; });
    renderKeys(data.keys || []);
  }

  function updateControls() {
    const unavailable = state.busy || !state.snapshot;
    const appsUnavailable = unavailable || !state.apps || !!state.appsError;
    $("connect-app").disabled = appsUnavailable || !isOwner();
    $("app-form-controls").disabled = appsUnavailable || !isOwner();
    $("app-editor").hidden = !isOwner();
    $("app-edit").disabled = appsUnavailable || !isOwner() || selectedApp()?.kind !== "connected" || !state.appDetail;
    $("app-start").disabled = appsUnavailable || !canOperateApp() || !state.appDetail || state.appsEnabled === true;
    $("app-stop").disabled = appsUnavailable || !canOperateApp() || !state.appDetail || state.appsEnabled === false;
    $("app-event").disabled = appsUnavailable || !canOperateApp() || !state.appDetail || (selectedApp()?.kind === "connected" && state.snapshot?.provider?.mode !== "anthropic");
    for (const button of document.querySelectorAll("[data-select-app]")) button.disabled = state.busy;
    for (const button of document.querySelectorAll("[data-action]")) {
      const enabled = state.snapshot?.monitoring?.enabled;
      button.disabled = unavailable || !canControl() || (button.dataset.action === "start" && enabled === true) || (button.dataset.action === "stop" && enabled === false);
    }
    for (const fieldset of document.querySelectorAll(".owner-only")) fieldset.disabled = unavailable || !isOwner();
    $("policy-controls").disabled = unavailable || !canControl() || typeof state.snapshot?.policy?.require_approval !== "boolean";
    for (const button of document.querySelectorAll("[data-approval]")) button.disabled = unavailable || !canControl() || (button.dataset.requiresApps === "true" && (!!state.appsError || state.snapshot?.provider?.mode !== "anthropic"));
    for (const button of document.querySelectorAll("[data-revoke]")) button.disabled = unavailable || !isOwner();
    $("export-data").disabled = unavailable;
    $("logout").disabled = state.busy;
    for (const message of document.querySelectorAll(".guest-restriction")) message.hidden = !isGuest();
  }

  function render(data) {
    setText("tenant-name", data.tenant?.name || data.tenant?.id || state.session.tenant_id);
    setText("session-kind", isGuest() ? "Isolated guest" : `${state.session.role} / ${state.session.kind}`);
    renderSystems(data);
    renderApps();
    const incidents = new Map((data.monitoring?.incidents || []).map((incident) => [String(incident.id), { ...incident, _appName: "Reportroom example", _kind: "example" }]));
    for (const incident of state.appDetail?.monitoring?.incidents || []) incidents.set(String(incident.id), { ...incident, _appName: selectedApp()?.name || state.selectedApp, _kind: selectedApp()?.kind });
    setText("incident-context", selectedApp() ? `${selectedApp().name} and Reportroom example. Select another app in Apps.` : "Reportroom example. Select an app to inspect its evidence.");
    renderIncidents([...incidents.values()]);
    renderAnalytics(data.analytics || {});
    renderLogs();
    renderStatus(data.status || {});
    renderSettings(data);
    updateControls();
  }

  function schedulePoll() {
    clearTimeout(state.poll);
    if (state.session && !state.busy && !document.hidden) state.poll = setTimeout(() => { void refresh(); }, 3000);
  }

  async function refresh() {
    if (!state.session || state.busy || document.hidden) return;
    if (state.reading) return state.reading.promise;
    const generation = state.generation;
    const controller = new AbortController();
    const request = { controller, promise: null };
    state.reading = request;
    const timeout = setTimeout(() => controller.abort(), 20000);
    request.promise = (async () => {
      $("refresh").disabled = true;
      try {
        const [data, appsResult] = await Promise.all([
          api("/api/overview", undefined, controller.signal),
          api("/api/apps", undefined, controller.signal).then((value) => ({ value }), (error) => ({ error })),
        ]);
        if (generation !== state.generation || !state.session) return;
        state.snapshot = data;
        state.appsError = "";
        if (appsResult.error) {
          if (appsResult.error.status === 401) throw appsResult.error;
          state.appsError = `Apps unavailable. ${appsResult.error.message} Refresh before taking action.`;
        } else {
          state.apps = appsResult.value.apps;
          state.appsEnabled = appsResult.value.enabled;
          if (!state.apps.some((app) => app.id === state.selectedApp)) {
            state.selectedApp = (state.apps.find((app) => app.kind === "connected") || state.apps[0])?.id || null;
            state.appDetail = null;
          }
          if (state.selectedApp) {
            try {
              const detail = await api(`/api/apps/${encodeURIComponent(state.selectedApp)}`, undefined, controller.signal);
              if (generation !== state.generation || !state.session) return;
              state.appDetail = detail;
            } catch (error) {
              if (generation !== state.generation) return;
              if (error.status === 401) throw error;
              state.appsError = `App details unavailable. ${error.message} Refresh before taking action.`;
            }
          }
        }
        $("snapshot-error").hidden = true;
        setText("snapshot-state", `Updated ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
        render(data);
      } catch (error) {
        if (generation !== state.generation) return;
        if (error.status === 401) {
          clearSession("Your session expired. Sign in again or open a new guest workspace.");
          return;
        }
        if (error.name === "AbortError" && document.hidden) return;
        setText("snapshot-state", state.snapshot ? "Snapshot stale · retrying" : "Snapshot unavailable");
        setText("snapshot-error", `${error.name === "AbortError" ? "Snapshot request timed out." : error.message} ${state.snapshot ? "Showing the last successful snapshot." : "No data has been loaded. Controls remain disabled."}`);
        $("snapshot-error").hidden = false;
        state.appsError = "Snapshot unavailable. Refresh before taking app actions.";
        renderApps();
        updateControls();
      } finally {
        clearTimeout(timeout);
        if (state.reading === request) state.reading = null;
        $("refresh").disabled = false;
        schedulePoll();
      }
    })();
    return request.promise;
  }

  function discardRead() {
    clearTimeout(state.poll);
    state.reading?.controller.abort();
    state.reading = null;
  }

  async function mutate(path, body, message, onSuccess) {
    if (state.busy || !state.session) return;
    state.busy = true;
    state.generation += 1;
    discardRead();
    updateControls();
    setText("snapshot-state", "Action in progress…");
    notify("Request in progress. Actions are not retried automatically.");
    const generation = state.generation;
    try {
      const result = await api(path, body);
      if (generation !== state.generation) return;
      if (onSuccess) onSuccess(result);
      notify(message);
    } catch (error) {
      if (error.status === 401) clearSession("Your session expired. Sign in again.");
      notify(error.message, true);
    } finally {
      state.busy = false;
      updateControls();
      await refresh();
    }
  }

  function switchView() {
    const hash = location.hash.slice(1);
    const view = views.includes(hash) ? hash : "apps";
    for (const name of views) $("view-" + name).hidden = name !== view;
    for (const link of document.querySelectorAll("[data-view]")) {
      if (link.dataset.view === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    const label = view === "systems" ? "Example" : view[0].toUpperCase() + view.slice(1);
    setText("current-view", label);
    document.title = `${label} | Roundhouse`;
  }

  function clearKey() {
    $("new-key").value = "";
    $("new-key-box").hidden = true;
  }

  function clearSession(message = "Sign in, use your invite, or try an isolated guest workspace.") {
    state.generation += 1;
    discardRead();
    state.session = null;
    state.snapshot = null;
    state.apps = null;
    state.appsEnabled = null;
    state.appsError = "";
    state.selectedApp = null;
    state.appDetail = null;
    resetAppForm();
    state.busy = false;
    clearKey();
    $("workspace").hidden = true;
    $("auth-screen").hidden = false;
    document.querySelector(".skip-link").href = "#auth-form";
    setText("auth-message", message);
    $("auth-message").classList.remove("is-error");
    updateControls();
  }

  function authControls(busy) {
    state.authBusy = busy;
    for (const control of $("auth-screen").querySelectorAll("button, input")) control.disabled = busy;
  }

  async function openWorkspace() {
    const session = await api("/api/auth/me");
    state.generation += 1;
    discardRead();
    state.session = session;
    state.snapshot = null;
    state.apps = null;
    state.appsEnabled = null;
    state.appsError = "";
    state.selectedApp = null;
    state.appDetail = null;
    resetAppForm();
    $("app-editor").open = false;
    $("app-detail").hidden = true;
    $("app-list").replaceChildren(empty("Loading…", "Reading apps."));
    fingerprints.delete($("app-list"));
    dirtyForms.clear();
    incidentPanels.clear();
    $("incident-list").replaceChildren();
    for (const form of document.querySelectorAll("#workspace form")) form.reset();
    clearKey();
    $("auth-screen").hidden = true;
    $("workspace").hidden = false;
    document.querySelector(".skip-link").href = "#main";
    setText("snapshot-state", "Loading snapshot…");
    $("snapshot-error").hidden = true;
    for (const id of ["system-metrics", "budget-summary", "probe-list", "analytics-metrics", "analytics-series", "analytics-paths", "analytics-referrers", "log-list", "status-summary", "status-updates", "key-list"]) {
      $(id).replaceChildren(empty("Loading…", "Reading snapshot."));
      fingerprints.delete($(id));
    }
    setText("tenant-name", session.tenant_id);
    setText("session-kind", isGuest() ? "Isolated guest" : session.role);
    setText("limits", "Loading…");
    setText("provider-summary", "Loading provider configuration…");
    updateControls();
    switchView();
    await refresh();
  }

  function registrationMode(registering) {
    state.registering = registering;
    $("login-tab").setAttribute("aria-pressed", String(!registering));
    $("register-tab").setAttribute("aria-pressed", String(registering));
    $("invite-field").hidden = !registering;
    $("invite").required = registering;
    $("password").autocomplete = registering ? "new-password" : "current-password";
    setText("auth-title", registering ? "Create account" : "Sign in");
    setText("auth-submit", registering ? "Create account" : "Sign in");
  }

  async function authenticate(kind, body) {
    if (state.authBusy) return;
    authControls(true);
    setText("auth-message", kind === "guest" ? "Creating your isolated workspace…" : "Authenticating…");
    $("auth-message").classList.remove("is-error");
    try {
      await api(`/api/auth/${kind}`, body);
      $("password").value = "";
      $("invite").value = "";
      const url = new URL(location.href);
      url.searchParams.delete("guest");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
      await openWorkspace();
    } catch (error) {
      setText("auth-message", error.message);
      $("auth-message").classList.add("is-error");
    } finally { authControls(false); }
  }

  $("connect-app").addEventListener("click", () => { if (!state.busy && state.apps && !state.appsError) editApp(null); });
  $("app-edit").addEventListener("click", () => { if (!state.busy && !state.appsError) editApp({ ...selectedApp(), ...state.appDetail?.app }); });
  $("app-cancel").addEventListener("click", () => {
    if (state.busy) return;
    if (dirtyForms.has("app-form") && !window.confirm("Discard unsaved app changes?")) return;
    resetAppForm();
    $("app-editor").open = false;
    $("connect-app").focus();
  });
  $("app-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isOwner() || !state.apps || state.appsError || state.editingApp?.kind === "example") return;
    let config;
    try { config = appConfigFromForm(); }
    catch (error) { notify(error.message, true); return; }
    const path = state.editingApp ? `/api/apps/${encodeURIComponent(state.editingApp.id)}/config` : "/api/apps";
    void mutate(path, config, "App configuration saved.", () => {
      state.selectedApp = config.id;
      state.appDetail = null;
      resetAppForm();
      $("app-editor").open = false;
    });
  });
  for (const [id, operation, message] of [["app-start", "start", "Tenant scheduler started."], ["app-stop", "stop", "Tenant scheduler stopped."], ["app-event", "events", "Investigation requested. Check incident evidence."]]) {
    $(id).addEventListener("click", () => {
      if (!canOperateApp() || !state.appDetail || state.appsError) return;
      if (operation === "events" && selectedApp()?.kind === "connected" && state.snapshot?.provider?.mode !== "anthropic") return;
      void mutate(`/api/apps/${encodeURIComponent(state.selectedApp)}/${operation}`, {}, message);
    });
  }

  $("login-tab").addEventListener("click", () => registrationMode(false));
  $("register-tab").addEventListener("click", () => registrationMode(true));
  $("guest-login").addEventListener("click", () => { void authenticate("guest", {}); });
  $("auth-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const body = { email: $("email").value.trim(), password: $("password").value };
    if (state.registering) body.invite = $("invite").value.trim();
    void authenticate(state.registering ? "register" : "login", body);
  });
  $("logout").addEventListener("click", async () => {
    if (state.busy) return;
    state.busy = true;
    updateControls();
    try {
      await api("/api/auth/logout", {});
      clearSession("Signed out. Your browser session has ended.");
      $("email").focus();
    } catch (error) { notify(error.message, true); }
    finally { state.busy = false; updateControls(); }
  });
  $("refresh").addEventListener("click", () => { void refresh(); });
  window.addEventListener("hashchange", switchView);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) discardRead();
    else void refresh();
  });
  $("log-search").addEventListener("input", renderLogs);
  for (const form of document.querySelectorAll("#workspace form")) {
    form.addEventListener("input", () => dirtyForms.add(form.id));
    form.addEventListener("change", () => dirtyForms.add(form.id));
  }
  for (const button of document.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => {
      if (!canControl()) return;
      const action = button.dataset.action;
      const routes = { start: "/api/monitor/start", stop: "/api/monitor/stop", investigate: "/api/monitor/investigate", fault: "/api/demo/fault", reset: "/api/demo/reset" };
      const messages = { start: "Monitoring started.", stop: "Monitoring stopped.", investigate: "Investigation complete. Check Incidents.", fault: "Fault introduced. Monitor or investigate.", reset: "Target reset. Check health and history." };
      if (action === "fault" && !window.confirm("Introduce a fault in synthetic Reportroom? No customer system is affected.")) return;
      if (action === "reset" && !window.confirm("Reset synthetic Reportroom directly? This bypasses agent recovery.")) return;
      void mutate(routes[action], {}, messages[action]);
    });
  }
  $("status-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isOwner()) return;
    const title = $("status-title-input").value.trim();
    if (!title) { notify("Enter a status page title.", true); return; }
    void mutate("/api/status", { published: $("status-published").checked, title }, "Publication settings saved.", () => { dirtyForms.delete("status-form"); });
  });
  $("status-update-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isOwner()) return;
    const message = $("update-message").value.trim();
    if (!message) { notify("Enter a status update message.", true); return; }
    void mutate("/api/status/updates", { message, state: $("update-state").value }, "Status update posted.", () => { $("status-update-form").reset(); dirtyForms.delete("status-update-form"); });
  });
  $("key-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isOwner()) return;
    if (!$("new-key-box").hidden) { notify("Save and dismiss the previous token before creating another key.", true); return; }
    const name = $("key-name").value.trim();
    const scopes = [...$("key-form").querySelectorAll("input[name='scope']:checked")].map((input) => input.value);
    if (!name || !scopes.length) { notify("Enter a key name and choose at least one scope.", true); return; }
    void mutate("/api/keys", { name, scopes }, "Key created. Copy and save the token now.", (result) => {
      if (typeof result.token !== "string" || !result.token) throw new Error("The key was created but no token was returned. Revoke it and create a replacement; do not assume it is usable.");
      $("new-key").value = result.token;
      $("new-key-box").hidden = false;
      $("new-key").focus();
      $("new-key").select();
      $("key-form").reset();
      dirtyForms.delete("key-form");
    });
  });
  $("copy-key").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("new-key").value); notify("Token copied. Store it as a server-side secret."); }
    catch { $("new-key").focus(); $("new-key").select(); notify("Clipboard unavailable. Copy the selected token manually.", true); }
  });
  $("dismiss-key").addEventListener("click", clearKey);
  window.addEventListener("pagehide", clearKey);
  $("provider-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isOwner()) return;
    const mode = $("provider-mode").value;
    if (mode === "anthropic" && !$("provider-consent").checked) { notify("Acknowledge live provider costs before enabling Anthropic.", true); $("provider-consent").focus(); return; }
    void mutate("/api/provider", { mode }, "Provider mode saved.", () => { dirtyForms.delete("provider-form"); $("provider-consent").checked = false; });
  });
  $("policy-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!canControl() || typeof state.snapshot?.policy?.require_approval !== "boolean") return;
    void mutate("/api/policy", { require_approval: $("require-approval").checked }, "Recovery policy saved.", () => { dirtyForms.delete("policy-form"); });
  });
  $("export-data").addEventListener("click", async () => {
    if (state.busy || !state.session) return;
    const generation = state.generation;
    $("export-data").disabled = true;
    try {
      const data = await api("/api/export");
      if (generation !== state.generation) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = node("a");
      link.href = url;
      link.download = "roundhouse-export.json";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Tenant JSON export downloaded.");
    } catch (error) { notify(error.message, true); }
    finally { updateControls(); }
  });

  setText("mcp-snippet", `Endpoint: ${location.origin}/mcp\nAuthorization: Bearer YOUR_SCOPED_KEY`);
  setText("ingest-snippet", `// Server-side only. ROUNDHOUSE_INGEST_KEY is a secret environment variable.\n// Reuse the same event id when retrying the same event.\nconst event = {\n  id: crypto.randomUUID(), kind: "pageview",\n  name: "pageview", path: "/your-page"\n};\nconst response = await fetch("${location.origin}/api/ingest", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",\n    "x-roundhouse": "1",\n    "Authorization": "Bearer " + env.ROUNDHOUSE_INGEST_KEY\n  },\n  body: JSON.stringify({ events: [event] })\n});\nif (!response.ok) throw new Error("Roundhouse ingest rejected the event");`);
  switchView();
  updateControls();
  authControls(true);
  void (async () => {
    try { await openWorkspace(); }
    catch (error) {
      if (error.status === 401) {
        clearSession();
        authControls(false);
        if (new URLSearchParams(location.search).get("guest") === "1") await authenticate("guest", {});
      } else {
        clearSession(error.message);
        $("auth-message").classList.add("is-error");
      }
    } finally { authControls(false); }
  })();
})();

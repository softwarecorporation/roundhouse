"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const views = ["systems", "incidents", "analytics", "logs", "status", "settings"];
  const state = { session: null, snapshot: null, generation: 0, busy: false, authBusy: false, registering: false, poll: null, reading: null };
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

  function renderSystems(data) {
    const app = data.app || {};
    const monitoring = data.monitoring || {};
    replaceRegion("system-metrics", [app.healthy, app.worker_running, app.recoveries, monitoring.enabled], () => [
      metric("Target health", boolLabel(app.healthy, "Healthy", "Unhealthy"), "Latest synthetic target state", app.healthy === true ? "good" : app.healthy === false ? "bad" : ""),
      metric("Monitoring", boolLabel(monitoring.enabled, "Running", "Stopped"), "Investigation control loop"),
      metric("Target worker", boolLabel(app.worker_running, "Running", "Stopped"), "Reportroom job worker"),
      metric("Recoveries", count(app.recoveries), "Recorded by this environment"),
    ]);
    replaceRegion("budget-summary", monitoring.budgets, () => {
      const budgets = monitoring.budgets || [];
      return budgets.length ? table(["Day", "Requests", "Reserved", "Actions"], budgets.map((b) => [b.day, count(b.requests), count(b.reserved), count(b.actions)])) : empty("No reservations yet", "Monitoring activity will appear here when the server records a budget.");
    });
    setText("limits", JSON.stringify(data.limits || {}, null, 2));
    replaceRegion("probe-list", monitoring.probes, () => {
      const probes = monitoring.probes || [];
      return probes.length ? table(["Observed at", "Health", "Status", "Duration"], probes.map((p) => [timestamp(p.at), badge(boolLabel(p.healthy, "Healthy", "Unhealthy"), p.healthy ? "good" : "bad"), p.status, p.duration_ms == null ? "—" : `${count(p.duration_ms)} ms`])) : empty("No health probes yet", "Start monitoring to collect actual health evidence from the synthetic target.");
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
    const title = node("h2", "Recovery investigation");
    const status = badge("Loading");
    heading.append(title, status);
    const incidentId = node("p", `INCIDENT / ${id}`, "incident-id");
    const pending = node("div");
    const disclosure = node("details");
    disclosure.open = true;
    disclosure.append(node("summary", "Evidence and action history"));
    const history = node("div");
    disclosure.append(history);
    panel.append(heading, incidentId, pending, disclosure);
    return { panel, status, pending, history, signature: undefined };
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
      replaceRegion(list, [], () => empty("No incidents recorded", "Introduce a synthetic fault from Systems, then investigate to inspect a real recovery proposal."));
      return;
    }
    list.querySelector(".empty-state")?.remove();
    fingerprints.delete(list);
    for (const incident of incidents) {
      const id = String(incident.id);
      let parts = incidentPanels.get(id);
      if (!parts) { parts = createIncident(id); incidentPanels.set(id, parts); list.append(parts.panel); }
      parts.status.textContent = incident.state || "Unknown";
      const signature = JSON.stringify([incident.pending_action, incident.state, canControl()]);
      if (parts.signature !== signature) {
        parts.pending.replaceChildren();
        if (incident.pending_action) {
          const proposed = node("div", null, "pending-action");
          proposed.append(node("span", "PROPOSED ACTION / NOT YET APPROVED", "tiny-label"), node("pre", printable(incident.pending_action)));
          parts.pending.append(proposed);
          if (canControl() && incident.state === "awaiting_approval") {
            const form = node("form", null, "approval-form");
            const label = node("label", null, "checkbox-label");
            const consent = node("input");
            consent.type = "checkbox";
            consent.required = true;
            label.append(consent, node("span", "I reviewed this proposal and approve executing it against the isolated synthetic target."));
            const approve = node("button", "Approve proposed recovery →", "button primary");
            approve.type = "submit";
            approve.dataset.approval = "1";
            approve.disabled = state.busy;
            form.append(label, approve);
            form.addEventListener("submit", (event) => {
              event.preventDefault();
              if (!canControl() || !consent.checked) return;
              void mutate(`/api/incidents/${encodeURIComponent(id)}/approve`, {}, "Approval submitted. Inspect the incident history for the execution result.");
            });
            parts.pending.append(form);
          } else if (!canControl()) {
            parts.pending.append(node("p", "Only a browser owner or the isolated guest can approve. Bearer keys cannot approve recovery.", "fine-print"));
          } else {
            parts.pending.append(node("p", "The investigation is still processing this proposal. Approval becomes available when it is awaiting approval.", "fine-print"));
          }
        } else {
          parts.pending.append(node("p", "No action is awaiting approval for this incident.", "fine-print"));
        }
        parts.signature = signature;
      }
      replaceRegion(parts.history, incident.history || [], () => (incident.history || []).length ? historyList(incident.history) : empty("No history yet", "Investigation evidence will appear when it is recorded."));
    }
  }

  function renderAnalytics(analytics) {
    replaceRegion("analytics-metrics", [analytics.pageviews, analytics.events], () => [
      metric("Pageviews", count(analytics.pageviews), "Explicitly captured pageviews"),
      metric("Events", count(analytics.events), "Explicitly captured events"),
    ]);
    replaceRegion("analytics-series", analytics.series || [], () => {
      const series = analytics.series || [];
      if (!series.length) return empty("No captured activity yet", "Send events through the server API using an ingest-scoped key. The console does not generate sample traffic.");
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
      replaceRegion(id, values, () => values.length ? table([header, "Count"], values.map((item) => [item.path ?? item.referrer ?? "(none)", count(item.count)])) : empty(`No ${field} recorded`, "Only captured records are shown. Nothing is inferred or seeded."));
    }
  }

  function renderLogs() {
    if (!state.snapshot) return;
    const logs = state.snapshot.logs || [];
    const query = $("log-search").value.trim().toLowerCase();
    const matches = logs.filter((entry) => [entry.message, entry.service, entry.level, entry.trace_id].some((value) => String(value ?? "").toLowerCase().includes(query)));
    setText("log-count", `${count(matches.length)} of ${count(logs.length)} loaded records${query ? " match this search" : ""}`);
    replaceRegion("log-list", [matches, query], () => {
      if (!matches.length) return empty(query ? "No matching records" : "No logs captured yet", query ? "Try a different message, service, level, or trace ID. Search is local to this snapshot." : "Ingest tenant logs or run the synthetic control loop to generate actual evidence.");
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
        const link = node("a", "Open public status page ↗");
        link.href = `/status/${encodeURIComponent(status.slug)}`;
        link.target = "_blank";
        link.rel = "noopener";
        content.append(link);
      } else content.append(node("p", "A public link is available only after the owner publishes the page."));
      return content;
    });
    seedForm("status-form", () => {
      $("status-title-input").value = status.title || "";
      $("status-published").checked = status.published === true;
    });
    replaceRegion("status-updates", status.updates || [], () => (status.updates || []).length ? historyList(status.updates) : empty("No status updates", "Updates are written explicitly by the owner; monitoring does not invent public messages."));
  }

  function renderKeys(keys) {
    replaceRegion("key-list", [keys, isOwner()], () => {
      if (!isOwner()) return empty("Key management is owner-only", "Guest sessions cannot create, inspect, or revoke bearer keys.");
      if (!keys.length) return empty("No keys issued", "Create a narrowly scoped key for your server or MCP client. Its token is shown only once.");
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
    setText("session-summary", `Tenant: ${session.tenant_id} · Role: ${session.role} · Session: ${session.kind} · Scopes: ${(session.scopes || []).join(", ") || "none reported"}`);
    setText("provider-summary", `Current provider: ${data.provider?.mode || "unknown"} · Model: ${data.provider?.model || "not reported"}`);
    seedForm("provider-form", () => { $("provider-mode").value = data.provider?.mode === "anthropic" ? "anthropic" : "fixture"; });
    renderKeys(data.keys || []);
  }

  function updateControls() {
    const unavailable = state.busy || !state.snapshot;
    for (const button of document.querySelectorAll("[data-action]")) {
      const enabled = state.snapshot?.monitoring?.enabled;
      button.disabled = unavailable || !canControl() || (button.dataset.action === "start" && enabled === true) || (button.dataset.action === "stop" && enabled === false);
    }
    for (const fieldset of document.querySelectorAll(".owner-only")) fieldset.disabled = unavailable || !isOwner();
    for (const button of document.querySelectorAll("[data-approval]")) button.disabled = unavailable || !canControl();
    for (const button of document.querySelectorAll("[data-revoke]")) button.disabled = unavailable || !isOwner();
    $("export-data").disabled = unavailable;
    $("logout").disabled = state.busy;
    for (const message of document.querySelectorAll(".guest-restriction")) message.hidden = !isGuest();
  }

  function render(data) {
    setText("tenant-name", data.tenant?.name || data.tenant?.id || state.session.tenant_id);
    setText("session-kind", isGuest() ? "ISOLATED GUEST" : `${state.session.role} / ${state.session.kind}`);
    renderSystems(data);
    renderIncidents(data.monitoring?.incidents || []);
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
        const data = await api("/api/overview", undefined, controller.signal);
        if (generation !== state.generation || !state.session) return;
        state.snapshot = data;
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
    const view = views.includes(hash) ? hash : "systems";
    for (const name of views) $("view-" + name).hidden = name !== view;
    for (const link of document.querySelectorAll("[data-view]")) {
      if (link.dataset.view === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    setText("current-view", view[0].toUpperCase() + view.slice(1));
    document.title = `${view[0].toUpperCase() + view.slice(1)} — Roundhouse`;
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
      $(id).replaceChildren(empty("Loading…", "Reading the authenticated tenant snapshot."));
      fingerprints.delete($(id));
    }
    setText("tenant-name", session.tenant_id);
    setText("session-kind", isGuest() ? "ISOLATED GUEST" : session.role);
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
    setText("auth-title", registering ? "Make it your workspace." : "Welcome back.");
    setText("auth-submit", registering ? "Create invited account →" : "Sign in →");
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
      const messages = { start: "Monitoring started.", stop: "Monitoring stopped.", investigate: "Investigation request completed. Review the recorded incident evidence.", fault: "Synthetic fault introduced. Start monitoring or investigate to inspect it.", reset: "Synthetic target reset. Review current health and incident history." };
      if (action === "fault" && !window.confirm("Introduce a fault in your isolated synthetic Reportroom? No customer system is affected.")) return;
      if (action === "reset" && !window.confirm("Reset your synthetic Reportroom target? This is a direct demo control, not an agent recovery approval.")) return;
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

  setText("mcp-snippet", `Endpoint: ${location.origin}/mcp\nAuthorization: Bearer YOUR_SCOPED_KEY\n\nConfigure these in your MCP client's remote-server settings.\nKeep the bearer token secret. Use read scope unless more is needed.`);
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

"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let pending = false;
  let connected = false;
  let activeId = null;
  let successMessage = "";
  const terminal = new Set(["resolved"]);
  const money = (cents) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format((Number(cents) || 0) / 100);
  const number = (n) => new Intl.NumberFormat("en-US").format(Number(n) || 0);
  const words = (value) => String(value || "unknown").replaceAll("_", " ");
  const date = (value) => {
    if (value == null || value === "") return null;
    const result = new Date(
      typeof value === "number" && value < 1e12 ? value * 1000 : value,
    );
    return Number.isNaN(result.getTime()) ? null : result;
  };
  const time = (value) =>
    date(value)?.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) || "—";
  const stamp = (value) =>
    date(value)?.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }) || "—";
  function text(id, value) {
    const node = typeof id === "string" ? $(id) : id;
    const next = String(value ?? "");
    if (node.textContent !== next) node.textContent = next;
  }
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) text(node, value);
    return node;
  }
  // Reconcile by identity, keeping focused links and open disclosures intact on polls.
  function reconcile(parent, items, key, create, update) {
    const existing = new Map(
      Array.from(parent.children, (node) => [node.dataset.key, node]),
    );
    items.forEach((item, index) => {
      const id = String(key(item, index));
      const node = existing.get(id) || create(item);
      node.dataset.key = id;
      update(node, item);
      if (parent.children[index] !== node)
        parent.insertBefore(node, parent.children[index] || null);
      existing.delete(id);
    });
    for (const node of existing.values()) node.remove();
  }
  function badge(node, value, tone) {
    text(node, value);
    node.className = `badge ${tone}`;
  }
  function detailsValue(value) {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
  function detailText(value) {
    const parsed = detailsValue(value);
    if (parsed == null) return "";
    if (typeof parsed === "string") return parsed;
    if (parsed.text) return String(parsed.text);
    if (typeof parsed.healthy === "boolean")
      return `Independent verification: ${parsed.healthy ? "healthy" : "unhealthy"}${parsed.status != null ? ` · status ${parsed.status}` : ""}`;
    if (parsed.health)
      return `Inspected queue and ${parsed.telemetry?.length || 0} events · health ${parsed.health.status ?? "unavailable"}`;
    if (parsed.action) return `Action: ${parsed.action}`;
    if (parsed.outcome) return `HTTP action outcome: ${parsed.outcome}`;
    return JSON.stringify(parsed, null, 2);
  }
  function renderTimeline(parent, history) {
    reconcile(
      parent,
      history || [],
      (entry, i) => `${i}:${entry.kind}:${entry.at}`,
      () => {
        const li = element("li");
        li.append(element("time"), element("strong"), element("p"));
        const evidence = element("details");
        evidence.append(element("summary", "", "Raw evidence"), element("pre"));
        li.append(evidence);
        return li;
      },
      (li, entry) => {
        text(li.children[0], time(entry.at));
        const d = date(entry.at);
        if (d) li.children[0].dateTime = d.toISOString();
        text(li.children[1], words(entry.kind));
        text(li.children[2], detailText(entry.detail));
        li.children[3].hidden = entry.kind !== "inspection";
        text(li.children[3].children[1], JSON.stringify(detailsValue(entry.detail), null, 2));
      },
    );
  }
  function currentIncident() {
    const incidents = state?.monitoring?.incidents || [];
    return (
      incidents.find((incident) => !terminal.has(incident.state)) ||
      incidents[0] ||
      null
    );
  }
  function failureActive() {
    if (!state) return false;
    const app = state.app;
    const incident = currentIncident();
    return (
      !app.healthy ||
      !app.worker_running ||
      app.recovering ||
      Boolean(incident && !terminal.has(incident.state))
    );
  }
  function updateControls() {
    const locked = pending || !connected || !state;
    const failure = failureActive();
    $("create-report").disabled = locked || failure;
    document.querySelectorAll('input[name="period"]').forEach((input) => {
      input.disabled = locked || failure;
    });
    $("fault").disabled =
      locked || failure || !state?.capabilities?.fault_allowed;
    $("reset").disabled =
      locked || !state?.capabilities?.reset_allowed;
    $("confirm-reset").disabled =
      locked || !state?.capabilities?.reset_allowed;
    const incident = currentIncident();
    $("approve").disabled = locked || incident?.state !== "awaiting_approval";
  }
  function renderJobs(jobs) {
    const sorted = [...jobs].sort(
      (a, b) =>
        (date(b.created_at)?.getTime() || 0) -
        (date(a.created_at)?.getTime() || 0),
    );
    text("job-count", jobs.length);
    $("jobs-empty").hidden = jobs.length > 0;
    text($("jobs-empty").querySelector("h3"), "Your first report starts here");
    text(
      $("jobs-empty").querySelector("p"),
      "Choose a period above and create a sales export.",
    );
    reconcile(
      $("jobs"),
      sorted,
      (job) => job.id,
      () => {
        const tr = element("tr");
        const report = element("td");
        report.append(
          element("span", "report-name"),
          element("span", "cell-secondary"),
        );
        const status = element("td");
        status.append(
          element("span", "badge"),
          element("span", "cell-secondary"),
        );
        const totals = element("td");
        totals.append(element("span"), element("span", "cell-secondary"));
        const output = element("td");
        const link = element("a", "download", "Download CSV ↗");
        const digest = element("details", "digest");
        digest.append(element("summary", "", "SHA-256"), element("code"));
        output.append(link, element("span", "cell-secondary"), digest);
        tr.append(report, status, totals, output);
        return tr;
      },
      (tr, job) => {
        const [report, status, totals, output] = tr.children;
        text(report.children[0], `${job.period}-day sales report`);
        text(report.children[1], stamp(job.created_at));
        report.children[1].title = String(job.id);
        badge(
          status.children[0],
          words(job.state),
          job.state === "completed"
            ? "good"
            : job.state === "failed"
              ? "bad"
              : "warn",
        );
        text(
          status.children[1],
          job.state === "completed"
            ? stamp(job.completed_at)
            : job.state === "queued"
              ? "Waiting for worker"
              : "Export failed",
        );
        text(
          totals.children[0],
          job.order_count == null ? "—" : `${number(job.order_count)} orders`,
        );
        text(
          totals.children[1],
          job.revenue_cents == null ? "—" : money(job.revenue_cents),
        );
        const ready = job.state === "completed";
        output.children[0].hidden = !ready;
        if (ready) {
          output.children[0].href = `/api/reports/${encodeURIComponent(job.id)}.csv`;
          output.children[0].setAttribute(
            "aria-label",
            `Download ${job.period}-day report created ${stamp(job.created_at)}`,
          );
        }
        text(
          output.children[1],
          ready ? `${number(job.rows)} rows` : "Not available yet",
        );
        output.children[2].hidden = !ready || !job.sha256;
        text(output.children[2].children[1], job.sha256 || "");
      },
    );
  }
  function renderIncidents(incidents) {
    const incident = currentIncident();
    activeId = incident?.id || null;
    const history = incident?.history || [];
    const kinds = new Set(history.map((entry) => entry.kind));
    badge(
      $("incident-state"),
      incident ? words(incident.state) : "Standby",
      incident?.state === "awaiting_approval"
        ? "warn"
        : incident?.state === "resolved"
          ? "good"
          : "neutral",
    );
    text(
      "incident-summary",
      incident
        ? `Incident ${incident.id} · ${stamp(incident.created_at)}`
        : "No active incident. Run a drill to follow the recovery workflow.",
    );
    const verified = history.some(
      (entry) =>
        entry.kind === "verification" &&
        detailsValue(entry.detail)?.healthy === true,
    );
    if (verified && $("operation").textContent.startsWith("Approval accepted."))
      text("operation", "Recovery verified by an independent health request. The queued export is complete.");
    const progress = [
      kinds.has("detected"),
      kinds.has("investigation") || kinds.has("approval_required"),
      kinds.has("approved"),
      verified,
    ];
    const names = ["detect", "investigate", "approve", "verify"];
    names.forEach((name, index) => {
      $(`step-${name}`).className = progress[index]
        ? "done"
        : incident &&
            !terminal.has(incident.state) &&
            (index === 0 || progress[index - 1])
          ? "current"
          : "";
    });
    $("approval").hidden = incident?.state !== "awaiting_approval";
    text(
      "approval-action",
      `Requested action: ${detailText(incident?.pending_action) || "See investigation timeline for the proposed recovery action."}`,
    );
    renderTimeline($("timeline"), history);
    const historical = incidents.filter(
      (item) => item.id !== incident?.id || terminal.has(item.state),
    );
    text("incident-count", historical.length);
    $("history-empty").hidden = historical.length > 0;
    reconcile(
      $("history-list"),
      historical,
      (item) => item.id,
      () => {
        const details = element("details", "historical");
        details.append(element("summary"), element("ol", "timeline"));
        return details;
      },
      (node, item) => {
        text(
          node.children[0],
          `${stamp(item.created_at)} · ${words(item.state)} · ${item.id}`,
        );
        renderTimeline(node.children[1], item.history);
      },
    );
  }
  function render() {
    const { app, monitoring, provider, limits } = state;
    monitoring.incidents = [...(monitoring.incidents || [])].sort(
      (a, b) =>
        (date(b.created_at)?.getTime() || 0) -
        (date(a.created_at)?.getTime() || 0),
    );
    text("order-count", number(app.orders.count));
    text("revenue", money(app.orders.revenue_cents));
    text(
      "worker",
      app.recovering
        ? "Recovering"
        : app.worker_running
          ? "Running"
          : "Stopped",
    );
    text(
      "worker-caption",
      app.worker_running
        ? "Processing queued exports"
        : "Exports paused until recovery",
    );
    badge(
      $("health"),
      app.healthy ? "Healthy" : app.recovering ? "Recovering" : "Degraded",
      app.healthy ? "good" : "warn",
    );
    text(
      "provider-mode",
      provider.mode === "anthropic"
        ? "Live Anthropic"
        : "Deterministic fixture provider",
    );
    text(
      "provider-model",
      `${provider.model || (provider.mode === "fixture" ? "Scripted investigation" : "Server-selected model")} · Server-side only`,
    );
    text(
      "drill-help",
      !state.capabilities.fault_allowed
        ? "Failure drills are disabled by the server."
        : !monitoring.enabled
          ? "Monitoring is disabled. A drill will not trigger automatic investigation."
          : failureActive()
            ? "Recovery in progress. New reports, drills, and reset are paused."
            : "Stops the export worker so you can follow recovery.",
    );
    renderJobs(app.jobs || []);
    renderIncidents(monitoring.incidents);
    const probe = [...(monitoring.probes || [])].sort(
      (a, b) => (date(b.at)?.getTime() || 0) - (date(a.at)?.getTime() || 0),
    )[0];
    text(
      "probe",
      probe
        ? `Independent probe · ${probe.healthy ? "Healthy" : "Unhealthy"} · status ${probe.status ?? "—"} · ${probe.duration_ms ?? "—"} ms · ${time(probe.at)}. This is separate from action acceptance.`
        : "Independent probe: no observation yet. Action acceptance alone does not verify recovery.",
    );
    const budgets = [...(monitoring.budgets || [])].sort((a, b) =>
      String(b.day).localeCompare(String(a.day)),
    );
    const today = new Date().toISOString().slice(0, 10);
    const budget = budgets.find((entry) => entry.day === today);
    text("budget-day", `${today} UTC`);
    text(
      "requests",
      `${number(budget?.requests)} / ${number(limits.daily_requests)}`,
    );
    text(
      "actions",
      `${number(budget?.actions)} / ${number(limits.daily_actions)}`,
    );
    text("reserved", number(budget?.reserved));
    text(
      "budget",
      `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format((Number(limits.daily_budget_microusd) || 0) / 1000000)} / day`,
    );
    text(
      "tokens",
      `${number(provider.input_tokens)} / ${number(provider.output_tokens)}`,
    );
    const events = [...(monitoring.events || [])]
      .sort(
        (a, b) =>
          (date(b.timestamp)?.getTime() || 0) -
          (date(a.timestamp)?.getTime() || 0),
      )
      .slice(0, 40);
    $("events-empty").hidden = events.length > 0;
    reconcile(
      $("events"),
      events,
      (event) => event.id,
      () => {
        const li = element("li");
        const details = element("details");
        details.append(element("summary", "", "Event details"), element("pre"));
        li.append(element("time"), element("strong"), details);
        return li;
      },
      (li, event) => {
        text(li.children[0], time(event.timestamp));
        text(
          li.children[1],
          `${words(event.kind)} · ${event.name || "Observation"}`,
        );
        text(li.children[2].children[1], detailText(event.properties));
      },
    );
    updateControls();
  }
  function showError(message) {
    text("error", message);
    $("error").hidden = false;
  }
  async function readResponse(response) {
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `The server returned an unreadable response (${response.status}).`,
      );
    }
    if (!response.ok)
      throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }
  async function poll() {
    try {
      const response = await fetch("/api/state", {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      const next = await readResponse(response);
      if (
        !next.app ||
        !next.monitoring ||
        !next.provider ||
        !next.limits ||
        !next.capabilities
      )
        throw new Error("The server returned an incomplete workspace state.");
      state = next;
      connected = true;
      text("connection", `Connected · ${time(Date.now())}`);
      $("connection-dot").className = "status-dot teal";
      if ($("error").dataset.source === "poll") {
        $("error").hidden = true;
        delete $("error").dataset.source;
      }
      render();
      if (successMessage) {
        text("operation", successMessage);
        $("operation").hidden = false;
        successMessage = "";
      }
    } catch (error) {
      connected = false;
      text("connection", "Connection interrupted");
      $("connection-dot").className = "status-dot offline";
      if ($("error").hidden || $("error").dataset.source === "poll") {
        showError(
          `Unable to refresh workspace: ${error.message} Retrying automatically. Displayed data may be stale; controls are paused.`,
        );
        $("error").dataset.source = "poll";
      }
      if (!state) {
        text($("jobs-empty").querySelector("h3"), "Workspace unavailable");
        text(
          $("jobs-empty").querySelector("p"),
          "Waiting to reconnect. No reports have been changed.",
        );
      }
      updateControls();
    }
  }
  async function operation(path, body, message) {
    if (pending || !connected) return;
    pending = true;
    $("error").hidden = true;
    delete $("error").dataset.source;
    text("operation", "Sending request…");
    $("operation").hidden = false;
    updateControls();
    try {
      await readResponse(
        await fetch(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-reportroom-demo": "1",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        }),
      );
      successMessage = message;
      text(
        "operation",
        "Request accepted. Waiting for the next state observation…",
      );
    } catch (error) {
      $("operation").hidden = true;
      showError(
        `${error.message} Check the latest state before retrying; a disconnected request may already have reached the server.`,
      );
    } finally {
      await poll();
      pending = false;
      updateControls();
    }
  }
  $("report-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("create-report").disabled) return;
    const period = Number(new FormData(event.currentTarget).get("period"));
    if (period === 7 || period === 30)
      void operation(
        "/api/reports",
        { period },
        "Report request accepted. The export queue below reflects the latest observed state.",
      );
  });
  $("fault").addEventListener("click", () => {
    if (!$("fault").disabled)
      void operation(
        "/api/fault",
        {},
        "Failure drill accepted. Follow detection, investigation, approval, and verification in Roundhouse.",
      );
  });
  $("approve").addEventListener("click", () => {
    if (!$("approve").disabled && activeId)
      void operation(
        `/api/incidents/${encodeURIComponent(activeId)}/approve`,
        {},
        "Approval accepted. Recovery is not confirmed until an independent verification reports healthy.",
      );
  });
  $("reset").addEventListener("click", () => {
    if (!$("reset").disabled) $("reset-dialog").showModal();
  });
  $("cancel-reset").addEventListener("click", () => $("reset-dialog").close());
  $("confirm-reset").addEventListener("click", () => {
    if ($("confirm-reset").disabled) return;
    $("reset-dialog").close();
    void operation(
      "/api/reset",
      {},
      "Demo reset accepted. Reports are cleared; incident, budget, and action-claim history remain.",
    );
  });
  async function refreshLoop() {
    if (!pending) await poll();
    window.setTimeout(refreshLoop, 1000);
  }
  void refreshLoop();
})();

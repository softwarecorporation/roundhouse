const scenes = [...document.querySelectorAll("[data-stage]")];
const byId = (id) => document.getElementById(id);
const motion = matchMedia("(prefers-reduced-motion: reduce)");
let index = 0,
  reading = motion.matches,
  playing = !reading,
  timer;
const beats = [
  [
    "Watching Reportroom",
    "Waiting for the next scheduled check.",
    "GET /health",
    "baseline · monitor ready",
  ],
  [
    "Watching Reportroom",
    "An export is queued. The worker has stopped.",
    "GET /health",
    "13:18:38 · seven-day export queued",
  ],
  [
    "Investigating a 503",
    "The scheduled probe failed. Inspect the queue before acting.",
    "inspect → export_queue",
    "13:19:08 · scheduled probe → 503",
  ],
  [
    "Found a paused worker",
    "The report is queued but no worker is taking jobs.",
    "export_queue → worker_running: false",
    "13:19:08 · inspect → worker paused",
  ],
  [
    "Resuming exports",
    "Automatic policy permits one resume. Acceptance is not proof of recovery.",
    "resume_exports → accepted",
    "13:19:08 · resume accepted; fresh probe → 503",
  ],
  [
    "Recovery verified",
    "A later probe passed. The CSV checksum matches the completed job.",
    "fresh probe → 200 OK",
    "13:19:38 · healthy → CSV verified",
  ],
  [
    "Incident closed",
    "The final pane illustrates a PR handoff. No PR was opened.",
    "verification complete",
    null,
  ],
];
function paintDesk() {
  const [title, note, tool] = beats[index];
  byId("desk").dataset.focus = [
    "app",
    "app",
    "agent",
    "log",
    "agent",
    "app",
    "repo",
  ][index];
  const values = {
    worker:
      index === 0 || index >= 5
        ? "Running"
        : index === 4
          ? "Resuming"
          : "Paused",
    job:
      index === 0
        ? "Ready for export"
        : index >= 5
          ? "Completed · 7 rows"
          : "Queued",
    "agent-title": title,
    "agent-note": note,
    "agent-tool": tool,
    "agent-status":
      index < 2
        ? "Monitoring"
        : index < 5
          ? "Incident b4441d05"
          : "Resolved · b4441d05",
    "source-tab":
      index === 6
        ? "Pull request mockup · Not submitted"
        : index < 3
          ? "Monitor configuration"
          : index >= 5
            ? "Verified artifact"
            : "Captured diagnostic",
    "file-name":
      index === 6
        ? "incident.md"
        : index < 3
          ? "Reportroom"
          : index >= 5
            ? "sales.csv"
            : "export_queue",
    "source-code":
      index === 6
        ? "+ Cause: export worker paused\n+ Action: resume_exports × 1\n+ Verification: HTTP 200\n+ CSV: 41 orders / 7 rows\n\nIllustration only. No repository changed."
        : index >= 5
          ? "state          completed\norder_count    41\nrows           7\nsha256         2dd6cda8…f0acb11f"
          : index >= 3
            ? "worker_running    false\nrecoveries        0\njobs[0].state     queued\nperiod            7 days"
            : "check       HTTP health\ninspect     export_queue\naction      resume_exports\npolicy      automatic",
  };
  for (const [id, text] of Object.entries(values)) byId(id).textContent = text;
  byId("feed").replaceChildren(
    ...beats
      .slice(0, index + 1)
      .filter((b) => b[3])
      .map((b) => {
        const li = document.createElement("li");
        li.textContent = b[3];
        return li;
      })
      .reverse(),
  );
}
function render() {
  clearTimeout(timer);
  const ended = index === scenes.length;
  document.body.classList.toggle("watching", !reading);
  byId("destinations").hidden = !ended && !reading;
  byId("desk").hidden = reading || ended;
  document.querySelector(".screen").hidden = !reading;
  if (!reading && !ended) paintDesk();
  document.querySelector(".slate b").textContent =
    ended && !reading ? "Roundhouse for your apps" : "The paused export worker";
  document.querySelector(".slate span").textContent =
    ended && !reading ? "Workspace guide" : "Illustrated fixture replay";
  byId("counter").textContent = reading
    ? "Complete sequence"
    : ended
      ? "Software Corporation (Hong Kong)"
      : `${index + 1} / ${scenes.length} · ${scenes[index].dataset.stage}`;
  byId("play").textContent = playing ? "Pause" : "Play";
  byId("static").textContent = reading ? "View player" : "Read all scenes";
  for (const id of ["play", "replay", "next", "skip"])
    byId(id).hidden = reading;
  for (const id of ["play", "next", "skip"]) byId(id).hidden = ended || reading;
  if (playing && !document.hidden)
    timer = setTimeout(() => {
      index++;
      if (index === scenes.length) playing = false;
      render();
    }, 3500);
}
byId("play").onclick = () => {
  playing = !playing;
  render();
};
byId("replay").onclick = () => {
  index = 0;
  playing = true;
  render();
};
byId("next").onclick = () => {
  index++;
  playing = false;
  render();
};
byId("skip").onclick = () => {
  index = scenes.length;
  playing = false;
  render();
  byId("destinations").querySelector("a").focus();
};
byId("static").onclick = () => {
  reading = !reading;
  playing = false;
  render();
};
motion.onchange = () => {
  reading = motion.matches;
  playing = false;
  render();
};
document.addEventListener("visibilitychange", render);
byId("controls").hidden = false;
render();

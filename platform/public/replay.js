// Project the roundhouse stalls, rails and bridge onto one measured plate.
const shapes = [];
const proj = (x, y, z = 0) => [
  303 + x * 0.94 + y * 0.25,
  220 + y * 0.49 - x * 0.12 - z,
];
const pt = (r, a, z = 0, side = 0) => {
  let t = (a * Math.PI) / 180;
  return proj(
    Math.sin(t) * r + side * Math.cos(t),
    -Math.cos(t) * r + side * Math.sin(t),
    z,
  );
};
function path(p, fill = "none", stroke = "#475872", sw = 1) {
  shapes.push(
    `<path d="M${p.map((x) => x.join(",")).join(" L")}${fill === "none" ? "" : " Z"}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
  );
}
const arc = (r, a, b, z = 0) =>
  Array.from({ length: 61 }, (_, i) => pt(r, a + ((b - a) * i) / 60, z));
for (let a = -99; a <= 108; a += 9) {
  path([pt(64, a, 0, -3), pt(258, a, 0, -3)], "none", "#8597ae", 0.8);
  path([pt(64, a, 0, 3), pt(258, a, 0, 3)], "none", "#8597ae", 0.8);
  for (let r = 72; r < 250; r += 9)
    path([pt(r, a, 0, -5), pt(r, a, 0, 5)], "none", "#909ca8", 0.8);
}
for (let a = -103.5; a < 108; a += 9) {
  let b = a + 9,
    mid = a + 4.5;
  path([pt(235, a), pt(235, b), pt(235, b, 40), pt(235, a, 40)], "#a5b2bf");
  path([pt(126, a), pt(126, b), pt(126, b, 35), pt(126, a, 35)], "#203a54");
  path(
    [
      pt(126, a + 1, 1),
      pt(126, b - 1, 1),
      pt(126, b - 1, 27),
      pt(126, mid, 31),
      pt(126, a + 1, 27),
    ],
    "#101f30",
    "#91a3b3",
    0.65,
  );
  path(
    [pt(126, a, 35), pt(235, a, 40), pt(235, mid, 53), pt(126, mid, 46)],
    "#aebfd1",
  );
  path(
    [pt(126, mid, 46), pt(235, mid, 53), pt(235, b, 40), pt(126, b, 35)],
    "#7087a1",
  );
  for (let j = 1; j < 8; j++) {
    let r = 126 + j * 13;
    path(
      [
        pt(r, a, 35 + (r - 126) * 0.046),
        pt(r, mid, 46 + (r - 126) * 0.064),
        pt(r, b, 35 + (r - 126) * 0.046),
      ],
      "none",
      "#d9e2e9",
      0.65,
    );
  }
  path(
    [
      pt(160, a + 2, 41),
      pt(195, a + 2, 43),
      pt(195, mid, 50),
      pt(160, mid, 48),
    ],
    "#dae3eb",
    "#435c75",
    0.65,
  );
}
for (let side of [-3, 3])
  path([pt(64, 164, 0, side), pt(356, 164, 0, side)], "none", "#667b8e", 1.3);
path(arc(64, 0, 360), "#bac9d4");
path(arc(58, 0, 360), "#ced9e1");
path(
  [
    pt(61, 164, 2, -7),
    pt(61, 164, 2, 7),
    pt(-61, 164, 2, 7),
    pt(-61, 164, 2, -7),
  ],
  "#c0643d",
  "#654235",
);
for (let j = -54; j < 56; j += 9)
  path([pt(j, 164, 4, -6), pt(j, 164, 4, 6)], "none", "#e8c0a4");
document.querySelector("#drawing").innerHTML = shapes.join("");
const $ = (s) => document.querySelector(s),
  motion = matchMedia("(prefers-reduced-motion: reduce)");
const original = $(".intro").querySelector("h1").innerHTML,
  description = $(".intro p").textContent;
const shots = [
  [
    "Fix app failures while you’re away.",
    description,
    "shop",
    "Monitor attached",
    "monitor.conf",
    ["target   Reportroom", "check    export worker", "policy   automatic"],
    3200,
  ],
  [
    "The export stalls.",
    "Seven-day close is queued. With its worker paused, Reportroom cannot generate the file.",
    "queue",
    "Report queued",
    "queue.json",
    ["{", '  "state": "queued",', '  "period": 7', "}"],
    3200,
  ],
  [
    "Find the failed worker.",
    "A scheduled probe returns 503. The agent inspects the queue before choosing an action.",
    "queue",
    "Probe failed · inspecting export_queue",
    "inspection.json",
    ['"worker_running": false,', '"recoveries": 0,', '"state": "queued"'],
    4000,
  ],
  [
    "Resume exports.",
    "The fixture agent requests the configured action once. No approval click is needed.",
    "queue",
    "resume_exports × 1 · accepted",
    "action.json",
    ['"action": "resume_exports",', '"outcome": "accepted"'],
    3200,
  ],
  [
    "Check the repair.",
    "The action was accepted, but the first fresh health check still fails. The incident stays open.",
    "queue",
    "Fresh check still unhealthy",
    "probe.json",
    ['"healthy": false,', '"status": 503'],
    3000,
  ],
  [
    "Open the finished file.",
    "Thirty seconds later the probe passes. The downloaded report matches its checksum: 41 orders, seven rows.",
    "ready",
    "CSV checksum verified",
    "Seven-day close.csv",
    [
      "date,order_count,revenue_cents",
      "2026-01-24,8,50523",
      "2026-01-25,3,15708",
      "2026-01-26,4,22324",
      "2026-01-27,5,30045",
      "2026-01-28,6,38539",
      "2026-01-29,7,45731",
      "2026-01-30,8,57099",
    ],
    4200,
  ],
  [
    "Leave a repair note.",
    "An illustrated PR shows the cause, action and evidence together. No repository was changed.",
    "ready",
    "Incident resolved",
    "PR preview · not submitted",
    [
      "+ Paused export worker",
      "+ Resumed exports once",
      "+ Fresh probe: HTTP 200",
      "+ CSV: 41 orders / 7 rows",
    ],
    3200,
  ],
];
let n = 0,
  running = !motion.matches,
  timer,
  remaining,
  started;
const title = $("h1"),
  intro = $(".intro p");
function rows(parent, strings) {
  parent.replaceChildren(
    ...strings.map((s) => {
      const el = document.createElement(parent.tagName === "OL" ? "li" : "div");
      el.textContent = s;
      return el;
    }),
  );
}
function schedule() {
  clearTimeout(timer);
  if (running && !document.hidden) {
    started = performance.now();
    timer = setTimeout(() => {
      n++;
      render();
    }, remaining);
  }
}
function freeze() {
  clearTimeout(timer);
  if (started != null) {
    remaining = Math.max(0, remaining - (performance.now() - started));
    started = null;
  }
}
function render() {
  clearTimeout(timer);
  started = null;
  const site = n === shots.length;
  document.body.classList.toggle("product", site);
  document.body.classList.toggle("rolling", !site);
  document.body.dataset.scene = n;
  $("#appshot").hidden = site;
  $("#play").hidden = $("#skip").hidden = site;
  $("#play").textContent = running ? "Pause" : "Play";
  $("#replay").textContent = site ? "Replay incident" : "Replay";
  if (site) {
    running = false;
    title.innerHTML = original;
    intro.textContent = description;
    return;
  }
  const [headline, note, image, , file, lines, duration] = shots[n];
  title.textContent = headline;
  intro.textContent = note;
  $("#capture").src = `/signal-${image}.webp`;
  $("#capture").alt = {
    shop: "Reportroom sales workspace",
    queue: "Seven-day close is generating",
    ready: "Seven-day close ready with CSV output",
  }[image];
  $(".line b").textContent = `Seven-day close · ${n + 1} / ${shots.length}`;
  $("#filetab").textContent = file;
  rows($("#editor"), lines);
  rows(
    $("#agentlog"),
    shots.slice(Math.max(0, n - 2), n + 1).map((s) => s[3]),
  );
  rows(
    $("#probes"),
    n >= 5
      ? ["14:40:22 UTC  ·  503", "14:40:52 UTC  ·  200 OK"]
      : n === 4
        ? ["14:40:22 UTC  ·  503", "Awaiting fresh probe"]
        : n >= 2
          ? ["Scheduled probe  ·  503"]
          : ["Scheduled monitor armed"],
  );
  remaining = duration;
  schedule();
}
function end() {
  n = shots.length;
  render();
}
$(".tabs").hidden = false;
$("#play").onclick = () => {
  if (running) freeze();
  running = !running;
  $("#play").textContent = running ? "Pause" : "Play";
  schedule();
};
$("#replay").onclick = () => {
  n = 0;
  running = true;
  render();
};
$("#skip").onclick = () => {
  end();
  $("#replay").focus();
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden) freeze();
  else schedule();
});
$("#transcript").ontoggle = () => {
  if ($("#transcript").open && running) {
    freeze();
    running = false;
    $("#play").textContent = "Play";
  }
};
motion.onchange = () => {
  if (motion.matches) end();
};
if (motion.matches) end();
else render();

const scenes = [...document.querySelectorAll("[data-stage]")];
const byId = (id) => document.getElementById(id);
const motion = matchMedia("(prefers-reduced-motion: reduce)");
let index = 0,
  reading = motion.matches,
  playing = !reading,
  timer;
function render() {
  clearTimeout(timer);
  scenes.forEach((scene, i) => (scene.hidden = !reading && i !== index));
  byId("counter").textContent = reading
    ? "Complete sequence"
    : `${index + 1} / ${scenes.length} · ${scenes[index].dataset.stage}`;
  byId("play").textContent = playing ? "Pause" : "Play";
  byId("static").textContent = reading ? "View player" : "Read all scenes";
  for (const id of ["play", "replay", "next", "skip"])
    byId(id).hidden = reading;
  byId("next").disabled = byId("skip").disabled = index === scenes.length - 1;
  if (playing && !document.hidden)
    timer = setTimeout(() => {
      index++;
      if (index === scenes.length - 1) playing = false;
      render();
    }, 3500);
}
byId("play").onclick = () => {
  if (!playing && index === scenes.length - 1) index = 0;
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
  index = scenes.length - 1;
  playing = false;
  render();
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

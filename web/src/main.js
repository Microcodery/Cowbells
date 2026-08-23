import "./style.css";
import { createEngine } from "./engine.js";
import { itineraryToGpx } from "./gpx.js";
import { createMap, currentTheme, flyTo, mapCenter, render as renderMap, replayCanvas, revealItinerary, setTheme } from "./map.js";
import { replay } from "./replay.js";
import { fetchOsm } from "./overpass.js";
import { renderPanel } from "./panel.js";
import * as state from "./state.js";

const STORAGE_KEY = "birdeye.event";
const UNITS_KEY = "birdeye.units";
const DEFAULT_CENTER = { lat: 45.5231, lon: -122.6765 };
const AUTOSAVE_DELAY_MS = 500;

const engine = createEngine();
const panel = document.getElementById("panel");
const ui = {
  tool: null,
  itinerary: null,
  network: null,
  osm: null,
  status: "Draw a course to begin.",
  busy: false,
  beam: 64,
  replaySeconds: 6,
  replaying: null,
  unit: state.UNITS[localStorage.getItem(UNITS_KEY)] ?? state.UNITS.km,
  // `null` while alternatives are still being explored; then the ones that beat the plan.
  alternatives: null,
};
let planGeneration = 0;

let event = loadSaved() ?? state.newEvent(DEFAULT_CENTER);
const map = createMap("map", event.origin, onMapClick);
map.on("layers-ready", draw);
window.birdeye = { map, event: () => event };

let autosave;
function draw() {
  renderPanel(panel, event, ui, actions);
  renderMap(map, event, ui.itinerary, ui.tool?.courseIndex ?? null);
  clearTimeout(autosave);
  autosave = setTimeout(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(event)), AUTOSAVE_DELAY_MS);
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return state.looksLikeEvent(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** Apply an edit to the event; any plan, and any search for alternatives to it, is stale afterwards. */
function mutate(edit) {
  edit();
  state.reconcileProfiles(event);
  ui.itinerary = null;
  planGeneration++;
  draw();
}

/** The network depends on mode and speed; rebuild it from the cached map data rather than refetching. */
function rebuildNetwork() {
  ui.network = null;
  if (ui.osm) run("Rebuilding network…", async () => (ui.status = await buildNetwork()));
}

function onMapClick(latlon) {
  if (ui.replaying) {
    ui.replaying.skip = true;
    return;
  }
  const tool = ui.tool;
  if (!tool) return;
  mutate(() => {
    if (tool.kind === "draw") state.addPoint(event.courses[tool.courseIndex], latlon);
    if (tool.kind === "start") event.spectator.start = latlon;
    if (tool.kind === "end") event.spectator.end = { location: latlon, latest: event.spectator.earliest + 4 * 3600 };
    if (tool.kind === "region") state.addRegion(event, latlon);
    if (tool.kind === "split") {
      const hit = state.nearestOnCourses(event, latlon);
      if (hit && hit.courseIndex === tool.courseIndex) {
        state.splitSegment(event.courses[hit.courseIndex], hit.segmentIndex, hit.pointIndex, hit.latlon);
      }
    }
    if (tool.kind !== "draw") ui.tool = null;
  });
}

function toggleTool(kind, courseIndex) {
  const same = ui.tool?.kind === kind && ui.tool.courseIndex === courseIndex;
  ui.tool = same ? null : { kind, courseIndex };
  draw();
}

/** Run async work with the panel locked and its outcome in the status line. */
async function run(label, work) {
  if (ui.busy) return;
  ui.busy = true;
  ui.status = label;
  draw();
  try {
    await work();
  } catch (err) {
    ui.status = `Error: ${err.message}`;
  } finally {
    ui.busy = false;
    draw();
  }
}

const actions = {
  addCourse() {
    mutate(() => {
      state.addCourse(event);
      ui.tool = { kind: "draw", courseIndex: event.courses.length - 1 };
    });
  },
  removeCourse({ ci }) {
    mutate(() => {
      state.removeCourse(event, event.courses[ci]);
      ui.tool = null;
    });
  },
  draw({ ci }) {
    toggleTool("draw", Number(ci));
  },
  undo({ ci }) {
    mutate(() => state.undoPoint(event.courses[ci]));
  },
  split({ ci }) {
    toggleTool("split", Number(ci));
  },
  merge({ ci, si }) {
    mutate(() => state.mergeWithNext(event.courses[ci], Number(si)));
  },
  addRacer() {
    mutate(() => state.addRacer(event, event.courses[0]));
  },
  removeRacer({ ri }) {
    mutate(() => event.racers.splice(Number(ri), 1));
  },
  splitInterval({ ri, ii }) {
    const interval = event.racers[ri].pace_profile[ii];
    mutate(() => state.splitInterval(event.racers[ri], Number(ii), (interval.start_m + interval.end_m) / 2));
  },
  mergeInterval({ ri, ii }) {
    mutate(() => state.mergeInterval(event.racers[ri], Number(ii)));
  },
  setStart() {
    toggleTool("start");
  },
  clearStart() {
    mutate(() => (event.spectator.start = null));
  },
  setEnd() {
    toggleTool("end");
  },
  clearEnd() {
    mutate(() => (event.spectator.end = null));
  },
  addRegion() {
    toggleTool("region");
  },
  removeRegion({ gi }) {
    mutate(() => event.spectator.required_regions.splice(Number(gi), 1));
  },
  theme() {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(map, next);
  },
  units() {
    const next = ui.unit === state.UNITS.km ? "mi" : "km";
    ui.unit = state.UNITS[next];
    localStorage.setItem(UNITS_KEY, next);
    draw();
  },
  flyTo({ stop }) {
    flyTo(map, ui.itinerary.stops[stop].location);
  },
  save() {
    download(`${event.name}.bird`, JSON.stringify({ event, osm: ui.osm }, null, 1), "application/json");
  },
  exportGpx() {
    download(`${event.name} spectator.gpx`, itineraryToGpx(ui.itinerary, event), "application/gpx+xml");
  },
  async load(_, input) {
    const text = await input.files[0]?.text();
    if (!text) return;
    await run("Loading…", async () => {
      const saved = JSON.parse(text);
      const loaded = saved.event ?? saved;
      if (!state.looksLikeEvent(loaded)) throw new Error("not a .bird event file");
      event = loaded;
      ui.osm = saved.osm ?? null;
      ui.network = null;
      ui.itinerary = null;
      flyTo(map, state.courseCenter(event, event.origin));
      ui.status = ui.osm ? await buildNetwork() : "Loaded. Fetch map data to plan.";
    });
  },
  async example(_, select) {
    const name = select.value;
    if (!name) return;
    await run("Loading example…", async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}examples/${name}.bird`);
      if (!response.ok) throw new Error(`example ${name} not found`);
      const saved = await response.json();
      event = saved.event;
      state.rebase(event, state.todayAt("09:00"));
      ui.osm = saved.osm;
      ui.network = null;
      ui.itinerary = null;
      flyTo(map, state.courseCenter(event, event.origin));
      ui.status = await buildNetwork();
    });
  },
  async gpx(_, input) {
    const xml = await input.files[0]?.text();
    if (!xml) return;
    await run("Parsing GPX…", async () => {
      const courses = await engine.call("gpx", { xml });
      for (const course of courses) {
        course.start_time = event.spectator.earliest;
        event.courses.push(course);
      }
      ui.itinerary = null;
      if (courses.length) flyTo(map, state.courseCenter(event, event.origin));
      ui.status = `Imported ${courses.length} course(s).`;
    });
  },
  async fetch() {
    if (event.courses.length === 0) return;
    // The projection is centred on the courses so distances stay true across the whole event.
    event.origin = state.courseCenter(event, mapCenter(map));
    await run("Fetching OpenStreetMap data…", async () => {
      ui.osm = await fetchOsm(event);
      ui.status = await buildNetwork();
    });
  },
  async plan() {
    let planned = false;
    await run("Planning…", async () => {
      const problems = await engine.call("validate", { event });
      if (problems.length) throw new Error(problems.join("; "));
      const { itinerary, trace } = await engine.call("plan", { event, options: { beam: ui.beam, trace: true } });
      // The previous itinerary fades out before the replay and the new one fades in after it.
      revealItinerary(map, false);
      await replayTrace(trace);
      ui.itinerary = itinerary;
      ui.alternatives = null;
      ui.status = `${state.planSummary(event, itinerary)}.`;
      planned = true;
      draw();
      requestAnimationFrame(() => revealItinerary(map, true));
    });
    if (planned) exploreAlternatives(++planGeneration).catch((err) => console.error("alternatives", err));
  },
  async useAlternative({ alt }) {
    const { variant, itinerary } = ui.alternatives[Number(alt)];
    await run("Switching…", async () => {
      event.spectator = variant.spectator;
      ui.itinerary = itinerary;
      // Already loosened once; offering further loosening would chase diminishing returns.
      ui.alternatives = [];
      ui.status = `${state.planSummary(event, itinerary)}. ${await buildNetwork()}`;
    });
  },
  skipReplay() {
    if (ui.replaying) ui.replaying.skip = true;
  },
  edit({ field, ci, si, ri, ii, gi }, input) {
    const course = event.courses[ci];
    const racer = event.racers[ri];
    const s = event.spectator;
    const number = Number(input.value);
    const edits = {
      name: () => (event.name = input.value),
      courseName: () => (course.name = input.value),
      courseStart: () => (course.start_time = state.withClock(course.start_time, input.value)),
      segmentMode: () => (course.segments[si].mode = input.value),
      viewable: () => (course.segments[si].viewable = input.checked),
      racerName: () => (racer.name = input.value),
      racerCourse: () => state.assignCourse(racer, event.courses.find((c) => c.id === input.value)),
      racerOffset: () => (racer.start_offset_s = number * 60),
      racerPriority: () => (racer.priority = number),
      pace: () => (racer.pace_profile[ii].seconds_per_km = state.parsePace(input.value, ui.unit) ?? racer.pace_profile[ii].seconds_per_km),
      uncertainty: () => (racer.pace_profile[ii].uncertainty = number / 100),
      earliest: () => (s.earliest = state.withClock(s.earliest, input.value)),
      latest: () => (s.latest = input.value ? state.laterThan(s.earliest, input.value) : null),
      endLatest: () => (s.end.latest = state.withClock(s.end.latest, input.value)),
      regionRadius: () => (s.required_regions[gi].radius_m = number),
      travel: () => {
        s.mode = input.value;
        s.speed_mps = null;
        rebuildNetwork();
      },
      speed: () => {
        s.speed_mps = input.value ? number / ui.unit.speedPerMps : null;
        rebuildNetwork();
      },
      radius: () => (s.sighting_radius_m = number),
      skipStart: () => (s.skip_start_m = number / ui.unit.perMetre),
      buffer: () => (s.safety_buffer_s = number * 60),
      minStop: () => (s.min_stop_s = number * 60),
      spacing: () => (s.viewpoint_spacing_m = number),
      decay: () => (s.objective.repeat_decay = number),
      finishes: () => (s.objective.finishes = input.checked),
      courseClosed: () => (s.course_closed = input.checked),
      beam: () => (ui.beam = number),
      replaySeconds: () => (ui.replaySeconds = number),
    };
    mutate(() => edits[field]?.());
  },
};

/** Tries looser settings after a plan and offers any that do clearly better; stops if a newer plan starts. */
async function exploreAlternatives(generation) {
  if (!ui.itinerary) return;
  const snapshot = structuredClone(event);
  const finishes = snapshot.spectator.objective.finishes !== false;
  const base = state.planLevels(snapshot, ui.itinerary);
  const options = { beam: ui.beam, trace: false };
  const found = [];
  for (const alt of state.ALTERNATIVES) {
    if (alt.when && !alt.when(snapshot.spectator)) continue;
    const variant = state.alternativeEvent(snapshot, alt);
    try {
      // The network was built at the current speed; a faster variant scales its times instead of rebuilding.
      const { itinerary } = await engine.call("plan", { event: variant, options: { ...options, speed_factor: alt.speedFactor } });
      if (generation !== planGeneration) return;
      if (state.betterPlan(state.planLevels(variant, itinerary), base, finishes)) found.push({ alt, variant, itinerary });
    } catch {
      // A variant that cannot be planned is simply not offered.
    }
  }
  if (generation !== planGeneration) return;
  ui.alternatives = found;
  draw();
}

async function replayTrace(trace) {
  ui.replaying = { skip: false };
  renderPanel(panel, event, ui, actions);
  // Status changes every frame; rebuilding the whole panel that often would drop input focus.
  const narrate = (text) => {
    ui.status = text;
    panel.querySelector("[data-status]").textContent = text;
  };
  const radius = event.spectator.sighting_radius_m;
  await replay(trace, replayCanvas(map), radius, () => ui.replaySeconds, narrate, ui.replaying);
  ui.replaying = null;
}

function download(filename, text, type) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function buildNetwork() {
  const { mode, speed_mps } = event.spectator;
  ui.network = await engine.call("network", { osm: ui.osm, origin: event.origin, mode, speed: speed_mps });
  return `Network: ${ui.network.nodes} nodes, ${ui.network.edges} edges.`;
}

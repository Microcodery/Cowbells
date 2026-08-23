import "./style.css";
import { createEngine } from "./engine.js";
import { itineraryToGpx } from "./gpx.js";
import { createMap, currentTheme, flyTo, mapCenter, render as renderMap, setTheme } from "./map.js";
import { fetchOsm } from "./overpass.js";
import { renderPanel } from "./panel.js";
import * as state from "./state.js";

const STORAGE_KEY = "birdeye.event";
const DEFAULT_CENTER = { lat: 45.5231, lon: -122.6765 };
const AUTOSAVE_DELAY_MS = 500;

const engine = createEngine();
const panel = document.getElementById("panel");
const ui = { tool: null, itinerary: null, network: null, osm: null, status: "Draw a course to begin.", busy: false, beam: 64 };

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

/** Apply an edit to the event; any plan is stale afterwards. */
function mutate(edit) {
  edit();
  state.reconcileProfiles(event);
  ui.itinerary = null;
  draw();
}

function onMapClick(latlon) {
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
      flyTo(map, event.origin);
      ui.status = ui.osm ? await buildNetwork() : "Loaded. Fetch map data to plan.";
    });
  },
  async example(_, select) {
    const name = select.value;
    if (!name) return;
    await run("Loading example…", async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}examples/${name}.bird`);
      if (!response.ok) throw new Error(`example ${name} not found`);
      event = await response.json();
      state.rebase(event, state.todayAt("09:00"));
      ui.osm = null;
      ui.network = null;
      ui.itinerary = null;
      flyTo(map, event.origin);
      ui.status = "Example loaded. Fetch map data, then plan.";
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
      if (courses[0]?.segments[0]?.points[0]) flyTo(map, courses[0].segments[0].points[0]);
      ui.status = `Imported ${courses.length} course(s).`;
    });
  },
  async fetch() {
    if (event.courses.length === 0) return;
    event.origin = mapCenter(map);
    await run("Fetching OpenStreetMap data…", async () => {
      ui.osm = await fetchOsm(event);
      ui.status = await buildNetwork();
    });
  },
  async plan() {
    await run("Planning…", async () => {
      const problems = await engine.call("validate", { event });
      if (problems.length) throw new Error(problems.join("; "));
      ui.itinerary = await engine.call("plan", { event, options: { beam: ui.beam } });
      ui.status = `Score ${Math.round(ui.itinerary.score)}.`;
    });
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
      pace: () => (racer.pace_profile[ii].seconds_per_km = state.parsePace(input.value) ?? racer.pace_profile[ii].seconds_per_km),
      uncertainty: () => (racer.pace_profile[ii].uncertainty = number / 100),
      earliest: () => (s.earliest = state.withClock(s.earliest, input.value)),
      latest: () => (s.latest = input.value ? state.laterThan(s.earliest, input.value) : null),
      endLatest: () => (s.end.latest = state.withClock(s.end.latest, input.value)),
      regionRadius: () => (s.required_regions[gi].radius_m = number),
      travel: () => {
        s.mode = input.value;
        ui.network = null;
      },
      radius: () => (s.sighting_radius_m = number),
      buffer: () => (s.safety_buffer_s = number * 60),
      minStop: () => (s.min_stop_s = number * 60),
      decay: () => (s.objective.repeat_decay = number),
      courseClosed: () => (s.course_closed = input.checked),
      beam: () => (ui.beam = number),
    };
    mutate(() => edits[field]?.());
  },
};

function download(filename, text, type) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function buildNetwork() {
  ui.network = await engine.call("network", { osm: ui.osm, origin: event.origin, mode: event.spectator.mode });
  return `Network: ${ui.network.nodes} nodes, ${ui.network.edges} edges.`;
}

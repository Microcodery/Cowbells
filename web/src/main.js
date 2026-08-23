import "./style.css";
import { createEngine } from "./engine.js";
import { itineraryToGpx } from "./gpx.js";
import { createMap, currentTheme, fitTo, flyTo, mapCenter, render as renderMap, replayCanvas, revealItinerary, setHover, setTheme } from "./map.js";
import { loadMapData, saveMapData } from "./store.js";
import { overlay } from "./overlay.js";
import { liveReplay } from "./replay.js";
import { bbox, covers, fetchOsm } from "./overpass.js";
import { esc, renderHeader, renderPanel } from "./panel.js";
import * as state from "./state.js";

const STORAGE_KEY = "birdseye.event";
const UNITS_KEY = "birdseye.units";
const TIER_KEY = "birdseye.tier";
const DEBUG_KEY = "birdseye.debug";

function loadDebug() {
  try {
    return { ...state.debugDefaults(), ...JSON.parse(localStorage.getItem(DEBUG_KEY) ?? "{}") };
  } catch {
    return state.debugDefaults();
  }
}
const DEFAULT_CENTER = { lat: 45.5231, lon: -122.6765 };
const AUTOSAVE_DELAY_MS = 500;

const engine = createEngine();
const panel = document.getElementById("panel");
// The ghost space left by a cleared plan goes once the user scrolls up.
let lastScroll = 0;
panel.addEventListener("scroll", () => {
  if (ui.ghost && panel.scrollTop < lastScroll) {
    ui.ghost = null;
    panel.querySelector(".ghost")?.remove();
  }
  lastScroll = panel.scrollTop;
});
const ui = {
  tool: null,
  itinerary: null,
  network: null,
  osm: null,
  // The area `osm` was fetched for; courses outside it trigger a new fetch.
  osmBox: null,
  status: "Draw a course to begin.",
  busy: false,
  beam: 64,
  unit: state.UNITS[localStorage.getItem(UNITS_KEY)] ?? state.UNITS.km,
  // A stand-in for a real account: what the tier allows is enforced, who pays is not.
  tier: localStorage.getItem(TIER_KEY) in state.TIERS ? localStorage.getItem(TIER_KEY) : "free",
  banner: null,
  debug: loadDebug(),
  // Height of the last plan's results, kept as empty space after it is cleared.
  ghost: null,
  // `null` while alternatives are still being explored; then the ones that beat the plan.
  alternatives: null,
};
let planGeneration = 0;

let event = loadSaved() ?? state.newEvent(DEFAULT_CENTER);
const map = createMap("map", event.origin, onMapClick, onMapHover);
const paint = overlay(map);
const top = document.getElementById("top");
const hoverTip = document.getElementById("hover");
const mapStatus = document.getElementById("mapstatus");
const scan = document.getElementById("scan");
/** On phones the panel covers the map; planning closes it so the progress is visible. */
const closePanelOnPhones = () => matchMedia("(max-width: 700px)").matches && document.body.classList.remove("panel-open");
map.on("layers-ready", draw);
map.once("layers-ready", restoreMapData);

/** After a reload the event comes back from localStorage; its map data comes back from IndexedDB. */
async function restoreMapData() {
  if (!hasCourse()) return;
  const saved = await loadMapData();
  if (saved && covers(saved.box, bbox(event))) {
    ui.osm = saved.osm;
    ui.osmBox = saved.box;
    narrate(await buildNetwork());
    draw();
  } else {
    scheduleMapData();
  }
}

/** Frame the longest course, with a margin, whenever a new event arrives. */
function showCourses() {
  const longest = state.largestCourse(event);
  if (longest) fitTo(map, longest.segments.flatMap((s) => s.points), ui.debug.fitMargin / 100);
  else flyTo(map, event.origin);
}
window.birdseye = { map, event: () => event };

let autosave;
function draw() {
  renderHeader(top, event, ui, actions);
  renderPanel(panel, event, ui, actions);
  mapStatus.textContent = ui.status;
  mapStatus.hidden = !ui.status;
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
  scheduleMapData();
}

/**
 * The network depends on mode and speed; rebuild it from the cached map data rather than
 * refetching. Runs in the background (the worker serialises engine calls) so a change made
 * while something else is busy is never silently dropped.
 */
const REBUILD_DELAY_MS = 400;
let rebuildTimer = null;
let networkBuild = null;

function rebuildNetwork() {
  ui.network = null;
  if (!ui.osm) return;
  narrate("Rebuilding network…");
  // Spinner clicks arrive in bursts; build once they stop, and let Plan wait for that build.
  clearTimeout(rebuildTimer);
  networkBuild = new Promise((resolve) => {
    rebuildTimer = setTimeout(() => {
      buildNetwork()
        .then(narrate)
        .catch((err) => narrate(`Network: ${err.message}`))
        .finally(resolve);
    }, REBUILD_DELAY_MS);
  });
}

let mapDataTimer = null;
let mapDataFetch = null;

const hasCourse = () => event.courses.some((c) => c.segments.some((s) => s.points.length >= 2));

/** Fetches map data for the courses in the background unless the extract in hand already covers them. */
function ensureMapData() {
  if (mapDataFetch || !hasCourse()) return mapDataFetch;
  const needed = bbox(event);
  if (covers(ui.osmBox, needed)) return null;
  // The projection is centred on the courses so distances stay true across the whole event.
  event.origin = state.courseCenter(event, mapCenter(map));
  narrate("Fetching map data…");
  mapDataFetch = (async () => {
    try {
      const osm = await fetchOsm(event);
      ui.osm = osm;
      ui.osmBox = needed;
      ui.network = null;
      saveMapData({ osm, box: needed });
      narrate(await buildNetwork());
    } catch (err) {
      narrate(`Map data: ${err.message}`);
    } finally {
      mapDataFetch = null;
      draw();
    }
  })();
  return mapDataFetch;
}

/** Courses change point by point while drawing; fetch once the pen has been still for a moment. */
function scheduleMapData() {
  clearTimeout(mapDataTimer);
  mapDataTimer = setTimeout(() => ensureMapData(), ui.debug.mapDataDelayMs);
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

/** Hovering a course marks the spot and lists when each racer on it should pass. */
function onMapHover(latlon, point, metresPerPixel) {
  const hits = latlon ? state.nearestOnEachCourse(event, latlon).filter((h) => h.metres <= ui.debug.hoverPx * metresPerPixel) : [];
  if (!hits.length) {
    setHover(map, null);
    hoverTip.hidden = true;
    return;
  }
  const blocks = hits.map((hit) => {
    const course = event.courses[hit.courseIndex];
    const metres = state.distanceAlong(course, hit);
    const rows = state.arrivalsAt(event, course, metres).map(
      (a) => `<li><b>${esc(a.racer.name)}</b> ~${state.clock(a.expected)} <span class="muted">${state.clock(a.early)}–${state.clock(a.late)}</span></li>`,
    );
    return `<div>${esc(course.name)} · ${state.distanceLabel(metres, ui.unit, 1)}</div><ul>${rows.join("") || "<li class='muted'>no racers</li>"}</ul>`;
  });
  hoverTip.innerHTML = blocks.join("");
  hoverTip.style.left = `${point.x + 14}px`;
  hoverTip.style.top = `${point.y + 14}px`;
  hoverTip.hidden = false;
  const nearest = hits.reduce((a, b) => (b.d2 < a.d2 ? b : a));
  setHover(map, nearest.latlon, nearest.courseIndex);
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

/** Applies `edit` only if the event still fits the tier afterwards; otherwise says why not. */
function mutateWithinTier(edit) {
  const trial = structuredClone(event);
  const probe = { event: trial };
  edit(probe.event);
  const why = state.overTierLimit(trial, ui.tier);
  if (why) {
    ui.status = `${why} — switch to Plus for more.`;
    draw();
    return false;
  }
  mutate(() => edit(event));
  return true;
}

const actions = {
  toggleTier() {
    ui.tier = ui.tier === "free" ? "plus" : "free";
    localStorage.setItem(TIER_KEY, ui.tier);
    if (ui.tier === "plus") ui.banner = null;
    draw();
  },
  locked({ what }) {
    const limit = { course: "one course", racer: "two racers", pace: "one pace per racer" }[what];
    ui.banner = `Free includes ${limit}. Upgrade to Plus for more, or`;
    draw();
  },
  dismissBanner() {
    ui.banner = null;
    draw();
  },
  resetDebug() {
    ui.debug = state.debugDefaults();
    localStorage.removeItem(DEBUG_KEY);
    draw();
  },
  addCourse() {
    if (!mutateWithinTier((e) => state.addCourse(e))) return;
    ui.tool = { kind: "draw", courseIndex: event.courses.length - 1 };
    draw();
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
    mutateWithinTier((e) => state.addRacer(e, e.courses[0]));
  },
  removeRacer({ ri }) {
    mutate(() => event.racers.splice(Number(ri), 1));
  },
  splitInterval({ ri, ii }) {
    const interval = event.racers[ri].pace_profile[ii];
    mutateWithinTier((e) => state.splitInterval(e.racers[ri], Number(ii), (interval.start_m + interval.end_m) / 2));
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
      ui.osmBox = ui.osm ? bbox(event) : null;
      saveMapData(ui.osm ? { osm: ui.osm, box: ui.osmBox } : null);
      ui.network = null;
      ui.itinerary = null;
      showCourses();
      ui.status = ui.osm ? await buildNetwork() : "Loaded.";
      if (!ui.osm) scheduleMapData();
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
      // Examples are demos: let them show what Plus allows.
      if (state.overTierLimit(event, ui.tier)) actions.toggleTier();
      ui.osm = saved.osm ?? null;
      ui.osmBox = ui.osm ? bbox(event) : null;
      saveMapData(ui.osm ? { osm: ui.osm, box: ui.osmBox } : null);
      ui.network = null;
      ui.itinerary = null;
      showCourses();
      ui.status = ui.osm ? await buildNetwork() : "Example loaded.";
      if (!ui.osm) scheduleMapData();
    });
  },
  async importCourses(_, input) {
    const file = input.files[0];
    if (!file) return;
    const bytes = await file.arrayBuffer();
    await run(`Reading ${file.name}…`, async () => {
      const courses = await engine.call("courses", { name: file.name, bytes });
      const room = state.TIERS[ui.tier].courses - event.courses.length;
      if (courses.length > room) throw new Error(`${file.name} has ${courses.length} courses; ${state.TIERS[ui.tier].label} allows ${state.TIERS[ui.tier].courses}`);
      for (const course of courses) {
        course.start_time = event.spectator.earliest;
        event.courses.push(course);
      }
      ui.itinerary = null;
      if (courses.length) showCourses();
      ui.status = `Imported ${courses.length} course(s).`;
    });
    ensureMapData();
  },
  togglePanel() {
    document.body.classList.toggle("panel-open");
  },
  reset() {
    if (!confirm("Start over? This clears the courses, racers, settings, and fetched map data.")) return;
    event = state.newEvent(mapCenter(map));
    Object.assign(ui, { osm: null, osmBox: null, network: null, itinerary: null, alternatives: null, tool: null, banner: null, status: "Draw a course to begin." });
    localStorage.removeItem(STORAGE_KEY);
    saveMapData(null);
    planGeneration++;
    draw();
  },
  async plan() {
    let planned = false;
    closePanelOnPhones();
    // Nothing to show until the engine reports; a scan across the map says it is working.
    scan.hidden = false;
    await run("Planning…", async () => {
      if (!event.courses.length) throw new Error("draw or import a course first");
      if (!event.racers.length) throw new Error("add a racer first");
      const over = state.overTierLimit(event, ui.tier);
      if (over) throw new Error(`${over} — switch to Plus to plan this event`);
      // Map data is normally already in hand from the background fetch; otherwise wait for it.
      clearTimeout(mapDataTimer);
      await ensureMapData();
      if (!ui.osm) throw new Error("map data could not be fetched; try again in a moment");
      // The previous itinerary fades out while the engine's progress plays, and the new one fades in after.
      revealItinerary(map, false);
      let itinerary;
      // A settings change mid-plan makes the result stale: drop it and plan again with the new settings.
      for (;;) {
        const generation = planGeneration;
        if (networkBuild) await networkBuild;
        if (!ui.network) narrate(await buildNetwork());
        const problems = await engine.call("validate", { event });
        if (problems.length) throw new Error(problems.join("; "));
        const radius = event.spectator.sighting_radius_m;
        const live = liveReplay({ ctx: replayCanvas(map), paint }, radius, narrate, () => (scan.hidden = true), ui.debug);
        itinerary = await engine.call("plan", { event, options: { beam: ui.beam, trace: true } }, live.push);
        await live.finish();
        if (generation === planGeneration) break;
        narrate("Settings changed — planning again…");
      }
      ui.itinerary = itinerary;
      ui.alternatives = null;
      ui.status = `${state.planSummary(event, itinerary)}.`;
      planned = true;
      draw();
      requestAnimationFrame(() => revealItinerary(map, true));
    });
    scan.hidden = true;
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
  edit({ field, ci, si, ri, ii, gi, key }, input) {
    const number = Number(input.value);
    // Debug tunables touch feel, not the event: the plan stays valid.
    if (field === "debug") {
      ui.debug[key] = number;
      localStorage.setItem(DEBUG_KEY, JSON.stringify(ui.debug));
      return;
    }
    const course = event.courses[ci];
    const racer = event.racers[ri];
    const s = event.spectator;
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
      racerPrefer: () => (racer.prefer = input.value),
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
        s.speed_mps = number > 0 ? number / ui.unit.speedPerMps : null;
        rebuildNetwork();
      },
      radius: () => (s.sighting_radius_m = number),
      skipStart: () => (s.skip_start_m = number / ui.unit.perMetre),
      buffer: () => (s.safety_buffer_s = number * 60),
      minStop: () => (s.min_stop_s = number * 60),
      spacing: () => (s.viewpoint_spacing_m = number),
      decay: () => (s.objective.repeat_decay = number),
      requireFinishes: () => (s.objective.require_finishes = input.checked),
      courseClosed: () => (s.course_closed = input.checked),
      beam: () => (ui.beam = number),
    };
    mutate(() => edits[field]?.());
  },
};

/** Tries looser settings after a plan and offers any that do clearly better; stops if a newer plan starts. */
async function exploreAlternatives(generation) {
  if (!ui.itinerary) return;
  const snapshot = structuredClone(event);
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
      if (state.betterPlan(state.planLevels(variant, itinerary), base)) found.push({ alt, variant, itinerary });
    } catch {
      // A variant that cannot be planned is simply not offered.
    }
  }
  if (generation !== planGeneration) return;
  ui.alternatives = found;
  draw();
}

/** Status changes every frame during planning; rebuilding the whole panel that often would drop input focus. */
function narrate(text) {
  ui.status = text;
  const status = panel.querySelector("[data-status]");
  if (status) status.textContent = text;
  mapStatus.textContent = text;
}

function download(filename, text, type) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Builds the network for the current settings. If the settings change while the engine is at
 * it, the result is stale: it is dropped and the build starts over.
 */
async function buildNetwork() {
  for (;;) {
    const generation = planGeneration;
    const { mode, speed_mps } = event.spectator;
    const network = await engine.call("network", { osm: ui.osm, origin: event.origin, mode, speed: speed_mps });
    if (generation === planGeneration) {
      ui.network = network;
      return `Network: ${network.nodes} nodes, ${network.edges} edges.`;
    }
  }
}

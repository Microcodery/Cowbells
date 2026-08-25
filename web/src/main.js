// The app: map, panel, and engine wired together, and the actions the panel fires.

import "./style.css";
import { exploreAlternatives } from "./alternatives.js";
import { debugDefaults } from "./debug.js";
import { createEngine } from "./engine.js";
import {
  addCourse,
  addPoint,
  addRacer,
  addRegion,
  assignCourse,
  looksLikeEvent,
  mergeInterval,
  deletePoint,
  insertPoint,
  mergeWithNext,
  movePoint,
  moveSegmentBoundary,
  movePaceBoundary,
  newEvent,
  rebase,
  reconcileProfiles,
  removeCourse,
  splitInterval,
  splitSegment,
  redoPoint,
  undoPoint,
} from "./event.js";
import { UNITS, laterThan, parsePace, todayAt, withClock } from "./format.js";
import { invalidatePlan, planGeneration } from "./generation.js";
import { arrivalsAt, distanceAlong, largestCourse, nearestOnCourses, nearestOnEachCourse, nearestVertex } from "./geo.js";
import { itineraryToGpx } from "./gpx.js";
import { createMap, currentTheme, fitTo, flyTo, mapCenter, render as renderMap, replayCanvas, revealItinerary, setHover, setTheme } from "./map.js";
import { createMapData } from "./mapdata.js";
import { overlay } from "./overlay.js";
import { closeDialog, openDialog, renderHeader, renderHoverTip, renderMapMenu, renderPanel, setStatus } from "./panel.js";
import { planSummary } from "./plans.js";
import { liveReplay } from "./replay.js";

const EVENT_KEY = "cowbells.event";
const UNITS_KEY = "cowbells.units";
const DEBUG_KEY = "cowbells.debug";
const SNAP_KEY = "cowbells.snap";
const DEFAULT_CENTER = { lat: 45.5231, lon: -122.6765 };
const AUTOSAVE_DELAY_MS = 500;

const engine = createEngine();
const ui = {
  tool: null,
  itinerary: null,
  network: null,
  osm: null,
  // The area `osm` was fetched for; courses outside it trigger a new fetch.
  osmArea: null,
  status: "Draw a course to begin.",
  busy: false,
  beam: 64,
  unit: UNITS[storedChoice(UNITS_KEY, UNITS, "mi")],
  debug: loadDebug(),
  // `null` while alternatives are still being explored; then the ones that beat the plan.
  alternatives: null,
  // Points taken back per course, newest last, so drawing can be walked backwards and forwards.
  undone: {},
  // The course whose shape is open for editing; its points are the ones the map offers.
  editing: null,
  // What the map is asking about: a point of the course, or the line between two of them.
  menu: null,
  // The point a move has taken hold of, waiting to be put down.
  held: null,
  // Where a new or moved point may land. Remembered now; snapping itself is still to come.
  snap: loadSnap(),
};

/** The course's stack of taken-back points, started on first use. */
const undoneFor = (course) => (ui.undone[course.id] ??= []);
let event = loadSaved() ?? newEvent(DEFAULT_CENTER);
let autosave;
/** The spot on a course the hover tip points at, so the tip rides along when the map moves. */
let hoverAnchor = null;

const editingIndex = () => {
  const index = event.courses.findIndex((c) => c.id === ui.editing);
  return index === -1 ? null : index;
};

const header = document.getElementById("top");
const panel = document.getElementById("panel");
const hoverTip = document.getElementById("hover");
const mapMenu = document.getElementById("mapmenu");
const mapStatus = document.getElementById("mapstatus");
const scan = document.getElementById("scan");
const map = createMap("map", event.origin, onMapClick, onMapHover);
const overlayCanvas = overlay(map);
const mapdata = createMapData({
  engine,
  ui,
  currentEvent: () => event,
  fallbackCenter: () => mapCenter(map),
  narrate,
  render,
});

map.on("layers-ready", render);
map.once("layers-ready", () => mapdata.restore());
map.on("move", placeHoverTip);
map.on("move", placeMapMenu);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMapMenu());
window.cowbells = { map, event: () => event };

/** A preference chosen on an earlier visit, or `fallback` when it is missing or no longer offered. */
function storedChoice(key, table, fallback) {
  const stored = localStorage.getItem(key);
  return stored in table ? stored : fallback;
}

function loadSnap() {
  try {
    return { roads: true, paths: true, ...JSON.parse(localStorage.getItem(SNAP_KEY) ?? "{}") };
  } catch {
    return { roads: true, paths: true };
  }
}

function loadDebug() {
  try {
    return { ...debugDefaults(), ...JSON.parse(localStorage.getItem(DEBUG_KEY) ?? "{}") };
  } catch {
    return debugDefaults();
  }
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(EVENT_KEY));
    return looksLikeEvent(saved) ? saved : null;
  } catch {
    return null;
  }
}

function render() {
  renderHeader(header, event, ui, actions);
  renderPanel(panel, event, ui, actions);
  mapStatus.textContent = ui.status;
  mapStatus.hidden = !ui.status;
  renderMap(map, event, ui.itinerary, editingIndex());
  renderMapMenu(mapMenu, ui.menu, ui, actions);
  placeMapMenu();
  clearTimeout(autosave);
  autosave = setTimeout(() => localStorage.setItem(EVENT_KEY, JSON.stringify(event)), AUTOSAVE_DELAY_MS);
}

/** Status changes every frame during planning; rebuilding the whole panel that often would drop input focus. */
function narrate(text) {
  ui.status = text;
  setStatus(panel, text);
  mapStatus.textContent = text;
}

/** Apply an edit to the event; any plan, and any search for alternatives to it, is stale afterwards. */
function mutate(edit) {
  edit();
  ui.menu = null;
  ui.held = null;
  reconcileProfiles(event);
  ui.itinerary = null;
  invalidatePlan();
  render();
  mapdata.schedule();
}

/** Run async work with the panel locked and its outcome in the status line. */
async function run(label, work) {
  if (ui.busy) return;
  ui.busy = true;
  ui.status = label;
  render();
  try {
    await work();
  } catch (err) {
    ui.status = `Error: ${err.message}`;
  } finally {
    ui.busy = false;
    render();
  }
}

/** Take on a freshly loaded event and whatever map data came with it. */
async function adoptEvent(loaded, osm, loadedMessage) {
  event = loaded;
  ui.itinerary = null;
  ui.alternatives = null;
  // The old event's editing state means nothing to this one, and its courses may not even exist.
  Object.assign(ui, { tool: null, editing: null, undone: {} });
  showCourses();
  ui.status = (await mapdata.adopt(osm)) ?? loadedMessage;
}

/** Frame the longest course, with a margin, whenever a new event arrives. */
function showCourses() {
  const longest = largestCourse(event);
  if (longest) fitTo(map, longest.segments.flatMap((s) => s.points), ui.debug.fitMargin / 100);
  else flyTo(map, event.origin);
}

/** On phones the panel covers the map; planning closes it so the progress is visible. */
const closePanelOnPhones = () => matchMedia("(max-width: 700px)").matches && document.body.classList.remove("panel-open");

function toggleTool(kind, courseIndex) {
  const same = ui.tool?.kind === kind && ui.tool.courseIndex === courseIndex;
  Object.assign(ui, { menu: null, held: null });
  ui.tool = same ? null : { kind, courseIndex };
  render();
}

function onMapClick(latlon, metresPerPixel) {
  const tool = ui.tool;
  if (!tool && ui.editing) return onEditClick(latlon, metresPerPixel);
  // Off the course being edited, with no tool active, a tap is a hover: phones cannot hover.
  if (!tool) return onMapHover(latlon, metresPerPixel);
  mutate(() => {
    if (tool.kind === "draw") {
      const course = event.courses[tool.courseIndex];
      addPoint(course, latlon);
      // A fresh point is a new branch: what was taken back before it can no longer be put back.
      ui.undone[course.id] = [];
    }
    if (tool.kind === "start") event.spectator.start = latlon;
    if (tool.kind === "end") event.spectator.end = { location: latlon, latest: event.spectator.earliest + 4 * 3600 };
    if (tool.kind === "region") addRegion(event, latlon);
    if (tool.kind === "split") {
      const hit = nearestOnCourses(event, latlon);
      if (hit && hit.courseIndex === tool.courseIndex) {
        splitSegment(event.courses[hit.courseIndex], hit.segmentIndex, hit.pointIndex, hit.latlon);
      }
    }
    if (tool.kind !== "draw") ui.tool = null;
  });
}

/**
 * While a course is open for editing, the map answers clicks about its shape: a point offers to
 * move or go, the line between points offers a new one, and anywhere else puts the question away.
 */
/**
 * Runs a reshaping of the course being edited on what the menu points at. An edit the course
 * refuses changes nothing, so the plan it already has survives it.
 */
function reshape(edit) {
  const course = event.courses[editingIndex()];
  const menu = ui.menu;
  ui.menu = null;
  if (!course || !menu) return render();
  const changed = edit(course, menu);
  // Drawing has moved on, so points taken back before it can no longer be put back.
  if (changed) ui.undone[course.id] = [];
  return changed ? mutate(() => {}) : render();
}

function closeMapMenu() {
  if (!ui.menu && !ui.held) return;
  ui.menu = null;
  ui.held = null;
  render();
}

function onEditClick(latlon, metresPerPixel) {
  const index = editingIndex();
  const course = event.courses[index];
  if (!course) return;
  const held = ui.held;
  if (held) {
    Object.assign(ui, { held: null, menu: null });
    if (movePoint(course, held.segmentIndex, held.pointIndex, latlon)) return mutate(() => {});
    return render();
  }
  const reach = ui.debug.hoverPx * metresPerPixel;
  const vertex = nearestVertex(course, latlon);
  if (vertex && vertex.metres <= reach) {
    const { segmentIndex, pointIndex } = vertex;
    ui.menu = { kind: "point", at: course.segments[segmentIndex].points[pointIndex], segmentIndex, pointIndex };
  } else {
    const hit = nearestOnEachCourse(event, latlon).find((h) => h.courseIndex === index);
    const { segmentIndex, pointIndex, latlon: on } = hit ?? {};
    ui.menu = hit && hit.metres <= reach ? { kind: "line", at: on, segmentIndex, pointIndex } : null;
  }
  render();
}

/**
 * Keeps the menu on the spot it was opened at as the map moves under it, and inside the map:
 * it sits above the spot unless the top is in the way, and never past a side or the header.
 */
function placeMapMenu() {
  if (!ui.menu) return;
  const at = map.project([ui.menu.at.lon, ui.menu.at.lat]);
  const menu = mapMenu.getBoundingClientRect();
  const within = map.getContainer().getBoundingClientRect();
  const margin = 8;
  const ceiling = Math.max(header.getBoundingClientRect().bottom - within.top, 0) + margin;
  const above = at.y - menu.height - 10;
  const half = menu.width / 2;
  mapMenu.style.left = `${Math.min(Math.max(at.x, half + margin), within.width - half - margin)}px`;
  mapMenu.style.top = `${above < ceiling ? at.y + 14 : above}px`;
}

/** Hovering a course marks the spot and lists when each racer on it should pass. */
function onMapHover(latlon, metresPerPixel) {
  // Editing asks about the shape, not the racers; arrival times would only crowd the menu.
  const hits = latlon && !ui.editing ? nearestOnEachCourse(event, latlon).filter((h) => h.metres <= ui.debug.hoverPx * metresPerPixel) : [];
  if (!hits.length) {
    hoverAnchor = null;
    setHover(map, null);
    hoverTip.hidden = true;
    return;
  }
  renderHoverTip(
    hoverTip,
    hits.map((hit) => {
      const course = event.courses[hit.courseIndex];
      const metres = distanceAlong(course, hit);
      return { course, metres, arrivals: arrivalsAt(event, course, metres) };
    }),
    ui.unit,
  );
  const nearest = hits.reduce((a, b) => (b.d2 < a.d2 ? b : a));
  hoverAnchor = nearest.latlon;
  placeHoverTip();
  hoverTip.hidden = false;
  setHover(map, nearest.latlon, nearest.courseIndex);
}

/** The tip sits beside the spot on the course, so it rides along when the map pans or zooms. */
function placeHoverTip() {
  if (!hoverAnchor) return;
  const point = map.project([hoverAnchor.lon, hoverAnchor.lat]);
  hoverTip.style.left = `${point.x + 14}px`;
  hoverTip.style.top = `${point.y + 14}px`;
}

function download(filename, text, type) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

const actions = {
  addCourse() {
    mutate(() => addCourse(event));
    ui.editing = event.courses.at(-1).id;
    ui.tool = { kind: "draw", courseIndex: event.courses.length - 1 };
    render();
  },
  editCourse({ ci }) {
    const course = event.courses[ci];
    ui.editing = ui.editing === course.id ? null : course.id;
    Object.assign(ui, { tool: null, menu: null, held: null });
    setHover(map, null);
    hoverTip.hidden = true;
    render();
  },
  removeCourse({ ci }) {
    const { id } = event.courses[ci];
    delete ui.undone[id];
    if (ui.editing === id) ui.editing = null;
    mutate(() => {
      removeCourse(event, event.courses[ci]);
      ui.tool = null;
    });
  },
  draw({ ci }) {
    toggleTool("draw", Number(ci));
  },
  undo({ ci }) {
    const course = event.courses[ci];
    mutate(() => {
      const undone = undoPoint(course);
      if (undone) undoneFor(course).push(undone);
    });
  },
  redo({ ci }) {
    const course = event.courses[ci];
    const undone = undoneFor(course).pop();
    if (undone) mutate(() => redoPoint(course, undone));
  },
  split({ ci }) {
    toggleTool("split", Number(ci));
  },
  movePoint() {
    const { segmentIndex, pointIndex } = ui.menu;
    ui.held = { segmentIndex, pointIndex };
    render();
  },
  deletePoint() {
    reshape((course, { segmentIndex, pointIndex }) => deletePoint(course, segmentIndex, pointIndex));
  },
  addPointHere() {
    reshape((course, { segmentIndex, pointIndex, at }) => insertPoint(course, segmentIndex, pointIndex, at));
  },
  merge({ ci, si }) {
    mutate(() => mergeWithNext(event.courses[ci], Number(si)));
  },
  addRacer() {
    mutate(() => addRacer(event, event.courses[0]));
  },
  removeRacer({ ri }) {
    mutate(() => event.racers.splice(Number(ri), 1));
  },
  splitInterval({ ri, ii }) {
    const interval = event.racers[ri].pace_profile[ii];
    mutate(() => splitInterval(event.racers[ri], Number(ii), (interval.start_m + interval.end_m) / 2));
  },
  mergeInterval({ ri, ii }) {
    mutate(() => mergeInterval(event.racers[ri], Number(ii)));
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
    setTheme(map, currentTheme() === "dark" ? "light" : "dark");
  },
  units() {
    const next = ui.unit === UNITS.km ? "mi" : "km";
    ui.unit = UNITS[next];
    localStorage.setItem(UNITS_KEY, next);
    render();
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
  showDialog({ dialog }) {
    openDialog(panel, dialog);
  },
  hideDialog({ dialog }) {
    closeDialog(panel, dialog);
  },
  async load(_, input) {
    const [file] = input.files;
    if (file) await actions.loadFile(file);
  },
  async loadFile(file) {
    closeDialog(panel, "load");
    const text = await file.text();
    await run("Loading…", async () => {
      const saved = JSON.parse(text);
      const loaded = saved.event ?? saved;
      if (!looksLikeEvent(loaded)) throw new Error("not a .bird event file");
      await adoptEvent(loaded, saved.osm, "Loaded.");
    });
  },
  async example({ example: name }) {
    closeDialog(panel, "load");
    await run("Loading example…", async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}examples/${name}.bird`);
      if (!response.ok) throw new Error(`example ${name} not found`);
      const saved = await response.json();
      rebase(saved.event, todayAt("09:00"));
      await adoptEvent(saved.event, saved.osm, "Example loaded.");
    });
  },
  async importCourses(_, input) {
    const file = input.files[0];
    if (!file) return;
    const bytes = await file.arrayBuffer();
    await run(`Reading ${file.name}…`, async () => {
      const courses = await engine.call("courses", { name: file.name, bytes });
      for (const course of courses) {
        course.start_time = event.spectator.earliest;
        event.courses.push(course);
      }
      ui.itinerary = null;
      if (courses.length) showCourses();
      ui.status = `Imported ${courses.length} course(s).`;
    });
    mapdata.ensure();
  },
  togglePanel() {
    document.body.classList.toggle("panel-open");
  },
  reset() {
    if (!confirm("Start over? This clears the courses, racers, settings, and fetched map data.")) return;
    event = newEvent(mapCenter(map));
    mapdata.clear();
    Object.assign(ui, { itinerary: null, alternatives: null, tool: null, undone: {}, editing: null, menu: null, held: null, status: "Draw a course to begin." });
    localStorage.removeItem(EVENT_KEY);
    invalidatePlan();
    render();
  },
  async plan() {
    let planned = false;
    closePanelOnPhones();
    // Nothing to show until the engine reports; a scan across the map says it is working.
    scan.hidden = false;
    await run("Planning…", async () => {
      if (!event.courses.length) throw new Error("draw or import a course first");
      if (!event.racers.length) throw new Error("add a racer first");
      // Map data is normally already in hand from the background fetch; otherwise wait for it.
      mapdata.cancelSchedule();
      await mapdata.ensure();
      if (!ui.osm) throw new Error("map data could not be fetched; try again in a moment");
      // The previous itinerary fades out while the engine's progress plays, and the new one fades in after.
      revealItinerary(map, false);
      let itinerary;
      // A settings change mid-plan makes the result stale: drop it and plan again with the new settings.
      for (;;) {
        const generation = planGeneration();
        await mapdata.awaitRebuild();
        if (!ui.network) narrate(await mapdata.buildNetwork());
        const problems = await engine.call("validate", { event });
        if (problems.length) throw new Error(problems.join("; "));
        const radius = event.spectator.sighting_radius_m;
        const live = liveReplay({ layers: replayCanvas(map), canvas: overlayCanvas }, radius, ui.debug, narrate, () => (scan.hidden = true));
        try {
          itinerary = await engine.call("plan", { event, options: { beam: ui.beam, trace: true } }, live.push);
        } finally {
          // However the plan ended, the replay owns an animation loop that has to be stopped.
          await live.finish();
        }
        if (generation === planGeneration()) break;
        narrate("Settings changed — planning again…");
      }
      ui.itinerary = itinerary;
      ui.alternatives = null;
      ui.status = `${planSummary(event, itinerary)}.`;
      planned = true;
      render();
      requestAnimationFrame(() => revealItinerary(map, true));
    });
    scan.hidden = true;
    if (planned) {
      const generation = invalidatePlan();
      exploreAlternatives({ engine, event, ui, generation, render }).catch((err) => console.error("alternatives", err));
    }
  },
  async useAlternative({ alt }) {
    const { variant, itinerary } = ui.alternatives[Number(alt)];
    await run("Switching…", async () => {
      event.spectator = variant.spectator;
      ui.itinerary = itinerary;
      // Already loosened once; offering further loosening would chase diminishing returns.
      ui.alternatives = [];
      ui.status = `${planSummary(event, itinerary)}. ${await mapdata.buildNetwork()}`;
    });
  },
  resetDebug() {
    ui.debug = debugDefaults();
    localStorage.removeItem(DEBUG_KEY);
    render();
  },
  edit({ field, ci, si, ri, ii, gi, key }, input) {
    const number = Number(input.value);
    // Debug tunables touch feel, not the event: the plan stays valid.
    if (field === "snapRoads" || field === "snapPaths") {
      ui.snap[field === "snapRoads" ? "roads" : "paths"] = input.checked;
      localStorage.setItem(SNAP_KEY, JSON.stringify(ui.snap));
      return;
    }
    if (field === "debug") {
      ui.debug[key] = number;
      localStorage.setItem(DEBUG_KEY, JSON.stringify(ui.debug));
      return;
    }
    // How hard to search is not part of the event either, but the next plan must use it.
    if (field === "beam") {
      ui.beam = number;
      invalidatePlan();
      return;
    }
    const course = event.courses[ci];
    const racer = event.racers[ri];
    const s = event.spectator;
    const edits = {
      name: () => (event.name = input.value),
      courseName: () => (course.name = input.value),
      courseStart: () => (course.start_time = withClock(course.start_time, input.value)),
      segmentMode: () => (course.segments[si].mode = input.value),
      segmentStart: () => moveSegmentBoundary(course, Number(si) - 1, number / ui.unit.perMetre),
      segmentEnd: () => moveSegmentBoundary(course, Number(si), number / ui.unit.perMetre),
      viewable: () => (course.segments[si].viewable = input.checked),
      racerName: () => (racer.name = input.value),
      racerCourse: () => assignCourse(racer, event.courses.find((c) => c.id === input.value)),
      racerOffset: () => (racer.start_offset_s = number * 60),
      racerPriority: () => (racer.priority = number),
      racerPrefer: () => (racer.prefer = input.value),
      paceBoundary: () => movePaceBoundary(racer, Number(ii), number / ui.unit.perMetre),
      pace: () => (racer.pace_profile[ii].seconds_per_km = parsePace(input.value, ui.unit) ?? racer.pace_profile[ii].seconds_per_km),
      uncertainty: () => (racer.pace_profile[ii].uncertainty = number / 100),
      earliest: () => (s.earliest = withClock(s.earliest, input.value)),
      latest: () => (s.latest = input.value ? laterThan(s.earliest, input.value) : null),
      endLatest: () => (s.end.latest = withClock(s.end.latest, input.value)),
      regionRadius: () => (s.required_regions[gi].radius_m = number),
      travel: () => {
        s.mode = input.value;
        s.speed_mps = null;
        mapdata.rebuildNetwork();
      },
      speed: () => {
        s.speed_mps = number > 0 ? number / ui.unit.speedPerMps : null;
        mapdata.rebuildNetwork();
      },
      radius: () => (s.sighting_radius_m = number),
      skipStart: () => (s.skip_start_m = number / ui.unit.perMetre),
      buffer: () => (s.safety_buffer_s = number * 60),
      minStop: () => (s.min_stop_s = number * 60),
      spacing: () => (s.viewpoint_spacing_m = number),
      racerRequireFinish: () => (racer.require_finish = input.checked),
      courseClosed: () => (s.course_closed = input.checked),
    };
    mutate(() => edits[field]());
  },
};

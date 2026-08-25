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
} from "./event.js";
import { UNITS, laterThan, parsePace, todayAt, withClock } from "./format.js";
import { invalidatePlan, planGeneration } from "./generation.js";
import { alongPolyline, arrivalsAt, between, distanceAlong, largestCourse, nearestOnEachCourse, polylineLength } from "./geo.js";
import { itineraryToGpx } from "./gpx.js";
import { createMap, currentTheme, fitTo, flyTo, mapCenter, render as renderMap, replayCanvas, revealItinerary, setEditing, setHover, setTheme } from "./map.js";
import { createMapData } from "./mapdata.js";
import { overlay } from "./overlay.js";
import { closeDialog, openDialog, renderHeader, renderHoverTip, renderMapMenu, renderPanel, setStatus } from "./panel.js";
import { planSummary } from "./plans.js";
import { liveReplay } from "./replay.js";
import { endGesture, redo, reshape, undo } from "./shapes.js";

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
  // Shapes each course has had, so any change to one can be walked backwards and forwards.
  shapes: {},
  // The course whose shape is open for editing; its points are the ones the map offers.
  editing: null,
  // What the pointer is over on the course being edited: one of its points, or the line between two.
  hot: null,
  // A point clicked rather than dragged, which is the one the bin would take away.
  selected: null,
  // The point a drag has hold of, holding where the pointer is so the event does not have to.
  held: null,
  // The racer whose name is open for typing over.
  renaming: null,
  // Where a new or moved point may land. Remembered now; snapping itself is still to come.
  snap: loadSnap(),
};

const reshapeCourse = (course, change, gesture) => reshape(ui.shapes, course, change, gesture);

let event = loadSaved() ?? newEvent(DEFAULT_CENTER);
let autosave;
/** The map redraw already asked for, so pointer moves that arrive before it still make only one. */
let mapFrame = null;
/** A fingertip covers far more than a cursor, so what counts as near enough opens up to suit it. */
const FINGER_ALLOWANCE = matchMedia("(pointer: coarse)").matches ? 2.2 : 1;
/** Ticks this far apart are separate goes at a field rather than one spinner being held down. */
const GESTURE_IDLE_MS = 400;
let gestureIdle;
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
const map = createMap("map", event.origin, {
  press: onMapPress,
  drag: onMapDrag,
  drop: onMapDrop,
  cancel: clearSelection,
  click: onMapClick,
  doubleClick: onMapDoubleClick,
  hover: onMapHover,
});
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
document.addEventListener("keydown", (e) => e.key === "Escape" && clearSelection());
window.cowbells = { map, event: () => event, shapes: () => ui.shapes };

/** A preference chosen on an earlier visit, or `fallback` when it is missing or no longer offered. */
function storedChoice(key, table, fallback) {
  const stored = localStorage.getItem(key);
  return stored in table ? stored : fallback;
}

function loadSnap() {
  try {
    return { roads: false, paths: false, ...JSON.parse(localStorage.getItem(SNAP_KEY) ?? "{}") };
  } catch {
    return { roads: false, paths: false };
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
  // Derived here rather than at each place editing starts or stops, so none can forget it.
  setEditing(map, editingIndex() !== null);
  renderMap(map, event, ui.itinerary, editingIndex(), ui.held, ui.hot);
  renderMapMenu(mapMenu, ui.selected, actions);
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
  releaseHeld();
  edit();
  Object.assign(ui, { selected: null, hot: null });
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
  Object.assign(ui, { tool: null, editing: null, shapes: {}, selected: null, hot: null, held: null, renaming: null });
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
  releaseHeld();
  Object.assign(ui, { selected: null, hot: null });
  ui.tool = same ? null : { kind, courseIndex };
  render();
}

/** How near a click has to land to count as grabbing something, measured where the user sees it. */
function withinReach(latlon, at) {
  if (!at) return false;
  const p = map.project([latlon.lon, latlon.lat]);
  return Math.hypot(p.x - at.x, p.y - at.y) <= ui.debug.hoverPx;
}

/** The place on the line from `a` to `b` closest to `p`, all in screen pixels. */
function closestOnLine(a, b, p) {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const span = dx * dx + dy * dy;
  const fraction = span ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / span)) : 0;
  return { fraction, pixels: Math.hypot(a.x + fraction * dx - p.x, a.y + fraction * dy - p.y) };
}

/**
 * What a spot on screen is over: the course's nearest drawn point if one is within reach, else the
 * nearest place along its line. Both the choosing and the reach are in pixels, because a tilted map
 * stretches the ground unevenly and a click means what it looks like it means.
 */
function whatIsUnder(course, at) {
  if (!at) return null;
  const reach = ui.debug.hoverPx * FINGER_ALLOWANCE;
  const screen = course.segments.map((segment) => segment.points.map((p) => map.project([p.lon, p.lat])));
  let vertex = null;
  screen.forEach((points, segmentIndex) => {
    points.forEach((p, pointIndex) => {
      const pixels = Math.hypot(p.x - at.x, p.y - at.y);
      if (!vertex || pixels < vertex.pixels) vertex = { kind: "point", segmentIndex, pointIndex, pixels };
    });
  });
  if (vertex && vertex.pixels <= reach) {
    return { ...vertex, at: course.segments[vertex.segmentIndex].points[vertex.pointIndex] };
  }
  let line = null;
  screen.forEach((points, segmentIndex) => {
    for (let i = 0; i + 1 < points.length; i++) {
      const { fraction, pixels } = closestOnLine(points[i], points[i + 1], at);
      if (!line || pixels < line.pixels) line = { kind: "line", segmentIndex, pointIndex: i, fraction, pixels };
    }
  });
  if (!line || line.pixels > reach) return null;
  const points = course.segments[line.segmentIndex].points;
  return { ...line, at: between(points[line.pointIndex], points[line.pointIndex + 1], line.fraction) };
}

function onMapClick(latlon, at) {
  const tool = ui.tool;
  if (!tool && ui.editing) return onEditClick(latlon, at);
  // Off any course, with no tool active, a tap is a hover: phones cannot hover.
  if (!tool) return onMapHover(latlon, at);
  mutate(() => {
    if (tool.kind === "start") event.spectator.start = latlon;
    if (tool.kind === "end") event.spectator.end = { location: latlon, latest: event.spectator.earliest + 4 * 3600 };
    if (tool.kind === "region") addRegion(event, latlon);
    ui.tool = null;
  });
}

/** The course open for editing, if one is. */
const editedCourse = () => event.courses[editingIndex()] ?? null;

/**
 * A click on the course being edited that was not a drag. On the line it does nothing — the line's
 * settings live in the course card. Away from the course it puts down whatever was picked out, or,
 * with nothing picked out, draws the course on to where the click landed.
 */
function onEditClick(latlon, at) {
  const course = editedCourse();
  if (!course) return;
  if (whatIsUnder(course, at)) return clearSelection();
  if (ui.selected) return clearSelection();
  reshapeCourse(course, () => addPoint(course, latlon));
  mutate(() => {});
}

/** Takes hold of a point when the press lands on one, so the map drags it instead of panning. */
function onMapPress(latlon, at) {
  const course = ui.tool ? null : editedCourse();
  if (!course) return false;
  const under = whatIsUnder(course, at);
  if (under?.kind !== "point") return false;
  const { segmentIndex, pointIndex } = under;
  ui.held = { segmentIndex, pointIndex, at: course.segments[segmentIndex].points[pointIndex] };
  ui.selected = null;
  render();
  return true;
}

function onMapDrag(latlon) {
  if (ui.held) trackHeld(ui.held, latlon);
}

/**
 * Lets a dragged point go. A press that never strayed was a click on the point rather than a drag,
 * and picks it out so it can be taken away; one that travelled moves it to where it was let go.
 */
function onMapDrop(latlon, at, strayed) {
  const held = ui.held;
  const course = editedCourse();
  releaseHeld();
  if (!held || !course) return render();
  if (!strayed) {
    ui.selected = { segmentIndex: held.segmentIndex, pointIndex: held.pointIndex, at: held.at };
    return render();
  }
  if (reshapeCourse(course, () => movePoint(course, held.segmentIndex, held.pointIndex, latlon))) {
    return mutate(() => {});
  }
  ui.status = "That point is no longer there to move.";
  render();
}

/** A double click on the course being edited puts a new point where it landed. */
function onMapDoubleClick(latlon, at) {
  const course = ui.tool ? null : editedCourse();
  if (!course) return;
  const under = whatIsUnder(course, at);
  if (under?.kind !== "line") return;
  reshapeCourse(course, () => insertPoint(course, under.segmentIndex, under.pointIndex, under.at));
  mutate(() => {});
}

function clearSelection() {
  if (!ui.selected && !ui.held) return;
  releaseHeld();
  ui.selected = null;
  render();
}

/**
 * A carried point rides with the cursor. The cursor's place is held in `ui`, never in the event,
 * so a plan, a save, or an export taken mid-drag reads the course as it will be when it lands.
 */
function trackHeld(held, latlon) {
  held.at = latlon;
  redrawMapSoon();
}

/**
 * Redraws the map on the next frame. Pointer moves outrun the redraw and every source it sets
 * re-tiles, so a flurry of them still costs only the one.
 */
function redrawMapSoon() {
  if (mapFrame) return;
  mapFrame = requestAnimationFrame(() => {
    mapFrame = null;
    renderMap(map, event, ui.itinerary, editingIndex(), ui.held, ui.hot);
  });
}

/**
 * Moves a segment boundary from its field. A spinner held down fires one of these a tick, and they
 * all undo together; the run ends when the ticks stop, since letting go of a spinner is silent and
 * the panel takes the focus off the field itself on every redraw.
 */
function nudgeBoundary(course, index, shown) {
  clearTimeout(gestureIdle);
  gestureIdle = setTimeout(() => endGesture(ui.shapes, course), GESTURE_IDLE_MS);
  return reshapeCourse(course, () => moveSegmentBoundary(course, index, shown / ui.unit.perMetre), `boundary:${course.id}:${index}`);
}

/** Ends a carry. The event never held the cursor's place, so there is nothing to put back. */
function releaseHeld() {
  if (!ui.held) return;
  cancelAnimationFrame(mapFrame);
  mapFrame = null;
  ui.held = null;
}

/**
 * Keeps the bin over the point it belongs to as the map moves under it, and inside the map: it
 * sits above the point unless the top is in the way, and never past a side or the header.
 */
function placeMapMenu() {
  if (!ui.selected) return;
  const at = map.project([ui.selected.at.lon, ui.selected.at.lat]);
  const menu = mapMenu.getBoundingClientRect();
  const within = map.getContainer().getBoundingClientRect();
  const margin = 8;
  const ceiling = Math.max(header.getBoundingClientRect().bottom - within.top, 0) + margin;
  const above = at.y - menu.height - 10;
  const half = menu.width / 2;
  mapMenu.style.left = `${Math.min(Math.max(at.x, half + margin), within.width - half - margin)}px`;
  mapMenu.style.top = `${above < ceiling ? at.y + 14 : above}px`;
}

/**
 * Lights up whatever the pointer is over on the course being edited, so what a press would take
 * hold of is never in doubt. Only the map is redrawn, and only when the answer changes.
 */
const sameSpot = (a, b) => a?.kind === b?.kind && a?.segmentIndex === b?.segmentIndex && a?.pointIndex === b?.pointIndex;

function highlightUnder(course, at) {
  const under = at ? whatIsUnder(course, at) : null;
  if (sameSpot(ui.hot, under)) return;
  ui.hot = under;
  redrawMapSoon();
}

/** Hovering a course marks the spot and lists when each racer on it should pass. */
function onMapHover(latlon, at) {
  if (ui.held && latlon) return trackHeld(ui.held, latlon);
  const editing = ui.tool ? null : editedCourse();
  // Editing asks about the shape, not the racers; arrival times would only get in the way.
  if (editing) return highlightUnder(editing, latlon ? at : null);
  const hits = latlon ? nearestOnEachCourse(event, latlon).filter((h) => withinReach(h.latlon, at)) : [];
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
    // A new course has no shape yet, so it opens ready for one: clicks on the map draw it.
    ui.editing = event.courses.at(-1).id;
    render();
  },
  endRename() {
    if (!ui.renaming) return;
    ui.renaming = null;
    render();
  },
  renameRacer({ ri }) {
    const racer = event.racers[ri];
    const card = panel.querySelector(`details[data-section="racer-${racer.id}"]`);
    // A closed card opens on the first click; the name gives way to a field only once it is open.
    if (card && !card.open) card.open = true;
    else ui.renaming = racer.id;
    render();
  },
  editCourse({ ci }) {
    const course = event.courses[ci];
    // A carried point only means anything for the course now closing; drop it before editing moves on.
    releaseHeld();
    ui.editing = ui.editing === course.id ? null : course.id;
    Object.assign(ui, { tool: null, selected: null, hot: null });
    setHover(map, null);
    hoverTip.hidden = true;
    render();
  },
  removeCourse({ ci }) {
    const { id } = event.courses[ci];
    delete ui.shapes[id];
    if (ui.editing === id) ui.editing = null;
    mutate(() => {
      removeCourse(event, event.courses[ci]);
      ui.tool = null;
    });
  },
  undo({ ci }) {
    releaseHeld();
    if (undo(ui.shapes, event.courses[ci])) mutate(() => {});
  },
  redo({ ci }) {
    releaseHeld();
    if (redo(ui.shapes, event.courses[ci])) mutate(() => {});
  },
  splitSegment({ ci, si }) {
    const course = event.courses[ci];
    const points = course.segments[Number(si)]?.points ?? [];
    const cut = alongPolyline(points, polylineLength(points) / 2);
    if (!cut) return;
    mutate(() => reshapeCourse(course, () => splitSegment(course, Number(si), cut.pointIndex, cut.latlon)));
  },
  deletePoint() {
    const course = editedCourse();
    const point = ui.selected;
    if (!course || !point) return clearSelection();
    if (!reshapeCourse(course, () => deletePoint(course, point.segmentIndex, point.pointIndex))) {
      ui.status = "That point holds two segments together, or is the last the segment can spare.";
      return render();
    }
    ui.selected = null;
    mutate(() => {});
  },
  merge({ ci, si }) {
    const course = event.courses[ci];
    mutate(() => reshapeCourse(course, () => mergeWithNext(course, Number(si))));
  },
  addRacer() {
    mutate(() => addRacer(event, event.courses[0]));
  },
  removeRacer({ ri }) {
    ui.renaming = null;
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
    Object.assign(ui, { itinerary: null, alternatives: null, tool: null, shapes: {}, editing: null, selected: null, hot: null, held: null, renaming: null, status: "Draw a course to begin." });
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
      // Held spinners nudge a boundary a tick at a time; all of one boundary's ticks undo together.
      segmentStart: () => nudgeBoundary(course, Number(si) - 1, number),
      segmentEnd: () => nudgeBoundary(course, Number(si), number),
      viewable: () => (course.segments[si].viewable = input.checked),
      racerName: () => {
        racer.name = input.value;
        ui.renaming = null;
      },
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

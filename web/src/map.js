// MapLibre setup, themed styles, and the overlay layers drawn from state.

import { Map as MapLibre, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { arrowLines, courseEnds, overlapChunks } from "./courselines.js";
import { movedSlots } from "./event.js";
import { metresBetween } from "./geo.js";
import { ICON_PREFIX, icons } from "./icons.js";
import { stopLabel } from "./plans.js";
// MapLibre resolves its tile worker with a dynamic URL Vite cannot bundle; hand it a built one.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);

const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

const THEME_KEY = "cowbells.theme";
// A theme chosen on an earlier visit is applied before the first paint; with none, the system's
// preference stands and keeps following it.
const storedTheme = localStorage.getItem(THEME_KEY);
if (storedTheme in STYLES) document.documentElement.dataset.theme = storedTheme;

/** The colours courses are drawn in, in order; the panel marks each card with its own. */
export const COURSE_COLORS = ["#4078f2", "#e45649", "#50a14f", "#c18401", "#0184bc", "#986801", "#e06c75", "#5c6370"];

const SOURCES = [
  "courses",
  "course-lines",
  "course-overlaps",
  "course-ends",
  "vertices",
  "spectator",
  "regions",
  "stops",
  "legs",
  "replay-fills",
  "replay-lines",
  "replay-points",
  "hover",
];

export function createMap(container, center, pointer) {
  const map = new MapLibre({
    container,
    style: STYLES[currentTheme()],
    center: [center.lon, center.lat],
    zoom: 13,
    attributionControl: { compact: true },
  });
  map.addControl(new NavigationControl(), "top-right");
  followPointer(map, pointer);
  map.on("style.load", () => addLayers(map));
  return map;
}

/** Further than this from where a press landed and it is a drag, not a click. A finger is never as
 * still as a mouse, so it is given the room every platform's own tap slop allows. */
const slopFor = (pointerType) => (pointerType === "mouse" ? 4 : 10);

/** Two clicks closer together than this are one double click. */
const DOUBLE_CLICK_MS = 400;

/** The camera gestures a drag of our own has to hold off, so the ground stays put under the point. */
const CAMERA_GESTURES = ["dragPan", "dragRotate", "boxZoom", "touchZoomRotate", "touchPitch"];

/** Stops the map moving itself, and hands back a way to put every gesture back as it was found. */
function holdCamera(map) {
  const were = CAMERA_GESTURES.filter((gesture) => map[gesture]?.isEnabled());
  for (const gesture of were) map[gesture].disable();
  return () => {
    for (const gesture of were) map[gesture].enable();
  };
}

/**
 * Turns raw pointer events into what the map means by them: `press` is offered the spot and says
 * whether it is taking hold of something, and if it does the map stops panning until `drop`.
 * Pointer events rather than MapLibre's own, so a finger and a mouse travel the same path.
 */
function followPointer(map, { press, drag, drop, cancel, click, doubleClick, hover }) {
  const canvas = map.getCanvasContainer();
  /** The one pointer being followed. A second finger is the map's business, not ours. */
  let active = null;

  const spotOf = (e) => {
    const box = canvas.getBoundingClientRect();
    const at = { x: e.clientX - box.left, y: e.clientY - box.top };
    const { lat, lng } = map.unproject([at.x, at.y]);
    return { latlon: { lat, lon: lng }, at };
  };

  const isOtherButton = (e) => e.pointerType === "mouse" && e.button !== 0;

  canvas.addEventListener("pointerdown", (e) => {
    if (active || isOtherButton(e)) return;
    const { latlon, at } = spotOf(e);
    active = { id: e.pointerId, from: at, slop: slopFor(e.pointerType), strayed: false, holding: Boolean(press?.(latlon, at)) };
    if (!active.holding) return;
    active.freeCamera = holdCamera(map);
    // Capture keeps the drag ours even off the map. A pointer already gone cannot be captured, and
    // the drag is no worse for it, so a refusal is nothing to stop for.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
  });

  canvas.addEventListener("pointermove", (e) => {
    const { latlon, at } = spotOf(e);
    if (!active) return hover?.(latlon, at);
    if (e.pointerId !== active.id) return;
    if (Math.hypot(at.x - active.from.x, at.y - active.from.y) > active.slop) active.strayed = true;
    if (active.holding) drag?.(latlon, at);
  });

  /**
   * Ends the press however it ends, so the camera and anything held are always given back. A
   * cancelled gesture was taken away rather than finished, so it lets go without landing anything.
   */
  const letGo = (e) => {
    if (!active || e.pointerId !== active.id) return;
    if (e.type === "pointerup" && isOtherButton(e)) return;
    const { latlon, at } = spotOf(e);
    const { holding, strayed, freeCamera } = active;
    active = null;
    freeCamera?.();
    if (holding && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (e.type === "pointercancel") return holding ? cancel?.() : undefined;
    if (holding) return drop?.(latlon, at, strayed);
    if (!strayed && !isSecondOfDouble(e.timeStamp, at)) click?.(latlon, at);
  };

  /**
   * Whether this click is the second half of a double click, which belongs to that gesture alone.
   * Without it, double clicking away from the course would draw two points on top of each other.
   */
  let firstClick = null;
  function isSecondOfDouble(time, at) {
    const near = firstClick && time - firstClick.time < DOUBLE_CLICK_MS && Math.hypot(at.x - firstClick.x, at.y - firstClick.y) <= slopFor("mouse");
    firstClick = near ? null : { time, x: at.x, y: at.y };
    return Boolean(near);
  }
  canvas.addEventListener("pointerup", letGo);
  canvas.addEventListener("pointercancel", letGo);
  // A press let go off the map still has to end; without capture nothing on the map would say so.
  window.addEventListener("pointerup", letGo);

  canvas.addEventListener("dblclick", (e) => {
    const { latlon, at } = spotOf(e);
    doubleClick?.(latlon, at);
  });
  // A cursor off the map hovers nothing. A finger lifting also "leaves", but the tap it just
  // finished is what put the tip on screen, so touch keeps what it showed.
  canvas.addEventListener("pointerleave", (e) => e.pointerType !== "touch" && hover?.(null));
}

/** While a course is open for editing the map stops zooming on a double click, which adds a point. */
export function setEditing(map, editing) {
  if (editing) map.doubleClickZoom.disable();
  else map.doubleClickZoom.enable();
}

export function setTheme(map, theme) {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.dataset.theme = theme;
  map.setStyle(STYLES[theme]);
}

export function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function addLayers(map) {
  // The dark basemap draws one-way traffic arrows; they read as course direction, so hide them.
  for (const layer of map.getStyle().layers) {
    if (/oneway/.test(layer.id)) map.setLayoutProperty(layer.id, "visibility", "none");
  }
  for (const name of SOURCES) {
    map.addSource(name, { type: "geojson", data: empty() });
  }
  for (const [name, image] of Object.entries(icons())) {
    if (!map.hasImage(name)) map.addImage(name, image, { pixelRatio: 2 });
  }
  map.addLayer({ id: "regions", type: "fill", source: "regions", paint: { "fill-color": "#4078f2", "fill-opacity": 0.15 } });
  // Sighting circles sit under the course lines so the course stays readable during replay.
  map.addLayer({
    id: "replay-fills",
    type: "fill",
    source: "replay-fills",
    paint: { "fill-color": ["get", "color"], "fill-opacity": ["get", "opacity"] },
  });
  map.addLayer({
    id: "legs",
    type: "line",
    source: "legs",
    paint: { "line-color": "#f97316", "line-width": 4, "line-dasharray": [1, 1.5], "line-opacity-transition": { duration: 600 } },
  });
  // A hovered segment thickens, so it is clear which stretch a double click would add a point to.
  map.addLayer({
    id: "courses",
    type: "line",
    source: "courses",
    paint: { "line-color": ["get", "color"], "line-width": ["case", ["boolean", ["get", "hot"], false], 7, 4], "line-opacity": 0.85 },
  });
  // Stretches shared by several courses are redrawn on top as alternating stripes.
  map.addLayer({
    id: "course-overlaps",
    type: "line",
    source: "course-overlaps",
    layout: { "line-cap": "butt" },
    paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.9 },
  });
  // Arrows follow whole courses (minus stretches another course owns) so spacing is even.
  map.addLayer({
    id: "course-arrows",
    type: "symbol",
    source: "course-lines",
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 120,
      "icon-image": `${ICON_PREFIX}arrow`,
      "icon-size": 1,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
  map.addLayer({
    id: "vertices",
    type: "circle",
    source: "vertices",
    // The point under the cursor swells and fills, so it is plain which one a press would take.
    paint: {
      "circle-radius": ["case", ["boolean", ["get", "hot"], false], 7, 4],
      "circle-color": ["case", ["boolean", ["get", "hot"], false], ["get", "color"], "#fff"],
      "circle-stroke-color": ["case", ["boolean", ["get", "hot"], false], "#fff", ["get", "color"]],
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({ id: "spectator", type: "circle", source: "spectator", paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({
    id: "replay-lines",
    type: "line",
    source: "replay-lines",
    paint: { "line-color": ["get", "color"], "line-width": ["get", "width"], "line-opacity": ["get", "opacity"] },
  });
  map.addLayer({
    id: "replay-points",
    type: "circle",
    source: "replay-points",
    paint: { "circle-radius": ["get", "radius"], "circle-color": ["get", "color"], "circle-opacity": ["coalesce", ["get", "opacity"], 0.8] },
  });
  map.addLayer({
    id: "stops",
    type: "circle",
    source: "stops",
    paint: { "circle-radius": 11, "circle-color": "#f97316", "circle-stroke-color": "#fff", "circle-stroke-width": 2, "circle-opacity-transition": { duration: 600 } },
  });
  // Above the stop circle, which often sits right at the finish, but under its number.
  map.addLayer({
    id: "course-ends",
    type: "symbol",
    source: "course-ends",
    layout: { "icon-image": ["concat", ICON_PREFIX, ["get", "kind"]], "icon-size": 1.6, "icon-allow-overlap": true, "icon-ignore-placement": true },
  });
  map.addLayer({
    id: "stop-labels",
    type: "symbol",
    source: "stops",
    layout: { "text-field": ["get", "label"], "text-size": 12, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": "#fff", "text-opacity-transition": { duration: 600 } },
  });
  map.addLayer({
    id: "hover",
    type: "circle",
    source: "hover",
    paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 3 },
  });
  map.fire("layers-ready");
}

/** The dot marking the hovered spot on a course; `null` hides it. */
export function setHover(map, latlon, courseIndex) {
  if (!map.getSource("hover")) return;
  const features = latlon ? [feature(pointOf(latlon), { color: COURSE_COLORS[courseIndex % COURSE_COLORS.length] })] : [];
  map.getSource("hover").setData(collection(features));
}

/**
 * Metres to a pixel at the middle of the view, asked of the map rather than assumed from the zoom:
 * tile size and projection are the map's business, and a constant here would only agree with it by
 * luck. Tilting the map makes this a rough figure — the scale then varies down the screen — so it
 * is for drawing at a glance, not for deciding what a click landed on.
 */
export function metresPerPixel(map) {
  const canvas = map.getCanvas();
  const [x, y] = [canvas.clientWidth / 2, canvas.clientHeight / 2];
  if (!(x > 0 && y > 0)) return 0;
  // Stepping a pixel each way rather than a distance on the ground: the ground turns with the map,
  // and on a tilted one the two axes disagree, so the scale of a circle drawn here is their mean.
  // MapLibre speaks lng; the rest of the app speaks lon.
  const ground = (p) => ({ lat: p.lat, lon: p.lng });
  const here = ground(map.unproject([x, y]));
  const across = metresBetween(here, ground(map.unproject([x + 1, y])));
  const down = metresBetween(here, ground(map.unproject([x, y + 1])));
  return Math.sqrt(across * down);
}

/** The slots that show the carried point in place of the course's own, or null when none is held. */
function carriedSlots(course, held) {
  if (!held?.at) return null;
  const slots = movedSlots(course, held.segmentIndex, held.pointIndex);
  return slots.length ? new Set(slots.map(([si, pi]) => `${si}:${pi}`)) : null;
}

/**
 * Redraw every overlay; editing a course shows its points and leaves the other courses out of the
 * way. `hot` is whatever the pointer is over, drawn heavier so it is plain what a press would take.
 */
export function render(map, event, itinerary, editingCourse = null, held = null, hot = null) {
  if (!map.getSource("courses")) return;
  const courses = [];
  const vertices = [];
  const shapes = [];
  event.courses.forEach((course, i) => {
    if (editingCourse !== null && i !== editingCourse) return;
    const color = COURSE_COLORS[i % COURSE_COLORS.length];
    // A carried point is only ever drawn; the event keeps the place it came from until it lands.
    const carried = i === editingCourse ? carriedSlots(course, held) : null;
    const editing = i === editingCourse;
    const drawn = course.segments.map((segment, si) =>
      carried ? segment.points.map((p, pi) => (carried.has(`${si}:${pi}`) ? held.at : p)) : segment.points,
    );
    shapes.push({ points: drawn.flat(), color });
    drawn.forEach((points, si) => {
      const hotLine = editing && hot?.kind === "line" && hot.segmentIndex === si;
      if (points.length >= 2) courses.push(feature(lineOf(points), { color, hot: Boolean(hotLine) }));
      if (!editing) return;
      // A point being dragged is the one the pointer has hold of, so it stays lit while it travels.
      const lit = held ?? (hot?.kind === "point" ? hot : null);
      const hotPoint = lit?.segmentIndex === si ? lit.pointIndex : -1;
      points.forEach((p, pi) => vertices.push(feature(pointOf(p), { color, hot: pi === hotPoint })));
    });
  });
  map.getSource("courses").setData(collection(courses));
  map.getSource("course-lines").setData(collection(arrowLines(shapes).map((line) => feature(lineOf(line)))));
  map.getSource("course-overlaps").setData(collection(overlapChunks(shapes).map((c) => feature(lineOf(c.path), { color: c.color }))));
  map.getSource("course-ends").setData(collection(courseEnds(shapes).map((e) => feature(pointOf(e.location), { kind: e.kind }))));
  map.getSource("vertices").setData(collection(vertices));

  const spectator = [];
  if (event.spectator.start) spectator.push(feature(pointOf(event.spectator.start), { color: "#50a14f" }));
  if (event.spectator.end) spectator.push(feature(pointOf(event.spectator.end.location), { color: "#e45649" }));
  map.getSource("spectator").setData(collection(spectator));
  map.getSource("regions").setData(collection(event.spectator.required_regions.map((r) => feature(circleOf(r.center, r.radius_m)))));

  const stops = (itinerary?.stops ?? [])
    .map((s, i) => ({ s, label: stopLabel(event, i) }))
    .filter(({ label }) => label !== "Start")
    .map(({ s, label }) => feature(pointOf(s.location), { label: String(label) }));
  const legs = (itinerary?.legs ?? []).filter((l) => l.path.length >= 2).map((l) => feature(lineOf(l.path)));
  map.getSource("stops").setData(collection(stops));
  map.getSource("legs").setData(collection(legs));
}

/**
 * Map layers the search stage draws on. `add*` queue features; `flush` sends each touched
 * source once per frame, since every `setData` re-tiles the whole source.
 */
export function replayCanvas(map) {
  const layers = { "replay-points": [], "replay-lines": [], "replay-fills": [] };
  const dirty = new Set();
  const add = (source, features) => {
    layers[source] = layers[source].concat(features);
    dirty.add(source);
  };
  return {
    addCircles(latlons, color, radiusM, opacity) {
      add("replay-fills", latlons.map((p) => feature(circleOf(p, radiusM, 16), { color, opacity })));
    },
    addPoints(latlons, color, radius, opacity = 0.8) {
      add("replay-points", latlons.map((p) => feature(pointOf(p), { color, radius, opacity })));
    },
    addLines(paths, color, width, opacity) {
      add("replay-lines", paths.filter((p) => p.length >= 2).map((p) => feature(lineOf(p), { color, width, opacity })));
    },
    clear() {
      for (const source of Object.keys(layers)) {
        layers[source] = [];
        dirty.add(source);
      }
    },
    flush() {
      // A style change tears the sources down mid-replay; what is queued waits for the new ones.
      if (!map.getSource("replay-points")) return;
      for (const source of dirty) map.getSource(source).setData(collection(layers[source]));
      dirty.clear();
    },
  };
}

/** Fade the itinerary layers from hidden to shown (paint transitions do the tweening). */
export function revealItinerary(map, shown) {
  map.setPaintProperty("stops", "circle-opacity", shown ? 1 : 0);
  map.setPaintProperty("stop-labels", "text-opacity", shown ? 1 : 0);
  map.setPaintProperty("legs", "line-opacity", shown ? 1 : 0);
}

/** Frame `points` with a margin of `margin` times their extent on every side. */
export function fitTo(map, points, margin = 0.1) {
  if (points.length < 2) return;
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const [south, north, west, east] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const [dy, dx] = [(north - south) * margin || 0.001, (east - west) * margin || 0.001];
  map.fitBounds(
    [
      [west - dx, south - dy],
      [east + dx, north + dy],
    ],
    { duration: 800 },
  );
}

export function flyTo(map, latlon) {
  map.flyTo({ center: [latlon.lon, latlon.lat], zoom: Math.max(map.getZoom(), 15) });
}

export function mapCenter(map) {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

const empty = () => collection([]);
const collection = (features) => ({ type: "FeatureCollection", features });
const feature = (geometry, properties = {}) => ({ type: "Feature", geometry, properties });
const pointOf = (p) => ({ type: "Point", coordinates: [p.lon, p.lat] });
const lineOf = (points) => ({ type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) });

function circleOf(center, radiusM, steps = 48) {
  const dLat = radiusM / 111195;
  const dLon = dLat / Math.cos((center.lat * Math.PI) / 180);
  const ring = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / steps;
    return [center.lon + dLon * Math.cos(a), center.lat + dLat * Math.sin(a)];
  });
  return { type: "Polygon", coordinates: [ring] };
}

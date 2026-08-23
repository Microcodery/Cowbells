// MapLibre setup, themed styles, and the overlay layers drawn from state.

import { Map as MapLibre, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { stopLabel } from "./state.js";
// MapLibre resolves its tile worker with a dynamic URL Vite cannot bundle; hand it a built one.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);

const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

const COURSE_COLORS = ["#2563eb", "#db2777", "#16a34a", "#d97706", "#7c3aed"];

const SOURCES = ["courses", "vertices", "spectator", "regions", "stops", "legs"];

export function createMap(container, center, onClick) {
  const map = new MapLibre({
    container,
    style: STYLES[currentTheme()],
    center: [center.lon, center.lat],
    zoom: 13,
    attributionControl: { compact: true },
  });
  map.addControl(new NavigationControl(), "top-right");
  map.on("click", (e) => onClick({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
  map.on("style.load", () => addLayers(map));
  return map;
}

export function setTheme(map, theme) {
  map.setStyle(STYLES[theme]);
}

export function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function addLayers(map) {
  for (const name of SOURCES) {
    map.addSource(name, { type: "geojson", data: empty() });
  }
  map.addLayer({ id: "regions", type: "fill", source: "regions", paint: { "fill-color": "#a855f7", "fill-opacity": 0.2 } });
  map.addLayer({ id: "legs", type: "line", source: "legs", paint: { "line-color": "#f97316", "line-width": 4, "line-dasharray": [1, 1.5] } });
  map.addLayer({ id: "courses", type: "line", source: "courses", paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.85 } });
  map.addLayer({ id: "vertices", type: "circle", source: "vertices", paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2 } });
  map.addLayer({ id: "spectator", type: "circle", source: "spectator", paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "stops", type: "circle", source: "stops", paint: { "circle-radius": 11, "circle-color": "#f97316", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({
    id: "stop-labels",
    type: "symbol",
    source: "stops",
    layout: { "text-field": ["get", "label"], "text-size": 12, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": "#fff" },
  });
  map.fire("layers-ready");
}

/** Redraw every overlay from the event and the latest itinerary; vertices only for the course being edited. */
export function render(map, event, itinerary, editingCourse = null) {
  if (!map.getSource("courses")) return;
  const courses = [];
  const vertices = [];
  event.courses.forEach((course, i) => {
    const color = COURSE_COLORS[i % COURSE_COLORS.length];
    course.segments.forEach((segment) => {
      if (segment.points.length >= 2) courses.push(feature(lineOf(segment.points), { color }));
      if (i === editingCourse) segment.points.forEach((p) => vertices.push(feature(pointOf(p), { color })));
    });
  });
  map.getSource("courses").setData(collection(courses));
  map.getSource("vertices").setData(collection(vertices));

  const spectator = [];
  if (event.spectator.start) spectator.push(feature(pointOf(event.spectator.start), { color: "#16a34a" }));
  if (event.spectator.end) spectator.push(feature(pointOf(event.spectator.end.location), { color: "#dc2626" }));
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

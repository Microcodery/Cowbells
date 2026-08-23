// The spectator's itinerary as GPX: one track for the walk, one waypoint per stop.

import { clock, stopLabel, visibleSightings } from "./state.js";

export function itineraryToGpx(itinerary, event) {
  const name = (id) => event.racers.find((r) => r.id === id)?.name ?? id;
  const iso = (epoch) => new Date(epoch * 1000).toISOString();
  const waypoints = itinerary.stops.map((stop, i) => {
    const seen = visibleSightings(stop).map((s) => `${name(s.racer_id)} ${s.kind} ~${clock(s.expected)}`).join(", ");
    const label = stopLabel(event, i);
    return `  <wpt lat="${stop.location.lat}" lon="${stop.location.lon}">
    <time>${iso(stop.arrive)}</time>
    <name>${label === "Start" ? "Start" : `Stop ${label}`} ${clock(stop.arrive)}–${clock(stop.depart)}</name>
    <desc>${esc(seen || "no sightings")}</desc>
  </wpt>`;
  });
  // Consecutive legs share their junction point; keep it once.
  const points = itinerary.legs
    .flatMap((leg, i) => (i === 0 ? leg.path : leg.path.slice(1)))
    .map((p) => `      <trkpt lat="${p.lat}" lon="${p.lon}"></trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="birdeye" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(event.name)} — spectator</name></metadata>
${waypoints.join("\n")}
  <trk>
    <name>${esc(event.name)} — spectator route</name>
    <trkseg>
${points.join("\n")}
    </trkseg>
  </trk>
</gpx>
`;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

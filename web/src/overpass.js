// Fetch the OpenStreetMap ways the routing graph needs for an event's area.

const INSTANCES = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
/** About 100 m: a block beyond the courses is as far as the spectator strays. */
const PADDING_DEG = 0.001;
const OPEN_AREAS = [
  `["leisure"~"^(park|garden|pitch|playground)$"]`,
  `["landuse"~"^(grass|recreation_ground|village_green)$"]`,
  `["amenity"="parking"]`,
  `["place"="square"]`,
];

const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);

/** Convex hull of `points` (Andrew's monotone chain), counter-clockwise, without the closing point. */
function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.lon - b.lon || a.lat - b.lat);
  if (sorted.length < 3) return sorted;
  const half = (input) => {
    const chain = [];
    for (const p of input) {
      while (chain.length >= 2 && cross(chain.at(-2), chain.at(-1), p) <= 0) chain.pop();
      chain.push(p);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

/**
 * The area to fetch: the convex hull of the courses and the spectator's points, padded.
 * A loop's interior is included, since cutting across it is the spectator's best move.
 */
export function area(event) {
  const points = event.courses.flatMap((c) => c.segments.flatMap((s) => s.points));
  if (event.spectator.start) points.push(event.spectator.start);
  if (event.spectator.end) points.push(event.spectator.end.location);
  const padded = points.flatMap((p) =>
    [-PADDING_DEG, PADDING_DEG].flatMap((dlat) => [-PADDING_DEG, PADDING_DEG].map((dlon) => ({ lat: p.lat + dlat, lon: p.lon + dlon }))),
  );
  return convexHull(padded);
}

const inside = (hull, p) => hull.every((a, i) => cross(a, hull[(i + 1) % hull.length], p) >= 0);

/** Whether the area fetched already contains the area needed (both convex). */
export function covers(fetched, needed) {
  return Array.isArray(fetched) && fetched.length >= 3 && needed.every((p) => inside(fetched, p));
}

export function query(hull) {
  const poly = `(poly:"${hull.map((p) => `${p.lat} ${p.lon}`).join(" ")}")`;
  const clauses = [`["highway"]`, ...OPEN_AREAS].map((filter) => `way${filter}${poly};`);
  return `[out:json][timeout:90];\n(\n  ${clauses.join("\n  ")}\n);\nout body; >; out skel qt;`;
}

/** Raw Overpass JSON text for the event area, trying each public instance in turn. */
export async function fetchOsm(event) {
  const body = new URLSearchParams({ data: query(area(event)) });
  let lastError;
  for (const url of INSTANCES) {
    try {
      const response = await fetch(url, { method: "POST", body });
      if (response.ok) return await response.text();
      lastError = new Error(`${url}: HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

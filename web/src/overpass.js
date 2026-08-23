// Fetch the OpenStreetMap ways the routing graph needs for an event's area.

const INSTANCES = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const PADDING_DEG = 0.005;

export function bbox(event) {
  const points = event.courses.flatMap((c) => c.segments.flatMap((s) => s.points));
  if (event.spectator.start) points.push(event.spectator.start);
  if (event.spectator.end) points.push(event.spectator.end.location);
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return {
    south: Math.min(...lats) - PADDING_DEG,
    west: Math.min(...lons) - PADDING_DEG,
    north: Math.max(...lats) + PADDING_DEG,
    east: Math.max(...lons) + PADDING_DEG,
  };
}

export function query({ south, west, north, east }) {
  const box = `(${south},${west},${north},${east})`;
  return `[out:json][timeout:90];
(
  way["highway"]${box};
  way["leisure"~"^(park|garden|pitch|playground)$"]${box};
  way["landuse"~"^(grass|recreation_ground|village_green)$"]${box};
  way["amenity"="parking"]${box};
  way["place"="square"]${box};
);
out body; >; out skel qt;`;
}

/** Raw Overpass JSON text for the event area, trying each public instance in turn. */
export async function fetchOsm(event) {
  const body = new URLSearchParams({ data: query(bbox(event)) });
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

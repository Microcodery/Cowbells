// The event document (mirrors the Rust model) plus the edits the panel makes to it.

const DEFAULT_PACE_S_PER_KM = { run: 360, bike: 100, swim: 1200, other: 360 };
const DEFAULT_UNCERTAINTY = 0.05;
const DEFAULT_REGION_RADIUS_M = 100;
/** Typical speeds per travel mode, matching the routing profiles; shown when the spectator sets none. */
export const DEFAULT_SPEED_KMH = { walk: 4.7, bike: 16 };
export const KMH_PER_MPS = 3.6;

export function newEvent(center) {
  return {
    name: "My race",
    origin: center,
    courses: [],
    racers: [],
    spectator: {
      start: null,
      earliest: todayAt("09:00"),
      latest: null,
      end: null,
      mode: "walk",
      speed_mps: null,
      sighting_radius_m: 30,
      safety_buffer_s: 120,
      min_stop_s: 60,
      viewpoint_spacing_m: 120,
      course_closed: false,
      required_regions: [],
      objective: { tiers: ["en_route", "finish"], repeat_decay: 0.5 },
    },
  };
}

let nextId = 1;
export function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${nextId++}`;
}

export function addCourse(event) {
  const course = { id: id("course"), name: `Course ${event.courses.length + 1}`, start_time: event.spectator.earliest, segments: [] };
  event.courses.push(course);
  return course;
}

export function addPoint(course, latlon) {
  if (course.segments.length === 0) {
    course.segments.push({ id: id("seg"), mode: "run", points: [], viewable: true });
  }
  course.segments.at(-1).points.push(latlon);
}

export function undoPoint(course) {
  const last = course.segments.at(-1);
  if (!last) return;
  last.points.pop();
  if (last.points.length === 0 && course.segments.length > 1) course.segments.pop();
}

export function removeCourse(event, course) {
  event.courses = event.courses.filter((c) => c !== course);
  event.racers = event.racers.filter((r) => r.course_id !== course.id);
}

/** Split a segment at `pointIndex` (insert `latlon` after it). Pace profiles are unaffected. */
export function splitSegment(course, segmentIndex, pointIndex, latlon) {
  const segment = course.segments[segmentIndex];
  const before = segment.points.slice(0, pointIndex + 1).concat([latlon]);
  const after = [latlon].concat(segment.points.slice(pointIndex + 1));
  segment.points = before;
  course.segments.splice(segmentIndex + 1, 0, { id: id("seg"), mode: segment.mode, points: after, viewable: segment.viewable });
}

export function mergeWithNext(course, segmentIndex) {
  const [a, b] = [course.segments[segmentIndex], course.segments[segmentIndex + 1]];
  if (!b) return;
  a.points = a.points.concat(b.points.slice(1));
  course.segments.splice(segmentIndex + 1, 1);
}

export function addRacer(event, course) {
  const racer = {
    id: id("racer"),
    name: `Racer ${event.racers.length + 1}`,
    course_id: course.id,
    start_offset_s: 0,
    pace_profile: seedProfile(course),
    priority: 1,
  };
  event.racers.push(racer);
  return racer;
}

export function assignCourse(racer, course) {
  racer.course_id = course.id;
  racer.pace_profile = seedProfile(course);
}

/** One interval per segment with a default pace for its mode. */
export function seedProfile(course) {
  let start = 0;
  return course.segments.map((segment) => {
    const end = start + polylineLength(segment.points);
    const interval = { start_m: start, end_m: end, seconds_per_km: DEFAULT_PACE_S_PER_KM[segment.mode], uncertainty: DEFAULT_UNCERTAINTY };
    start = end;
    return interval;
  });
}

/** Stretch every racer's profile to its course's current length after geometry edits. */
export function reconcileProfiles(event) {
  for (const racer of event.racers) {
    const course = event.courses.find((c) => c.id === racer.course_id);
    if (!course) continue;
    const length = courseLength(course);
    const profile = racer.pace_profile;
    const current = profile.at(-1)?.end_m ?? 0;
    if (profile.length === 0 || current === 0) {
      racer.pace_profile = seedProfile(course);
    } else if (Math.abs(current - length) > 0.5) {
      const scale = length / current;
      for (const interval of profile) {
        interval.start_m *= scale;
        interval.end_m *= scale;
      }
    }
  }
}

export function splitInterval(racer, index, atM) {
  const interval = racer.pace_profile[index];
  if (!(atM > interval.start_m && atM < interval.end_m)) return;
  racer.pace_profile.splice(index + 1, 0, { ...interval, start_m: atM });
  interval.end_m = atM;
}

export function mergeInterval(racer, index) {
  const [a, b] = [racer.pace_profile[index], racer.pace_profile[index + 1]];
  if (!b) return;
  a.end_m = b.end_m;
  racer.pace_profile.splice(index + 1, 1);
}

export function addRegion(event, center) {
  event.spectator.required_regions.push({ center, radius_m: DEFAULT_REGION_RADIUS_M, latest: null });
}

export function courseLength(course) {
  return course.segments.reduce((sum, s) => sum + polylineLength(s.points), 0);
}

/** The length-weighted centre of every course, or `fallback` when nothing is drawn yet. */
export function courseCenter(event, fallback) {
  let weight = 0;
  let lat = 0;
  let lon = 0;
  for (const course of event.courses) {
    for (const segment of course.segments) {
      for (let i = 1; i < segment.points.length; i++) {
        const [a, b] = [segment.points[i - 1], segment.points[i]];
        const w = haversineM(a, b);
        weight += w;
        lat += (w * (a.lat + b.lat)) / 2;
        lon += (w * (a.lon + b.lon)) / 2;
      }
    }
  }
  return weight ? { lat: lat / weight, lon: lon / weight } : fallback;
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

function haversineM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

/** Shift every timestamp so the earliest course start lands on `startAt`; examples ship with relative times. */
export function rebase(event, startAt) {
  if (event.courses.length === 0) return;
  const delta = startAt - Math.min(...event.courses.map((c) => c.start_time));
  for (const course of event.courses) course.start_time += delta;
  const s = event.spectator;
  s.earliest += delta;
  if (s.latest != null) s.latest += delta;
  if (s.end) s.end.latest += delta;
  for (const r of s.required_regions) if (r.latest != null) r.latest += delta;
}

/** "Start" for an anchored start stop, otherwise the stop's 1-based number. */
export function stopLabel(event, index) {
  if (!event.spectator.start) return index + 1;
  return index === 0 ? "Start" : index;
}

/** A finish counts as a pass too; list it once, as the finish. */
export function visibleSightings(stop) {
  const key = (s) => `${s.racer_id}@${s.expected}`;
  const finishKeys = new Set(stop.seen.filter((s) => s.kind === "finish").map(key));
  return stop.seen.filter((s) => s.kind === "finish" || !finishKeys.has(key(s)));
}

export function todayAt(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function clock(epoch) {
  return new Date(epoch * 1000).toTimeString().slice(0, 5);
}

export function withClock(epoch, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(epoch * 1000);
  d.setHours(h, m, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** The first moment after `epoch` whose clock reads `hhmm`, rolling past midnight if needed. */
export function laterThan(epoch, hhmm) {
  const t = withClock(epoch, hhmm);
  return t > epoch ? t : t + 24 * 3600;
}

export function paceLabel(secondsPerKm) {
  const m = Math.floor(secondsPerKm / 60);
  const s = Math.round(secondsPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "m:ss" or whole minutes per km, as seconds; `null` when unparseable. */
export function parsePace(text) {
  const match = text.trim().match(/^(\d+)(?::(\d{1,2}))?$/);
  if (!match) return null;
  const seconds = Number(match[1]) * 60 + Number(match[2] ?? 0);
  return seconds > 0 ? seconds : null;
}

export function looksLikeEvent(value) {
  return Boolean(value?.spectator && Array.isArray(value.courses) && Array.isArray(value.racers));
}

/** Nearest point on any course to `latlon`, in a flat approximation good enough for picking. */
export function nearestOnCourses(event, latlon) {
  const kx = Math.cos((latlon.lat * Math.PI) / 180);
  const xy = (p) => ({ x: p.lon * kx, y: p.lat });
  const P = xy(latlon);
  let best = null;
  event.courses.forEach((course, courseIndex) => {
    course.segments.forEach((segment, segmentIndex) => {
      for (let i = 0; i + 1 < segment.points.length; i++) {
        const A = xy(segment.points[i]);
        const B = xy(segment.points[i + 1]);
        const len2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2 || 1e-12;
        const t = Math.max(0, Math.min(1, ((P.x - A.x) * (B.x - A.x) + (P.y - A.y) * (B.y - A.y)) / len2));
        const Q = { x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) };
        const d2 = (P.x - Q.x) ** 2 + (P.y - Q.y) ** 2;
        if (!best || d2 < best.d2) best = { d2, courseIndex, segmentIndex, pointIndex: i, latlon: { lat: Q.y, lon: Q.x / kx } };
      }
    });
  });
  return best;
}

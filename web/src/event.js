// The event document (mirrors the Rust model) plus the edits the panel makes to it.

import { todayAt } from "./format.js";
import { courseLength, cutPolyline, polylineLength } from "./geo.js";

const DEFAULT_PACE_S_PER_KM = { run: 360, bike: 100, swim: 1200, other: 360 };
const DEFAULT_UNCERTAINTY = 0.05;
const DEFAULT_REGION_RADIUS_M = 100;
/** Typical speeds per travel mode, matching the routing profiles; shown when the spectator sets none. */
export const DEFAULT_SPEED_MPS = { walk: 1.3, bike: 4.5, drive: 13.9 };

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
      skip_start_m: 1600,
      safety_buffer_s: 120,
      min_stop_s: 60,
      viewpoint_spacing_m: 120,
      course_closed: false,
      required_regions: [],
    },
  };
}

export function looksLikeEvent(value) {
  return Boolean(value?.spectator && Array.isArray(value.courses) && Array.isArray(value.racers));
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

/** Takes back the last point drawn, and reports what it took so it can be put back. */
export function undoPoint(course) {
  const last = course.segments.at(-1);
  const latlon = last?.points.pop();
  if (!latlon) return null;
  const emptied = last.points.length === 0 && course.segments.length > 1;
  return { latlon, segment: emptied ? course.segments.pop() : null };
}

/** Puts back what `undoPoint` took, segment and all. */
export function redoPoint(course, undone) {
  if (undone.segment) course.segments.push(undone.segment);
  addPoint(course, undone.latlon);
}

/**
 * Puts a drawn point somewhere else, and reports whether it went. Segments that meet do so at a
 * shared point, so moving one side moves the other; segments parted by a gap keep their gap.
 */
export function movePoint(course, segmentIndex, pointIndex, latlon) {
  const segment = course.segments[segmentIndex];
  const was = segment?.points[pointIndex];
  if (!was) return false;
  const above = course.segments[segmentIndex - 1]?.points;
  const below = course.segments[segmentIndex + 1]?.points;
  segment.points[pointIndex] = latlon;
  if (pointIndex === 0 && above?.length && coincide(above.at(-1), was)) above[above.length - 1] = latlon;
  if (pointIndex === segment.points.length - 1 && below?.length && coincide(below[0], was)) below[0] = latlon;
  return true;
}

/**
 * Takes a drawn point out, and reports whether it went. A point where two segments meet holds
 * them together, so it stays; merge the segments to be rid of it.
 */
export function deletePoint(course, segmentIndex, pointIndex) {
  const segment = course.segments[segmentIndex];
  if (!segment?.points[pointIndex]) return false;
  const joinsAbove = pointIndex === 0 && segmentIndex > 0;
  const joinsBelow = pointIndex === segment.points.length - 1 && segmentIndex + 1 < course.segments.length;
  if (joinsAbove || joinsBelow) return false;
  const left = segment.points.filter((_, i) => i !== pointIndex);
  // The engine needs two points that are actually apart, not merely two points.
  if (!left.some((p) => !coincide(p, left[0]))) return false;
  segment.points = left;
  return true;
}

/** Adds a drawn point just after `pointIndex`, where a click on the line between two points lands. */
export function insertPoint(course, segmentIndex, pointIndex, latlon) {
  const segment = course.segments[segmentIndex];
  if (!segment?.points[pointIndex]) return false;
  segment.points.splice(pointIndex + 1, 0, latlon);
  return true;
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

/** Where each segment ends, measured along the course, with 0 and the finish included. */
export function segmentBoundaries(course) {
  let along = 0;
  return [0, ...course.segments.map((segment) => (along += polylineLength(segment.points)))];
}

/** Segments and legs keep at least this much length, so neither collapses to nothing. */
const SHORTEST_M = 1;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * Moves where segment `index` gives way to the next, re-cutting only that pair. A course whose
 * segments do not meet keeps its gap: re-cutting across one would silently swallow it.
 */
export function moveSegmentBoundary(course, index, metres) {
  const [before, after] = [course.segments[index], course.segments[index + 1]];
  if (!after || !coincide(before?.points.at(-1), after.points[0])) return;
  const boundaries = segmentBoundaries(course);
  // Boundaries lead with the start line, so the pair runs from the mark at `index` to the one two on.
  const [low, high] = [boundaries[index], boundaries[index + 2]];
  if (high - low < 2 * SHORTEST_M) return;
  const pair = before.points.concat(after.points.slice(1));
  // The old boundary was cut into the line and adds nothing to it; drop it so nudging cannot pile up.
  const join = before.points.length - 1;
  if (addsNoLength(pair[join - 1], pair[join], pair[join + 1])) pair.splice(join, 1);
  const at = clamp(metres, low + SHORTEST_M, high - SHORTEST_M) - low;
  const [head, tail] = cutPolyline(pair, [at]);
  before.points = head;
  after.points = tail;
}

const addsNoLength = (a, p, b) => a && b && polylineLength([a, p, b]) - polylineLength([a, b]) < 0.05;

const coincide = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;

export function addRacer(event, course) {
  const racer = {
    id: id("racer"),
    name: `Racer ${event.racers.length + 1}`,
    course_id: course.id,
    start_offset_s: 0,
    pace_profile: seedProfile(course),
    priority: 1,
    prefer: "finish",
    require_finish: false,
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

/** The one pace that would cover the whole profile in the time its legs take together. */
export function averagePace(racer) {
  const legs = racer.pace_profile;
  const distance = legs.reduce((total, leg) => total + (leg.end_m - leg.start_m), 0);
  if (distance <= 0) return legs[0]?.seconds_per_km ?? 0;
  return legs.reduce((seconds, leg) => seconds + (leg.end_m - leg.start_m) * leg.seconds_per_km, 0) / distance;
}

/** Moves where one leg gives way to the next; the boundary stays between its neighbours. */
export function movePaceBoundary(racer, index, metres) {
  const [a, b] = [racer.pace_profile[index], racer.pace_profile[index + 1]];
  if (!b || b.end_m - a.start_m < 2 * SHORTEST_M) return;
  const at = clamp(metres, a.start_m + SHORTEST_M, b.end_m - SHORTEST_M);
  a.end_m = at;
  b.start_m = at;
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
  if (b.end_m > a.start_m) {
    a.seconds_per_km = blendedPace(a, b);
    a.uncertainty = blendedSpread(a, b);
  }
  a.end_m = b.end_m;
  racer.pace_profile.splice(index + 1, 1);
}

/** Legs already run at one pace keep it; otherwise they take the pace that runs both in the same time. */
function blendedPace(a, b) {
  if (a.seconds_per_km === b.seconds_per_km) return a.seconds_per_km;
  const [runA, runB] = [a.end_m - a.start_m, b.end_m - b.start_m];
  const average = (runA * a.seconds_per_km + runB * b.seconds_per_km) / (runA + runB);
  return round(average, TENTHS);
}

/** Spread blends the same way, but as a fraction of one it needs the places a whole percent takes. */
function blendedSpread(a, b) {
  if (a.uncertainty === b.uncertainty) return a.uncertainty;
  const [runA, runB] = [a.end_m - a.start_m, b.end_m - b.start_m];
  const average = (runA * a.uncertainty + runB * b.uncertainty) / (runA + runB);
  // Two spreads a whisker under 1 would otherwise round to 1, which the engine rejects.
  return Math.min(round(average, FRACTION_OF_A_PERCENT), WIDEST_SPREAD);
}

const TENTHS = 1;
const FRACTION_OF_A_PERCENT = 4;
const WIDEST_SPREAD = 0.9999;
const round = (value, places) => Number(value.toFixed(places));

export function addRegion(event, center) {
  event.spectator.required_regions.push({ center, radius_m: DEFAULT_REGION_RADIUS_M, latest: null });
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

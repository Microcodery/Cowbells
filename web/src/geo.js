// Measuring the courses: lengths along them, the nearest point on them, and when racers pass it.

/** Metres along a path of lat/lon points. */
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += metresBetween(points[i - 1], points[i]);
  return total;
}

/** Metres between two lat/lon points, over the sphere. */
export function metresBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

/**
 * Cuts a polyline at each distance in `cuts` (ascending, in metres), interpolating a point at
 * every cut so the pieces join exactly where they were parted. Cuts outside the line are pulled
 * onto it, so a cut on an end yields a piece of no length rather than none at all.
 */
export function cutPolyline(points, cuts) {
  if (points.length < 2) return [points, ...cuts.map(() => points.slice())];
  const total = polylineLength(points);
  const within = cuts.map((cut) => Math.min(Math.max(cut, 0), total));
  const pieces = [];
  let piece = points.slice(0, 1);
  let along = 0;
  let next = 0;
  for (let i = 1; i < points.length; i++) {
    const step = metresBetween(points[i - 1], points[i]);
    // A step of no length has no fraction to cut at; the cut waits for one that has.
    while (next < within.length && step > 0 && within[next] <= along + step) {
      const at = between(points[i - 1], points[i], (within[next] - along) / step);
      piece.push(at);
      pieces.push(piece);
      piece = [at];
      next++;
    }
    along += step;
    piece.push(points[i]);
  }
  pieces.push(piece);
  return pieces;
}

/** The point `fraction` of the way from `a` to `b`. */
export const between = (a, b, fraction) => ({
  lat: a.lat + (b.lat - a.lat) * fraction,
  lon: a.lon + (b.lon - a.lon) * fraction,
});

/** Where `metres` along a path falls: the point it is past, and the spot itself. */
export function alongPolyline(points, metres) {
  if (points.length < 2) return null;
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    const step = metresBetween(points[i - 1], points[i]);
    if (step > 0 && along + step >= metres) {
      return { pointIndex: i - 1, latlon: between(points[i - 1], points[i], (metres - along) / step) };
    }
    along += step;
  }
  return { pointIndex: points.length - 2, latlon: points.at(-1) };
}

export function courseLength(course) {
  return course.segments.reduce((sum, s) => sum + polylineLength(s.points), 0);
}

/** The course covering the most ground, or null when none has a line yet. */
export function largestCourse(event) {
  return event.courses.reduce((best, c) => (courseLength(c) > (best ? courseLength(best) : 0) ? c : best), null);
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
        const w = metresBetween(a, b);
        weight += w;
        lat += (w * (a.lat + b.lat)) / 2;
        lon += (w * (a.lon + b.lon)) / 2;
      }
    }
  }
  return weight ? { lat: lat / weight, lon: lon / weight } : fallback;
}

/** Metres along `course` to a point found by `nearestOnCourses`. */
export function distanceAlong(course, hit) {
  let along = 0;
  course.segments.forEach((segment, si) => {
    if (si < hit.segmentIndex) along += polylineLength(segment.points);
    if (si === hit.segmentIndex) {
      along += polylineLength(segment.points.slice(0, hit.pointIndex + 1));
      along += metresBetween(segment.points[hit.pointIndex], hit.latlon);
    }
  });
  return along;
}

/** When each racer on `course` should pass `metres` along it, earliest to latest, with their spread. */
export function arrivalsAt(event, course, metres) {
  return event.racers
    .filter((r) => r.course_id === course.id)
    .map((racer) => {
      let seconds = 0;
      let spread = 0;
      for (const p of racer.pace_profile) {
        const covered = Math.max(0, Math.min(metres, p.end_m) - p.start_m);
        seconds += (covered * p.seconds_per_km) / 1000;
        spread += (covered * p.seconds_per_km * p.uncertainty) / 1000;
      }
      const expected = course.start_time + racer.start_offset_s + seconds;
      return { racer, expected, early: expected - spread, late: expected + spread };
    })
    .sort((a, b) => a.expected - b.expected);
}

/** The drawn point of `course` nearest `latlon`, which is what a move takes hold of. */
export function nearestVertex(course, latlon) {
  const kx = Math.cos((latlon.lat * Math.PI) / 180);
  let best = null;
  course.segments.forEach((segment, segmentIndex) => {
    segment.points.forEach((point, pointIndex) => {
      const d2 = ((point.lon - latlon.lon) * kx) ** 2 + (point.lat - latlon.lat) ** 2;
      if (!best || d2 < best.d2) best = { d2, metres: Math.sqrt(d2) * 111195, segmentIndex, pointIndex };
    });
  });
  return best;
}

/** Nearest point on any course to `latlon`, in a flat approximation good enough for picking. */
export function nearestOnCourses(event, latlon) {
  return nearestOnEachCourse(event, latlon).reduce((best, hit) => (!best || hit.d2 < best.d2 ? hit : best), null);
}

/** The nearest point on every course to `latlon`, so a shared stretch reports all of them. */
export function nearestOnEachCourse(event, latlon) {
  const kx = Math.cos((latlon.lat * Math.PI) / 180);
  const xy = (p) => ({ x: p.lon * kx, y: p.lat });
  const P = xy(latlon);
  const hits = [];
  event.courses.forEach((course, courseIndex) => {
    let best = null;
    course.segments.forEach((segment, segmentIndex) => {
      for (let i = 0; i + 1 < segment.points.length; i++) {
        const A = xy(segment.points[i]);
        const B = xy(segment.points[i + 1]);
        const len2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2 || 1e-12;
        const t = Math.max(0, Math.min(1, ((P.x - A.x) * (B.x - A.x) + (P.y - A.y) * (B.y - A.y)) / len2));
        const Q = { x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) };
        const d2 = (P.x - Q.x) ** 2 + (P.y - Q.y) ** 2;
        if (!best || d2 < best.d2) {
          best = { d2, metres: Math.sqrt(d2) * 111195, courseIndex, segmentIndex, pointIndex: i, latlon: { lat: Q.y, lon: Q.x / kx } };
        }
      }
    });
    if (best) hits.push(best);
  });
  return hits;
}

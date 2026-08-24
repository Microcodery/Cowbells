// Measuring the courses: lengths along them, the nearest point on them, and when racers pass it.

/** Metres along a path of lat/lon points. */
export function polylineLength(points) {
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
        const w = haversineM(a, b);
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
      along += haversineM(segment.points[hit.pointIndex], hit.latlon);
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

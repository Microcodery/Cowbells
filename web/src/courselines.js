// Course overlay geometry: stretches shared by several courses, striped by course, and the
// start/finish markers, merged where courses share them.

const CHUNK_M = 25;
const NEAR_M = 8;
/** Minimum |cos| between a chunk and the stretch it lies on to count as running along it. */
const ALONG = 0.7;
const M_PER_DEG = 111195;

/**
 * Short pieces of course that another course also runs along, coloured by alternating course
 * so a shared stretch reads as a barber pole. `courses` are `{ points, color }`.
 */
export function overlapChunks(courses) {
  return classify(courses).flatMap((chunks) =>
    chunks.flatMap(({ piece, sharing, owner, k }) =>
      sharing.length >= 2 && owner ? [{ path: piece.path, color: courses[sharing[k % sharing.length]].color }] : [],
    ),
  );
}

/** Each course's line with the shared stretches it does not own cut out, so arrows never stack. */
export function arrowLines(courses) {
  return classify(courses).flatMap((chunks) => {
    const lines = [];
    for (const { piece, owner } of chunks) {
      if (!owner) lines.push([]);
      else if (lines.at(-1)?.length) lines.at(-1).push(...piece.path.slice(1));
      else lines.push([...piece.path]);
    }
    return lines.filter((line) => line.length >= 2);
  });
}

/**
 * Every course's chunks with the courses each one runs along (`sharing`, ascending, including its
 * own) and whether this course is the lowest of them (`owner`), which makes it the one to draw.
 */
function classify(courses) {
  const project = projector(courses);
  const polylines = courses.map((c) => c.points.map(project));
  return courses.map((course, index) =>
    chunk(course.points, project).map((piece, k) => {
      const sharing = polylines.flatMap((line, other) => (other === index || runsAlong(piece, line) ? [other] : []));
      return { piece, k, sharing, owner: sharing[0] === index };
    }),
  );
}

/** Each course's first and last point, merged when within a few metres: `{ location, kind }`. */
export function courseEnds(courses) {
  const project = projector(courses);
  const groups = [];
  for (const course of courses) {
    if (course.points.length < 2) continue;
    for (const [point, kind] of [[course.points[0], "start"], [course.points.at(-1), "finish"]]) {
      const xy = project(point);
      const group = groups.find((g) => distance(g.xy, xy) <= NEAR_M);
      if (group) group.kinds.add(kind);
      else groups.push({ location: point, xy, kinds: new Set([kind]) });
    }
  }
  return groups.map((g) => ({ location: g.location, kind: g.kinds.size === 2 ? "both" : [...g.kinds][0] }));
}

function projector(courses) {
  const first = courses.find((c) => c.points.length)?.points[0];
  const scale = Math.cos(((first?.lat ?? 0) * Math.PI) / 180);
  return (p) => [p.lon * scale * M_PER_DEG, p.lat * M_PER_DEG];
}

/** Splits a polyline into pieces of about CHUNK_M, each with its midpoint in metres. */
function chunk(points, project) {
  const pieces = [];
  let path = [];
  let length = 0;
  const cut = () => {
    if (length >= 1) {
      const xys = path.map(project);
      pieces.push({ path, mid: midpoint(xys), heading: unit(xys[0], xys.at(-1)) });
    }
    path = [path.at(-1)];
    length = 0;
  };
  for (const [i, point] of points.entries()) {
    if (i === 0) {
      path.push(point);
      continue;
    }
    let from = points[i - 1];
    let step = distance(project(from), project(point));
    while (length + step > CHUNK_M) {
      const t = (CHUNK_M - length) / step;
      from = { lat: from.lat + (point.lat - from.lat) * t, lon: from.lon + (point.lon - from.lon) * t };
      path.push(from);
      length = CHUNK_M;
      cut();
      step = distance(project(from), project(point));
    }
    path.push(point);
    length += step;
  }
  cut();
  return pieces;
}

/** The point halfway along a projected path. */
function midpoint(xys) {
  const steps = xys.slice(1).map((xy, i) => distance(xys[i], xy));
  let remaining = steps.reduce((a, b) => a + b, 0) / 2;
  for (const [i, step] of steps.entries()) {
    if (remaining <= step) {
      const t = step ? remaining / step : 0;
      const [a, b] = [xys[i], xys[i + 1]];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= step;
  }
  return xys.at(-1);
}

/** Whether the chunk's midpoint sits on `line` (in metres) and the chunk points along it, either way. */
function runsAlong(piece, line) {
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const ab = [b[0] - a[0], b[1] - a[1]];
    const len2 = ab[0] ** 2 + ab[1] ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((piece.mid[0] - a[0]) * ab[0] + (piece.mid[1] - a[1]) * ab[1]) / len2)) : 0;
    const foot = [a[0] + ab[0] * t, a[1] + ab[1] * t];
    if (distance(piece.mid, foot) > NEAR_M) continue;
    const along = unit(a, b);
    if (Math.abs(along[0] * piece.heading[0] + along[1] * piece.heading[1]) >= ALONG) return true;
  }
  return false;
}

function unit(a, b) {
  const d = distance(a, b) || 1;
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

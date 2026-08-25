import { describe, expect, it } from "vitest";
import { mergeInterval, moveSegmentBoundary, newEvent, rebase, redoPoint, segmentBoundaries, undoPoint } from "../src/event.js";
import { polylineLength } from "../src/geo.js";

const racerWith = (...intervals) => ({
  pace_profile: intervals.map(([start_m, end_m, seconds_per_km, uncertainty = 0.05]) => ({ start_m, end_m, seconds_per_km, uncertainty })),
});

describe("mergeInterval", () => {
  it("keeps the pace when both legs already run it", () => {
    const racer = racerWith([0, 1000, 300], [1000, 5000, 300]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile).toHaveLength(1);
    expect(racer.pace_profile[0]).toMatchObject({ start_m: 0, end_m: 5000, seconds_per_km: 300 });
  });

  it("averages differing paces by the distance each one covers", () => {
    // 1 km at 300 s/km and 4 km at 400 s/km is 1900 s over 5 km: 380 s/km.
    const racer = racerWith([0, 1000, 300], [1000, 5000, 400]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile[0].seconds_per_km).toBe(380);
  });

  it("rounds a lopsided average to a tenth of a second", () => {
    const racer = racerWith([0, 1000, 300], [1000, 4000, 401]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile[0].seconds_per_km).toBe(375.8);
  });

  it("blends the spread without collapsing it to a tenth", () => {
    const racer = racerWith([0, 1000, 300, 0.05], [1000, 3000, 300, 0.08]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile[0].uncertainty).toBeCloseTo(0.07, 5);
  });

  it("keeps a blended spread under the whole the engine rejects", () => {
    const racer = racerWith([0, 1000, 300, 0.9998], [1000, 3000, 300, 0.9999]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile[0].uncertainty).toBeLessThan(1);
  });

  it("leaves the profile alone when there is no leg below", () => {
    const racer = racerWith([0, 1000, 300]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile).toHaveLength(1);
  });
});

describe("rebase", () => {
  it("keeps staggered starts and the spectator's lead intact", () => {
    const event = newEvent({ lat: 0, lon: 0 });
    event.courses = [
      { id: "a", start_time: 300, segments: [] },
      { id: "b", start_time: 0, segments: [] },
    ];
    event.spectator.earliest = -900;
    event.spectator.required_regions = [{ center: { lat: 0, lon: 0 }, radius_m: 50, latest: 600 }];
    rebase(event, 10_000);
    expect(event.courses.map((c) => c.start_time)).toEqual([10_300, 10_000]);
    expect(event.spectator.earliest).toBe(9_100);
    expect(event.spectator.required_regions[0].latest).toBe(10_600);
  });
});

/** A straight north-south course cut into two segments of about a kilometre each. */
const twoSegments = () => {
  const at = (km) => ({ lat: 45 + km / 111.195, lon: -122 });
  return {
    id: "c",
    segments: [
      { id: "a", mode: "run", points: [at(0), at(1)], viewable: true },
      { id: "b", mode: "bike", points: [at(1), at(2)], viewable: false },
    ],
  };
};

describe("moveSegmentBoundary", () => {
  it("hands distance from one segment to the next without moving the ends", () => {
    const course = twoSegments();
    const total = segmentBoundaries(course).at(-1);
    moveSegmentBoundary(course, 0, 1500);
    const [start, middle, end] = segmentBoundaries(course);
    expect(start).toBe(0);
    expect(middle).toBeCloseTo(1500, 0);
    expect(end).toBeCloseTo(total, 0);
    expect(course.segments[0].points.at(-1)).toEqual(course.segments[1].points[0]);
  });

  it("keeps each segment's own settings while its shape changes", () => {
    const course = twoSegments();
    moveSegmentBoundary(course, 0, 400);
    expect(course.segments.map((s) => [s.id, s.mode, s.viewable])).toEqual([
      ["a", "run", true],
      ["b", "bike", false],
    ]);
    expect(polylineLength(course.segments[0].points)).toBeCloseTo(400, 0);
  });

  it("leaves both sides of the boundary long enough for the engine to accept", () => {
    const course = twoSegments();
    const total = segmentBoundaries(course).at(-1);
    moveSegmentBoundary(course, 0, 99_999);
    const pushedForward = segmentBoundaries(course)[1];
    expect(pushedForward).toBeLessThan(total);
    expect(total - pushedForward).toBeGreaterThan(0);

    moveSegmentBoundary(course, 0, -50);
    const pushedBack = segmentBoundaries(course)[1];
    expect(pushedBack).toBeGreaterThan(0);
  });

  it("does not pile up vertices as the boundary is nudged", () => {
    const course = twoSegments();
    const before = course.segments.map((s) => s.points.length);
    for (let metres = 900; metres < 920; metres++) moveSegmentBoundary(course, 0, metres);
    expect(course.segments.map((s) => s.points.length)).toEqual(before);
  });

  it("keeps a course whose segments do not meet exactly as it found it", () => {
    const course = twoSegments();
    course.segments[1].points = course.segments[1].points.map((p) => ({ lat: p.lat + 0.05, lon: p.lon }));
    const before = JSON.stringify(course);
    moveSegmentBoundary(course, 0, 1500);
    expect(JSON.stringify(course), "a gap is the user's, not ours to swallow").toBe(before);
  });

  it("leaves the course alone when asked to move an end", () => {
    const course = twoSegments();
    const before = JSON.stringify(course);
    moveSegmentBoundary(course, 1, 500);
    expect(JSON.stringify(course)).toBe(before);
  });
});

describe("undo and redo", () => {
  it("puts back the point it took", () => {
    const course = twoSegments();
    const shape = JSON.stringify(course.segments);
    redoPoint(course, undoPoint(course));
    expect(JSON.stringify(course.segments)).toBe(shape);
  });

  it("puts back the segment that taking the point emptied", () => {
    const course = twoSegments();
    course.segments[1].points = course.segments[1].points.slice(0, 1);
    const shape = JSON.stringify(course.segments);
    const undone = undoPoint(course);
    expect(course.segments, "the emptied segment goes with the point").toHaveLength(1);
    redoPoint(course, undone);
    expect(JSON.stringify(course.segments)).toBe(shape);
  });

  it("reports nothing to put back once the course is empty", () => {
    const course = { id: "c", segments: [{ id: "a", mode: "run", points: [], viewable: true }] };
    expect(undoPoint(course)).toBeNull();
  });
});

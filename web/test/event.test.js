import { describe, expect, it } from "vitest";
import { deletePoint, insertPoint, mergeInterval, moveSegmentBoundary, movePoint, movedSlots, newEvent, rebase, reconcileProfiles, segmentBoundaries } from "../src/event.js";
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

describe("reconcileProfiles", () => {
  const eventWith = (course, ...intervals) => ({
    courses: [course],
    racers: [{ id: "r", course_id: course.id, ...racerWith(...intervals) }],
  });

  it("stretches a profile to the course it belongs to", () => {
    const course = twoSegments();
    const event = eventWith(course, [0, 2000, 300]);
    course.segments.pop();
    reconcileProfiles(event);
    expect(event.racers[0].pace_profile[0].end_m, "half the course, half the distance").toBeCloseTo(1000, 0);
  });

  it("keeps the paces a racer has while their course has no length", () => {
    const course = twoSegments();
    const event = eventWith(course, [0, 1000, 300], [1000, 2000, 400]);
    const before = JSON.stringify(event.racers[0].pace_profile);
    for (const segment of course.segments) segment.points = [];
    reconcileProfiles(event);
    expect(JSON.stringify(event.racers[0].pace_profile), "an empty course says nothing about pace").toBe(before);
  });

  it("does not trade a racer's paces for defaults on the way back", () => {
    const course = twoSegments();
    const event = eventWith(course, [0, 2000, 333]);
    const shape = structuredClone(course.segments);
    for (const segment of course.segments) segment.points = [];
    reconcileProfiles(event);
    course.segments = shape;
    reconcileProfiles(event);
    expect(event.racers[0].pace_profile[0].seconds_per_km, "the pace they set survived the round trip").toBe(333);
  });
});

describe("movedSlots", () => {
  it("takes both sides of a join, so the map draws a move the way it will land", () => {
    const course = twoSegments();
    const slots = movedSlots(course, 0, 1);
    expect(slots).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("leaves a gap between segments alone", () => {
    const course = twoSegments();
    course.segments[1].points = course.segments[1].points.map((p) => ({ lat: p.lat + 0.05, lon: p.lon }));
    expect(movedSlots(course, 0, 1), "a gap is the user's own").toEqual([[0, 1]]);
  });

  it("has nothing to say about a point that is not there", () => {
    expect(movedSlots(twoSegments(), 4, 0)).toEqual([]);
  });
});

describe("editing points", () => {
  const at = (km) => ({ lat: 45 + km / 111.195, lon: -122 });

  it("moves the point on both sides of a join, so the course stays in one piece", () => {
    const course = twoSegments();
    const moved = { lat: 45.02, lon: -122.01 };
    expect(movePoint(course, 0, 1, moved)).toBe(true);
    expect(course.segments[0].points.at(-1)).toEqual(moved);
    expect(course.segments[1].points[0], "the next segment came along").toEqual(moved);
  });

  it("leaves a gap between segments open when it moves a point beside it", () => {
    const course = twoSegments();
    course.segments[1].points = [at(5), at(6)];
    const moved = { lat: 45.02, lon: -122.01 };
    movePoint(course, 0, 1, moved);
    expect(course.segments[1].points[0], "a gap is the user's own").toEqual(at(5));
  });

  it("refuses to take out a point two segments meet at", () => {
    const course = twoSegments();
    expect(deletePoint(course, 0, 1)).toBe(false);
    expect(course.segments[0].points).toHaveLength(2);
  });

  it("refuses a deletion that would leave a segment with nowhere to go", () => {
    const course = { id: "c", segments: [{ id: "a", mode: "run", points: [at(0), at(1), at(0)], viewable: true }] };
    expect(deletePoint(course, 0, 1), "the two left over sit on the same spot").toBe(false);
    expect(course.segments[0].points).toHaveLength(3);
  });

  it("adds a point between the two it was dropped between", () => {
    const course = twoSegments();
    const added = { lat: 45.004, lon: -122 };
    expect(insertPoint(course, 0, 0, added)).toBe(true);
    expect(course.segments[0].points[1]).toEqual(added);
    expect(course.segments[0].points).toHaveLength(3);
  });
});

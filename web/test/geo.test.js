import { describe, expect, it } from "vitest";
import { newEvent } from "../src/event.js";
import { alongPolyline, arrivalsAt, courseCenter, distanceAlong, largestCourse, nearestOnCourses, polylineLength } from "../src/geo.js";

/** A straight line north, a kilometre to the point. */
const northward = (points) => Array.from({ length: points }, (_, i) => ({ lat: 45 + i / 111.195, lon: -122 }));

describe("alongPolyline", () => {
  it("finds the spot a given distance in, and the point it is past", () => {
    const line = northward(4);
    const { pointIndex, latlon } = alongPolyline(line, 1500);
    expect(pointIndex, "half way along the second leg").toBe(1);
    expect(polylineLength([line[0], latlon])).toBeCloseTo(1500, 0);
  });

  it("lands on the far end when asked for more than the line has", () => {
    const line = northward(3);
    const { latlon } = alongPolyline(line, 99_999);
    expect(latlon).toEqual(line.at(-1));
  });

  it("lands on the near end when asked for nothing", () => {
    const line = northward(3);
    const { pointIndex, latlon } = alongPolyline(line, 0);
    expect(pointIndex).toBe(0);
    expect(latlon).toEqual(line[0]);
  });

  it("steps over points that sit on top of one another", () => {
    const line = [{ lat: 45, lon: -122 }, { lat: 45, lon: -122 }, { lat: 45.01, lon: -122 }];
    const { pointIndex } = alongPolyline(line, 500);
    expect(pointIndex, "a leg of no length has no spot to give").toBe(1);
  });

  it("has nothing to offer a line too short to have one", () => {
    expect(alongPolyline([{ lat: 45, lon: -122 }], 10)).toBeNull();
    expect(alongPolyline([], 10)).toBeNull();
  });
});

describe("hovering a course", () => {
  it("measures distance along it and predicts each racer's arrival", () => {
    const event = newEvent({ lat: 0, lon: 0 });
    const course = {
      id: "c",
      start_time: 1000,
      segments: [
        { points: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }] },
        { points: [{ lat: 0, lon: 0.01 }, { lat: 0, lon: 0.02 }] },
      ],
    };
    event.courses.push(course);
    event.racers.push({ id: "r", name: "R", course_id: "c", start_offset_s: 60, pace_profile: [{ start_m: 0, end_m: 3000, seconds_per_km: 300, uncertainty: 0.1 }] });
    const hit = nearestOnCourses(event, { lat: 0.0001, lon: 0.015 });
    expect(hit.segmentIndex).toBe(1);
    expect(hit.metres).toBeCloseTo(11.1, 0);
    const metres = distanceAlong(course, hit);
    expect(metres).toBeCloseTo(1668, -1);
    const [arrival] = arrivalsAt(event, course, metres);
    expect(arrival.expected).toBeCloseTo(1000 + 60 + 1.668 * 300, 0);
    expect(arrival.late - arrival.early).toBeCloseTo(2 * 0.1 * 1.668 * 300, 0);
  });
});

describe("largestCourse", () => {
  it("picks the longest course and null when nothing is drawn", () => {
    const event = newEvent({ lat: 0, lon: 0 });
    expect(largestCourse(event)).toBeNull();
    event.courses.push(
      { id: "a", segments: [{ points: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 }] }] },
      { id: "b", segments: [{ points: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.03 }] }] },
    );
    expect(largestCourse(event).id).toBe("b");
  });
});

describe("courseCenter", () => {
  it("weights by length and falls back when nothing is drawn", () => {
    const event = newEvent({ lat: 1, lon: 1 });
    expect(courseCenter(event, event.origin)).toEqual({ lat: 1, lon: 1 });
    event.courses.push({
      segments: [
        { points: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.03 }] },
        { points: [{ lat: 0, lon: 0.03 }, { lat: 0.01, lon: 0.03 }] },
      ],
    });
    const center = courseCenter(event, event.origin);
    expect(center.lon).toBeCloseTo(0.01875, 4);
    expect(center.lat).toBeCloseTo(0.00125, 4);
  });
});

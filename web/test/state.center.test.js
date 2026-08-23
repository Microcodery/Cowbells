import { describe, expect, it } from "vitest";
import { UNITS, courseCenter, newEvent, paceLabel, parsePace } from "../src/state.js";

describe("hovering a course", () => {
  it("measures distance along it and predicts each racer's arrival", async () => {
    const { arrivalsAt, distanceAlong, nearestOnCourses } = await import("../src/state.js");
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

describe("pace in display units", () => {
  it("round-trips per mile and per kilometre", () => {
    expect(paceLabel(360)).toBe("6:00");
    expect(paceLabel(360, UNITS.mi)).toBe("9:39");
    expect(parsePace("9:39", UNITS.mi)).toBeCloseTo(359.7, 0);
    expect(parsePace("6", UNITS.km)).toBe(360);
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

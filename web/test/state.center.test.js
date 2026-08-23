import { describe, expect, it } from "vitest";
import { UNITS, courseCenter, newEvent, paceLabel, parsePace } from "../src/state.js";

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

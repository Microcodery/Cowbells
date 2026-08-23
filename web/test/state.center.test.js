import { describe, expect, it } from "vitest";
import { courseCenter, newEvent } from "../src/state.js";

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

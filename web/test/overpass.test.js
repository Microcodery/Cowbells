import { describe, expect, it } from "vitest";
import { bbox } from "../src/overpass.js";

describe("bbox", () => {
  it("covers the courses and optional spectator points", () => {
    const event = {
      courses: [{ segments: [{ points: [{ lat: 45, lon: -122 }, { lat: 45.01, lon: -121.99 }] }] }],
      spectator: { start: null, end: null },
    };
    const box = bbox(event);
    expect(box.south).toBeLessThan(45);
    expect(box.north).toBeGreaterThan(45.01);
    event.spectator.start = { lat: 45.05, lon: -122 };
    expect(bbox(event).north).toBeGreaterThan(45.05);
  });
});

import { describe, expect, it } from "vitest";
import { bbox, covers } from "../src/overpass.js";

describe("covers", () => {
  it("is true only when the fetched box contains the needed one", () => {
    const outer = { south: 0, west: 0, north: 1, east: 1 };
    expect(covers(outer, { south: 0.2, west: 0.2, north: 0.8, east: 0.8 })).toBe(true);
    expect(covers(outer, { south: 0.2, west: 0.2, north: 1.2, east: 0.8 })).toBe(false);
    expect(covers(null, outer)).toBe(false);
  });
});

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

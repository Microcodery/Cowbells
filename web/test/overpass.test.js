import { describe, expect, it } from "vitest";
import { area, covers, query } from "../src/overpass.js";

const event = (points, spectator = { start: null, end: null }) => ({ courses: [{ segments: [{ points }] }], spectator });
const triangle = [{ lat: 45, lon: -122 }, { lat: 45.05, lon: -122 }, { lat: 45.05, lon: -121.95 }];

describe("area", () => {
  it("is the padded convex hull: a loop's interior is in, the far corner of its box is out", () => {
    const hull = area(event(triangle));
    expect(hull.length).toBeGreaterThanOrEqual(5);
    expect(covers(hull, [{ lat: 45.04, lon: -121.99 }])).toBe(true);
    expect(covers(hull, [{ lat: 45.001, lon: -121.951 }])).toBe(false);
    expect(covers(hull, [{ lat: 45.05, lon: -121.9495 }])).toBe(true);
    expect(covers(hull, [{ lat: 45.05, lon: -121.9485 }])).toBe(false);
  });

  it("includes the spectator's points", () => {
    const spectator = { start: { lat: 45.2, lon: -122 }, end: { location: { lat: 44.9, lon: -122 } } };
    const hull = area(event(triangle, spectator));
    expect(covers(hull, [{ lat: 45.19, lon: -122 }, { lat: 44.91, lon: -122 }])).toBe(true);
  });
});

describe("covers", () => {
  it("is true only when the needed area lies within the fetched one", () => {
    const small = area(event(triangle));
    const large = area(event([...triangle, { lat: 45.1, lon: -121.9 }]));
    expect(covers(large, small)).toBe(true);
    expect(covers(small, large)).toBe(false);
    expect(covers(null, small)).toBe(false);
    expect(covers({ south: 0 }, small)).toBe(false);
  });
});

describe("query", () => {
  it("filters by the hull polygon", () => {
    const text = query([{ lat: 45, lon: -122 }, { lat: 45.1, lon: -122 }, { lat: 45.1, lon: -121.9 }]);
    expect(text).toContain('way["highway"](poly:"45 -122 45.1 -122 45.1 -121.9")');
    expect(text).toContain('way["amenity"="parking"](poly:');
    expect(text.match(/poly:/g)).toHaveLength(5);
  });
});

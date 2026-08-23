import { describe, expect, it } from "vitest";
import { arrowLines, courseEnds, overlapChunks } from "../src/courselines.js";

const at = (x, y) => ({ lat: 45 + y / 111195, lon: -122 + x / (111195 * Math.cos(Math.PI / 4)) });

describe("overlapChunks", () => {
  it("stripes only the stretch two courses share, alternating their colours", () => {
    const short = { points: [at(0, 0), at(200, 0), at(200, 200)], color: "red" };
    const long = { points: [at(0, 0), at(200, 0), at(200, -200)], color: "blue" };
    const chunks = overlapChunks([short, long]);
    expect(chunks.length).toBe(8);
    expect(chunks.map((c) => c.color)).toEqual(["red", "blue", "red", "blue", "red", "blue", "red", "blue"]);
    expect(chunks.every((c) => c.path.every((p) => Math.abs(p.lat - 45) < 1e-9))).toBe(true);
  });

  it("stripes regardless of where each course starts counting, and ignores crossings", () => {
    const a = { points: [at(0, 0), at(300, 0)], color: "red" };
    const b = { points: [at(-13, 0), at(300, 0)], color: "blue" };
    expect(overlapChunks([a, b]).length).toBeGreaterThanOrEqual(11);
    const across = { points: [at(150, -100), at(150, 100)], color: "blue" };
    expect(overlapChunks([a, across])).toEqual([]);
  });

  it("leaves a lone course unstriped", () => {
    expect(overlapChunks([{ points: [at(0, 0), at(500, 0)], color: "red" }])).toEqual([]);
  });
});

describe("arrowLines", () => {
  it("gives the shared stretch to one course and the rest to each", () => {
    const short = { points: [at(0, 0), at(200, 0), at(200, 200)], color: "red" };
    const long = { points: [at(0, 0), at(200, 0), at(200, -200)], color: "blue" };
    const lines = arrowLines([short, long]);
    expect(lines.length).toBe(2);
    expect(lines[0][0]).toEqual(at(0, 0));
    expect(lines[1][0].lon).toBeCloseTo(at(200, 0).lon, 6);
  });
});

describe("courseEnds", () => {
  it("merges shared starts and marks a loop's start-finish as both", () => {
    const loop = { points: [at(0, 0), at(100, 0), at(100, 100), at(0, 0)], color: "red" };
    const out = { points: [at(2, 0), at(300, 0)], color: "blue" };
    const ends = courseEnds([loop, out]);
    expect(ends.map((e) => e.kind).sort()).toEqual(["both", "finish"]);
  });
});

import { describe, expect, it } from "vitest";

import { createEngine } from "../src/engine.js";

describe("engine", () => {
  const engine = createEngine();

  it("reports the engine version over the worker bridge", async () => {
    const reply = await engine.call("version", {});
    expect(reply).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("validates an event and reports problems", async () => {
    const event = {
      name: "e",
      origin: { lat: 0, lon: 0 },
      courses: [],
      racers: [{ id: "r", name: "r", course_id: "missing", pace_profile: [] }],
      spectator: { earliest: 0, mode: "walk" },
    };
    const problems = await engine.call("validate", { event });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unknown course");
  });

  it("rejects unknown message types", async () => {
    await expect(engine.call("nope")).rejects.toThrow("unknown message type");
  });
});

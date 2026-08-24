import { describe, expect, it } from "vitest";
import { newEvent } from "../src/event.js";
import { betterPlan, planLevels, planSummary, stopLabel } from "../src/plans.js";

describe("planLevels", () => {
  it("counts distinct racers per kind and every sighting", () => {
    const event = newEvent({ lat: 0, lon: 0 });
    event.racers = [{ id: "a" }, { id: "b" }];
    const itinerary = {
      stops: [
        { seen: [{ racer_id: "a", kind: "pass" }, { racer_id: "a", kind: "pass" }] },
        { seen: [{ racer_id: "a", kind: "finish" }, { racer_id: "b", kind: "finish" }] },
      ],
    };
    expect(planLevels(event, itinerary)).toEqual({ racers: 2, seen: 1, finished: 2, sightings: 4 });
    expect(planSummary(event, itinerary)).toBe("Seen en route 1/2 · finishes 2/2 · 4 sightings");
  });
});

describe("betterPlan", () => {
  const levels = (seen, finished, sightings = 0) => ({ racers: 3, seen, finished, sightings });

  it("ranks completeness above counts and ignores mere repeats", () => {
    expect(betterPlan(levels(3, 0), levels(2, 3))).toBe(true);
    expect(betterPlan(levels(2, 3), levels(2, 2))).toBe(true);
    expect(betterPlan(levels(2, 2), levels(2, 2, 9))).toBe(false);
    expect(betterPlan(levels(2, 2), levels(3, 3))).toBe(false);
  });
});

describe("stopLabel", () => {
  const anchored = { spectator: { start: { lat: 0, lon: 0 } } };
  const free = { spectator: { start: null } };
  it("names the anchor and numbers from there", () => {
    expect([0, 1, 2].map((i) => stopLabel(anchored, i))).toEqual(["Start", 1, 2]);
    expect([0, 1].map((i) => stopLabel(free, i))).toEqual([1, 2]);
  });
});

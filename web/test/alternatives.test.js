import { describe, expect, it } from "vitest";
import { ALTERNATIVES, alternativeEvent, betterPlan, newEvent, planLevels, planSummary } from "../src/state.js";

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

describe("overTierLimit", () => {
  it("caps courses, racers, and paces on Free but nothing on Plus", async () => {
    const { addCourse, addRacer, overTierLimit, splitInterval } = await import("../src/state.js");
    const event = newEvent({ lat: 0, lon: 0 });
    expect(overTierLimit(event, "free")).toBeNull();
    addCourse(event);
    addRacer(event, event.courses[0]);
    addRacer(event, event.courses[0]);
    expect(overTierLimit(event, "free")).toBeNull();
    addRacer(event, event.courses[0]);
    expect(overTierLimit(event, "free")).toMatch(/2 racers/);
    event.racers.pop();
    event.racers[0].pace_profile = [{ start_m: 0, end_m: 1000, seconds_per_km: 300, uncertainty: 0 }];
    splitInterval(event.racers[0], 0, 500);
    expect(overTierLimit(event, "free")).toMatch(/one pace/);
    expect(overTierLimit(event, "plus")).toBeNull();
  });
});

describe("alternativeEvent", () => {
  it("loosens a copy and leaves the original alone", () => {
    const event = newEvent({ lat: 0, lon: 0 });
    const faster = alternativeEvent(event, ALTERNATIVES[0]);
    expect(faster.spectator.speed_mps).toBeCloseTo(1.3 * 1.25, 6);
    expect(event.spectator.speed_mps).toBeNull();
    const everything = alternativeEvent(event, ALTERNATIVES.at(-1));
    expect(everything.spectator.safety_buffer_s).toBe(60);
    expect(everything.spectator.min_stop_s).toBe(0);
    expect(event.spectator.safety_buffer_s).toBe(120);
  });
});

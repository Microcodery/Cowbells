import { describe, expect, it } from "vitest";
import { addCourse, addRacer, newEvent, splitInterval } from "../src/event.js";
import { overTierLimit, tierSummary } from "../src/tiers.js";

describe("overTierLimit", () => {
  it("caps courses, racers, and paces on Free but nothing on Plus", () => {
    const event = newEvent({ lat: 0, lon: 0 });
    expect(overTierLimit(event, "free")).toBeNull();
    addCourse(event);
    addRacer(event, event.courses[0]);
    addRacer(event, event.courses[0]);
    expect(overTierLimit(event, "free")).toBeNull();
    addRacer(event, event.courses[0]);
    expect(overTierLimit(event, "free")).toBe("Free allows two racers");
    event.racers.pop();
    event.racers[0].pace_profile = [{ start_m: 0, end_m: 1000, seconds_per_km: 300, uncertainty: 0 }];
    splitInterval(event.racers[0], 0, 500);
    expect(overTierLimit(event, "free")).toBe("Free allows one pace per racer");
    expect(overTierLimit(event, "plus")).toBeNull();
  });
});

describe("tierSummary", () => {
  it("reads the limits out of the table rather than repeating them", () => {
    expect(tierSummary()).toBe("Free: one course, two racers, one pace per racer. Plus: no limits.");
  });
});

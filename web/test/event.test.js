import { describe, expect, it } from "vitest";
import { newEvent, rebase } from "../src/event.js";

describe("rebase", () => {
  it("keeps staggered starts and the spectator's lead intact", () => {
    const event = newEvent({ lat: 0, lon: 0 });
    event.courses = [
      { id: "a", start_time: 300, segments: [] },
      { id: "b", start_time: 0, segments: [] },
    ];
    event.spectator.earliest = -900;
    event.spectator.required_regions = [{ center: { lat: 0, lon: 0 }, radius_m: 50, latest: 600 }];
    rebase(event, 10_000);
    expect(event.courses.map((c) => c.start_time)).toEqual([10_300, 10_000]);
    expect(event.spectator.earliest).toBe(9_100);
    expect(event.spectator.required_regions[0].latest).toBe(10_600);
  });
});

import { describe, expect, it } from "vitest";
import { mergeInterval, newEvent, rebase } from "../src/event.js";

const racerWith = (...intervals) => ({
  pace_profile: intervals.map(([start_m, end_m, seconds_per_km, uncertainty = 0.05]) => ({ start_m, end_m, seconds_per_km, uncertainty })),
});

describe("mergeInterval", () => {
  it("keeps the pace when both legs already run it", () => {
    const racer = racerWith([0, 1000, 300], [1000, 5000, 300]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile).toHaveLength(1);
    expect(racer.pace_profile[0]).toMatchObject({ start_m: 0, end_m: 5000, seconds_per_km: 300 });
  });

  it("averages differing paces by the distance each one covers", () => {
    // 1 km at 300 s/km and 4 km at 400 s/km is 1900 s over 5 km: 380 s/km.
    const racer = racerWith([0, 1000, 300], [1000, 5000, 400]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile[0].seconds_per_km).toBe(380);
  });

  it("rounds a lopsided average to a tenth of a second", () => {
    const racer = racerWith([0, 1000, 300], [1000, 4000, 401]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile[0].seconds_per_km).toBe(375.8);
  });

  it("blends the spread without collapsing it to a tenth", () => {
    const racer = racerWith([0, 1000, 300, 0.05], [1000, 3000, 300, 0.08]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile[0].uncertainty).toBeCloseTo(0.07, 5);
  });

  it("keeps a blended spread under the whole the engine rejects", () => {
    const racer = racerWith([0, 1000, 300, 0.9998], [1000, 3000, 300, 0.9999]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile[0].uncertainty).toBeLessThan(1);
  });

  it("leaves the profile alone when there is no leg below", () => {
    const racer = racerWith([0, 1000, 300]);
    mergeInterval(racer, 0);
    expect(racer.pace_profile).toHaveLength(1);
  });
});

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

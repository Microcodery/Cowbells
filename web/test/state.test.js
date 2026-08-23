import { describe, expect, it } from "vitest";

import { itineraryToGpx } from "../src/gpx.js";
import { newEvent, rebase, stopLabel, withClock } from "../src/state.js";

const stop = (seen) => ({ location: { lat: 1, lon: 2 }, arrive: 100, depart: 200, seen });
const sighting = (racer_id, kind, expected) => ({ racer_id, kind, expected, open: 0, close: 0 });

describe("withClock", () => {
  it("keeps the time when the input is blank, so the event never carries a NaN timestamp", () => {
    const epoch = 1_700_000_000;
    expect(withClock(epoch, "")).toBe(epoch);
    expect(withClock(epoch, "xx:yy")).toBe(epoch);
    expect(withClock(epoch, "07:30")).not.toBe(epoch);
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

describe("stopLabel", () => {
  const anchored = { spectator: { start: { lat: 0, lon: 0 } } };
  const free = { spectator: { start: null } };
  it("names the anchor and numbers from there", () => {
    expect([0, 1, 2].map((i) => stopLabel(anchored, i))).toEqual(["Start", 1, 2]);
    expect([0, 1].map((i) => stopLabel(free, i))).toEqual([1, 2]);
  });
});

describe("itineraryToGpx", () => {
  it("writes one waypoint per stop and a track without duplicated junctions", () => {
    const event = { ...newEvent({ lat: 0, lon: 0 }), name: "Fun & Games", racers: [{ id: "a", name: "Ann <3" }] };
    event.spectator.start = { lat: 0, lon: 0 };
    const itinerary = {
      stops: [stop([]), stop([sighting("a", "finish", 150)])],
      legs: [{ seconds: 10, path: [{ lat: 0, lon: 0 }, { lat: 1, lon: 2 }] }, { seconds: 5, path: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }],
    };
    const gpx = itineraryToGpx(itinerary, event);
    expect(gpx).toContain("Fun &amp; Games");
    expect(gpx).toContain("Ann &lt;3 finish");
    expect(gpx.match(/<wpt /g)).toHaveLength(2);
    expect(gpx.match(/<trkpt /g)).toHaveLength(3);
    expect(gpx.indexOf("<time>")).toBeLessThan(gpx.indexOf("<name>Start"));
  });
});

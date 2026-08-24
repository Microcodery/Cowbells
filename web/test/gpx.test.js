import { describe, expect, it } from "vitest";
import { newEvent } from "../src/event.js";
import { itineraryToGpx } from "../src/gpx.js";

const stop = (seen) => ({ location: { lat: 1, lon: 2 }, arrive: 100, depart: 200, seen });
const sighting = (racer_id, kind, expected) => ({ racer_id, kind, expected, open: 0, close: 0 });

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

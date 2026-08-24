import { describe, expect, it } from "vitest";
import { liveReplay } from "../src/replay.js";

const noop = () => {};
const canvas = { clear: noop, dots: noop, slidingDots: noop, sectors: noop, lines: noop };
const layers = { clear: noop, flush: noop, addCircles: noop, addPoints: noop, addLines: noop };
const instant = { networkMs: 0, candidatesMs: 0, mergeMs: 0, searchMs: 0 };

describe("liveReplay", () => {
  it("finishes even when the plan reported no candidates to animate", async () => {
    const live = liveReplay({ layers, canvas }, 30, instant, noop);
    live.push({ stage: "network", points: [{ lat: 0, lon: 0 }] });
    await live.finish();
  });

  it("announces the first report once, not on every push until the network lands", async () => {
    let firstDraws = 0;
    const live = liveReplay({ layers, canvas }, 30, instant, noop, () => firstDraws++);
    live.push({ stage: "candidates", locations: [] });
    live.push({ stage: "candidates", locations: [] });
    live.push({ stage: "network", points: [] });
    expect(firstDraws).toBe(1);
    await live.finish();
  });
});

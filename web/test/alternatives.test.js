import { describe, expect, it } from "vitest";
import { ALTERNATIVES, alternativeEvent } from "../src/alternatives.js";
import { newEvent } from "../src/event.js";

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

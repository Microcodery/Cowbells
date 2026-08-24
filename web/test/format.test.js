import { describe, expect, it } from "vitest";
import { UNITS, paceLabel, parsePace, withClock } from "../src/format.js";

describe("pace in display units", () => {
  it("round-trips per mile and per kilometre", () => {
    expect(paceLabel(360)).toBe("6:00");
    expect(paceLabel(360, UNITS.mi)).toBe("9:39");
    expect(parsePace("9:39", UNITS.mi)).toBeCloseTo(359.7, 0);
    expect(parsePace("6", UNITS.km)).toBe(360);
  });
});

describe("withClock", () => {
  it("keeps the time when the input is blank, so the event never carries a NaN timestamp", () => {
    const epoch = 1_700_000_000;
    expect(withClock(epoch, "")).toBe(epoch);
    expect(withClock(epoch, "xx:yy")).toBe(epoch);
    expect(withClock(epoch, "07:30")).not.toBe(epoch);
  });
});

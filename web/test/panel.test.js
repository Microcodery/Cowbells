import { describe, expect, it } from "vitest";
import { renderPanel } from "../src/panel.js";
import { UNITS, addCourse, newEvent } from "../src/state.js";

const ui = { tool: null, itinerary: null, network: null, osm: null, status: "", busy: false, beam: 64, replaySeconds: 6, replaying: null, unit: UNITS.km };

describe("renderPanel", () => {
  it("keeps each section's fold across re-renders", () => {
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    renderPanel(root, event, ui, {});
    const section = (name) => root.querySelector(`details[data-section=${name}]`);
    expect(section("courses").open).toBe(true);
    expect(section("settings").open).toBe(false);
    section("settings").open = true;
    section("courses").open = false;
    renderPanel(root, event, ui, {});
    expect(section("settings").open).toBe(true);
    expect(section("courses").open).toBe(false);
    expect(section("racers")).toBeNull();
    addCourse(event);
    renderPanel(root, event, ui, {});
    expect(section("racers").open).toBe(true, "a section appearing for the first time opens by default");
    expect(section("courses").open).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { renderPanel } from "../src/panel.js";
import { UNITS, addCourse, newEvent } from "../src/state.js";

const ui = { tool: null, itinerary: null, network: null, osm: null, status: "", busy: false, beam: 64, unit: UNITS.km, tier: "free", debug: { networkMs: 1000, candidatesMs: 1000, mergeMs: 1000, searchMs: 3000, fitMargin: 10, hoverPx: 18, mapDataDelayMs: 1500 } };

describe("tier locks", () => {
  it("locks the add buttons once Free is used up and frees them on Plus", async () => {
    const { addCourse, addPoint, addRacer } = await import("../src/state.js");
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    addCourse(event);
    addPoint(event.courses[0], { lat: 45, lon: -122 });
    addPoint(event.courses[0], { lat: 45.01, lon: -122 });
    addRacer(event, event.courses[0]);
    addRacer(event, event.courses[0]);
    renderPanel(root, event, ui, {});
    expect(root.querySelector("button[data-act=addCourse]")).toBeNull();
    expect(root.querySelector("button.locked[data-what=course]")).not.toBeNull();
    expect(root.querySelector("button.locked[data-what=racer]")).not.toBeNull();
    expect(root.querySelectorAll("button.locked[data-what=pace]").length).toBe(2);
    renderPanel(root, event, { ...ui, tier: "plus" }, {});
    expect(root.querySelector("button.locked")).toBeNull();
    expect(root.querySelector("button[data-act=addCourse]")).not.toBeNull();
  });
});

describe("renderPanel", () => {
  it("keeps each section's fold across re-renders", () => {
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    renderPanel(root, event, ui, {});
    const section = (name) => root.querySelector(`details[data-section=${name}]`);
    expect(section("courses").open).toBe(false, "sections start folded");
    expect(section("settings").open).toBe(false);
    section("settings").open = true;
    section("courses").open = true;
    renderPanel(root, event, ui, {});
    expect(section("settings").open).toBe(true);
    expect(section("courses").open).toBe(true);
    expect(section("racers")).toBeNull();
    addCourse(event);
    renderPanel(root, event, ui, {});
    expect(section("racers").open).toBe(false, "a section appearing for the first time keeps the template default");
    expect(section("courses").open).toBe(true);
  });
});

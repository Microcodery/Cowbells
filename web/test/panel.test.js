import { describe, expect, it } from "vitest";
import { addCourse, newEvent } from "../src/event.js";
import { UNITS } from "../src/format.js";
import { renderPanel } from "../src/panel.js";

const ui = { tool: null, itinerary: null, network: null, osm: null, status: "", busy: false, beam: 64, unit: UNITS.km, tier: "free", debug: { networkMs: 1000, candidatesMs: 1000, mergeMs: 1000, searchMs: 3000, fitMargin: 10, hoverPx: 18, mapDataDelayMs: 1500 } };

describe("tier locks", () => {
  it("locks the add buttons once Free is used up and frees them on Plus", async () => {
    const { addPoint, addRacer } = await import("../src/event.js");
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    addCourse(event);
    addPoint(event.courses[0], { lat: 45, lon: -122 });
    addPoint(event.courses[0], { lat: 45.01, lon: -122 });
    addRacer(event, event.courses[0]);
    addRacer(event, event.courses[0]);
    renderPanel(root, event, ui, {});
    expect(root.querySelector("button[data-act=addCourse]")).toBeNull();
    expect(root.querySelector("button.locked[data-what=courses]")).not.toBeNull();
    expect(root.querySelector("button.locked[data-what=racers]")).not.toBeNull();
    expect(root.querySelectorAll("button.locked[data-what=paces]").length).toBe(2);
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
    expect(section("courses").open, "sections start folded").toBe(false);
    expect(section("settings").open).toBe(false);
    section("settings").open = true;
    section("courses").open = true;
    renderPanel(root, event, ui, {});
    expect(section("settings").open).toBe(true);
    expect(section("courses").open).toBe(true);
    expect(section("racers")).toBeNull();
    addCourse(event);
    renderPanel(root, event, ui, {});
    expect(section("racers").open, "a section appearing for the first time keeps the template default").toBe(false);
    expect(section("courses").open).toBe(true);
  });
});

// Last in the file: the ghost is panel-wide state, and this leaves it dismissed.
describe("ghost space", () => {
  it("keeps the cleared plan's height until the panel is scrolled up", () => {
    const root = document.createElement("div");
    root.style.cssText = "height:50px;overflow:auto";
    document.body.append(root);
    const event = newEvent({ lat: 45, lon: -122 });
    const planned = { ...ui, itinerary: { stops: [], legs: [], unseen: [], unmet_regions: [], score: 0 }, alternatives: [] };
    renderPanel(root, event, planned, {});
    const height = root.querySelector("[data-results]").offsetHeight;
    expect(height).toBeGreaterThan(0);

    const cleared = { ...planned, itinerary: null };
    renderPanel(root, event, cleared, {});
    expect(root.querySelector(".ghost").style.height).toBe(`${height}px`);

    root.scrollTop = 20;
    root.dispatchEvent(new Event("scroll"));
    expect(root.querySelector(".ghost"), "scrolling down keeps the space").not.toBeNull();
    root.scrollTop = 0;
    root.dispatchEvent(new Event("scroll"));
    expect(root.querySelector(".ghost")).toBeNull();
    renderPanel(root, event, cleared, {});
    expect(root.querySelector(".ghost"), "and it does not come back on the next render").toBeNull();
    root.remove();
  });
});

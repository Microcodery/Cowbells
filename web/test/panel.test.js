import { describe, expect, it } from "vitest";
import { addCourse, newEvent } from "../src/event.js";
import { UNITS } from "../src/format.js";
import { renderPanel } from "../src/panel.js";

const ui = { tool: null, itinerary: null, network: null, osm: null, status: "", busy: false, beam: 64, unit: UNITS.km, shapes: {}, editing: null, debug: { networkMs: 1000, candidatesMs: 1000, mergeMs: 1000, searchMs: 3000, fitMargin: 10, hoverPx: 18, mapDataDelayMs: 1500 } };

describe("the load dialog", () => {
  it("offers a file drop zone and every example behind one Load button", () => {
    const root = document.createElement("div");
    document.body.append(root);
    renderPanel(root, newEvent({ lat: 45, lon: -122 }), ui, {});
    expect(root.querySelector("select[data-act=example]"), "the dropdown moved into the dialog").toBeNull();
    expect(root.querySelector("button[data-act=showDialog][data-dialog=load]")).not.toBeNull();

    const dialog = root.querySelector("dialog[data-dialog=load]");
    expect(dialog.querySelector("[data-dropzone] input[type=file]").accept).toContain(".bird");
    const examples = [...dialog.querySelectorAll("button[data-act=example]")].map((b) => b.dataset.example);
    expect(examples).toEqual(["three-distances", "uptown-ladder", "colfax"]);
    root.remove();
  });

  it("keeps the debug tunables out of the panel, behind the flask", () => {
    const root = document.createElement("div");
    document.body.append(root);
    renderPanel(root, newEvent({ lat: 45, lon: -122 }), ui, {});
    expect(root.querySelector("details[data-section=debug]"), "debug is no longer a section").toBeNull();
    expect(root.querySelector(".lab button[data-act=showDialog][data-dialog=debug]")).not.toBeNull();
    expect(root.querySelector("dialog[data-dialog=debug] input[data-field=debug]")).not.toBeNull();
    root.remove();
  });

  it("stays open when a background update redraws the panel", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const event = newEvent({ lat: 45, lon: -122 });
    renderPanel(root, event, ui, {});
    root.querySelector("dialog[data-dialog=load]").showModal();

    renderPanel(root, event, { ...ui, status: "Fetching map data…" }, {});
    expect(root.querySelector("dialog[data-dialog=load]").open).toBe(true);
    root.remove();
  });
});

describe("renderPanel", () => {
  it("keeps each section's fold across re-renders", () => {
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    renderPanel(root, event, ui, {});
    const section = (name) => root.querySelector(`details[data-section=${name}]`);
    expect(section("courses").open, "the sections you start in are open").toBe(true);
    expect(section("settings").open, "the rest start folded").toBe(false);
    section("settings").open = true;
    section("courses").open = false;
    renderPanel(root, event, ui, {});
    expect(section("settings").open).toBe(true);
    expect(section("courses").open).toBe(false);
    expect(section("racers")).toBeNull();
    addCourse(event);
    renderPanel(root, event, ui, {});
    expect(section("racers").open, "a section appearing for the first time keeps the template default").toBe(false);
    expect(section("courses").open).toBe(false);
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

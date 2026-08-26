import { describe, expect, it } from "vitest";
import { addCourse, addRacer, newEvent } from "../src/event.js";
import { UNITS } from "../src/format.js";
import { renderPanel } from "../src/panel.js";

const ui = { tool: null, itinerary: null, network: null, osm: null, status: "", busy: false, beam: 64, unit: UNITS.km, shapes: {}, editing: null, snap: { roads: true, paths: true }, debug: { networkMs: 1000, candidatesMs: 1000, mergeMs: 1000, searchMs: 3000, fitMargin: 10, hoverPx: 18, mapDataDelayMs: 1500 } };

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

describe("course cards", () => {
  it("start folded down to a name and a length", () => {
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    addCourse(event);
    renderPanel(root, event, ui, {});
    const card = root.querySelector("details.card.course");
    expect(card.open, "a course opens only when asked").toBe(false);
    expect(card.querySelector("summary .name").textContent).toBe(event.courses[0].name);
    expect(card.querySelector("summary input"), "the name is text until it is clicked").toBeNull();
  });

  it("gives the name over to a field once the card is open", () => {
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    addCourse(event);
    renderPanel(root, event, { ...ui, renaming: event.courses[0].id }, {});
    expect(root.querySelector("details.card.course summary input.rename")).not.toBeNull();
  });

  it("stays open while its shape is being drawn", () => {
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    addCourse(event);
    renderPanel(root, event, { ...ui, editing: event.courses[0].id }, {});
    const card = root.querySelector("details.card.course");
    expect(card.open, "the tools for drawing are no use folded away").toBe(true);
    expect(card.querySelector("button[data-act=editCourse]").textContent).toBe("Done");
  });

  it("takes the name back as text once the new one is in", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const event = newEvent({ lat: 45, lon: -122 });
    addCourse(event);
    const renaming = { ...ui, renaming: event.courses[0].id };
    const actions = {
      edit({ field }, input) {
        // What main.js does for this field: take the name, and let the renaming end with it.
        expect(field).toBe("courseName");
        event.courses[0].name = input.value;
        renaming.renaming = null;
        renderPanel(root, event, renaming, actions);
      },
      // Leaving the field ends the rename too; the panel calls this whichever way the field goes.
      endRename() {
        renaming.renaming = null;
      },
    };
    renderPanel(root, event, renaming, actions);
    const field = root.querySelector("input.rename");
    field.value = "Named by hand";
    field.dispatchEvent(new Event("change", { bubbles: true }));

    expect(root.querySelector("input.rename"), "the field gave way once it had served").toBeNull();
    expect(root.querySelector("details.card.course summary .name").textContent).toBe("Named by hand");
    root.remove();
  });
});

describe("racer cards", () => {
  it("start folded, so opening Racers shows the whole field at once", () => {
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    addCourse(event);
    addRacer(event, event.courses[0]);
    addRacer(event, event.courses[0]);
    renderPanel(root, event, ui, {});
    const cards = [...root.querySelectorAll("details.card[data-section^=racer-]")];
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => !card.open), "every racer is folded down to its summary").toBe(true);
  });

  it("stays open across a redraw once the reader has opened it", () => {
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    addCourse(event);
    addRacer(event, event.courses[0]);
    renderPanel(root, event, ui, {});
    const card = () => root.querySelector("details.card[data-section^=racer-]");
    card().open = true;
    renderPanel(root, event, { ...ui, status: "Fetching map data…" }, {});
    expect(card().open).toBe(true);
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

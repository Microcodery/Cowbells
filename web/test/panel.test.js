import { describe, expect, it } from "vitest";
import { renderPanel } from "../src/panel.js";
import { newEvent } from "../src/state.js";

const ui = { tool: null, itinerary: null, network: null, osm: null, status: "", busy: false, beam: 64, replaySeconds: 6, replaying: null };

describe("renderPanel", () => {
  it("keeps an opened section open across re-renders", () => {
    const root = document.createElement("div");
    const event = newEvent({ lat: 45, lon: -122 });
    renderPanel(root, event, ui, {});
    const details = root.querySelector("details");
    expect(details.open).toBe(false);
    details.open = true;
    renderPanel(root, event, ui, {});
    expect(root.querySelector("details").open).toBe(true);
  });
});

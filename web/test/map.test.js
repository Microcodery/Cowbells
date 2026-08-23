import { Map as MapLibre } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import "../src/map.js";

const hasWebGL = Boolean(document.createElement("canvas").getContext("webgl2"));

describe("maplibre", () => {
  // GeoJSON sources are processed in MapLibre's worker; "loaded" proves the bundled worker runs.
  it.skipIf(!hasWebGL)("spawns its worker from the bundled URL", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.style.cssText = "width:200px;height:200px";
    const map = new MapLibre({ container, style: { version: 8, sources: {}, layers: [] }, center: [0, 0], zoom: 1 });
    await new Promise((resolve) => map.once("load", resolve));
    map.addSource("dot", { type: "geojson", data: { type: "Point", coordinates: [0, 0] } });
    map.addLayer({ id: "dot", type: "circle", source: "dot" });
    await new Promise((resolve) => map.once("idle", resolve));
    expect(map.isSourceLoaded("dot")).toBe(true);
    map.remove();
  });
});

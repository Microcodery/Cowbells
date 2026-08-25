import { Map as MapLibre } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { metresPerPixel } from "../src/map.js";

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

const WIDE = 800;
const TALL = 600;

/**
 * A map that projects like MapLibre's does — web mercator over 512-pixel tiles, turned by a bearing
 * and foreshortened by a pitch — without needing a canvas to draw on. Tilting is modelled at the
 * middle of the view, which is where the scale is measured.
 */
const mapAt = (center, zoom, bearing = 0, pitch = 0) => {
  const world = 512 * 2 ** zoom;
  const mercator = (lat, lng) => ({
    x: ((lng + 180) / 360) * world,
    y: ((180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360) * world,
  });
  const groundAt = ({ x, y }) => {
    const north = 180 - (y / world) * 360;
    return {
      lng: (x / world) * 360 - 180,
      lat: (360 / Math.PI) * Math.atan(Math.exp((north * Math.PI) / 180)) - 90,
    };
  };
  const origin = mercator(center.lat, center.lng);
  const turn = (bearing * Math.PI) / 180;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  const squash = Math.cos((pitch * Math.PI) / 180);
  return {
    getCenter: () => center,
    getCanvas: () => ({ clientWidth: WIDE, clientHeight: TALL }),
    project: ([lng, lat]) => {
      const { x, y } = mercator(lat, lng);
      const [dx, dy] = [x - origin.x, y - origin.y];
      return { x: dx * cos - dy * sin + WIDE / 2, y: (dx * sin + dy * cos) * squash + TALL / 2 };
    },
    unproject: ([x, y]) => {
      const [rx, ry] = [x - WIDE / 2, (y - TALL / 2) / squash];
      return groundAt({ x: origin.x + (rx * cos + ry * sin), y: origin.y + (-rx * sin + ry * cos) });
    },
  };
};

/** What a 512-pixel-tile mercator map covers per pixel, from the projection's own constants. */
const exactly = (lat, zoom) => (78271.516 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

describe("metresPerPixel", () => {
  it("measures what a pixel covers", () => {
    const scale = metresPerPixel(mapAt({ lat: 45.5, lng: -122.6 }, 13));
    expect(scale).toBeCloseTo(exactly(45.5, 13), 1);
  });

  it("halves each time the map zooms in", () => {
    const far = metresPerPixel(mapAt({ lat: 45.5, lng: -122.6 }, 12));
    const near = metresPerPixel(mapAt({ lat: 45.5, lng: -122.6 }, 13));
    expect(far / near).toBeCloseTo(2, 3);
  });

  it("holds still as the map is turned", () => {
    const north = metresPerPixel(mapAt({ lat: 45.5, lng: -122.6 }, 13));
    // A turned map lays east across both axes; measuring only the width would run away here.
    for (const bearing of [30, 45, 60, 89, 90, 180, 270]) {
      const turned = metresPerPixel(mapAt({ lat: 45.5, lng: -122.6 }, 13, bearing));
      expect(turned, `bearing ${bearing}`).toBeCloseTo(north, 3);
    }
  });

  it("holds still as a tilted map is turned", () => {
    // The scale used to be taken from a step due east, which a tilt foreshortens by however much
    // the turn has laid it up the screen: the radar then grew and shrank as the map spun.
    const flat = metresPerPixel(mapAt({ lat: 45.5, lng: -122.6 }, 13, 0, 60));
    for (const bearing of [30, 45, 60, 89, 90, 180, 270]) {
      const turned = metresPerPixel(mapAt({ lat: 45.5, lng: -122.6 }, 13, bearing, 60));
      expect(turned, `bearing ${bearing} at 60° of pitch`).toBeCloseTo(flat, 3);
    }
  });

  it("covers more ground per pixel away from the equator", () => {
    const equator = metresPerPixel(mapAt({ lat: 0, lng: 0 }, 13));
    const north = metresPerPixel(mapAt({ lat: 60, lng: 0 }, 13));
    expect(north).toBeLessThan(equator);
    expect(north).toBeCloseTo(exactly(60, 13), 1);
  });
});

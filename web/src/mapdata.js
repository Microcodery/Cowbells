// Keeps the map data behind an event in step with the courses drawn on it: the OpenStreetMap
// extract they need, the routing network built from that, and the debounces that keep both out of
// the way while the pen is moving.

import { planGeneration } from "./generation.js";
import { courseCenter } from "./geo.js";
import { area, covers, fetchOsm } from "./overpass.js";
import { loadMapData, saveMapData } from "./store.js";

/** Settings arrive in bursts while a spinner is held down; rebuild the network once they stop. */
const REBUILD_DELAY_MS = 400;

/**
 * `currentEvent` and `fallbackCenter` are called rather than captured: the event is replaced whole
 * when one is loaded, and the map's centre only stands in while nothing is drawn.
 */
export function createMapData({ engine, ui, currentEvent, fallbackCenter, narrate, render }) {
  let rebuildTimer = null;
  let resolveRebuild = null;
  let networkBuild = null;
  let fetchTimer = null;
  let fetching = null;

  const hasCourse = () => currentEvent().courses.some((c) => c.segments.some((s) => s.points.length >= 2));

  /**
   * Builds the network for the current settings. If the settings change while the engine is at
   * it, the result is stale: it is dropped and the build starts over.
   */
  async function buildNetwork() {
    for (;;) {
      const generation = planGeneration();
      const event = currentEvent();
      const { mode, speed_mps } = event.spectator;
      const network = await engine.call("network", { osm: ui.osm, origin: event.origin, mode, speed: speed_mps });
      if (generation === planGeneration()) {
        ui.network = network;
        return `Network: ${network.nodes} nodes, ${network.edges} edges.`;
      }
    }
  }

  /**
   * The network depends on mode and speed; rebuild it from the cached map data rather than
   * refetching. Runs in the background (the worker serialises engine calls) so a change made
   * while something else is busy is never silently dropped.
   */
  function rebuildNetwork() {
    ui.network = null;
    if (!ui.osm) return;
    narrate("Rebuilding network…");
    // The superseded build is settled first: anything already waiting on it wants the newer one.
    resolveRebuild?.();
    clearTimeout(rebuildTimer);
    networkBuild = new Promise((resolve) => {
      resolveRebuild = resolve;
      rebuildTimer = setTimeout(() => {
        buildNetwork()
          .then(narrate)
          .catch((err) => narrate(`Network: ${err.message}`))
          .finally(resolve);
      }, REBUILD_DELAY_MS);
    });
  }

  /** Fetches map data for the courses in the background unless the extract in hand already covers them. */
  function ensureMapData() {
    if (fetching || !hasCourse()) return fetching;
    const event = currentEvent();
    const needed = area(event);
    if (covers(ui.osmArea, needed)) return null;
    // The projection is centred on the courses so distances stay true across the whole event.
    event.origin = courseCenter(event, fallbackCenter());
    narrate("Fetching map data…");
    fetching = (async () => {
      try {
        const osm = await fetchOsm(event);
        ui.osm = osm;
        ui.osmArea = needed;
        ui.network = null;
        saveMapData({ osm, area: needed });
        narrate(await buildNetwork());
      } catch (err) {
        narrate(`Map data: ${err.message}`);
      } finally {
        fetching = null;
        render();
      }
    })();
    return fetching;
  }

  /** Courses change point by point while drawing; fetch once the pen has been still for a moment. */
  function scheduleMapData() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => ensureMapData(), ui.debug.mapDataDelayMs);
  }

  return {
    buildNetwork,
    rebuildNetwork,
    ensure: ensureMapData,
    schedule: scheduleMapData,
    cancelSchedule: () => clearTimeout(fetchTimer),
    /** Resolves once a debounced rebuild has finished, so a plan never uses the old network. */
    async awaitRebuild() {
      await networkBuild;
    },

    /** After a reload the event comes back from localStorage; its map data comes back from IndexedDB. */
    async restore() {
      if (!hasCourse()) return;
      const saved = await loadMapData();
      if (!saved || !covers(saved.area, area(currentEvent()))) {
        scheduleMapData();
        return;
      }
      ui.osm = saved.osm;
      ui.osmArea = saved.area;
      narrate(await buildNetwork());
      render();
    },

    /**
     * Takes on the map data that came with a loaded event, or none at all. Returns the network's
     * status once it is built, or null when there is nothing yet and a fetch has been scheduled.
     */
    async adopt(osm) {
      ui.osm = osm ?? null;
      ui.osmArea = ui.osm ? area(currentEvent()) : null;
      ui.network = null;
      saveMapData(ui.osm ? { osm: ui.osm, area: ui.osmArea } : null);
      if (!ui.osm) {
        scheduleMapData();
        return null;
      }
      return buildNetwork();
    },

    /** Forgets the extract and the network, and the copy saved for the next reload with them. */
    clear() {
      clearTimeout(fetchTimer);
      ui.osm = null;
      ui.osmArea = null;
      ui.network = null;
      saveMapData(null);
    },
  };
}

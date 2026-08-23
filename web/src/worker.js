// Owns the WASM engine. Requests carry an id; replies echo it.

import init, { Network, parse_gpx, ping, validate } from "birdeye-wasm";

const ready = init();
let network = null;

const handlers = {
  ping: ({ msg }) => ping(msg),
  validate: ({ event }) => JSON.parse(validate(JSON.stringify(event))),
  gpx: ({ xml }) => JSON.parse(parse_gpx(xml)),
  network: ({ osm, origin, mode, speed }) => {
    network?.free();
    network = null;
    // wasm-bindgen maps only `undefined` to `None`, and an unset speed arrives as `null`.
    network = new Network(osm, JSON.stringify(origin), mode, speed ?? undefined);
    return { nodes: network.node_count(), edges: network.edge_count() };
  },
  plan: ({ event, options }, progress) => {
    if (!network) throw new Error("fetch map data before planning");
    const onProgress = (json) => progress(JSON.parse(json));
    return JSON.parse(network.plan(JSON.stringify(event), JSON.stringify(options ?? {}), onProgress));
  },
};

self.onmessage = async (e) => {
  const { id, type, ...payload } = e.data;
  try {
    await ready;
    const handler = handlers[type];
    if (!handler) throw new Error(`unknown message type: ${type}`);
    const progress = (data) => self.postMessage({ id, type, progress: data });
    self.postMessage({ id, type, result: handler(payload, progress) });
  } catch (err) {
    self.postMessage({ id, type, error: String(err?.message ?? err) });
  }
};

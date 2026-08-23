// Animates the engine's progress on the map as a funnel. Each stage is a timed animation that
// starts once its data has arrived and the stage before it has finished:
//   network    – the walkable nodes appear one after another          (≥ networkMs)
//   candidates – spots within sight brighten while the rest fade      (candidatesMs)
//   merge      – candidates slide into their viewpoint, whose sighting circle and arc grow (mergeMs)
//   search     – the search plays out with the best plan lit along the roads (≥ searchMs)
// The big point sets are sent to the map once and animated with paint expressions; only the
// merge rebuilds geometry per frame, on a thinned set, so frames stay cheap.

const DEFAULT_MS = { network: 1000, candidates: 1000, merge: 1000, search: 3000 };
/** Candidates animated in the merge; more than this is thinned for frame rate. */
const MAX_MERGING = 1500;
const RECENT_REACHED = 40;
const RECENT_REJECTS = 25;
const NETWORK_COLOR = "#64748b";
const CANDIDATE_COLOR = "#f59e0b";
const VIEWPOINT_COLOR = "#ea580c";
const BEST_COLOR = "#0f766e";
const REJECT_COLOR = "#7f1d1d";

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const key = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

/**
 * Feed progress messages with `push`; they are animated onto `ctx` with `timings` (ms per
 * stage). `onFirstDraw` fires when the first report lands. `finish()` resolves once the last
 * stage has played.
 */
export function liveReplay(ctx, radius, onStatus, onFirstDraw = () => {}, timings = {}) {
  const ms = {
    network: timings.networkMs ?? DEFAULT_MS.network,
    candidates: timings.candidatesMs ?? DEFAULT_MS.candidates,
    merge: timings.mergeMs ?? DEFAULT_MS.merge,
    search: timings.searchMs ?? DEFAULT_MS.search,
  };
  const data = { network: null, candidates: [], viewpoints: null, search: [] };
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const search = searchState(ctx, radius);
  let stage = null;
  let stageStart = 0;
  let merging = null;
  let lastStatus = "";
  const status = (text) => text !== lastStatus && onStatus((lastStatus = text));

  /** Runs once when a stage begins: sends its geometry, which the frames then only restyle. */
  const enter = (now, next) => {
    stage = next;
    stageStart = now;
    ctx.clear();
    ctx.fadePoints(null);
    ctx.fadeLines(null);
    if (next === "network") {
      const n = data.network.length;
      ctx.addPoints(data.network, NETWORK_COLOR, 2, 0.8, (i) => ({ order: i / n }));
      status("Walkable network near the course");
    } else if (next === "candidates") {
      const lit = new Set(data.candidates.map(key));
      ctx.addPoints(data.network.filter((p) => !lit.has(key(p))), NETWORK_COLOR, 2, 0.8, () => ({ kind: "node" }));
      ctx.addPoints(data.candidates, CANDIDATE_COLOR, 4, 0.8, () => ({ kind: "lit" }));
      status(`${data.candidates.length} spots within sighting distance of the course`);
    } else if (next === "merge") {
      merging = mergePlan(data.candidates, data.viewpoints);
      ctx.addLines(data.viewpoints.flatMap((v) => v.arcs.map((a) => a.path)), VIEWPOINT_COLOR, 4, 0.7);
      status(`Clustered to ${data.viewpoints.length} viewpoints, each covering a stretch of course`);
    }
    ctx.flush();
  };

  /** The next stage starts when its data is in and the current one has run its time. */
  const step = (now) => {
    const elapsed = now - stageStart;
    if (stage === null && data.network) enter(now, "network");
    else if (stage === "network" && elapsed >= ms.network && data.candidates.length) enter(now, "candidates");
    else if (stage === "candidates" && elapsed >= ms.candidates && data.viewpoints) enter(now, "merge");
    else if (stage === "merge" && elapsed >= ms.merge && (data.search.length || finished)) enter(now, "search");
  };

  const draw = (now) => {
    const p = clamp01((now - stageStart) / ms[stage]);
    if (stage === "network") {
      ctx.fadePoints(["case", ["<=", ["get", "order"], ease(p)], 0.8, 0]);
    } else if (stage === "candidates") {
      ctx.fadePoints(["case", ["==", ["get", "kind"], "lit"], 0.2 + 0.6 * ease(p), 0.8 * (1 - ease(p))]);
    } else if (stage === "merge") {
      const slide = ease(clamp01(p / 0.6));
      const grow = ease(clamp01((p - 0.5) / 0.5));
      ctx.clear("replay-points", "replay-fills");
      const moved = merging.map(({ from, to }) => ({ lat: from.lat + (to.lat - from.lat) * slide, lon: from.lon + (to.lon - from.lon) * slide }));
      ctx.addPoints(moved, CANDIDATE_COLOR, 4, 0.8 * (1 - grow));
      if (grow > 0) ctx.addCircles(data.viewpoints.map((v) => v.location), VIEWPOINT_COLOR, radius * grow, 0.35);
      ctx.fadeLines(grow);
      ctx.flush();
    } else if (stage === "search") {
      // Play the events that have arrived in proportion to the stage's time, one by one, so a
      // fast engine still unfolds over the whole stage and a slow one is shown as it comes.
      const target = Math.ceil(data.search.length * p);
      while (search.count < target && data.search.length > search.count) search.absorb(data.search[search.count], data.viewpoints);
      ctx.clear();
      search.draw(data.viewpoints);
      ctx.flush();
      status(`Searching… ${search.count} decisions · teal = best plan so far`);
    }
  };

  const frame = () => {
    const now = performance.now();
    step(now);
    if (stage) draw(now);
    const searchDone = stage === "search" && finished && search.count >= data.search.length && now - stageStart >= ms.search;
    if (searchDone) resolveDone();
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return {
    push(progress) {
      if (stage === null && !data.network) onFirstDraw();
      if (progress.stage === "network") data.network = progress.points;
      else if (progress.stage === "candidates") data.candidates = data.candidates.concat(progress.locations);
      else if (progress.stage === "viewpoints") data.viewpoints = progress.viewpoints;
      else if (progress.stage === "search") {
        // Legs are only road paths to draw later; events are what the stage paces through.
        search.legs(progress.legs);
        data.search.push(...progress.events);
      }
    },
    finish() {
      finished = true;
      if (!data.network) data.network = [];
      if (!data.viewpoints) data.viewpoints = [];
      return done.then(() => {
        ctx.clear();
        ctx.fadePoints(null);
        ctx.fadeLines(null);
        ctx.flush();
      });
    },
  };
}

/** Where each candidate slides to: the nearest viewpoint (the engine's clusters are spatial). */
function mergePlan(candidates, viewpoints) {
  const stride = Math.max(1, Math.ceil(candidates.length / MAX_MERGING));
  const kx = Math.cos(((viewpoints[0]?.location.lat ?? 0) * Math.PI) / 180);
  return candidates
    .filter((_, i) => i % stride === 0)
    .map((from) => {
      let to = from;
      let best = Infinity;
      for (const v of viewpoints) {
        const d = ((v.location.lon - from.lon) * kx) ** 2 + (v.location.lat - from.lat) ** 2;
        if (d < best) [best, to] = [d, v.location];
      }
      return { from, to };
    });
}

/** The search as drawn: visited viewpoints, the ones just reached, rejections, and the best chain. */
function searchState(ctx, radius) {
  const legPath = new Map();
  const alive = new Map();
  const visited = new Set();
  const recent = [];
  const rejected = [];
  let best = { score: -Infinity, chain: [] };
  const state = {
    count: 0,
    legs(legs) {
      for (const l of legs) legPath.set(`${l.from}>${l.to}`, l.path);
    },
    absorb(e, viewpoints) {
      state.count++;
      const parentChain = e.parent == null ? [] : (alive.get(e.parent)?.chain ?? []);
      if (e.kind === "kept") {
        const entry = { label: e.label, score: e.score, chain: parentChain.concat([e.viewpoint]) };
        alive.set(e.label, entry);
        visited.add(e.viewpoint);
        recent.push(e.viewpoint);
        if (recent.length > RECENT_REACHED) recent.shift();
        if (e.score > best.score) best = entry;
      } else if (e.kind === "trimmed") {
        alive.delete(e.label);
        if (best.label === e.label) best = [...alive.values()].reduce((a, b) => (b.score > a.score ? b : a), { score: -Infinity, chain: [] });
      } else if (e.kind === "dominated") {
        rejected.push(viewpoints[e.viewpoint].location);
        if (rejected.length > RECENT_REJECTS) rejected.shift();
      }
    },
    draw(viewpoints) {
      const at = (i) => viewpoints[i].location;
      // Only the best chain's legs are routed; anything else would be a straight line.
      const leg = (from, to) => legPath.get(`${from}>${to}`) ?? [at(from), at(to)];
      const onBest = new Set(best.chain);
      const justReached = new Set(recent);
      ctx.addCircles(viewpoints.filter((_, i) => !visited.has(i)).map((v) => v.location), VIEWPOINT_COLOR, radius, 0.15);
      ctx.addCircles([...visited].filter((i) => !onBest.has(i) && !justReached.has(i)).map(at), VIEWPOINT_COLOR, radius, 0.4);
      ctx.addCircles([...justReached].filter((i) => !onBest.has(i)).map(at), CANDIDATE_COLOR, radius, 0.7);
      ctx.addPoints(rejected, REJECT_COLOR, 5);
      ctx.addLines(best.chain.slice(1).map((to, k) => leg(best.chain[k], to)), BEST_COLOR, 4, 0.9);
      ctx.addCircles(best.chain.map(at), BEST_COLOR, radius, 0.8);
    },
  };
  return state;
}

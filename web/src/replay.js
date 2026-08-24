// Animates the engine's progress on the map as a funnel. Each stage is a timed animation that
// starts once its data has arrived and the stage before it has finished:
//   network    – the walkable nodes appear one after another          (≥ networkMs)
//   candidates – spots within sight brighten while the rest fade      (candidatesMs)
//   merge      – candidates slide into their viewpoint, whose sighting circle and arc grow (mergeMs)
//   search     – the search plays out with the best plan lit along the roads (≥ searchMs)
// The first three stages draw on a 2D `canvas` overlay, which can redraw thousands of dots every
// frame; the search draws through MapLibre `layers`, where a few hundred shapes a frame is fine.

/** Candidates animated in the merge; more than this is thinned for frame rate. */
const MAX_MERGING = 4000;
const RECENT_REACHED = 40;
const RECENT_REJECTS = 25;
const NETWORK_COLOR = "#64748b";
const CANDIDATE_COLOR = "#f59e0b";
const VIEWPOINT_COLOR = "#ea580c";
const BEST_COLOR = "#facc15";
const TRIED_COLOR = "#fde047";
const REJECT_COLOR = "#7f1d1d";
/** Legs the search tried most recently stay on screen, faded, behind the best plan. */
const RECENT_LEGS = 150;

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const key = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

/**
 * Feed progress messages with `push`; they are animated onto the `canvas` overlay and the map's
 * `layers` with `timings` (ms per stage). `onFirstDraw` fires once, when the first report lands.
 * `finish()` resolves once the last stage has played.
 */
export function liveReplay({ layers, canvas }, radius, timings, onStatus, onFirstDraw = () => {}) {
  const ms = {
    network: timings.networkMs,
    candidates: timings.candidatesMs,
    merge: timings.mergeMs,
    search: timings.searchMs,
  };
  const data = { network: null, candidates: [], viewpoints: null, search: [] };
  let finished = false;
  let drawn = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const search = searchState(layers, radius);
  let stage = null;
  let stageStart = 0;
  let others = [];
  /** The candidate count `others` was last computed against. */
  let othersAt = -1;
  let merging = null;
  let lastStatus = "";
  const status = (text) => {
    if (text === lastStatus) return;
    lastStatus = text;
    onStatus(text);
  };

  /** Runs once when a stage begins and prepares what its frames draw. */
  const enter = (now, next) => {
    stage = next;
    stageStart = now;
    if (next === "network") {
      status("Walkable network near the course");
    } else if (next === "merge") {
      merging = mergePlan(data.candidates, data.viewpoints);
      status(`Clustered to ${data.viewpoints.length} viewpoints, each covering a stretch of course`);
    } else if (next === "search") {
      canvas.clear();
    }
  };

  /**
   * The next stage starts when its data is in and the current one has run its time. Once the plan
   * has finished, a stage with nothing to show plays anyway, so the funnel always reaches the end.
   */
  const step = (now) => {
    const elapsed = now - stageStart;
    const ready = (arrived) => finished || Boolean(arrived);
    if (stage === null && ready(data.network)) enter(now, "network");
    else if (stage === "network" && elapsed >= ms.network && ready(data.candidates.length)) enter(now, "candidates");
    else if (stage === "candidates" && elapsed >= ms.candidates && ready(data.viewpoints)) enter(now, "merge");
    else if (stage === "merge" && elapsed >= ms.merge && ready(data.search.length)) enter(now, "search");
  };

  const draw = (now) => {
    const p = clamp01((now - stageStart) / ms[stage]);
    if (stage === "network") {
      canvas.clear();
      canvas.dots("network", data.network, NETWORK_COLOR, 2, 0.8, Math.ceil(data.network.length * ease(p)));
    } else if (stage === "candidates") {
      // Chunks keep arriving during the stage; the unlit set follows them.
      if (othersAt !== data.candidates.length) {
        const lit = new Set(data.candidates.map(key));
        others = data.network.filter((p) => !lit.has(key(p)));
        othersAt = data.candidates.length;
        status(`${data.candidates.length} spots within sighting distance of the course`);
      }
      canvas.clear();
      canvas.dots(`others:${othersAt}`, others, NETWORK_COLOR, 2, 0.8 * (1 - ease(p)));
      canvas.dots(`candidates:${data.candidates.length}`, data.candidates, CANDIDATE_COLOR, 3, 0.2 + 0.6 * ease(p));
    } else if (stage === "merge") {
      // Candidates slide home, then each viewpoint's sighting range sweeps open like a radar.
      const slide = ease(clamp01(p / 0.6));
      const sweep = clamp01((p - 0.45) / 0.55);
      canvas.clear();
      canvas.slidingDots("merge", merging.from, merging.to, slide, CANDIDATE_COLOR, 3, 0.8 * (1 - sweep));
      if (sweep > 0) {
        canvas.sectors("viewpoints", merging.centres, VIEWPOINT_COLOR, radius, 0.35, 2 * Math.PI * sweep);
        canvas.lines("arcs", merging.arcs, VIEWPOINT_COLOR, 4, 0.7 * sweep);
      }
    } else if (stage === "search") {
      // Play the events that have arrived in proportion to the stage's time, one by one, so a
      // fast engine still unfolds over the whole stage and a slow one is shown as it comes.
      const target = Math.ceil(data.search.length * p);
      while (search.count < target && data.search.length > search.count) search.absorb(data.search[search.count], data.viewpoints);
      layers.clear();
      search.draw(data.viewpoints);
      layers.flush();
      status(`Searching… ${search.count} decisions · bright yellow = best plan so far`);
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
      if (!drawn) {
        drawn = true;
        onFirstDraw();
      }
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
        canvas.clear();
        layers.clear();
        layers.flush();
      });
    },
  };
}

/** Where each candidate slides to (the nearest viewpoint: the engine's clusters are spatial), plus what grows there. */
function mergePlan(candidates, viewpoints) {
  const stride = Math.max(1, Math.ceil(candidates.length / MAX_MERGING));
  const kx = Math.cos(((viewpoints[0]?.location.lat ?? 0) * Math.PI) / 180);
  const from = candidates.filter((_, i) => i % stride === 0);
  const to = from.map((c) => {
    let nearest = c;
    let best = Infinity;
    for (const v of viewpoints) {
      const d = ((v.location.lon - c.lon) * kx) ** 2 + (v.location.lat - c.lat) ** 2;
      if (d < best) [best, nearest] = [d, v.location];
    }
    return nearest;
  });
  return { from, to, centres: viewpoints.map((v) => v.location), arcs: viewpoints.flatMap((v) => v.arcs.map((a) => a.path)) };
}

/** The search as drawn: visited viewpoints, the ones just reached, rejections, and the best chain. */
function searchState(layers, radius) {
  const legPath = new Map();
  const alive = new Map();
  const visited = new Set();
  const recent = [];
  const tried = [];
  const rejected = [];
  let best = { score: -Infinity, chain: [] };
  const search = {
    count: 0,
    legs(legs) {
      for (const l of legs) legPath.set(`${l.from}>${l.to}`, l.path);
    },
    absorb(e, viewpoints) {
      search.count++;
      const parentChain = e.parent == null ? [] : (alive.get(e.parent)?.chain ?? []);
      if (e.kind === "kept") {
        const entry = { label: e.label, score: e.score, chain: parentChain.concat([e.viewpoint]) };
        alive.set(e.label, entry);
        visited.add(e.viewpoint);
        recent.push(e.viewpoint);
        if (recent.length > RECENT_REACHED) recent.shift();
        if (parentChain.length) {
          tried.push(`${parentChain.at(-1)}>${e.viewpoint}`);
          if (tried.length > RECENT_LEGS) tried.shift();
        }
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
      // Every tried leg is routed up to the engine's cap; past it a straight line stands in.
      const leg = (from, to) => legPath.get(`${from}>${to}`) ?? [at(from), at(to)];
      const onBest = new Set(best.chain);
      const justReached = new Set(recent);
      layers.addCircles(viewpoints.filter((_, i) => !visited.has(i)).map((v) => v.location), VIEWPOINT_COLOR, radius, 0.15);
      layers.addCircles([...visited].filter((i) => !onBest.has(i) && !justReached.has(i)).map(at), VIEWPOINT_COLOR, radius, 0.4);
      layers.addCircles([...justReached].filter((i) => !onBest.has(i)).map(at), CANDIDATE_COLOR, radius, 0.7);
      layers.addPoints(rejected, REJECT_COLOR, 5);
      layers.addLines([...new Set(tried)].map((pair) => leg(...pair.split(">").map(Number))), TRIED_COLOR, 1.5, 0.12);
      layers.addLines(best.chain.slice(1).map((to, k) => leg(best.chain[k], to)), BEST_COLOR, 5, 1);
      layers.addCircles(best.chain.map(at), BEST_COLOR, radius, 0.8);
    },
  };
  return search;
}

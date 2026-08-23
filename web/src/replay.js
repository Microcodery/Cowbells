// Draws the engine's progress on the map as it arrives: network → candidate spots →
// clustered viewpoints → the search, with the best plan so far lit up along the roads.
// Stages are paced so the whole thing takes at least MIN_MS even when the engine is faster.

const MIN_MS = 3000;
const RECENT_REACHED = 40;
const RECENT_REJECTS = 25;
const VIEWPOINT_COLOR = "#ea580c";
const BEST_COLOR = "#0f766e";
const REJECT_COLOR = "#7f1d1d";

/**
 * Feed progress messages with `push`; they are drawn onto `ctx` in order, spread out so the
 * first MIN_MS are never empty. `done()` resolves once everything queued has been drawn.
 */
export function liveReplay(ctx, radius, onStatus) {
  const started = performance.now();
  const queue = [];
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const search = searchState(ctx, radius);
  let viewpoints = [];
  let candidates = 0;

  const draw = (p) => {
    if (p.stage === "network") {
      ctx.clear();
      ctx.addPoints(p.points, "#94a3b8", 2);
      onStatus("Walkable network near the course");
    } else if (p.stage === "candidates") {
      if (candidates === 0) ctx.clear();
      candidates += p.locations.length;
      ctx.addPoints(p.locations, "#f59e0b", 4);
      onStatus(`${candidates} spots within sighting distance of the course`);
    } else if (p.stage === "viewpoints") {
      viewpoints = p.viewpoints;
      ctx.clear();
      ctx.addCircles(viewpoints.map((v) => v.location), VIEWPOINT_COLOR, radius, 0.35);
      ctx.addLines(viewpoints.flatMap((v) => v.arcs.map((a) => a.path)), VIEWPOINT_COLOR, 4, 0.7);
      onStatus(`Clustered to ${viewpoints.length} viewpoints, each covering a stretch of course`);
    } else if (p.stage === "search") {
      search.absorb(p, viewpoints);
      search.draw(viewpoints);
      onStatus(`Searching… ${search.count} decisions · teal = best plan so far`);
    }
  };

  const frame = () => {
    const left = Math.max(0, MIN_MS - (performance.now() - started));
    // Before MIN_MS, let out only what keeps the queue draining evenly until then.
    const framesLeft = Math.ceil(left / 16);
    const share = framesLeft > 0 && !(finished && left === 0) ? Math.ceil(queue.length / framesLeft) : queue.length;
    for (let i = 0; i < share && queue.length; i++) draw(queue.shift());
    if (queue.length || !finished || left > 0) requestAnimationFrame(frame);
    else resolveDone();
  };
  requestAnimationFrame(frame);

  return {
    push(progress) {
      queue.push(progress);
    },
    finish() {
      finished = true;
      return done.then(() => ctx.clear());
    },
  };
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
    absorb(p, viewpoints) {
      for (const l of p.legs) legPath.set(`${l.from}>${l.to}`, l.path);
      const at = (i) => viewpoints[i].location;
      for (const e of p.events) {
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
          rejected.push(at(e.viewpoint));
          if (rejected.length > RECENT_REJECTS) rejected.shift();
        }
      }
    },
    draw(viewpoints) {
      const at = (i) => viewpoints[i].location;
      // Only the best chain's legs are routed; anything else would be a straight line.
      const leg = (from, to) => legPath.get(`${from}>${to}`) ?? [at(from), at(to)];
      const onBest = new Set(best.chain);
      const justReached = new Set(recent);
      ctx.clear();
      ctx.addCircles(viewpoints.filter((_, i) => !visited.has(i)).map((v) => v.location), VIEWPOINT_COLOR, radius, 0.15);
      ctx.addCircles([...visited].filter((i) => !onBest.has(i) && !justReached.has(i)).map(at), VIEWPOINT_COLOR, radius, 0.4);
      ctx.addCircles([...justReached].filter((i) => !onBest.has(i)).map(at), "#f59e0b", radius, 0.7);
      ctx.addPoints(rejected, REJECT_COLOR, 5);
      ctx.addLines(best.chain.slice(1).map((to, k) => leg(best.chain[k], to)), BEST_COLOR, 4, 0.9);
      ctx.addCircles(best.chain.map(at), BEST_COLOR, radius, 0.8);
    },
  };
  return state;
}

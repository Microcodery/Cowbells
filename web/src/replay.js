// Draws the engine's progress on the map as it arrives, as a funnel: the walkable network
// sweeps in, the spots within sight light up among it, the field prunes to the clustered
// viewpoints, then the search runs with the best plan so far lit up along the roads. Each
// stage holds for a moment so the narrowing reads, and the whole thing takes at least MIN_MS.

const MIN_MS = 3000;
/** How long each stage stays on screen before the next may replace it. */
const STAGE_MS = { network: 1000, candidates: 1000, viewpoints: 900 };
/** Frames over which the network dots sweep in. */
const NETWORK_SWEEP_FRAMES = 24;
const RECENT_REACHED = 40;
const RECENT_REJECTS = 25;
const NETWORK_COLOR = "#64748b";
const NETWORK_DIM = "#94a3b8";
const CANDIDATE_COLOR = "#f59e0b";
const VIEWPOINT_COLOR = "#ea580c";
const BEST_COLOR = "#0f766e";
const REJECT_COLOR = "#7f1d1d";

/**
 * Feed progress messages with `push`; they are drawn onto `ctx` in order with the pacing above.
 * `onFirstDraw` fires when the first report lands, so the caller can drop its waiting cue.
 * `finish()` resolves once everything queued has been drawn.
 */
export function liveReplay(ctx, radius, onStatus, onFirstDraw = () => {}) {
  const started = performance.now();
  const queue = [];
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const search = searchState(ctx, radius);
  let stage = null;
  let stageShownAt = 0;
  let network = [];
  let sweep = 0;
  let candidates = [];
  let viewpoints = [];
  const redrawCandidates = () => {
    ctx.clear();
    ctx.addPoints(network, NETWORK_DIM, 2);
    ctx.addPoints(candidates, CANDIDATE_COLOR, 4);
  };

  const draw = (p) => {
    if (stage === null) onFirstDraw();
    if (p.stage !== stage) stageShownAt = performance.now();
    stage = p.stage;
    if (p.stage === "network") {
      network = p.points;
      sweep = 0;
      ctx.clear();
      onStatus("Walkable network near the course");
    } else if (p.stage === "candidates") {
      candidates = candidates.concat(p.locations);
      redrawCandidates();
      onStatus(`${candidates.length} spots within sighting distance of the course`);
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
    const now = performance.now();
    // The network sweeps in a slice per frame rather than all at once.
    if (stage === "network" && sweep < NETWORK_SWEEP_FRAMES) {
      sweep += 1;
      const shown = Math.ceil((network.length * sweep) / NETWORK_SWEEP_FRAMES);
      ctx.clear();
      ctx.addPoints(network.slice(0, shown), NETWORK_COLOR, 2);
    }
    const holding = queue.length && queue[0].stage !== stage && now < stageShownAt + (STAGE_MS[stage] ?? 0);
    const sweeping = stage === "network" && sweep < NETWORK_SWEEP_FRAMES;
    if (queue.length && !holding && !sweeping) {
      // Within a stage, drain evenly so the first MIN_MS are never empty; after that, keep up.
      const left = Math.max(0, MIN_MS - (now - started));
      const framesLeft = Math.ceil(left / 16);
      const sameStage = queue.findIndex((p) => p.stage !== queue[0].stage);
      const batch = sameStage < 0 ? queue.length : sameStage;
      const share = framesLeft > 0 ? Math.max(1, Math.ceil(batch / framesLeft)) : batch;
      const draining = queue[0].stage;
      for (let i = 0; i < share && queue.length && queue[0].stage === draining; i++) draw(queue.shift());
    }
    const left = Math.max(0, MIN_MS - (now - started));
    if (queue.length || !finished || left > 0 || sweeping) requestAnimationFrame(frame);
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
      ctx.addCircles([...justReached].filter((i) => !onBest.has(i)).map(at), CANDIDATE_COLOR, radius, 0.7);
      ctx.addPoints(rejected, REJECT_COLOR, 5);
      ctx.addLines(best.chain.slice(1).map((to, k) => leg(best.chain[k], to)), BEST_COLOR, 4, 0.9);
      ctx.addCircles(best.chain.map(at), BEST_COLOR, radius, 0.8);
    },
  };
  return state;
}

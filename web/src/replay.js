// Replays an engine trace on the map: network → sighting circles → clustering → search → itinerary.

const STAGES = [
  { share: 0.1, name: () => "Walkable network near the course", draw: (t, ctx) => ctx.addPoints(t.network, "#94a3b8", 2) },
  {
    share: 0.15,
    name: (t) => `${t.raw_viewpoints.length} spots within sighting distance of the course`,
    draw: (t, ctx, radius) => ctx.addCircles(t.raw_viewpoints, "#f59e0b", radius, 0.25),
  },
  {
    share: 0.15,
    name: (t) => `Clustered to ${t.viewpoints.length} viewpoints, each covering a stretch of course`,
    draw: (t, ctx, radius) => {
      ctx.addCircles(t.viewpoints.map((v) => v.location), VIEWPOINT_COLOR, radius, 0.35);
      ctx.addLines(t.viewpoints.flatMap((v) => v.arcs.map((a) => a.path)), VIEWPOINT_COLOR, 4, 0.7);
    },
  },
];
const SEARCH_SHARE = 1 - STAGES.reduce((s, stage) => s + stage.share, 0);
const VIEWPOINT_COLOR = "#ea580c";
const BEST_COLOR = "#0f766e";
const REJECT_COLOR = "#7f1d1d";

/**
 * Plays the trace over roughly `seconds()` seconds: each stage in turn, then the search
 * event by event. `ctx` draws onto the map; `radius` is the sighting radius in metres;
 * `onStatus` narrates; `controller.skip` ends it early.
 */
export async function replay(trace, ctx, radius, seconds, onStatus, controller) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const stage of STAGES) {
    if (controller.skip) break;
    ctx.clear();
    stage.draw(trace, ctx, radius);
    onStatus(stage.name(trace));
    await pause(seconds() * stage.share * 1000);
  }
  await replaySearch(trace, ctx, radius, seconds, onStatus, controller);
  ctx.clear();
}

/** The best plan so far lights up its viewpoints and the road between them as the search runs. */
async function replaySearch(trace, ctx, radius, seconds, onStatus, controller) {
  const at = (i) => trace.viewpoints[i].location;
  const legPath = new Map(trace.legs.map((l) => [`${l.from}>${l.to}`, l.path]));
  // Legs are capped with the best plans first, so a passing expansion may lack a road path.
  const leg = (from, to) => legPath.get(`${from}>${to}`) ?? [at(from), at(to)];
  const alive = new Map();
  const visited = new Set();
  let best = { score: -Infinity, chain: [] };
  const topAlive = () => [...alive.values()].reduce((a, b) => (b.score > a.score ? b : a), { score: -Infinity, chain: [] });
  const recent = [];
  const rejected = [];
  const total = trace.labels.length;
  const sampled = trace.labels_total > total ? ` (sampled of ${trace.labels_total})` : "";
  let i = 0;
  let started = null;
  while (i < total && !controller.skip) {
    const budget = seconds() * SEARCH_SHARE * 1000;
    // The clock starts at the first painted frame so setup time does not eat the budget.
    started ??= performance.now();
    const due = Math.min(total, Math.max(1, Math.ceil(((performance.now() - started) / budget) * total)));
    for (; i < due; i++) {
      const e = trace.labels[i];
      const parentChain = e.parent == null ? [] : (alive.get(e.parent)?.chain ?? []);
      if (e.kind === "kept") {
        const entry = { label: e.label, score: e.score, chain: parentChain.concat([e.viewpoint]) };
        alive.set(e.label, entry);
        visited.add(e.viewpoint);
        if (parentChain.length) recent.push(leg(parentChain.at(-1), e.viewpoint));
        if (recent.length > 60) recent.shift();
        if (e.score > best.score) best = entry;
      } else if (e.kind === "trimmed") {
        alive.delete(e.label);
        if (best.label === e.label) best = topAlive();
      } else if (e.kind === "dominated") {
        rejected.push(at(e.viewpoint));
        if (rejected.length > 25) rejected.shift();
      }
    }
    ctx.clear();
    const untouched = trace.viewpoints.filter((_, index) => !visited.has(index)).map((v) => v.location);
    const onBest = new Set(best.chain);
    const reached = [...visited].filter((index) => !onBest.has(index)).map(at);
    ctx.addCircles(untouched, VIEWPOINT_COLOR, radius, 0.15);
    ctx.addCircles(reached, VIEWPOINT_COLOR, radius, 0.4);
    ctx.addLines(recent, "#f59e0b", 2, 0.45);
    ctx.addPoints(rejected, REJECT_COLOR, 5);
    const legs = best.chain.slice(1).map((to, k) => leg(best.chain[k], to));
    ctx.addLines(legs, BEST_COLOR, 4, 0.9);
    ctx.addCircles(best.chain.map(at), BEST_COLOR, radius, 0.8);
    onStatus(`Searching ${i}/${total}${sampled} · teal = best plan so far`);
    await new Promise(requestAnimationFrame);
  }
}

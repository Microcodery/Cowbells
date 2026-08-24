// Scoring an itinerary: how far it gets on each objective level, and how two plans compare.

/** How far the plan gets on each objective level: racers seen en route, racers finished, sightings. */
export function planLevels(event, itinerary) {
  const seen = new Set();
  const finished = new Set();
  let sightings = 0;
  for (const stop of itinerary.stops) {
    for (const s of stop.seen) {
      sightings += 1;
      (s.kind === "finish" ? finished : seen).add(s.racer_id);
    }
  }
  return { racers: event.racers.length, seen: seen.size, finished: finished.size, sightings };
}

/** "Seen en route 2/3 · finishes 3/3 · 7 sightings". */
export function planSummary(event, itinerary) {
  const { racers, seen, finished, sightings } = planLevels(event, itinerary);
  return `Seen en route ${seen}/${racers} · finishes ${finished}/${racers} · ${sightings} sighting${sightings === 1 ? "" : "s"}`;
}

/** Whether `a` beats `b` on the levels that matter most: completeness first, then counts. */
export function betterPlan(a, b) {
  const key = (l) => [l.seen === l.racers, l.finished === l.racers, l.finished, l.seen].map(Number);
  const [ka, kb] = [key(a), key(b)];
  const i = ka.findIndex((v, i) => v !== kb[i]);
  return i >= 0 && ka[i] > kb[i];
}

/** "Start" for an anchored start stop, otherwise the stop's 1-based number. */
export function stopLabel(event, index) {
  if (!event.spectator.start) return index + 1;
  return index === 0 ? "Start" : index;
}

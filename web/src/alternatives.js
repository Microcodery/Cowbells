// Looser settings tried in the background after a plan, so the spectator learns what a small
// concession would buy them.

import { DEFAULT_SPEED_MPS } from "./event.js";
import { planGeneration } from "./generation.js";
import { betterPlan, planLevels } from "./plans.js";

/** Looser constraints worth trying in the background once a plan is shown. */
const selfPowered = (s) => s.mode !== "drive";
export const ALTERNATIVES = [
  { label: "moving 25% faster", speedFactor: 1.25, when: selfPowered },
  { label: "a half-length safety buffer", adjust: (s) => (s.safety_buffer_s /= 2) },
  { label: "no minimum stop", adjust: (s) => (s.min_stop_s = 0), when: (s) => s.min_stop_s > 0 },
  {
    label: "all of those",
    speedFactor: 1.25,
    when: selfPowered,
    adjust: (s) => {
      s.safety_buffer_s /= 2;
      s.min_stop_s = 0;
    },
  },
];

/** A copy of the event with one alternative's looser settings applied. */
export function alternativeEvent(event, alt) {
  const variant = structuredClone(event);
  const s = variant.spectator;
  if (alt.speedFactor) s.speed_mps = (s.speed_mps ?? DEFAULT_SPEED_MPS[s.mode]) * alt.speedFactor;
  alt.adjust?.(s);
  return variant;
}

/**
 * Plans each alternative to the itinerary in `ui` and offers the ones that do clearly better.
 * `generation` is the generation this search belongs to: a newer plan abandons it.
 */
export async function exploreAlternatives({ engine, event, ui, generation, render }) {
  if (!ui.itinerary) return;
  const snapshot = structuredClone(event);
  const base = planLevels(snapshot, ui.itinerary);
  const found = [];
  for (const alt of ALTERNATIVES) {
    if (alt.when && !alt.when(snapshot.spectator)) continue;
    const variant = alternativeEvent(snapshot, alt);
    try {
      // The network was built at the current speed; a faster variant scales its times instead of rebuilding.
      const options = { beam: ui.beam, trace: false, speed_factor: alt.speedFactor };
      const { itinerary } = await engine.call("plan", { event: variant, options });
      if (generation !== planGeneration()) return;
      if (betterPlan(planLevels(variant, itinerary), base)) found.push({ alt, variant, itinerary });
    } catch {
      // A variant that cannot be planned is simply not offered.
    }
  }
  if (generation !== planGeneration()) return;
  ui.alternatives = found;
  render();
}

// What each tier allows, and the prose describing it. A stand-in for a real account: what the
// tier allows is enforced, who pays is not.

/** What each tier allows; Free is enough for one friend in one race. */
export const TIERS = {
  free: { label: "Free", courses: 1, racers: 2, paces: 1 },
  plus: { label: "Plus", courses: Infinity, racers: Infinity, paces: Infinity },
};

const LIMITS = ["courses", "racers", "paces"];
/** How each limit reads in prose, singular and plural. */
const NOUNS = {
  courses: ["course", "courses"],
  racers: ["racer", "racers"],
  paces: ["pace per racer", "paces per racer"],
};
const NUMBER_WORDS = ["no", "one", "two", "three", "four"];

/** What `tier` allows of one limit, in words: "one course", "two racers", "one pace per racer". */
export function tierAllows(tier, limit) {
  const allowed = TIERS[tier][limit];
  const [one, many] = NOUNS[limit];
  if (allowed === Infinity) return `unlimited ${many}`;
  return `${NUMBER_WORDS[allowed] ?? allowed} ${allowed === 1 ? one : many}`;
}

/** "Free: one course, two racers, one pace per racer. Plus: no limits." */
export function tierSummary() {
  return Object.entries(TIERS)
    .map(([tier, { label }]) => {
      const unlimited = LIMITS.every((limit) => TIERS[tier][limit] === Infinity);
      return `${label}: ${unlimited ? "no limits" : LIMITS.map((limit) => tierAllows(tier, limit)).join(", ")}.`;
    })
    .join(" ");
}

/** Which "add" buttons the tier has used up: another course, another racer, another pace for `racer`. */
export function tierLocks(event, tier) {
  const limits = TIERS[tier];
  return {
    courses: event.courses.length >= limits.courses,
    racers: event.racers.length >= limits.racers,
    paces: (racer) => racer.pace_profile.length >= limits.paces,
  };
}

/** Why the event exceeds `tier`, or null when it fits. */
export function overTierLimit(event, tier) {
  const limits = TIERS[tier];
  const over = (limit) => `${limits.label} allows ${tierAllows(tier, limit)}`;
  if (event.courses.length > limits.courses) return over("courses");
  if (event.racers.length > limits.racers) return over("racers");
  if (event.racers.some((r) => r.pace_profile.length > limits.paces)) return over("paces");
  return null;
}

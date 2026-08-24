// One counter says whether a result still describes the current event: an edit invalidates the
// plan, and work that outlives the edit compares the generation it started in with the current one.

let generation = 0;

export const planGeneration = () => generation;

/** Marks every plan and network in flight as stale, and returns the generation that replaces them. */
export function invalidatePlan() {
  return ++generation;
}

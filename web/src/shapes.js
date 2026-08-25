/**
 * The shapes each course has had, so an edit to one can be taken back. Shapes are kept per course
 * id in a store the caller owns; a course that has never been edited has no entry.
 */

/** How many shapes back a course can be taken. */
const KEPT = 30;

const historyFor = (store, course) => (store[course.id] ??= { past: [], future: [], gesture: null });

export const canUndo = (store, course) => Boolean(store[course.id]?.past.length);
export const canRedo = (store, course) => Boolean(store[course.id]?.future.length);

/**
 * Runs a change to a course's shape, remembering the shape it had first. A change that reports it
 * did not happen leaves the history untouched. Changes sharing a `gesture` fold into the entry the
 * first of them made: a spinner held down fires an edit per tick, and taking those back one tick
 * at a time would spend the whole history on a single drag.
 */
export function reshape(store, course, change, gesture = null) {
  const folding = gesture !== null && store[course.id]?.gesture === gesture;
  const before = folding ? null : structuredClone(course.segments);
  if (!change()) return false;
  const history = historyFor(store, course);
  if (!folding) {
    history.past.push(before);
    if (history.past.length > KEPT) history.past.shift();
  }
  history.gesture = gesture;
  history.future.length = 0;
  return true;
}

/**
 * Marks a gesture finished, so picking the same field up again starts an entry of its own. Without
 * it a second drag of one boundary would fold into the first and undo would skip past where the
 * user deliberately stopped.
 */
export function endGesture(store, course) {
  const history = store[course.id];
  if (history) history.gesture = null;
}

export const undo = (store, course) => walk(store[course.id], course, "past", "future");
export const redo = (store, course) => walk(store[course.id], course, "future", "past");

/** Swaps the course's shape for the one at the end of `from`, tucking the one it had away in `to`. */
function walk(history, course, from, to) {
  const shape = history?.[from].pop();
  if (!shape) return false;
  history[to].push(structuredClone(course.segments));
  // The gesture that shape belonged to is over; the next edit starts an entry of its own.
  history.gesture = null;
  course.segments = shape;
  return true;
}

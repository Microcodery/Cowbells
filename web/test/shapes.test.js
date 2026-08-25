import { describe, expect, it } from "vitest";
import { canRedo, canUndo, endGesture, redo, reshape, undo } from "../src/shapes.js";

const courseOf = (...lats) => ({
  id: "c",
  segments: [{ id: "a", mode: "run", points: lats.map((lat) => ({ lat, lon: -122 })), viewable: true }],
});

const lats = (course) => course.segments[0].points.map((p) => p.lat);

/** Stands in for the shape edits in event.js: appends a point, or refuses to. */
const append = (course, lat) => () => {
  course.segments[0].points.push({ lat, lon: -122 });
  return true;
};
const refuse = () => false;

describe("reshape", () => {
  it("remembers the shape a change replaced", () => {
    const store = {};
    const course = courseOf(1);
    expect(reshape(store, course, append(course, 2))).toBe(true);
    expect(canUndo(store, course)).toBe(true);
    undo(store, course);
    expect(lats(course)).toEqual([1]);
  });

  it("leaves the history alone when a change reports it did not happen", () => {
    const store = {};
    const course = courseOf(1);
    expect(reshape(store, course, refuse)).toBe(false);
    expect(canUndo(store, course), "a refused edit is nothing to take back").toBe(false);
  });

  it("keeps a refused change from throwing away what redo has waiting", () => {
    const store = {};
    const course = courseOf(1);
    reshape(store, course, append(course, 2));
    undo(store, course);
    expect(canRedo(store, course)).toBe(true);
    reshape(store, course, refuse);
    expect(canRedo(store, course), "the redo survived the refusal").toBe(true);
  });

  it("drops the redos once a new change is made", () => {
    const store = {};
    const course = courseOf(1);
    reshape(store, course, append(course, 2));
    undo(store, course);
    reshape(store, course, append(course, 3));
    expect(canRedo(store, course), "the shape it would return to is no longer on this branch").toBe(false);
  });

  it("folds a gesture's changes into one entry, and starts fresh for the next", () => {
    const store = {};
    const course = courseOf(1);
    for (const lat of [2, 3, 4]) reshape(store, course, append(course, lat), "nudge");
    reshape(store, course, append(course, 5), "other-nudge");
    undo(store, course);
    expect(lats(course), "the second gesture came off on its own").toEqual([1, 2, 3, 4]);
    undo(store, course);
    expect(lats(course), "the first gesture came off whole").toEqual([1]);
  });

  it("does not fold a gesture into the entry an undo just moved away from", () => {
    const store = {};
    const course = courseOf(1);
    reshape(store, course, append(course, 2), "nudge");
    undo(store, course);
    reshape(store, course, append(course, 3), "nudge");
    undo(store, course);
    expect(lats(course), "the change after the undo was its own entry").toEqual([1]);
  });

  it("keeps a bounded history, dropping the oldest shapes", () => {
    const store = {};
    const course = courseOf(1);
    for (let lat = 2; lat < 60; lat++) reshape(store, course, append(course, lat));
    let depth = 0;
    while (undo(store, course)) depth++;
    expect(depth, "thirty shapes back, no further").toBe(30);
    expect(lats(course).length, "it stops where the dropped shapes begin").toBe(29);
  });

  it("starts a new entry once a gesture is finished, even under the same name", () => {
    const store = {};
    const course = courseOf(1);
    reshape(store, course, append(course, 2), "nudge");
    endGesture(store, course);
    reshape(store, course, append(course, 3), "nudge");
    undo(store, course);
    expect(lats(course), "letting go of the field ended the run of edits").toEqual([1, 2]);
  });
});

describe("undo and redo", () => {
  it("walks back and forward over the same shapes", () => {
    const store = {};
    const course = courseOf(1);
    reshape(store, course, append(course, 2));
    reshape(store, course, append(course, 3));
    undo(store, course);
    undo(store, course);
    expect(lats(course)).toEqual([1]);
    redo(store, course);
    redo(store, course);
    expect(lats(course)).toEqual([1, 2, 3]);
    expect(redo(store, course), "there is nothing beyond the newest shape").toBe(false);
  });

  it("reports nothing to do on a course that has never been edited", () => {
    const store = {};
    const course = courseOf(1);
    expect(undo(store, course)).toBe(false);
    expect(canUndo(store, course)).toBe(false);
    expect(canRedo(store, course)).toBe(false);
  });

  it("hands back shapes that no later edit can reach into", () => {
    const store = {};
    const course = courseOf(1);
    reshape(store, course, append(course, 2));
    undo(store, course);
    course.segments[0].points.push({ lat: 99, lon: -122 });
    redo(store, course);
    expect(lats(course), "the redone shape was kept apart from the live one").toEqual([1, 2]);
  });
});

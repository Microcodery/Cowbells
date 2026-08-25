// The header and side panel: the event drawn as forms, and every control wired to an action.

import { DEBUG_DEFAULTS } from "./debug.js";
import { DEFAULT_SPEED_MPS, averagePace, segmentBoundaries } from "./event.js";
import { clock, distanceLabel, paceLabel, speedLabel } from "./format.js";
import { courseLength, polylineLength } from "./geo.js";
import { COURSE_COLORS } from "./map.js";
import { planSummary, stopLabel } from "./plans.js";
import { canRedo, canUndo } from "./shapes.js";

const MODES = ["run", "bike", "swim", "other"];
const TRAVEL = ["walk", "bike", "drive"];

/** Per-root state that outlives a render, with the listeners that maintain it. */
const panels = new WeakMap();

/** The map menu that already took focus, so it is only taken once per opening. */
let focusedMenu = null;

function panelState(root) {
  let state = panels.get(root);
  if (!state) {
    state = { editingTime: false, pendingRender: null, actions: null, renaming: null };
    panels.set(root, state);
    trackFieldFocus(root, state);
    trackGhostDismissal(root);
    trackDialogs(root, state);
    trackNestedFolds(root, state);
  }
  return state;
}

/**
 * `actions` is the set of callbacks the app wires up; `ui` is transient editor state
 * (which tool is active, the latest itinerary, status text).
 */
export function renderPanel(root, event, ui, actions) {
  const state = panelState(root);
  state.actions = actions;
  // A time input fires change after each segment typed; rebuilding it mid-entry would eat the rest, so wait for blur.
  if (state.editingTime) {
    state.pendingRender = () => renderPanel(root, event, ui, actions);
    return;
  }
  // Rebuilding the markup must not move the user: keep open sections open and the scroll where it was.
  const folds = new Map([...root.querySelectorAll("details[data-section]")].map((d) => [d.dataset.section, d.open]));
  const scroll = root.scrollTop;
  const focused = root.contains(document.activeElement) ? selectorFor(document.activeElement) : null;
  const openedDialog = root.querySelector("dialog[open]")?.dataset.dialog ?? null;
  measureGhost(root, ui.itinerary);
  root.innerHTML = `
    <section>
      <div class="row">
        <button data-act="save" title="Save event as .bird">Save</button>
        <button data-act="showDialog" data-dialog="load" title="Open an event or an example" ${ui.busy ? "disabled" : ""}>Load</button>
        <button data-act="reset" title="Start over with an empty event" ${ui.busy ? "disabled" : ""}>Reset</button>
      </div>
      ${loadDialog(ui)}
      <label>Event <input data-field="name" value="${esc(event.name)}"></label>
    </section>
    ${coursesSection(event, ui)}
    ${racersSection(event, ui)}
    ${spectatorSection(event, ui)}
    ${settingsSection(event, ui)}
    <section>
      <h2>Results</h2>
      <p class="muted"><span data-status>${esc(ui.status)}</span></p>
      ${ui.itinerary ? `<div data-results>${results(ui.itinerary, event, ui)}</div>` : ghost()}
    </section>
    ${debugDialog(ui)}
    <div class="lab">
      <button data-act="showDialog" data-dialog="debug" title="Debug settings" aria-label="Debug settings">${FLASK}</button>
    </div>`;
  for (const details of root.querySelectorAll("details[data-section]")) {
    if (folds.has(details.dataset.section)) details.open = folds.get(details.dataset.section);
  }
  root.scrollTop = scroll;
  // A name that has just opened for typing takes the focus with all of it selected, ready to be
  // replaced. Later renders rebuild the same field, so only the first one may select it.
  const renaming = root.querySelector("input.rename");
  if (renaming && state.renaming !== ui.renaming) {
    renaming.focus({ preventScroll: true });
    renaming.select();
  }
  state.renaming = ui.renaming;
  // Opening first: showModal moves focus to the dialog, so restoring it afterwards wins.
  if (openedDialog) openDialog(root, openedDialog);
  if (focused) root.querySelector(focused)?.focus({ preventScroll: true });
  bindActions(root, actions);
}

const EXAMPLES = [
  { name: "three-distances", label: "City Park 5K · 10K · half" },
  { name: "uptown-ladder", label: "Uptown zigzag, six racers" },
  { name: "colfax", label: "Colfax Marathon & Half" },
];

/** Where an event comes from: a file the user drops or browses to, or one of the examples. */
function loadDialog(ui) {
  const example = ({ name, label }) =>
    `<li><button data-act="example" data-example="${name}" ${ui.busy ? "disabled" : ""}>${esc(label)}</button></li>`;
  return `<dialog data-dialog="load" aria-label="Open an event">
    <button data-act="hideDialog" data-dialog="load" class="dismiss" title="Close" aria-label="Close">✕</button>
    <label class="dropzone" data-dropzone>
      <input type="file" accept=".bird,.json" data-act="load" class="offscreen" ${ui.busy ? "disabled" : ""}>
      <b>Drop an event here</b>
      <span class="muted">or click to browse for a .bird file</span>
    </label>
    <p class="muted">or try an example</p>
    <ul class="examples">${EXAMPLES.map(example).join("")}</ul>
  </dialog>`;
}

const dialogNamed = (root, name) => root.querySelector(`dialog[data-dialog="${name}"]`);
export const openDialog = (root, name) => dialogNamed(root, name)?.showModal();
export const closeDialog = (root, name) => dialogNamed(root, name)?.close();

/** The bar that stays put: name, the Plan button, theme, and on phones the panel toggle. */
export function renderHeader(root, event, ui, actions) {
  const ready = event.courses.length && event.racers.length;
  const why = event.courses.length ? (event.racers.length ? "Plan where to stand" : "Add a racer first") : "Add a course first";
  root.innerHTML = `
    <h1>cowbells</h1>
    <button data-act="plan" class="plan ${ready ? "ready" : "missing"}" ${ui.busy ? "disabled" : ""} title="${why}">Plan</button>
    <span class="row">
      <button data-act="theme" title="Light or dark">◐</button>
      <button data-act="units" title="Switch units">${ui.unit.label}</button>
      <button data-act="togglePanel" class="phone-only" title="Options">☰</button>
    </span>`;
  bindActions(root, actions);
}

/** The status line alone, for the many updates a full render would be too heavy for. */
export function setStatus(root, text) {
  const status = root.querySelector("[data-status]");
  if (status) status.textContent = text;
}

/**
 * The tip beside a hovered spot on the courses: each `{ course, metres, arrivals }` the caller
 * found there, with when every racer on that course is due.
 */
export function renderHoverTip(root, hovered, unit) {
  root.innerHTML = hovered
    .map(({ course, metres, arrivals }) => {
      const rows = arrivals
        .map((a) => `<li><b>${esc(a.racer.name)}</b> ~${clock(a.expected)} <span class="muted">${clock(a.early)}–${clock(a.late)}</span></li>`)
        .join("");
      return `<div>${esc(course.name)} · ${distanceLabel(metres, unit, 1)}</div><ul>${rows || "<li class='muted'>no racers</li>"}</ul>`;
    })
    .join("");
}

/** The bin for the point picked out on the course being edited, which takes it out of the course. */
export function renderMapMenu(root, selected, actions) {
  root.hidden = !selected;
  if (!selected) {
    // Focus would fall to the top of the document with the button it was on; the map keeps it.
    if (root.contains(document.activeElement)) document.getElementById("map")?.focus({ preventScroll: true });
    root.innerHTML = "";
    focusedMenu = null;
    return;
  }
  // A picked-out point keeps its own markup, so a redraw cannot take the focus off the bin.
  if (focusedMenu === selected) return;
  root.innerHTML = `<button data-act="deletePoint" title="Take this point out" aria-label="Take this point out">${TRASH}</button>`;
  bindActions(root, actions);
  root.querySelector("button")?.focus({ preventScroll: true });
  focusedMenu = selected;
}

/** Clicks and changes inside `root` dispatch to `actions` by their `data-act` / `data-field`. */
function bindActions(root, actions) {
  root.onclick = (e) => {
    const target = e.target.closest("[data-act]");
    // File inputs and selects act on change, not on the click that opens them.
    if (target && !["INPUT", "SELECT"].includes(target.tagName)) actions[target.dataset.act](target.dataset);
    // A control in a summary acts without folding the section it heads.
    if (target?.closest("summary") || (e.target.closest("summary") && e.target.matches("input, select"))) {
      e.preventDefault();
    }
  };
  root.onkeydown = (e) => {
    const target = e.target.closest?.("[data-act][tabindex]");
    if (!target || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    target.click();
  };
  root.onchange = (e) => {
    const { act, field } = e.target.dataset;
    if (act) actions[act](e.target.dataset, e.target);
    else if (field) actions.edit(e.target.dataset, e.target);
  };
  // A summary folds on Space, so a field inside one has to spell its own spaces out.
  for (const field of root.querySelectorAll("summary input")) {
    field.onkeydown = (e) => {
      if (e.key !== " ") return;
      e.preventDefault();
      field.setRangeText(" ", field.selectionStart, field.selectionEnd, "end");
    };
  }
}

/**
 * Tracks a field losing focus, to end a rename and to know when a time is being typed. Chromium
 * reports no active element between a time input's segments, so that has to be followed through
 * its own events rather than read off the document.
 */
function trackFieldFocus(root, state) {
  root.addEventListener("focusin", (e) => {
    state.editingTime = e.target.type === "time";
  });
  root.addEventListener("focusout", (e) => {
    if (e.target.matches("input.rename")) state.actions?.endRename();
    if (e.target.type !== "time") return;
    state.editingTime = false;
    const deferred = state.pendingRender;
    state.pendingRender = null;
    deferred?.();
  });
}

/**
 * Closing a fold closes what is inside it, so reopening shows the same tidy view every time.
 * `toggle` does not bubble, so the panel listens for it on the way down.
 */
function trackNestedFolds(root, state) {
  root.addEventListener(
    "toggle",
    (e) => {
      if (e.target.open) return;
      if (e.target.querySelector("input.rename")) state.actions?.endRename();
      for (const nested of e.target.querySelectorAll("details")) nested.open = false;
    },
    true,
  );
}

/** Gestures the dialogs answer to: a file dropped on a drop zone, and a backdrop click to dismiss. */
function trackDialogs(root, state) {
  const dropzone = (target) => target.closest?.("[data-dropzone]");
  root.addEventListener("dragover", (e) => {
    const zone = dropzone(e.target);
    if (!zone) return;
    e.preventDefault();
    zone.classList.add("over");
  });
  // Crossing into the zone's own text fires dragleave; only leaving the zone entirely unhighlights it.
  root.addEventListener("dragleave", (e) => {
    const zone = dropzone(e.target);
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("over");
  });
  root.addEventListener("drop", (e) => {
    const zone = dropzone(e.target);
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove("over");
    const [file] = e.dataTransfer?.files ?? [];
    if (file) state.actions?.loadFile(file);
  });
  // A click lands on the dialog itself both on its backdrop and in its padding; only the backdrop closes.
  root.addEventListener("click", (e) => {
    if (!e.target.matches("dialog[data-dialog]")) return;
    const card = e.target.getBoundingClientRect();
    const inside = e.clientX >= card.left && e.clientX <= card.right && e.clientY >= card.top && e.clientY <= card.bottom;
    if (!inside) e.target.close();
  });
}

// When the plan goes away, its space stays until the user scrolls up, so the panel does not snap.
let ghostHeight = null;

function measureGhost(root, itinerary) {
  const shown = root.querySelector("[data-results]");
  if (itinerary) ghostHeight = null;
  else if (shown) ghostHeight = shown.offsetHeight;
}

const ghost = () => (ghostHeight ? `<div class="ghost" style="height:${ghostHeight}px"></div>` : "");

function trackGhostDismissal(root) {
  let lastScroll = 0;
  root.addEventListener("scroll", () => {
    if (ghostHeight && root.scrollTop < lastScroll) {
      ghostHeight = null;
      root.querySelector(".ghost")?.remove();
    }
    lastScroll = root.scrollTop;
  });
}

function coursesSection(event, ui) {
  const tool = (kind, index) => ui.tool?.kind === kind && ui.tool.courseIndex === index;
  return `<details class="section" data-section="courses" open>
    <summary><h2>Courses <button data-act="addCourse" title="Add a course" aria-label="Add a course">+</button></h2></summary>
    <div class="row">
      <label class="button" title="Import courses from GPX, KML, KMZ, TCX, FIT, or GeoJSON">Import<input type="file" accept=".gpx,.kml,.kmz,.tcx,.fit,.geojson,.json" data-act="importCourses" hidden ${ui.busy ? "disabled" : ""}></label>
      <span class="muted">GPX, KML, KMZ, TCX, FIT, GeoJSON</span>
    </div>
    ${event.courses
      .map(
        (course, ci) => `<div class="card course" style="border-left-color: ${COURSE_COLORS[ci % COURSE_COLORS.length]}">
      <div class="row">
        <input data-field="courseName" data-ci="${ci}" value="${esc(course.name)}" aria-label="Course name">
        <span class="muted">${distanceLabel(courseLength(course), ui.unit)}</span>
        <button data-act="removeCourse" data-ci="${ci}" title="Remove course" aria-label="Remove course">${TRASH}</button>
      </div>
      <div class="fields">
        <label>starts <input type="time" data-field="courseStart" data-ci="${ci}" value="${clock(course.start_time)}"></label>
      </div>
      ${courseTools(course, ci, ui)}
      ${segmentsSection(course, ci, ui)}
    </div>`,
      )
      .join("")}
  </details>`;
}

/** The buttons that reshape a course, offered only once its shape is open for editing. */
function courseTools(course, ci, ui) {
  if (ui.editing !== course.id) {
    return `<div class="row centered"><button data-act="editCourse" data-ci="${ci}">Edit course</button></div>`;
  }
  const snap = (field, on, label) => `<label title="Snapping is not built yet">${label} ${toggle(field, on, "disabled")}</label>`;
  return `<div class="row">
    <button data-act="undo" data-ci="${ci}" ${canUndo(ui.shapes, course) ? "" : "disabled"}>Undo</button>
    <button data-act="redo" data-ci="${ci}" ${canRedo(ui.shapes, course) ? "" : "disabled"}>Redo</button>
    <button data-act="editCourse" data-ci="${ci}" class="active">Done</button>
  </div>
  <p class="muted hint">Drag a point to move it, click it to pick it out for removal, or double click the line to add one.</p>
  <div class="fields">
    ${snap("snapRoads", ui.snap.roads, "snap to roads")}
    ${snap("snapPaths", ui.snap.paths, "snap to paths")}
  </div>`;
}

/** The stretches a course is built from, folded down to how many and how detailed they are. */
function segmentsSection(course, ci, ui) {
  const bounds = segmentBoundaries(course);
  const last = course.segments.length - 1;
  const edge = (label, field, si, metres, fixed) =>
    `<label>${label} <span><input type="number" data-field="${field}" data-ci="${ci}" data-si="${si}" value="${(metres * ui.unit.perMetre).toFixed(2)}" min="0" step="0.1" size="5" ${fixed ? "disabled" : ""}> ${ui.unit.label}</span></label>`;
  const segment = (s, si) => `<li>
      <div class="row">
        <span class="muted">${si + 1}</span>
        <button data-act="splitSegment" data-ci="${ci}" data-si="${si}" title="Split this stretch in half" aria-label="Split this stretch in half">split</button>
        <select data-field="segmentMode" data-ci="${ci}" data-si="${si}">${options(MODES, s.mode)}</select>
        <label title="Can spectators watch this stretch?">${toggle("viewable", s.viewable, `data-ci="${ci}" data-si="${si}"`)} viewable</label>
        <span class="muted">${distanceLabel(polylineLength(s.points), ui.unit, 1)}</span>
        ${si + 1 < course.segments.length ? `<button data-act="merge" data-ci="${ci}" data-si="${si}">merge ↓</button>` : ""}
      </div>
      ${advanced(
        `course-${course.id}-segment-${si}`,
        `<div class="fields">
          ${edge("from", "segmentStart", si, bounds[si], si === 0)}
          ${edge("to", "segmentEnd", si, bounds[si + 1], si === last)}
        </div>`,
      )}
    </li>`;
  return `<details class="foldout" data-section="course-${course.id}-segments">
    <summary>
      <span>segments ${CARET}</span>
      <span class="muted">${course.segments.length}</span>
    </summary>
    <ul class="segments">${course.segments.map(segment).join("")}</ul>
  </details>`;
}

function racersSection(event, ui) {
  if (event.courses.length === 0) return "";
  return `<details class="section" data-section="racers">
    <summary><h2>Racers <button data-act="addRacer" title="Add a racer" aria-label="Add a racer">+</button></h2></summary>
    ${event.racers.map((racer, ri) => racerCard(racer, ri, event, ui)).join("")}
  </details>`;
}

/** A racer folded down to name, course, and pace, with the rest behind the gear. */
function racerCard(racer, ri, event, ui) {
  const course = event.courses.find((c) => c.id === racer.course_id)?.name ?? "";
  return `<details class="card" data-section="racer-${racer.id}" open>
    <summary>
      ${
        ui.renaming === racer.id
          ? `<input class="rename" data-field="racerName" data-ri="${ri}" value="${esc(racer.name)}" aria-label="Racer name">`
          : `<span class="name" data-act="renameRacer" data-ri="${ri}" tabindex="0" role="button" title="Rename">${esc(racer.name)}</span>`
      }
      <span class="muted">${esc(course)} · ${paceLabel(averagePace(racer), ui.unit)}/${ui.unit.label}</span>
      <button data-act="removeRacer" data-ri="${ri}" title="Remove racer" aria-label="Remove racer">${TRASH}</button>
    </summary>
    <div class="fields">
      <label>course <select data-field="racerCourse" data-ri="${ri}">${event.courses.map((c) => `<option value="${c.id}" ${c.id === racer.course_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    </div>
    ${paceSection(racer, ri, event, ui)}
    ${advanced(`racer-${racer.id}-adv`, racerAdvanced(racer, ri))}
  </details>`;
}

/** What the racer averages, opening to the legs that make it up. */
function paceSection(racer, ri, event, ui) {
  const legs = racer.pace_profile.length;
  const average = `${paceLabel(averagePace(racer), ui.unit)}/${ui.unit.label}`;
  return `<details class="foldout" data-section="racer-${racer.id}-pace">
    <summary>
      <span>pace ${CARET}</span>
      <span class="muted">${average}${legs > 1 ? ` over ${legs} legs` : ""}</span>
    </summary>
    ${paceLadder(racer, ri, event, ui)}
  </details>`;
}

/** How the racer runs: when they start, how much they matter, and which sighting counts. */
function racerAdvanced(racer, ri) {
  return `<div class="fields">
      <label>start offset <span><input type="number" data-field="racerOffset" data-ri="${ri}" value="${racer.start_offset_s / 60}" step="1" size="4"> min</span></label>
      <label>priority <input type="number" data-field="racerPriority" data-ri="${ri}" value="${racer.priority}" step="0.5" min="0" size="3"></label>
      <label>prefer <select data-field="racerPrefer" data-ri="${ri}" title="which sighting of this racer matters most">
        ${options(["finish", "neutral", "en_route"], racer.prefer ?? "finish", { finish: "the finish", neutral: "during, then finish", en_route: "during, always" })}
      </select></label>
      <label title="A plan that misses this finish is worse than any plan that catches it">require their finish ${toggle("racerRequireFinish", racer.require_finish, `data-ri="${ri}"`)}</label>
    </div>`;
}

/**
 * The profile as a ladder: a distance mark at every boundary, the pace held over the leg
 * between two marks, and a merge on each mark the two legs around it could collapse into.
 */
function paceLadder(racer, ri, event, ui) {
  const lastLeg = racer.pace_profile.length - 1;
  // The start reads bare, since every mark below it carries the unit.
  const at = (metres) => (metres === 0 ? "0" : distanceLabel(metres, ui.unit, 1));
  // Every leg holds identical controls, so each names the stretch it covers to tell them apart.
  const over = ({ start_m, end_m }) => ` from ${at(start_m)} to ${at(end_m)}`;
  // Only the marks between two legs can move; the start and the finish are where the course says.
  const mark = (metres, mergeIndex) => `<div class="mark">
      ${
        mergeIndex === null
          ? `<span>${at(metres)}</span>`
          : `<span><input class="quiet" type="number" data-field="paceBoundary" data-ri="${ri}" data-ii="${mergeIndex}" value="${(metres * ui.unit.perMetre).toFixed(2)}" min="0" step="0.1" size="5" aria-label="Where the leg above ends"> ${ui.unit.label}</span>
      <button data-act="mergeInterval" data-ri="${ri}" data-ii="${mergeIndex}" title="Merge the legs meeting at ${at(metres)}" aria-label="Merge the legs meeting at ${at(metres)}">merge</button>`
      }
    </div>`;
  const leg = (interval, ii) => `<div class="leg">
      ${paceInput(racer, ri, ii, ui, over(interval))}<span class="muted">/${ui.unit.label}</span>
      <label>&plusmn; ${spreadInput(racer, ri, ii, over(interval))}%</label>
      <button data-act="splitInterval" data-ri="${ri}" data-ii="${ii}" title="Split the leg${over(interval)} in half" aria-label="Split the leg${over(interval)} in half">split</button>
    </div>`;
  const rungs = racer.pace_profile.map((interval, ii) => leg(interval, ii) + mark(interval.end_m, ii === lastLeg ? null : ii));
  return `<div class="ladder">${mark(0, null)}${rungs.join("")}</div>`;
}

const paceInput = (racer, ri, ii, ui, over = "") =>
  `<input data-field="pace" data-ri="${ri}" data-ii="${ii}" value="${paceLabel(racer.pace_profile[ii].seconds_per_km, ui.unit)}" size="5" title="min:sec per ${ui.unit.label}" aria-label="Pace${over}">`;

const spreadInput = (racer, ri, ii, over = "") =>
  `<input type="number" data-field="uncertainty" data-ri="${ri}" data-ii="${ii}" value="${Math.round(racer.pace_profile[ii].uncertainty * 100)}" min="0" max="99" size="2" aria-label="Pace uncertainty${over}">`;

function spectatorSection(event, ui) {
  const s = event.spectator;
  const tool = (kind) => ui.tool?.kind === kind;
  return `<details class="section" data-section="spectator" open>
    <summary><h2>Spectator</h2></summary>
    <div class="fields">
      <label>start spectating <input type="time" data-field="earliest" value="${clock(s.earliest)}"></label>
      ${s.mode === "drive" ? "" : `<label>${s.mode} speed <span><input type="number" data-field="speed" value="${speedLabel(s.speed_mps ?? DEFAULT_SPEED_MPS[s.mode], ui.unit)}" min="0.5" step="0.5" size="4" title="your pace on ordinary streets"> ${ui.unit.speed}</span></label>`}
    </div>
    ${advanced(
      "spectator-adv",
      `<div class="fields">
      <label>until <input type="time" data-field="latest" value="${s.latest ? clock(s.latest) : ""}"></label>
      <label>travel <select data-field="travel">${options(TRAVEL, s.mode)}</select></label>
    </div>
    <div class="row">
      ${toolButton("setStart", tool("start"), s.start ? "Move start" : "Set start", "Click the map")}
      ${s.start ? `<button data-act="clearStart" title="Remove start; the planner chooses" aria-label="Remove start">${TRASH}</button>` : `<span class="muted">planner chooses</span>`}
    </div>
    <div class="row">
      ${toolButton("setEnd", tool("end"), s.end ? "Move end" : "Set end", "Click the map")}
      ${s.end ? `<label>by <input type="time" data-field="endLatest" value="${clock(s.end.latest)}"></label><button data-act="clearEnd" title="Remove end point" aria-label="Remove end point">${TRASH}</button>` : ""}
    </div>
    <div class="row">
      ${toolButton("addRegion", tool("region"), "Add must-visit area", "Click the map")}
    </div>
    ${s.required_regions
      .map(
        (r, gi) => `<div class="row">
      <span class="muted">area ${gi + 1}</span>
      <label>r <input type="number" data-field="regionRadius" data-gi="${gi}" value="${r.radius_m}" min="10" size="4"> m</label>
      <button data-act="removeRegion" data-gi="${gi}" title="Remove area" aria-label="Remove area">${TRASH}</button>
    </div>`,
      )
      .join("")}`,
    )}
  </details>`;
}

/** Rarely-touched controls behind a gear, folded until asked for. */
function advanced(section, content) {
  return `<details class="advanced" data-section="${section}">
    <summary title="Advanced" aria-label="Advanced">${GEAR}<span>advanced</span></summary>
    ${content}
  </details>`;
}

/** Feel-only tunables, kept per browser so they can be tried without a code change. */
function debugDialog(ui) {
  const rows = Object.entries(DEBUG_DEFAULTS)
    .map(([k, d]) => `<label>${d.label} <span><input type="number" data-field="debug" data-key="${k}" value="${ui.debug[k]}" min="0" step="${d.unit === "%" ? 1 : 50}" size="5"> ${d.unit}</span></label>`)
    .join("");
  return `<dialog data-dialog="debug" aria-label="Debug settings">
      <button data-act="hideDialog" data-dialog="debug" class="dismiss" title="Close" aria-label="Close">✕</button>
      <h2>Debug <button data-act="resetDebug" title="Back to the defaults" aria-label="Reset the debug settings">↺</button></h2>
      <div class="fields">${rows}</div>
  </dialog>`;
}

function settingsSection(event, ui) {
  const s = event.spectator;
  return `<details class="section" data-section="settings">
      <summary><h2>Advanced settings</h2></summary>
      <div class="fields">
        <label>sighting radius <span><input type="number" data-field="radius" value="${s.sighting_radius_m}" min="5" size="3"> m</span></label>
        <label>skip first <span><input type="number" data-field="skipStart" value="${((s.skip_start_m ?? 1600) * ui.unit.perMetre).toFixed(1)}" min="0" step="0.1" size="4" title="the crowded start of each course is not worth a stop"> ${ui.unit.label}</span></label>
        <label>safety buffer <span><input type="number" data-field="buffer" value="${s.safety_buffer_s / 60}" min="0" step="0.5" size="3"> min</span></label>
        <label>min stop <span><input type="number" data-field="minStop" value="${s.min_stop_s / 60}" min="0" size="3"> min</span></label>
        <label>viewpoint spacing <span><input type="number" data-field="spacing" value="${s.viewpoint_spacing_m ?? 120}" min="20" step="10" size="4" title="spots closer than this that see the same courses merge"> m</span></label>
        <label>course closed to crossing ${toggle("courseClosed", s.course_closed)}</label>
        <label>search effort <select data-field="beam">${options(["16", "64", "256"], String(ui.beam))}</select></label>
      </div>
  </details>`;
}

function results(itinerary, event, ui) {
  const name = (id) => event.racers.find((r) => r.id === id)?.name ?? id;
  const stops = itinerary.stops
    .map((stop, i) => {
      const label = stopLabel(event, i);
      const when = label === "Start" ? clock(stop.depart) : `${clock(stop.arrive)}–${clock(stop.depart)}`;
      return `<li data-act="flyTo" data-stop="${i}">
      <b>${label}</b> ${when}
      <ul>${stop.seen.map((s) => `<li>${esc(name(s.racer_id))} <span class="muted">${s.kind} ~${clock(s.expected)}</span></li>`).join("")}</ul>
      ${itinerary.legs[i] ? `<p class="muted">→ ${Math.round(itinerary.legs[i].seconds / 60)} min · ${distanceLabel(polylineLength(itinerary.legs[i].path), ui.unit, 1)}</p>` : ""}
    </li>`;
    })
    .join("");
  const unseen = itinerary.unseen.length ? `<p class="warn">Never seen: ${itinerary.unseen.map(name).map(esc).join(", ")}</p>` : "";
  const missedFinish = itinerary.unmet_finishes?.length
    ? `<p class="warn">Missed the finish you required for ${itinerary.unmet_finishes.map(name).map(esc).join(", ")}</p>`
    : "";
  const unmet = itinerary.unmet_regions.length ? `<p class="warn">Could not visit area ${itinerary.unmet_regions.map((i) => i + 1).join(", ")}</p>` : "";
  return `<p><button data-act="exportGpx">Export GPX</button></p>
    <ol class="stops">${stops}</ol>${unseen}${missedFinish}${unmet}${alternatives(ui)}`;
}

/** Looser settings that would do clearly better, once the background search has tried them. */
function alternatives(ui) {
  if (ui.alternatives === null) return `<p class="muted">Trying looser settings…</p>`;
  if (ui.alternatives.length === 0) return "";
  const items = ui.alternatives
    .map(
      ({ alt, variant, itinerary }, i) =>
        `<li>With ${esc(alt.label)}: ${planSummary(variant, itinerary)} <button data-act="useAlternative" data-alt="${i}" ${ui.busy ? "disabled" : ""}>Use</button></li>`,
    )
    .join("");
  return `<p>Better plans are possible:</p><ul class="alternatives">${items}</ul>`;
}

/** A selector that finds the same control again after the markup is rebuilt, or null for anonymous ones. */
function selectorFor(element) {
  const keys = Object.keys(element.dataset ?? {});
  if (!keys.length) return null;
  return keys.map((k) => `[data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${element.dataset[k]}"]`).join("");
}

const GEAR = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M8 1.6v2.1M8 12.3v2.1M1.6 8h2.1M12.3 8h2.1M3.5 3.5l1.5 1.5M11 11l1.5 1.5M12.5 3.5 11 5M5 11l-1.5 1.5"/></svg>`;

const toolButton = (act, active, idle, working, extra = "") =>
  `<button data-act="${act}" ${extra} class="${active ? "active" : ""}">${active ? working : idle}</button>`;

/** An on/off field, drawn as a slider rather than a checkbox. */
const toggle = (field, on, attrs = "") =>
  `<input type="checkbox" class="toggle" data-field="${field}" ${attrs} ${on ? "checked" : ""}>`;

const CARET = `<svg class="caret" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m6 4 4 4-4 4"/></svg>`;

const FLASK = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M6.4 1.8v4L2.8 12a1.3 1.3 0 0 0 1.1 2h8.2a1.3 1.3 0 0 0 1.1-2L9.6 5.8v-4"/><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M5.6 1.8h4.8M4.9 10.2h6.2"/></svg>`;

/** A trash-can glyph for remove buttons, so removing never looks like closing. */
const TRASH = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4"/></svg>`;

const options = (values, selected, labels = {}) =>
  values.map((v) => `<option value="${v}" ${v === selected ? "selected" : ""}>${labels[v] ?? v}</option>`).join("");

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The side panel: renders the event as forms and turns edits into state changes.

import * as state from "./state.js";

const MODES = ["run", "bike", "swim", "other"];
const TRAVEL = ["walk", "bike", "drive"];

/**
 * `actions` is the set of callbacks the app wires up; `ui` is transient editor state
 * (which tool is active, the latest itinerary, status text).
 */
export function renderPanel(root, event, ui, actions) {
  // A time input fires change after each segment typed; rebuilding it mid-entry would eat the rest, so wait for blur.
  if (root.editingTime) {
    root.pendingRender = () => renderPanel(root, event, ui, actions);
    return;
  }
  // Rebuilding the markup must not move the user: keep open sections open and the scroll where it was.
  const folds = new Map([...root.querySelectorAll("details[data-section]")].map((d) => [d.dataset.section, d.open]));
  const scroll = root.scrollTop;
  const focused = root.contains(document.activeElement) ? selectorFor(document.activeElement) : null;
  // When the plan goes away, its space stays until the user scrolls up, so the panel does not snap.
  const shown = root.querySelector("[data-results]");
  if (shown && !ui.itinerary) ui.ghost = shown.offsetHeight;
  if (ui.itinerary) ui.ghost = null;
  root.innerHTML = `
    ${ui.banner ? `<div class="banner">${ui.banner} <a href="${RELEASES}" target="_blank" rel="noopener">Run it yourself</a> <button data-act="dismissBanner" title="Dismiss">✕</button></div>` : ""}
    <section>
      <div class="row">
        <select data-act="example" ${ui.busy ? "disabled" : ""}>
          <option value="">Examples…</option>
          <option value="downtown-loop">Downtown loop</option>
          <option value="three-distances">5K · 10K · half marathon</option>
          <option value="hawthorne-belmont">Out-and-back, six racers</option>
          <option value="colfax">Colfax Marathon &amp; Half</option>
        </select>
      </div>
      <div class="row">
        <button data-act="save" title="Save event as .bird">Save</button>
        <label class="button" title="Load a .bird event">Load<input type="file" accept=".bird,.json" data-act="load" hidden ${ui.busy ? "disabled" : ""}></label>
        <button data-act="reset" title="Start over with an empty event" ${ui.busy ? "disabled" : ""}>Reset</button>
      </div>
      <label>Event <input data-field="name" value="${esc(event.name)}"></label>
    </section>
    ${coursesSection(event, ui)}
    ${racersSection(event, ui)}
    ${spectatorSection(event, ui)}
    ${settingsSection(event, ui)}
    ${debugSection(ui)}
    <section>
      <h2>Results</h2>
      <p class="muted"><span data-status>${esc(ui.status)}</span></p>
      ${ui.itinerary ? `<div data-results>${results(ui.itinerary, event, ui)}</div>` : ui.ghost ? `<div class="ghost" style="height:${ui.ghost}px"></div>` : ""}
    </section>`;
  for (const details of root.querySelectorAll("details[data-section]")) {
    if (folds.has(details.dataset.section)) details.open = folds.get(details.dataset.section);
  }
  root.scrollTop = scroll;
  if (focused) root.querySelector(focused)?.focus({ preventScroll: true });
  bindActions(root, actions);
}

/** The bar that stays put: name, the Plan button, theme, and on phones the panel toggle. */
export function renderHeader(root, event, ui, actions) {
  const ready = event.courses.length && event.racers.length;
  const why = event.courses.length ? (event.racers.length ? "Plan where to stand" : "Add a racer first") : "Add a course first";
  root.innerHTML = `
    <h1>birdseye</h1>
    <button data-act="plan" class="plan ${ready ? "ready" : "missing"}" ${ui.busy ? "disabled" : ""} title="${why}">Plan</button>
    <span class="row">
      <button data-act="toggleTier" class="tier ${ui.tier}" title="Free: one course, two racers, one pace each. Plus: no limits.">${state.TIERS[ui.tier].label}</button>
      <button data-act="theme" title="Light or dark">◐</button>
      <button data-act="units" title="Switch units">${ui.unit.label}</button>
      <button data-act="togglePanel" class="phone-only" title="Options">☰</button>
    </span>`;
  bindActions(root, actions);
}

/** Clicks and changes inside `root` dispatch to `actions` by their `data-act` / `data-field`. */
function bindActions(root, actions) {
  root.onclick = (e) => {
    const target = e.target.closest("[data-act]");
    // File inputs and selects act on change, not on the click that opens them.
    if (target && !["INPUT", "SELECT"].includes(target.tagName)) actions[target.dataset.act](target.dataset);
    // A button in a section heading acts without folding the section.
    if (target?.closest("summary")) e.preventDefault();
  };
  root.onchange = (e) => {
    const { act, field } = e.target.dataset;
    if (act) actions[act](e.target.dataset, e.target);
    else if (field) actions.edit(e.target.dataset, e.target);
  };
  if (root.focusTracked) return;
  root.focusTracked = true;
  // Chromium reports no active element between a time input's segments, so focus is tracked by its events.
  root.addEventListener("focusin", (e) => {
    root.editingTime = e.target.type === "time";
  });
  root.addEventListener("focusout", (e) => {
    if (e.target.type !== "time") return;
    root.editingTime = false;
    const render = root.pendingRender;
    root.pendingRender = null;
    render?.();
  });
}

function coursesSection(event, ui) {
  const tool = (kind, index) => ui.tool?.kind === kind && ui.tool.courseIndex === index;
  return `<details class="section" data-section="courses">
    <summary><h2>Courses ${addButton("addCourse", state.tierLocks(event, ui.tier).course, "course")}</h2></summary>
    <div class="row">
      ${state.tierLocks(event, ui.tier).course ? addButton("importCourses", true, "course", "Import") : `<label class="button" title="Import courses from GPX, KML, KMZ, TCX, FIT, or GeoJSON">Import<input type="file" accept=".gpx,.kml,.kmz,.tcx,.fit,.geojson,.json" data-act="importCourses" hidden ${ui.busy ? "disabled" : ""}></label>`}
      <span class="muted">GPX, KML, KMZ, TCX, FIT, GeoJSON</span>
    </div>
    ${event.courses
      .map(
        (course, ci) => `<div class="card">
      <div class="row">
        <input data-field="courseName" data-ci="${ci}" value="${esc(course.name)}" aria-label="Course name">
        <button data-act="removeCourse" data-ci="${ci}" title="Remove course" aria-label="Remove course">${TRASH}</button>
      </div>
      <div class="fields">
        <label>starts <input type="time" data-field="courseStart" data-ci="${ci}" value="${state.clock(course.start_time)}"></label>
        <label>length <span class="muted">${state.distanceLabel(state.courseLength(course), ui.unit)}</span></label>
      </div>
      <div class="row">
        ${toolButton("draw", tool("draw", ci), "Draw", "Drawing… (click map)", `data-ci="${ci}"`)}
        <button data-act="undo" data-ci="${ci}">Undo point</button>
        ${toolButton("split", tool("split", ci), "Split", "Click the course", `data-ci="${ci}"`)}
      </div>
      <ol class="segments">
        ${course.segments
          .map(
            (s, si) => `<li>
          <select data-field="segmentMode" data-ci="${ci}" data-si="${si}">${options(MODES, s.mode)}</select>
          <label title="Can spectators watch this stretch?"><input type="checkbox" data-field="viewable" data-ci="${ci}" data-si="${si}" ${s.viewable ? "checked" : ""}> viewable</label>
          <span class="muted">${s.points.length} pts</span>
          ${si + 1 < course.segments.length ? `<button data-act="merge" data-ci="${ci}" data-si="${si}">merge ↓</button>` : ""}
        </li>`,
          )
          .join("")}
      </ol>
    </div>`,
      )
      .join("")}
  </details>`;
}

function racersSection(event, ui) {
  if (event.courses.length === 0) return "";
  return `<details class="section" data-section="racers">
    <summary><h2>Racers ${addButton("addRacer", state.tierLocks(event, ui.tier).racer, "racer")}</h2></summary>
    ${event.racers
      .map(
        (racer, ri) => `<details class="card" data-section="racer-${racer.id}" open>
      <summary><b>${esc(racer.name)}</b> <span class="muted">${esc(event.courses.find((c) => c.id === racer.course_id)?.name ?? "")} · ${state.paceLabel(racer.pace_profile[0]?.seconds_per_km ?? 0, ui.unit)}/${ui.unit.label}</span></summary>
      <div class="row">
        <input data-field="racerName" data-ri="${ri}" value="${esc(racer.name)}" aria-label="Racer name">
        <button data-act="removeRacer" data-ri="${ri}" title="Remove racer" aria-label="Remove racer">${TRASH}</button>
      </div>
      <div class="fields">
        <label>course <select data-field="racerCourse" data-ri="${ri}">${event.courses.map((c) => `<option value="${c.id}" ${c.id === racer.course_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
        ${
          racer.pace_profile.length === 1
            ? `<label>pace <span><input data-field="pace" data-ri="${ri}" data-ii="0" value="${state.paceLabel(racer.pace_profile[0].seconds_per_km, ui.unit)}" size="5" title="min:sec per ${ui.unit.label}" aria-label="Pace"> /${ui.unit.label}</span></label>`
            : `<label>pace <span class="muted">${racer.pace_profile.length} intervals ${GEAR}</span></label>`
        }
      </div>
      ${advanced(
        `racer-${racer.id}-adv`,
        `<div class="fields">
        <label>start offset <span><input type="number" data-field="racerOffset" data-ri="${ri}" value="${racer.start_offset_s / 60}" step="1" size="4"> min</span></label>
        <label>priority <input type="number" data-field="racerPriority" data-ri="${ri}" value="${racer.priority}" step="0.5" min="0" size="3"></label>
        <label>prefer <select data-field="racerPrefer" data-ri="${ri}" title="which sighting of this racer matters most">
          ${options(["finish", "neutral", "en_route"], racer.prefer ?? "finish", { finish: "the finish", neutral: "during, then finish", en_route: "during, always" })}
        </select></label>
      </div>
      ${
        racer.pace_profile.length === 1
          ? `<div class="row">
        <label>&plusmn; <input type="number" data-field="uncertainty" data-ri="${ri}" data-ii="0" value="${Math.round(racer.pace_profile[0].uncertainty * 100)}" min="0" max="99" size="2" aria-label="Pace uncertainty">%</label>
        ${state.tierLocks(event, ui.tier).pace(racer) ? addButton("splitInterval", true, "pace", "Split pace") : `<button data-act="splitInterval" data-ri="${ri}" data-ii="0" title="Split into two intervals at half distance">Split pace</button>`}
      </div>`
          : `<div class="paces">
        ${racer.pace_profile
          .map(
            (p, ii) => `<div class="row">
          <span class="muted">${(p.start_m * ui.unit.perMetre).toFixed(1)}&ndash;${state.distanceLabel(p.end_m, ui.unit, 1)}</span>
          <input data-field="pace" data-ri="${ri}" data-ii="${ii}" value="${state.paceLabel(p.seconds_per_km, ui.unit)}" size="5" title="min:sec per ${ui.unit.label}" aria-label="Pace">
          &plusmn; <input type="number" data-field="uncertainty" data-ri="${ri}" data-ii="${ii}" value="${Math.round(p.uncertainty * 100)}" min="0" max="99" size="2" aria-label="Pace uncertainty">%
          ${state.tierLocks(event, ui.tier).pace(racer) ? addButton("splitInterval", true, "pace", "\u22ef") : `<button data-act="splitInterval" data-ri="${ri}" data-ii="${ii}" title="Split this interval in half">\u22ef</button>`}
          ${ii + 1 < racer.pace_profile.length ? `<button data-act="mergeInterval" data-ri="${ri}" data-ii="${ii}" title="Merge with next">merge \u2193</button>` : ""}
        </div>`,
          )
          .join("")}
      </div>`
      }`,
      )}
    </details>`,
      )
      .join("")}
  </details>`;
}

function spectatorSection(event, ui) {
  const s = event.spectator;
  const tool = (kind) => ui.tool?.kind === kind;
  return `<details class="section" data-section="spectator">
    <summary><h2>Spectator</h2></summary>
    <div class="fields">
      <label>out from <input type="time" data-field="earliest" value="${state.clock(s.earliest)}"></label>
      ${s.mode === "drive" ? "" : `<label>${s.mode} speed <span><input type="number" data-field="speed" value="${state.speedLabel(s.speed_mps ?? state.DEFAULT_SPEED_MPS[s.mode], ui.unit)}" min="0.5" step="0.5" size="4" title="your pace on ordinary streets"> ${ui.unit.speed}</span></label>`}
    </div>
    ${advanced(
      "spectator-adv",
      `<div class="fields">
      <label>until <input type="time" data-field="latest" value="${s.latest ? state.clock(s.latest) : ""}"></label>
      <label>travel <select data-field="travel">${options(TRAVEL, s.mode)}</select></label>
    </div>
    <div class="row">
      ${toolButton("setStart", tool("start"), s.start ? "Move start" : "Set start", "Click the map")}
      ${s.start ? `<button data-act="clearStart" title="Remove start; the planner chooses" aria-label="Remove start">${TRASH}</button>` : `<span class="muted">planner chooses</span>`}
    </div>
    <div class="row">
      ${toolButton("setEnd", tool("end"), s.end ? "Move end" : "Set end", "Click the map")}
      ${s.end ? `<label>by <input type="time" data-field="endLatest" value="${state.clock(s.end.latest)}"></label><button data-act="clearEnd" title="Remove end point" aria-label="Remove end point">${TRASH}</button>` : ""}
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
function debugSection(ui) {
  const rows = Object.entries(state.DEBUG_DEFAULTS)
    .map(([k, d]) => `<label>${d.label} <span><input type="number" data-field="debug" data-key="${k}" value="${ui.debug[k]}" min="0" step="${d.unit === "%" ? 1 : 50}" size="5"> ${d.unit}</span></label>`)
    .join("");
  return `<details class="section" data-section="debug">
      <summary><h2>Debug <button data-act="resetDebug" title="Back to the defaults">↺</button></h2></summary>
      <div class="fields">${rows}</div>
  </details>`;
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
        <label title="Otherwise, in order: everyone seen the way they prefer, everyone's finish, each preferred sighting, each other sighting, repeats">require every finish <input type="checkbox" data-field="requireFinishes" ${s.objective.require_finishes ? "checked" : ""}></label>
        <label title="How much each repeat sighting of a racer is worth relative to the previous one">breadth ↔ depth <input type="range" data-field="decay" value="${s.objective.repeat_decay}" min="0" max="0.9" step="0.1"></label>
        <label>course closed to crossing <input type="checkbox" data-field="courseClosed" ${s.course_closed ? "checked" : ""}></label>
        <label>search effort <select data-field="beam">${options(["16", "64", "256"], String(ui.beam))}</select></label>
      </div>
  </details>`;
}

function results(itinerary, event, ui) {
  const name = (id) => event.racers.find((r) => r.id === id)?.name ?? id;
  const stops = itinerary.stops
    .map((stop, i) => {
      const label = state.stopLabel(event, i);
      const when = label === "Start" ? state.clock(stop.depart) : `${state.clock(stop.arrive)}–${state.clock(stop.depart)}`;
      return `<li data-act="flyTo" data-stop="${i}">
      <b>${label}</b> ${when}
      <ul>${stop.seen.map((s) => `<li>${esc(name(s.racer_id))} <span class="muted">${s.kind} ~${state.clock(s.expected)}</span></li>`).join("")}</ul>
      ${itinerary.legs[i] ? `<p class="muted">→ ${Math.round(itinerary.legs[i].seconds / 60)} min · ${state.distanceLabel(state.pathLength(itinerary.legs[i].path), ui.unit, 1)}</p>` : ""}
    </li>`;
    })
    .join("");
  const unseen = itinerary.unseen.length ? `<p class="warn">Never seen: ${itinerary.unseen.map(name).map(esc).join(", ")}</p>` : "";
  const unmet = itinerary.unmet_regions.length ? `<p class="warn">Could not visit area ${itinerary.unmet_regions.map((i) => i + 1).join(", ")}</p>` : "";
  return `<p><button data-act="exportGpx">Export GPX</button></p>
    <ol class="stops">${stops}</ol>${unseen}${unmet}${alternatives(ui)}`;
}

/** Looser settings that would do clearly better, once the background search has tried them. */
function alternatives(ui) {
  if (ui.alternatives === null) return `<p class="muted">Trying looser settings…</p>`;
  if (ui.alternatives.length === 0) return "";
  const items = ui.alternatives
    .map(
      ({ alt, variant, itinerary }, i) =>
        `<li>With ${esc(alt.label)}: ${state.planSummary(variant, itinerary)} <button data-act="useAlternative" data-alt="${i}" ${ui.busy ? "disabled" : ""}>Use</button></li>`,
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

const RELEASES = "https://github.com/Microcodery/cowbells/releases";

const LOCK = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2"/><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/></svg>`;

const GEAR = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M8 1.6v2.1M8 12.3v2.1M1.6 8h2.1M12.3 8h2.1M3.5 3.5l1.5 1.5M11 11l1.5 1.5M12.5 3.5 11 5M5 11l-1.5 1.5"/></svg>`;

/** An "add" button, or the same button greyed under a lock when the tier has no room for another `what`. */
const addButton = (act, locked, what, label = "+") =>
  locked
    ? `<button data-act="locked" data-what="${what}" class="locked" title="Plus allows more">${label}<span class="lock">${LOCK}</span></button>`
    : `<button data-act="${act}">${label}</button>`;

const toolButton = (act, active, idle, working, extra = "") =>
  `<button data-act="${act}" ${extra} class="${active ? "active" : ""}">${active ? working : idle}</button>`;

/** A trash-can glyph for remove buttons, so removing never looks like closing. */
const TRASH = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4"/></svg>`;

const options = (values, selected, labels = {}) =>
  values.map((v) => `<option value="${v}" ${v === selected ? "selected" : ""}>${labels[v] ?? v}</option>`).join("");

export function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

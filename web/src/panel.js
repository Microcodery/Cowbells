// The side panel: renders the event as forms and turns edits into state changes.

import * as state from "./state.js";

const MODES = ["run", "bike", "swim", "other"];
const TRAVEL = ["walk", "bike", "drive"];

/**
 * `actions` is the set of callbacks the app wires up; `ui` is transient editor state
 * (which tool is active, the latest itinerary, status text).
 */
export function renderPanel(root, event, ui, actions) {
  root.innerHTML = `
    <header>
      <h1>birdeye</h1>
      <div class="row">
        <button data-act="save">Save</button>
        <label class="button">Load<input type="file" accept=".json" data-act="load" hidden ${ui.busy ? "disabled" : ""}></label>
        <label class="button">GPX<input type="file" accept=".gpx" data-act="gpx" hidden ${ui.busy ? "disabled" : ""}></label>
        <button data-act="theme">◐</button>
      </div>
    </header>
    <section>
      <label>Event <input data-field="name" value="${esc(event.name)}"></label>
    </section>
    ${coursesSection(event, ui)}
    ${racersSection(event)}
    ${spectatorSection(event, ui)}
    <section>
      <h2>Plan</h2>
      <div class="row">
        <button data-act="fetch" ${ui.busy ? "disabled" : ""}>Fetch map data</button>
        <button data-act="plan" ${ui.busy || !ui.network ? "disabled" : ""}>Plan</button>
      </div>
      <p class="muted">${esc(ui.status)}</p>
      ${ui.itinerary ? results(ui.itinerary, event) : ""}
    </section>`;

  root.onclick = (e) => {
    const target = e.target.closest("[data-act]");
    // File inputs act on change, not on the click that opens the picker.
    if (target && target.tagName !== "INPUT") actions[target.dataset.act](target.dataset);
  };
  root.onchange = (e) => {
    const { act, field } = e.target.dataset;
    if (act) actions[act](e.target.dataset, e.target);
    else if (field) actions.edit(e.target.dataset, e.target);
  };
}

function coursesSection(event, ui) {
  const tool = (kind, index) => ui.tool?.kind === kind && ui.tool.courseIndex === index;
  return `<section>
    <h2>Courses <button data-act="addCourse">+</button></h2>
    ${event.courses
      .map(
        (course, ci) => `<div class="card">
      <div class="row">
        <input data-field="courseName" data-ci="${ci}" value="${esc(course.name)}">
        <input type="time" data-field="courseStart" data-ci="${ci}" value="${state.clock(course.start_time)}">
        <span class="muted">${(state.courseLength(course) / 1000).toFixed(2)} km</span>
        <button data-act="removeCourse" data-ci="${ci}" title="Remove">✕</button>
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
  </section>`;
}

function racersSection(event) {
  if (event.courses.length === 0) return "";
  return `<section>
    <h2>Racers <button data-act="addRacer">+</button></h2>
    ${event.racers
      .map(
        (racer, ri) => `<div class="card">
      <div class="row">
        <input data-field="racerName" data-ri="${ri}" value="${esc(racer.name)}">
        <select data-field="racerCourse" data-ri="${ri}">${event.courses.map((c) => `<option value="${c.id}" ${c.id === racer.course_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
        <button data-act="removeRacer" data-ri="${ri}" title="Remove">✕</button>
      </div>
      <div class="row">
        <label>offset <input type="number" data-field="racerOffset" data-ri="${ri}" value="${racer.start_offset_s / 60}" step="1" size="4"> min</label>
        <label>priority <input type="number" data-field="racerPriority" data-ri="${ri}" value="${racer.priority}" step="0.5" min="0" size="3"></label>
      </div>
      <div class="paces">
        ${racer.pace_profile
          .map(
            (p, ii) => `<div class="row">
          <span class="muted">${(p.start_m / 1000).toFixed(1)}–${(p.end_m / 1000).toFixed(1)} km</span>
          <input data-field="pace" data-ri="${ri}" data-ii="${ii}" value="${state.paceLabel(p.seconds_per_km)}" size="5" title="min:sec per km">
          ± <input type="number" data-field="uncertainty" data-ri="${ri}" data-ii="${ii}" value="${Math.round(p.uncertainty * 100)}" min="0" max="99" size="2">%
          <button data-act="splitInterval" data-ri="${ri}" data-ii="${ii}" title="Split this interval in half">⋯</button>
          ${ii + 1 < racer.pace_profile.length ? `<button data-act="mergeInterval" data-ri="${ri}" data-ii="${ii}" title="Merge with next">⌄</button>` : ""}
        </div>`,
          )
          .join("")}
      </div>
    </div>`,
      )
      .join("")}
  </section>`;
}

function spectatorSection(event, ui) {
  const s = event.spectator;
  const tool = (kind) => ui.tool?.kind === kind;
  return `<section>
    <h2>Spectator</h2>
    <div class="row">
      ${toolButton("setStart", tool("start"), s.start ? "Move start" : "Set start", "Click the map")}
      ${s.start ? `<button data-act="clearStart" title="Let the planner choose">✕</button>` : `<span class="muted">planner chooses</span>`}
      <label>from <input type="time" data-field="earliest" value="${state.clock(s.earliest)}"></label>
      <label>until <input type="time" data-field="latest" value="${s.latest ? state.clock(s.latest) : ""}"></label>
      <select data-field="travel">${options(TRAVEL, s.mode)}</select>
    </div>
    <div class="row">
      ${toolButton("setEnd", tool("end"), s.end ? "Move end" : "Set end", "Click the map")}
      ${s.end ? `<label>by <input type="time" data-field="endLatest" value="${state.clock(s.end.latest)}"></label><button data-act="clearEnd">✕</button>` : ""}
    </div>
    <div class="row">
      ${toolButton("addRegion", tool("region"), "Add must-visit area", "Click the map")}
    </div>
    ${s.required_regions
      .map(
        (r, gi) => `<div class="row">
      <span class="muted">area ${gi + 1}</span>
      <label>r <input type="number" data-field="regionRadius" data-gi="${gi}" value="${r.radius_m}" min="10" size="4"> m</label>
      <button data-act="removeRegion" data-gi="${gi}">✕</button>
    </div>`,
      )
      .join("")}
    <details>
      <summary>Settings</summary>
      <label>sighting radius <input type="number" data-field="radius" value="${s.sighting_radius_m}" min="5" size="3"> m</label>
      <label>safety buffer <input type="number" data-field="buffer" value="${s.safety_buffer_s / 60}" min="0" step="0.5" size="3"> min</label>
      <label>min stop <input type="number" data-field="minStop" value="${s.min_stop_s / 60}" min="0" size="3"> min</label>
      <label>breadth ↔ depth <input type="range" data-field="decay" value="${s.objective.repeat_decay}" min="0" max="1" step="0.1" title="How much each repeat sighting of a racer is worth relative to the previous one"></label>
      <label><input type="checkbox" data-field="courseClosed" ${s.course_closed ? "checked" : ""}> course closed to crossing</label>
      <label>search effort <select data-field="beam">${options(["16", "64", "256"], String(ui.beam))}</select></label>
    </details>
  </section>`;
}

function results(itinerary, event) {
  const name = (id) => event.racers.find((r) => r.id === id)?.name ?? id;
  const anchored = Boolean(event.spectator.start);
  const stops = itinerary.stops
    .map((stop, i) => {
      const isStart = anchored && i === 0;
      const label = isStart ? "Start" : anchored ? i : i + 1;
      const when = isStart ? state.clock(stop.depart) : `${state.clock(stop.arrive)}–${state.clock(stop.depart)}`;
      return `<li data-act="flyTo" data-stop="${i}">
      <b>${label}</b> ${when}
      <ul>${stop.seen.map((s) => `<li>${esc(name(s.racer_id))} <span class="muted">${s.kind} ~${state.clock(s.expected)}</span></li>`).join("")}</ul>
      ${itinerary.legs[i] ? `<p class="muted">→ ${Math.round(itinerary.legs[i].seconds / 60)} min</p>` : ""}
    </li>`;
    })
    .join("");
  const unseen = itinerary.unseen.length ? `<p class="warn">Never seen: ${itinerary.unseen.map(name).map(esc).join(", ")}</p>` : "";
  const unmet = itinerary.unmet_regions.length ? `<p class="warn">Could not visit area ${itinerary.unmet_regions.map((i) => i + 1).join(", ")}</p>` : "";
  const sightings = itinerary.stops.reduce((n, s) => n + s.seen.length, 0);
  return `<p>${sightings} sightings, score ${Math.round(itinerary.score)}</p><ol class="stops">${stops}</ol>${unseen}${unmet}`;
}

const toolButton = (act, active, idle, working, extra = "") =>
  `<button data-act="${act}" ${extra} class="${active ? "active" : ""}">${active ? working : idle}</button>`;

const options = (values, selected) => values.map((v) => `<option ${v === selected ? "selected" : ""}>${v}</option>`).join("");

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

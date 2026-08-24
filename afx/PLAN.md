# cowbells — Implementation Plan

Phases → milestones → tasks. Each milestone ends in a working, tested state and a single squashed commit. Design in [EDD.md](EDD.md); requirements in [SPEC.md](SPEC.md).

**Progress (2026-08-22):** Phase 0 and Phase 1 complete on the [ALGORITHM.md](ALGORITHM.md) design: pace profiles, viewable segments, densified spectator network, coverage-arc viewpoints with clustering, and the tiered objective (M1.7 ships the label-setting planner without the greedy+2-opt comparison or benchmarks; M1.8 without the `serde-wasm-bindgen` A/B). Phase 2 has a first cut of M2.1–M2.4 as a sandbox: drawing, splitting, pace intervals, must-visit areas, Overpass fetch, planning, and results on the map. Not yet done: IndexedDB cache, network overlay, timeline, print, share URL.

## Phase 0 — Foundation

### M0.1 Workspace scaffold
- Cargo workspace: `crates/core`, `crates/routing`, `crates/plan`, `crates/wasm`.
- `web/` with Vite, a blank page, and a worker that loads the WASM and echoes a message.
- `just`/`make` targets: `test` (cargo + web), `build` (wasm-pack + vite), `dev`.
- CI: cargo test, clippy, fmt, wasm build, vite build.
- **Done when:** `just test` and `just build` pass from clean checkout; page loads and the worker round-trips.

### M0.2 Research sign-off
- Read RESEARCH.md; resolve EDD §9 open questions (tile provider, drawing plugin, routing crate).
- Update EDD and this plan if the stack changes.

## Phase 1 — Engine

### M1.1 Core model and geometry
- `Event`/`Course`/`Segment`/`Racer`/`SpectatorConfig` with serde; validation returning error lists.
- Azimuthal equidistant projection; `Point` maths; polyline length, cumulative distance, nearest point; point-in-polygon; segment intersection.
- GPX → `Course` via `gpx` crate.
- **Done when:** unit tests cover projection round-trip, validation cases, geometry against known values, GPX fixture import.

### M1.2 Trajectory
- Cumulative table per racer; `t_expected/t_early/t_late(d)`; sighting window.
- **Done when:** hand-computed tables match for a two-segment course with differing uncertainty; windows widen monotonically.

### M1.3 Routing graph
- Overpass JSON parser; mode-based way filter and speed table; access tags; oneway.
- Graph build; r-tree snapping; Dijkstra `time`, `path`, `matrix`.
- **Done when:** fixture extract yields expected counts; grid Dijkstra matches analytic answers; `matrix` of 300 nodes on the fixture runs under 200 ms natively.

### M1.4 Open-area shortcuts and closures
- Polygon extraction from Overpass; inside-polygon node sets; chord-inside test; k-nearest cap.
- Opt-in course-closure edge removal.
- **Done when:** tests show a chord through a park is used and a chord that leaves the polygon is not; closure removes crossing edges only.

### M1.5 Candidate generation
- Course sampling, snapping, merging within sighting radius; windows per candidate; start/finish kinds; spectator start/end candidates.
- **Done when:** two courses passing within the radius yield one merged candidate with both racers' windows.

### M1.6 Greedy planner
- `Objective` trait and `PriorityObjective`; greedy insertion producing a feasible `Itinerary`; required-sighting feasibility report.
- **Done when:** scenario tests produce sensible itineraries; infeasible required finish is reported, not dropped.

### M1.7 DP planner
- Labels, successor generation over window suffixes, dominance, optimistic bound, beam, greedy seed as lower bound.
- Property test: on tiny instances DP equals exhaustive search.
- Benchmarks: 3 courses × 30 racers × ~800 candidates under 5 s natively.
- **Done when:** tests and benchmarks pass; effort presets (fast/balanced/thorough) map to beam widths.

### M1.8 WASM facade
- `plan(event_json, osm_json, options_json) -> itinerary_json`, `parse_gpx`, `validate`, progress callback.
- Graph cached inside the worker across plans for the same OSM payload.
- **Done when:** `wasm-bindgen-test` round trip passes; bundle size recorded.

## Phase 2 — Web app

### M2.1 Map and course editing
- Page shell: side panel layout, light/dark palettes as CSS variables, `prefers-color-scheme` + toggle.
- MapLibre with OpenFreeMap light/dark styles; draw/edit polyline; split/merge segments; segment mode; course start time; GPX upload.
- Event state + auto-save to `localStorage`.
- **Done when:** a course can be drawn, split, saved, reloaded.

### M2.2 Racers and spectator forms
- Racer list: course assignment, start offset, pace profile seeded per segment with split/merge, priority.
- Spectator: start/end pick on map, times, mode, settings panel.
- **Done when:** a full event can be entered and survives save/load as JSON.

### M2.3 OSM fetch and routing preview
- Bbox from event; Overpass query per mode with backoff and instance rotation; IndexedDB cache; embed extract in the save file; "show network" overlay layer.
- **Done when:** fetch succeeds for a real city bbox, the network renders, and a saved event reloads offline with its extract.

### M2.4 Planning and results
- Worker protocol with progress; run plan; itinerary list, stops on map, legs drawn from `path`, click-to-highlight.
- Unseen racers and unreachable must-visit areas surfaced.
- **Done when:** end-to-end plan on a real event renders correctly.

### M2.5 Timeline and export
- Timeline view of stops × racer windows; print stylesheet / text export.
- **Done when:** timeline matches itinerary; print view is readable.

### M2.6 Sharing
- Fragment-URL encode/decode with size guard; JSON download/upload.
- **Done when:** a shared URL reloads the identical event.

## Phase 3 — Hardening and release

### M3.1 Quality
- Playwright flows; error handling for Overpass failures, oversized bboxes, invalid GPX.
- Accessibility pass on forms and results.

### M3.2 Performance
- Profile WASM on the benchmark event; tune dominance relaxation and beam defaults; lazy graph build.

### M3.3 Release v1
- Static deploy (GitHub Pages or similar); README usage docs; CHANGELOG; tag `v1.0.0`.

## Phase 4 — Post-v1 (from SPEC "Future plans")

Each item is a new `Objective` or an isolated module; sequenced by value:

1. Racer groups and coverage constraints
2. Pace curves
3. Live re-planning from tracking feeds
4. Multi-mode spectator
5. Organizer mode / optional hosting backend

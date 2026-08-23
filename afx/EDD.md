# birdeye — Engineering Design Document

Bridges [SPEC.md](SPEC.md) (what) and [PLAN.md](PLAN.md) (when). Covers architecture, data model, algorithms, and the decisions behind them.

## 1. Architecture

```
┌──────────────────────── browser ────────────────────────┐
│  web/ (plain JS)                                        │
│   ├─ map + drawing (MapLibre GL)                        │
│   ├─ forms: courses, racers, spectator                  │
│   ├─ GPX import, JSON save/load, URL share              │
│   ├─ Overpass fetch + cache (IndexedDB)                 │
│   └─ Web Worker ──── postMessage ────┐                  │
│                                      ▼                  │
│                       crates/wasm (wasm-bindgen facade) │
│                        ├─ crates/plan    optimizer      │
│                        ├─ crates/routing OSM graph      │
│                        └─ crates/core    model, geometry│
└─────────────────────────────────────────────────────────┘
         │ tiles                     │ Overpass JSON
         ▼                           ▼
   free tile CDN               public Overpass API
```

Principles:

- **Engine is pure Rust**, no DOM, no network, no browser APIs. Tested natively with `cargo test`. `wasm` is a thin serde boundary.
- **One direction of dependency**: `wasm → plan → routing → core`. `plan` depends on `routing` only through the `TravelTime` trait.
- **All compute in a Web Worker** so the map never blocks; the main thread only renders.
- **Event JSON is the universal format**: save file, share payload, and worker input are the same document.

Stack decisions are discussed in §7.

## 2. Data model (`crates/core`)

The algorithm and data model follow [ALGORITHM.md](ALGORITHM.md); this section records the Rust shape of it.

```rust
struct Event {
    name: String,
    origin: LatLon,              // projection centre
    courses: Vec<Course>,
    racers: Vec<Racer>,
    spectator: SpectatorConfig,
}

struct Course {
    id: CourseId,
    name: String,
    start_time: Timestamp,       // seconds since epoch, UTC
    segments: Vec<Segment>,      // ordered, contiguous (end of i == start of i+1)
}

struct Segment {
    id: SegmentId,
    mode: Mode,                  // Run | Bike | Swim | Other
    points: Vec<LatLon>,
    viewable: bool,              // false: no viewpoints along it (a swim leg)
}

struct Racer {
    id: RacerId,
    name: String,
    course_id: CourseId,
    start_offset_s: Seconds,
    pace_profile: Vec<PaceInterval>,  // contiguous, spans 0..course length
    priority: f64,                    // default 1.0
}

/// Pace is a function of distance along the course, decoupled from segments;
/// the UI seeds one interval per segment and the user subdivides freely.
struct PaceInterval { start_m: f64, end_m: f64, seconds_per_km: f64, uncertainty: f64 }

struct SpectatorConfig {
    start: Option<LatLon>,               // absent: the planner chooses
    earliest: Timestamp,
    latest: Option<Timestamp>,           // day window end
    end: Option<(LatLon, Timestamp)>,    // end anchor + latest arrival
    mode: TravelMode,                    // Walk | Bike | Drive
    sighting_radius_m: f64,              // 30
    safety_buffer_s: f64,                // 120: in place this long before a racer could appear
    min_stop_s: f64,                     // 60
    course_closed: bool,                 // crossing policy: never / always
    required_regions: Vec<RequiredRegion>,  // soft "watch from roughly here", large penalty
    objective: Objective,                // ordered tiers + repeat_decay
}

struct RequiredRegion { center: LatLon, radius_m: f64, latest: Option<Timestamp> }  // no `earliest`: waiting is never generated, so "not before" would break early-is-better dominance
struct Objective { tiers: Vec<Tier>, repeat_decay: f64 }   // Tier: EnRoute | Finish
```

Validation on load (returns a list of errors, not a panic): every racer's `course_id` exists; the pace profile runs from 0 to the course length with no gaps or overlaps; segments are contiguous; paces positive; uncertainty in `[0, 1)`.

**Projection.** All geometry is stored as WGS84 and projected on load to a local metric plane using an azimuthal equidistant projection about `origin`. Events span at most tens of km, so distortion is negligible and all downstream math is Euclidean. `core::geom` owns `LatLon`, `Point` (metres), projection, polyline length, nearest-point-on-polyline, and point-in-polygon.

## 3. Trajectory (`crates/core::trajectory`)

For each racer, precompute a cumulative table over its pace profile: `(distance_m, t_expected, t_early, t_late)` at every interval boundary. Within an interval position is linear in time, so arrival at any distance `d` is interpolated exactly.

- `t_expected(d)`: `course.start_time + start_offset + Σ pace·length` up to `d`.
- Uncertainty accumulates: `t_early(d) = start + Σ pace·(1−u)·length`, `t_late(d) = start + Σ pace·(1+u)·length`. Widening with distance is the desired behaviour.
- **Visibility window** for a coverage arc `[from, to]`: `[t_early(from) − safety_buffer, t_late(to)]` — in place before the racer could enter the arc, until they could not still be in it. The spectator must be present for the whole window (ALGORITHM.md §4.3).

No time stepping anywhere; every window is closed-form. This was a deliberate simplification over a "step every 15 s and intersect racer blobs" approach, which cannot find the common case of several racers passing one spot at *different* times (see §5).

## 4. Routing (`crates/routing`)

### Input

An Overpass JSON document for the event bounding box (courses + spectator start/end, padded ~500 m). The web shell obtains it; the crate only parses. Two sources, same format:

1. **Pre-baked extract** (primary): an extract saved alongside the event (`event.osm` in the save file or a sibling download). Produced by the same fetch, then exported. Shared events carry their extract so race-morning spectators never hit Overpass.
2. **Live Overpass** (fallback/authoring): fetched on demand, cached in IndexedDB, with instance rotation and backoff. Public instances allow ~2 concurrent slots per IP (RESEARCH.md §2e), so this is an authoring-time path, not a crowd path.

The query ends with `out body; >; out skel qt;` so nodes arrive as separate elements with `lat`/`lon`; the parser does not read inline `geometry` from `out geom`. Multipolygon relations are ignored (parks mapped as relations get no shortcuts; routes stay correct, just longer). Query pulls:

- `way[highway]` — filtered by mode: walk uses footway/path/pedestrian/steps/living_street/residential/tertiary/…, excludes motorway/trunk; bike adds cycleway, drops steps, respects oneway; drive uses motor-legal classes, oneway, and `maxspeed`.
- Walkable area polygons: `leisure=park|garden|pitch|playground`, `landuse=grass|recreation_ground|village_green`, `amenity=parking`, `highway=pedestrian` areas, `place=square`.
- Access tags honoured: `access=private|no`, `foot=no`, etc.

### Graph

- Nodes: OSM nodes on kept ways. Edges: consecutive way nodes, weight `length / speed(mode, tags)`. Default speeds: walk 1.3 m/s, bike 4.5 m/s, drive from `maxspeed` or class table.
- **Open-area shortcuts:** for each walkable polygon, collect graph nodes inside or on its boundary; add an edge between each pair whose connecting segment lies entirely inside the polygon (point-in-polygon on endpoints plus no intersection with the ring). Quadratic per polygon; polygons with more than `N` nodes (configurable, default 200) use a k-nearest (k=8) restriction. Only for walk and bike.
- **Course closure** (opt-in): remove edges whose segment intersects any course polyline. Coarse but honest; the user controls it.
- Spatial index: `rstar` r-tree over nodes and over edges for snapping.

### API

```rust
trait TravelTime {
    fn snap(&self, p: Point) -> Option<NodeId>;
    fn time(&self, from: NodeId, to: NodeId) -> Option<Seconds>;
    fn matrix(&self, nodes: &[NodeId]) -> Matrix;   // many-to-many
    fn path(&self, from: NodeId, to: NodeId) -> Option<Vec<Point>>;  // for display
}
```

`matrix` runs one Dijkstra per source; expected ~10²–10³ viewpoints on a graph of ~10⁴–10⁵ edges, well under a second natively. The planner depends only on this trait; tests use a synthetic grid graph.

## 5. Planner (`crates/plan`)

### 5.1 Viewpoints (ALGORITHM.md §3)

1. **Sample the course** every 20 m along viewable segments, recording distance-along-course.
2. **Densify the spectator network** near the course (`Graph::densify_near`): edges within the sighting radius are split into ≤20 m pieces so viewpoints can sit mid-block, not only at intersections.
3. **Spatial join**: for every graph node, the course samples within `sighting_radius` (r-tree). Nodes with none are discarded.
4. **Coverage arcs**: per course, contiguous runs of matched samples become `Arc { start_m, end_m, mean_view_m, finish }`. Multi-lap courses yield several arcs per node.
5. **Cluster**: viewpoints are ranked by arc width then view distance; one within `viewpoint_spacing_m` (default 120 m, about a minute's walk) of a kept viewpoint that sees no course the kept one misses is dropped — its windows differ by less than the safety buffer, so it cannot change the plan. Spots where another course comes into view survive. Search cost scales with viewpoints², so this spacing is the main performance dial.
6. **Windows**: for each racer on the arc's course, `Trajectory::window(arc.start, arc.end, safety_buffer)` gives `[entry_earliest − buffer, exit_latest]`; `expected` is the mid-arc expected time.
7. The spectator's start and end anchors become viewpoints with no sightings (reusing an existing viewpoint at the same node).

Output: `Vec<Viewpoint { node, point, arcs, sightings: Vec<Sighting { racer, window, expected, kind: Pass|Finish }> }>`.

### 5.2 Problem statement

Orienteering problem with time windows (OPTW) on the viewpoint set: choose an ordered sequence of viewpoints with dwell intervals, maximising the objective over windows fully covered by a dwell, subject to

- travel time between consecutive stops from `TravelTime::matrix`;
- dwell at each stop ≥ `min_stop_s`;
- begin at the start anchor (or anywhere, if none) no earlier than `earliest`; finish by `latest`; end at the end anchor no later than its deadline if given.

**Objective (ALGORITHM.md §5.1–5.3).** Two tiers in a configurable order, default `EnRoute` then `Finish`. Each tier's weight is a power of a *base* chosen so that one tier outweighs everything the tiers below it could accumulate for this field (base = the next power of ten above `racers × max_priority × Σ decay^k`), which keeps the scalar lexicographic at any field size. Within `EnRoute` each racer has a concave value curve: the *k*-th sighting is worth `priority × W_enroute × repeat_decay^(k−1)`, so `repeat_decay` is the breadth↔depth dial (0: only first sightings count; 1: repeats count fully). `Finish` pays `priority × W_finish` once per racer. A required region that no stop falls inside by its `latest` costs `base × W_top` — soft, so an unreachable region still yields a plan — and that penalty is part of the score the beam ranks by.

A window is *covered* by a dwell `[a, b]` at its viewpoint iff `a ≤ t_open` and `b ≥ t_close`. Because windows are fixed intervals, the dwell at a stop is determined by which windows it chooses to cover; the planner reasons in terms of windows, not free-form dwell times.

### 5.3 Algorithm: label-setting DP with beam

State (label): `(viewpoint, depart_time, score, seen: count per racer, finished: BitSet, regions_done: BitSet)`. Because value is marginal, what has already been seen is part of the state.

- Labels expand by moving to another viewpoint `c'` (arrival `= depart + travel`), then choosing a set of windows at `c'` to cover. Enumerating subsets is avoided: windows at a viewpoint are sorted by `t_open`; a dwell starting at `arrival` and covering windows `i..j` is valid iff `arrival ≤ t_open[i]` and all windows `i..j` are mutually compatible (`max t_open ≤ min t_close` needn't hold — the dwell just spans `[min t_open, max t_close]`). So the choice is "leave after window `j`", for each `j`, giving `O(windows)` successors per move.
- **Dominance:** label A dominates B at the same viewpoint iff `A.depart ≤ B.depart`, `A.score ≥ B.score`, `A.seen ≤ B.seen` elementwise, `A.finished ⊆ B.finished`, and `A.regions_done ⊇ B.regions_done` — A has banked at least as much and has at least as much left to gain. A window can only be covered once (`close ≤ depart` now, `open ≥ arrive ≥ depart` later), so nothing else about history matters. Dominated labels are discarded on arrival and evicted when a new label beats them.
- **Beam:** at most `BEAM` (default 64) labels per viewpoint, ranked by penalised score (unmet regions charged), always keeping the earliest-departing label (it has the most future). Known weakness: ranking by banked score is future-blind — a prefix that has already seen everyone can crowd out the one label with seven racers still ahead. The planned fix is ranking by `score + optimistic_remaining` (per-racer sightings still coverable after `t`), which also enables *bounded* dominance (a label that has seen more may dominate if its lead exceeds what the other could still catch up) — today dominance only ever removes exact-history duplicates.
- **Memory:** every live label's descendants keep it addressable, so dead labels stay in the arena with their bitsets dropped. The arena grows with labels *considered*, not kept; large events (hundreds of viewpoints, tens of racers) need the bound above before the beam is the only thing limiting the search.
- **Presence-only stops** are generated only where they tick off a required region; everywhere else a stop that sees nothing is never better than going direct.
- **Anchors and the day window:** labels that cannot reach the end anchor by its deadline, or that depart after `latest`, are pruned. Without a start anchor every viewpoint seeds a root at `earliest` and the planner chooses.
- **Required regions** are tracked as bits and penalised at the end rather than enforced, per ALGORITHM.md §2.6.
The alternative in ALGORITHM.md §5.4–5.6 (greedy insertion with whole-itinerary marginal scoring, then 2-opt local search) handles the same objective heuristically and is the benchmark to compare against once real event data exists.

Complexity is bounded by `BEAM × viewpoints × windows_per_viewpoint`; tunable from the UI ("fast / balanced / thorough").

The literature's standard for this exact variant (MC-TOP-MTW) is greedy insertion + iterated local search (Souffriau et al. 2013, see RESEARCH.md §1). M1.7 benchmarks the DP against an ILS implementation on the KU Leuven TOPTW instances; if ILS matches quality at lower cost, it replaces the DP behind the same `Planner` trait.

### 5.4 Extension points

The objective lives in `core::Objective` (tiers + decay) and the marginal-gain function in the planner; new tiers ("see X at least k times", groups) add a tier variant and, if they need history, a field in the label and a clause in `dominates`.

### 5.5 Output

`Itinerary { stops: Vec<Stop { location, arrive, depart, seen: Vec<SightingReport> }>, legs: Vec<Leg { path, seconds }>, unseen: Vec<RacerId>, unmet_regions: Vec<usize>, score }`.

## 6. Web shell (`web/`)

Plain ES-module JavaScript, no framework, Vite for dev server and bundling only.

- **Look:** minimal. One light and one dark palette defined as CSS custom properties on `:root` and `[data-theme=dark]`, following `prefers-color-scheme` with a manual toggle. System font stack, no icon library, no component framework. The map is the interface; controls live in a single collapsible side panel.
- **Map:** MapLibre GL JS with a free vector tile style (default OpenFreeMap, self-host-able Protomaps as the fallback; see RESEARCH.md §2d). Light and dark map styles follow the theme. Drawing via a small custom controller (click to add, drag to move, split/merge handles) — drawing plugins are evaluated in RESEARCH.md; the custom path is the fallback.
- **State:** a single `event` object mirroring the Rust model, mutated through a handful of reducer-style functions; every mutation re-renders the affected layer and debounces auto-save to `localStorage`.
- **GPX:** parsed in Rust (`gpx` crate) via the WASM facade to avoid two parsers.
- **OSM data:** pre-baked extract from the save file if present; otherwise bbox computed from the event, query built per travel mode, response cached in IndexedDB keyed by `(bbox, mode, query-version)` and offered for export.
- **Worker protocol:** `{type: "plan", event, osm, options}` → progress messages → `{type: "result", itinerary}` or `{type: "error", ...}`. The worker owns the WASM instance; the graph is built once per OSM payload and reused across plans.
- **Share URL:** event JSON → deflate → base64url in the fragment; refuse above ~8 KB with a prompt to download instead.

## 7. Decisions

| Decision | Choice | Alternatives considered | Why |
|---|---|---|---|
| Engine language | Rust → WASM | Plain JS, Go/WASM, Elm, ClojureScript | Typed, fast, testable natively; reusable server-side later; user preference against TypeScript. |
| UI language | Plain JS | Rust UI frameworks (Leptos/Yew), TS | MapLibre interop is simplest from JS; UI is small. |
| Routing | Hand-built graph from Overpass | Valhalla/OSRM/GraphHopper in WASM | Bboxes are tiny; measured 34 ms per Dijkstra on all of Manhattan (RESEARCH.md §2c). No CH, no external engine. |
| OSM source | Pre-baked extract primary, live Overpass fallback | Live-only | Overpass allows ~2 slots/IP; race-morning crowds would be throttled. |
| WASM threads | None | wasm threads + SharedArrayBuffer | Requires COEP headers that break third-party tiles and static hosts; not needed at measured sizes. |
| Allocator / crates | Default allocator; `geo ≥ 0.33`, `rstar`, `gpx`; own projection | `wee_alloc`, `proj` | `wee_alloc` unmaintained (RUSTSEC-2022-0054); `proj` does not build for wasm32. |
| WASM boundary | JSON strings, A/B `serde-wasm-bindgen` in M1.8 | `serde-wasm-bindgen` by default | Likely slower for Overpass-shaped payloads; measure, don't assume. |
| Open areas | Straight-line edges within polygons | Grid over polygon; ignore | Visibility edges are exact for convex-ish parks and cheap; grid adds nodes and fuzz. |
| Windows | Closed-form per point | 15 s time-stepping | Exact, simpler, and finds non-simultaneous multi-sightings. |
| Planner | Label-setting DP + beam, greedy seed | Greedy + local search; ILP | Near-exact on typical sizes, degrades gracefully, objective pluggable. |
| Racer pace | Piecewise intervals over distance | Positional per-segment paces | Course and racer only meet through distance; segments seed the profile, users subdivide freely (ALGORITHM.md §2.2). |
| Viewpoints | Spectator-network positions with coverage arcs, clustered | Course samples snapped to nodes | Proximity, not intersection; mid-block spots; one viewpoint per broad area (ALGORITHM.md §3). |
| Objective | Lexicographic tiers + diminishing repeats + soft regions | Flat weights + hard required start/finish | Breadth vs depth is a dial; unreachable wishes still yield a plan (ALGORITHM.md §5). |
| Sharing | JSON file + fragment URL | Backend | No server by design. |

## 8. Testing

- `core`: projection round-trips, polyline length/nearest-point, window maths against hand-computed tables, validation errors.
- `routing`: parse a small checked-in Overpass fixture; assert node/edge counts, oneway handling, park shortcut edges present only when the chord is inside; Dijkstra against a grid with known answers.
- `plan`: synthetic grid `TravelTime`; scenarios with known optimal itineraries (single racer/out-and-back, two courses crossing, required finish unreachable → reported); dominance and beam produce the same answer as exhaustive search on tiny cases (property test).
- `wasm`: native unit tests only; the built module is exercised in a real browser by the web worker test below, so no separate `wasm-bindgen-test` harness.
- `web`: vitest in browser mode (headless Chromium via Playwright) for the worker protocol, plus end-to-end flows (draw course, add racer, plan, see result) against the built site.

## 9. Open questions

- Whether to ship a drawing plugin (terra-draw) or the custom controller — decide in M2.1.
- Beam ranking with an optimistic bound, and DP vs ILS — decide empirically with benchmarks on real events.
- Format of the pre-baked extract: raw Overpass JSON (simple, large) vs a compact serialized graph (small, versioned) — decide in M1.8 once sizes are measured.

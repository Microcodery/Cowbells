# birdeye

Spectator planning for races (running, cycling, triathlon, and similar).

Given the course route(s) and each racer's estimated pace, birdeye computes
where a spectator should stand — and when — to see as many of the racers they
care about as possible, moving between viewpoints on real roads and paths.

Runs entirely in the browser as a static page: no account, no backend.

## v1 at a glance

- **Courses:** draw on the map or import GPX; multiple courses per event, each
  with a start time; split into segments with a mode (run/bike/swim) and a
  viewable flag.
- **Racers:** any number; each on one course with a start offset, a pace
  profile over distance (with ±uncertainty per interval), and a priority.
- **Spectator:** optional start point, day window, optional end point and
  deadline, must-visit areas, walk/bike/drive; tunable sighting radius,
  safety buffer, minimum stop, and a breadth-vs-depth dial.
- **Routing:** OpenStreetMap roads and paths fetched on demand; never crosses
  water or buildings; straight lines allowed through parks and open areas.
- **Planning:** viewpoints are spots on the spectator network within sight of
  a stretch of course; each racer's visibility window there follows from their
  pace profile. An orienteering-with-time-windows solver picks the itinerary
  that best serves the priority tiers (everyone once, everyone's finish, extras).
- **Results:** numbered stops on the map with arrive/leave times and who you'll
  see; unseen racers and unreachable areas called out.
- **Files:** save/load the whole event as a `.bird` file; export the
  spectator's itinerary as GPX (a track plus a waypoint per stop).
- **Examples:** two sample `.bird` events in the header dropdown — a downtown
  loop with two racers, and a three-distance event (short/medium/long sharing
  start and finish) with four racers.

Engine in Rust compiled to WebAssembly; map UI in plain JavaScript with
MapLibre GL.

## Future plans

Racer groups and coverage rules ("see everyone once"), pace curves, live
re-planning from tracking feeds, multi-mode spectator trips, transit, organizer
mode, line-of-sight, elevation. See [afx/SPEC.md](afx/SPEC.md).

## Documents

- [afx/ALGORITHM.md](afx/ALGORITHM.md) — algorithm and data model
- [afx/SPEC.md](afx/SPEC.md) — product specification
- [afx/EDD.md](afx/EDD.md) — engineering design
- [afx/PLAN.md](afx/PLAN.md) — implementation plan
- [afx/RESEARCH.md](afx/RESEARCH.md) — prior art and stack research

## Development

Requires Rust stable with the `wasm32-unknown-unknown` target, `wasm-pack`,
and Node 22. The `Makefile` and `justfile` define the same targets; use
whichever you have.

    make setup   # one-time: install web deps and a headless browser
    make test    # lint, wasm build, cargo test, web tests
    make build   # release wasm + vite build into web/dist
    make serve   # build, then serve web/dist locally
    make dev     # wasm dev build + vite dev server with hot reload

## Status

Working prototype. Start from an example, draw courses, or import GPX; then
split segments, add racers with pace profiles, set the spectator's start,
fetch OpenStreetMap data for the area, and plan. Expect rough edges; see
`afx/PLAN.md` for what's next.

## License

[AGPL-3.0](LICENSE)

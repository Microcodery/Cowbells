# cowbells

Spectator planning for races (running, cycling, triathlon, and similar).

Given the course route(s) and each racer's estimated pace, cowbells computes
where a spectator should stand — and when — to see as many of the racers they
care about as possible, moving between viewpoints on real roads and paths.

Runs entirely in the browser as a static page: no account, no backend.

## v1 at a glance

- **Courses:** draw on the map or import GPX, KML/KMZ, TCX, FIT, or GeoJSON;
  multiple courses per event, each
  with a start time; split into segments with a mode (run/bike/swim) and a
  viewable flag.
- **Racers:** any number; each on one course with a start offset, a pace
  profile over distance (with ±uncertainty per interval), and a priority.
- **Spectator:** optional start point, day window, optional end point and
  deadline, must-visit areas, walk/bike/drive at your own pace; tunable
  sighting radius, safety buffer, minimum stop, viewpoint spacing, how much
  of each course's crowded start to skip (a mile by default), and a
  breadth-vs-depth dial. Distances and paces display in km or miles.
- **Map:** courses drawn with start/finish markers and direction arrows;
  stretches shared by several courses striped in their colours. After each
  plan the engine streams its progress to the map — viewpoints, clustering,
  then the search with the best plan so far lit up — paced to take at least
  three seconds so there is always something to watch.
- **Routing:** OpenStreetMap roads and paths fetched on demand; never crosses
  water or buildings; straight lines allowed through parks and open areas.
  Roads the race runs on are off limits to the spectator, who keeps to
  sidewalks, side streets, and paths and crosses the course only on cross
  streets.
- **Planning:** viewpoints are spots on the spectator network within sight of
  a stretch of course; each racer's visibility window there follows from their
  pace profile. An orienteering-with-time-windows solver picks the itinerary
  with the best priorities, strictly in order: everyone seen the way they
  prefer (per racer: the finish — the default — or once during the race,
  then the finish, or during always), then everyone's
  finish, then each preferred sighting, then each other sighting, then repeats
  (with diminishing returns). "Require every finish" makes a missed finish
  outweigh everything else.
- **Results:** numbered stops on the map with arrive/leave times and who you'll
  see; unseen racers and unreachable areas called out. Once a plan is shown,
  looser settings (moving faster, a shorter safety buffer, no minimum stop)
  are tried in the background and offered when they do clearly better.
- **Files:** save/load the whole event as a `.bird` file; export the
  spectator's itinerary as GPX (a track plus a waypoint per stop).
- **Examples:** sample `.bird` events in the header dropdown, map data
  included — a 5K, 10K, and half marathon lapping Denver's City Park with
  five racers; a 7.8 km zigzag through Uptown and City Park West that folds
  past itself at four corners, with six racers; and the Denver Colfax
  Marathon and Half Marathon together, from the official course files, with
  Cat running the half and Cat's Friend the full (this one fetches its map
  data when first planned; the others bundle theirs). Each is
  also a regression test (`crates/wasm/tests/examples.rs`) pinning the levels
  its plan must reach.

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

## Deployments

`main` is published at [cowbells.app](https://cowbells.app) and `dev`, the
tester channel, at [cowbells.app/dev](https://cowbells.app/dev). A push to
either branch rebuilds both. They share an origin, so a saved event carries
between them: reset the event if the two disagree about its shape.

## Development

Requires Rust ≥ 1.85 with the `wasm32-unknown-unknown` standard library,
Node 22, and `make` or `just` (both define the same targets). With `rustup`,
`setup` adds the wasm target itself; with a distro toolchain install its
wasm32 package (Arch `rust-wasm`, Debian/Ubuntu `libstd-rust-dev-wasm32`,
Fedora `rust-std-static-wasm32-unknown-unknown`). `setup` also installs
`wasm-pack` (unless your distro's package is present), web dependencies, and
a headless browser for tests.

    make setup   # one-time: wasm target, wasm-pack, web deps, headless browser
    make test    # lint, wasm build, cargo test, web tests
    make build   # release wasm + vite build into web/dist
    make serve   # serve the last build in web/dist locally
    make dev     # vite dev server with hot reload (run `make wasm` after Rust changes)

## Status

Working prototype. Start from an example (map data included), draw courses,
or import GPX; then split segments, add racers with pace profiles, set the
spectator's start, fetch OpenStreetMap data for the area, and plan. The public
Overpass servers can be slow or return 504 under load; saved `.bird` files keep
the fetched data so a reload never needs them. Expect rough edges; see
`afx/PLAN.md` for what's next.

## License

[Business Source License 1.1](LICENSE): free to use and self-host, but not to resell
as a hosted service; each version converts to Apache 2.0 on its change date.

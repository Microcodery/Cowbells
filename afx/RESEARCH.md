# birdseye — Prior Art, Stack Validation, and Risk Research

*Compiled 2026-08-22. Every non-obvious claim carries a URL. Claims that could not be
verified from a primary source are marked **[unverified]**. Numbers I measured myself on
this machine are marked **[measured]** and the method is in [Appendix A](#appendix-a--methodology-for-measured-numbers).*

---

## Executive summary

1. **There is no prior art close enough to matter.** Live race-tracking apps (RaceJoy,
   Racemap, RTRT.me) track runners and never plan the spectator's movement. Official race
   spectator guides are hand-curated static advice — the London Marathon's is literally a
   PDF-and-prose page. The one genuine near-miss, [RunDida's Spectator Planner](https://rundida.com/tools/spectator-planner/),
   *validates* a user-chosen set of 1–5 stops against hardcoded travel-speed formulas; it
   never searches the space of possible stop combinations, has no real routing, and only
   supports six named marathons. birdseye is not duplicating anything.
2. **The academic framing is solid and the exact application is novel.** birdseye is an
   instance of the **Multi-Constraint Team Orienteering Problem with Multiple Time Windows
   (MC-TOP-MTW)** — a node (viewing spot) carries *several* time windows, one per racer
   passing it. That variant has a published, fast, greedy-insertion + ILS/GRASP solver that
   hits ~5% of best-known in **1.5 seconds** ([Souffriau et al., *Transportation Science* 47(1), 2013](https://doi.org/10.1287/trsc.1110.0377)).
   No paper applies OP/OPTW to race spectators.
3. **Rust→WASM is a sound but *optional* choice for the routing layer, and the ecosystem
   just got healthier.** wasm-bindgen and wasm-pack moved out of the archived `rustwasm`
   org in 2025 and wasm-pack has shipped two releases since ([blog.rust-lang.org](https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org)).
   But **[measured]**: a full one-to-all Dijkstra over the entire Manhattan pedestrian +
   road graph (97,006 nodes / 294,972 directed edges) takes **34 ms in plain JavaScript**,
   and building that graph from raw Overpass JSON takes **260 ms in plain JavaScript**.
   Routing is not the reason to reach for WASM. The optimizer's inner loop and the geometry
   code are.
4. **Overpass works directly from a static site — verified, not inferred.** `overpass-api.de`
   returns `Access-Control-Allow-Origin: *` **[measured]**, and Overpass Turbo has been a
   static client-side app for a decade. A ~10 km × 7.6 km Manhattan query for all
   `highway=*` + park polygons returned **3.9 MB gzipped / 26 MB raw in 3.6 s** **[measured]**.
   The binding constraint is not size, it is the **2-slot-per-IP rate limit** **[measured]**
   and the "<10,000 queries/day, <1 GB/day" etiquette ([commons.html](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)).
5. **Top risks, in order:** (a) Overpass availability/rate-limiting on race morning when
   many spectators open the app for the same event; (b) tile-hosting sustainability
   (OpenFreeMap is one person's donation-funded project — [openfreemap.org](https://openfreemap.org/));
   (c) modelling risk — pace uncertainty compounds, and Riegel-style predictions are off by
   5–10 min at marathon distance, which is wider than most viewing windows;
   (d) build-your-own-everything scope creep in the routing/optimizer layer.

**Headline recommendations:** ship pre-baked per-course data as the primary path with live
Overpass as the fallback; use MapLibre GL JS 6.x + Terra Draw + self-hosted PMTiles;
implement the optimizer as greedy insertion + ILS with the O(1) Wait/MaxShift feasibility
trick; keep the routing graph single-threaded (skip WASM threads entirely, which also makes
the COOP/COEP question moot); deploy to Cloudflare Pages or Netlify rather than GitHub Pages.

---

## 1. Prior art

### 1.1 Commercial and consumer tools

**Live tracking apps — tracking and alerts only, zero itinerary planning.**

| Tool | What it does | Plans the spectator's route? |
|---|---|---|
| [RaceJoy](https://info.runsignup.com/products/raceday/racejoy/) (RunSignup) | GPS/RFID live tracking of participants, "NearMe" proximity alerts, mile-marker audio updates with pace and projected finish, Send-a-Cheer | No |
| [Racemap](https://go.racemap.com/) | Live GPS map, trails, leaderboard; interpolates position between timing reads | No |
| [RTRT.me](https://rtrt.me/) | White-label real-time tracking behind many major events (incl. Ironman Tracker); live pace/place/ETA, track multiple participants at once | No — "crew on one screen" means many *runners*, one spectator position |
| [ChronoTrack](https://support.chronotrack.com/hc/en-us/articles/208381533-Spectators) | Last-scored-checkpoint map, SMS alerts | No |
| [Strava Beacon](https://support.strava.com/hc/en-us/articles/224357527-Strava-Beacon) | Live location share of one athlete to ≤3 contacts | No |
| Garmin LiveTrack + Spectator Messaging | Live location share + messages to the athlete's watch | No |

All of these also require **race-organizer integration** (chip timing feeds or the runner
carrying a phone). birdseye requires neither — it works from a course and a pace estimate,
which is exactly the case these tools cannot serve (small races, unofficial events,
training runs, races where your runner won't carry a phone).

**Official race spectator guides — hand-curated, no computation.** I fetched the
[TCS London Marathon spectator guide](https://www.londonmarathonevents.co.uk/london-marathon/london-marathon-spectator-guide)
directly: it is a "six busiest areas" table with quieter alternatives, prose walking-route
suggestions, transport tips, and lettered finish-line meeting points. There is no tool that
computes standing locations from runner timing. The Boston [B.A.A. spectator page](https://www.baa.org/races/boston-marathon/info-for-spectators/)
is static PDFs plus MBTA notes.

The **NYRR (New York City Marathon) app** is the most feature-rich official offering; trade
press describes it letting users "see when a tracked runner will get to a course spot, using
directions provided in-app" ([endurance.biz, 2025](https://endurance.biz/2025/industry-news/year-round-all-event-nyrr-app-developed-by-tcs-enhances-marathon-spectator-experience/)).
Whether it *optimizes* the set of spots or just gives ETA + directions for spots the user
picked is **[unverified]** — nyrr.org was not reachable during research. This is the single
item worth checking by hand before making any public "first of its kind" claim.

**The "see your runner twice" hack is folklore, not software.** Tower Bridge (~mile 12.8 and
~22.7), Shadwell (~13 and ~22), Canada Water, Isle of Dogs — documented in blog posts like
[jonevanscoaching.com](https://www.jonevanscoaching.com/post/our-london-marathon-spectator-guide-part-2-where-to-stand-to-see-your-runner)
and [marathonhandbook.com](https://marathonhandbook.com/how-to-watch-the-2026-london-marathon-a-complete-guide/).
This is precisely the plan birdseye would compute, and today it is produced entirely by hand.

**The closest thing that exists: [RunDida Spectator Planner](https://rundida.com/tools/spectator-planner/).**
Fetched and inspected directly. Inputs: pace or finish time, race start, distance, number of
spots (1–5), transport mode, priority, pacing model (even / positive / negative split), wave
delay. Outputs: arrival estimates at standard 5K timing mats and travel times between the
chosen spots, with conflict warnings when a relocation is infeasible.

Critically:
- The **user picks the spots**; the tool only validates that fixed choice. There is no search.
- Travel time uses fixed formulas — "3 minutes per kilometre walking, 2 minutes per metro
  station plus 5 minutes for platform access, or 1.5 minutes per kilometre cycling" plus a
  5-minute buffer. **No routing engine, no OSM.**
- Course-specific data exists only for Berlin, Boston, Chicago, London, New York, Tokyo.
- Single runner. No GPX import. Free, closed-source, no license stated.

**Ultra / crew planning.** [UltraPlanRun](https://ultraplan.run/) and
[ultraPacer](https://ultrapacer.com/) produce excellent *runner* pacing plans (altitude,
darkness, heat, fatigue-aware) with live-recalculating aid-station ETAs shareable with crew —
they solve birdseye's *prediction* half well, and none of its *routing/optimization* half.
Crew logistics remains DIY spreadsheets; see e.g. [WSER crew suggestions](https://www.wser.org/crew-suggestions/).

**Note:** [FindMyMarathon.com](https://findmymarathon.com/) has **no spectator feature** — it
is a runner-facing calendar/pace-band/course-comparison site. If you remembered one there,
it was probably RunDida.

**Cycling.** Tour de France spectating is served by human-curated commercial tour packages
(e.g. [Thomson Bike Tours spectator trips](https://spectator.thomsonbiketours.com/)) and by
[Tour Tracker](https://www.thetourtracker.com/applications) for remote viewing. No computed
in-person multi-stop planner found.

### 1.2 Open-source projects

A GitHub search API sweep over `marathon spectator`, `race spectator planner`, and
`spectator route optimizer` **[measured]** returned essentially nothing: the top hit is
[NUDelta/CrowdCheer](https://github.com/NUDelta/CrowdCheer) (1 star, last pushed 2018), and
everything else is 0-star course guides or abandoned scaffolds. `race+spectator+planner` and
`spectator+route+optimizer` returned **zero repositories**.

CrowdCheer is worth a mention as adjacent HCI work rather than a competitor — it is a
Northwestern Delta Lab research app about *crowdsourcing motivational support* (helping
spectators cheer for strangers in addition to their own runner), not about where to stand
([project page](https://www.leesha.io/crowdcheer.html), [Delta Lab](https://delta.northwestern.edu/publications/)).

**OPTW/TOPTW solver implementations** (the reusable optimizer core) are all small academic
projects, mostly Python or Java:

| Repo | License | Stars | Last push | Note |
|---|---|---|---|---|
| [mustelideos/optw_rl](https://github.com/mustelideos/optw_rl) | MIT | 25 | 2021-12 | PyTorch pointer-network + RL; needs a trained model |
| [gkobeaga/op-solver](https://github.com/gkobeaga/op-solver) | Apache-2.0 | 40 | 2025-04 | Best-maintained pure-OP repo, but exact mode needs proprietary CPLEX + Concorde |
| [Constantino/TOPTW](https://github.com/Constantino/TOPTW) | **none** | 9 | 2016-05 | Reference implementation of the Vansteenwegen 2009 ILS — **no LICENSE file, so all rights reserved** |
| [miladbarooni/TOPTW](https://github.com/miladbarooni/TOPTW) | MIT | 3 | 2026-01 | GA/SA/Tabu/GRASP/ACO/PSO over 34 benchmarks |
| [LucaAngioloni/optw](https://github.com/LucaAngioloni/optw) | MIT | 5 | 2021-07 | Greedy only; author reports 0.003–0.1 s on 10/50/100-node instances |
| [copa-uniandes/OPTW_Pulse](https://github.com/copa-uniandes/OPTW_Pulse) | none | 2 | 2019-02 | Java implementation of the exact Pulse algorithm |
| [alberto-santini/orienteering-alns](https://github.com/alberto-santini/orienteering-alns) | GPL-3.0 | 13 | 2023-02 | ALNS, but hard-depends on CPLEX + LKH |

Mature permissive VRP engines exist but approximate the OP objective rather than solve it:
[PyVRP](https://github.com/PyVRP/PyVRP) (MIT, 677 stars, actively developed **[measured]**)
explicitly supports "prize collecting / team orienteering" with time windows but is a
Python/C++ HGS core; [VROOM](https://github.com/VROOM-Project/vroom) (BSD-2) has an ordinal
job-priority drop mechanism, not reward maximization; OR-Tools has no native OP model and its
`AddDisjunction()` workaround is an approximation ([or-tools#1869](https://github.com/google/or-tools/issues/1869))
with a dependency footprint hostile to WASM.

**The most interesting single find** is [DENGYUFAN0/route-compass](https://github.com/DENGYUFAN0/route-compass)
(MIT, 1 star, pushed 2026-06-23 **[measured]**): *"In-browser optimizer for multi-day
sightseeing itineraries — solves the Team Orienteering Problem with Time Windows (TOPTW) with
greedy insertion + ILS and O(1) Wait–MaxShift feasibility."* Vanilla JS, zero dependencies,
runs entirely client-side in a Web Worker. It is not a competitor (tourism, not racing; no
course or pace model) but it is direct evidence that **the exact algorithmic bet birdseye is
making runs fine in a browser**.

No purpose-built Rust or WASM orienteering solver was found. birdseye's solver would be
written from the published algorithms, not ported.

### 1.3 Academic framing

**birdseye's problem is MC-TOP-MTW.** Candidate viewing spots are nodes with a score. Each
racer passing a spot creates *one time window* at that node, so a spot on a course crossing
with three racers has three windows and three separately-collectible rewards. Travel between
nodes is the OSM routing time. The spectator's day is the tour-length budget. If the user
wants several spectators splitting up, it becomes a team problem. This is exactly:

> Souffriau, W., Vansteenwegen, P., Vanden Berghe, G., Van Oudheusden, D. (2013).
> "The Multiconstraint Team Orienteering Problem with Multiple Time Windows."
> *Transportation Science* 47(1), 53–63. DOI: [10.1287/trsc.1110.0377](https://doi.org/10.1287/trsc.1110.0377)

whose abstract reports: *"an average run has a score gap of only 5.19% with known high
quality solutions, using 1.5 seconds of computational time"*, from a hybrid of iterated local
search and GRASP. That runtime is the single most important number in this whole document —
it says the optimizer fits comfortably inside a click-to-result interaction.

**Core surveys and foundational papers** (all verified against publisher/DOI pages):

- Vansteenwegen, P., Souffriau, W., Van Oudheusden, D. (2011). "The orienteering problem: A survey." *EJOR* 209(1), 1–10. DOI: [10.1016/j.ejor.2010.03.045](https://doi.org/10.1016/j.ejor.2010.03.045)
- Gunawan, A., Lau, H.C., Vansteenwegen, P. (2016). "Orienteering Problem: A survey of recent variants, solution approaches and applications." *EJOR* 255(2), 315–332. DOI: [10.1016/j.ejor.2016.04.059](https://doi.org/10.1016/j.ejor.2016.04.059). [Free author PDF](http://www.mysmu.edu/faculty/hclau/doc/EJOR%20-%20Orienteering%20Survey.pdf)
- Vansteenwegen, P., Souffriau, W., Vanden Berghe, G., Van Oudheusden, D. (2009). "Iterated local search for the team orienteering problem with time windows." *Computers & Operations Research* 36(12), 3281–3290. DOI: [10.1016/j.cor.2009.03.008](https://doi.org/10.1016/j.cor.2009.03.008)
- Gavalas, D., Konstantopoulos, C., Mastakas, K., Pantziou, G. (2014). "A survey on algorithmic approaches for solving tourist trip design problems." *Journal of Heuristics* 20(3), 291–328. DOI: [10.1007/s10732-014-9242-5](https://doi.org/10.1007/s10732-014-9242-5)

The **Tourist Trip Design Problem (TTDP)** literature is the closest existing application
framing: pick which POIs to visit, in what order, respecting opening hours and a time budget.
Swap "opening hours" for "the window when your runner passes" and it is the same problem.
Reading the TTDP survey is probably higher value per page than the general OP surveys.

**Explicit negative result:** no paper applies OP/OPTW/TOPTW to race or sporting-event
spectators. Neither the 2011 nor 2016 survey lists spectator planning among OP application
domains (they list tourism, athlete recruiting, home fuel delivery, search & rescue, UAV
routing, wildfire asset protection). Two hits that look relevant are false positives — a
["stadium spectators" metaheuristic](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10847446/)
and a ["marathon runner algorithm"](https://www.degruyterbrill.com/document/doi/10.1515/mt-2023-0091/html)
both borrow the words as naming metaphors. **birdseye's application domain appears genuinely
novel in the OR literature.**

### 1.4 Solution approaches that are practical client-side

Target: ~50–500 candidate viewing spots, 1–10 racers as reward sources, answer in 1–5 s.

| Approach | Reference | Fit |
|---|---|---|
| **Greedy insertion + Iterated Local Search** | Vansteenwegen et al. 2009 (above) | **Best fit — start here.** The paper reports an average gap of 1.8% to best-known with computation time reduced by "a factor of several hundreds" vs. prior algorithms, and "even when the computation time is limited to 1 s, high quality results are obtained" ([KU Leuven preprint](https://lirias.kuleuven.be/retrieve/91f75023-e620-4f54-90c2-5ada4495c62c/)). No dependencies, ~500 lines. |
| **ILS + GRASP hybrid** | Souffriau et al. 2013 (above) | The MC-TOP-MTW-native version; 5.19% gap in 1.5 s. Natural v2 once multiple windows per node are in play. |
| **Simulated annealing** | Lin & Yu (2012), *EJOR* — exact volume/pages **[unverified]** | Simple and portable; comparable class of quality. Reasonable A/B against ILS. |
| **Ant colony optimization** | Montemanni & Gambardella (2009), *Foundations of Computing and Decision Sciences* 34(4), 287–306 | Works, but consistently the slowest of these in the literature. Poor match for a hard 1–5 s budget. |
| **GRASP with path relinking** | Campos, Martí, Sánchez-Oro, Duarte (2014), *JORS* 65(12), 1800–1813. DOI: [10.1057/jors.2013.156](https://doi.org/10.1057/jors.2013.156) | Good quality, more machinery than ILS. |
| **Exact label-setting DP with dominance** | Righini & Salani (2009), "Decremental state space relaxation…", *C&OR* 36(4), 1191–1203. DOI: [10.1016/j.cor.2008.01.003](https://doi.org/10.1016/j.cor.2008.01.003) | Bi-directional bounded DP with decremental state-space relaxation. Exact but combinatorially explosive — realistic only at the small end (tens of nodes, one tour). Worth having as an "exact mode" toggle for small inputs. |
| **Pulse framework (exact)** | Duque, Lozano, Medaglia (2014), "Solving the OPTW via the pulse framework", *C&OR* 54, 168–176. DOI: [10.1016/j.cor.2014.08.019](https://doi.org/10.1016/j.cor.2014.08.019) | Reported up to 266× speedup over the prior state of the art and optimal solutions on instances up to **562 nodes** — right at birdseye's upper size bound. The strongest candidate if you want a provably-optimal mode. |
| Beam search over a time-expanded graph | No single canonical OPTW paper found under that name | Don't lean on this framing publicly; it's underspecified in the literature. |

**The implementation detail that matters most** is the O(1) feasibility test from
Vansteenwegen et al. 2009: maintain per-visit `Wait` (idle time before service) and
`MaxShift` (how much this visit can be delayed without breaking anything downstream), so that
testing an insertion is constant-time instead of a forward pass. The shake step removes
`NumberToRemove` consecutive visits starting at `PositionStartRemove`, then pulls later
visits earlier to squeeze out waiting. `route-compass` (§1.2) implements exactly this in JS.

**Benchmarks** are hosted at [KU Leuven, Division MIM](https://www.mech.kuleuven.be/en/mim/op):
144 TOPTW instances derived from Solomon (1987) VRPTW and Cordeau et al. (1997) multi-depot
VRPTW instances — the [Righini & Salani sets](https://www.mech.kuleuven.be/en/mim/op/instances/righiniTOPTW1)
(`c/r/rc-100-50`, `c/r/rc-100-100`, `pr01–10`) and the
[Montemanni & Gambardella sets](https://www.mech.kuleuven.be/en/mim/op/instances/MontemanniTOPTW1)
(`pr11–20`). Best-known results tracked at [OPLib, SMU](http://unicen.smu.edu.sg/oplib-orienteering-problem-library).
**Use these as birdseye's optimizer test fixtures** — they give a hard, external correctness
and quality signal that a hand-rolled solver otherwise lacks.

### 1.5 Duplication and licensing assessment

**Duplication risk: low.** No tool combines arbitrary/GPX courses + multiple racers with
independent paces and start offsets + real OSM routing + an actual optimization over which
spots to stand at. RunDida is the only thing in the neighbourhood and it is a formula
calculator over six hardcoded marathons. There is nothing to be accused of cloning.

**Licensing constraints for AGPL-3.0:**

- The classic academic reference codebases are the real trap. `Constantino/TOPTW` — the
  implementation most TOPTW work traces to — **has no LICENSE file**, which means all rights
  reserved. You can reimplement the *published algorithm* freely (algorithms aren't
  copyrightable and these are all long-published, unpatented academic metaheuristics), but
  you cannot copy the code. Read the paper, not the repo.
- MIT/BSD/Apache-2.0 dependencies (MapLibre BSD-3, Terra Draw MIT, `geo` MIT-or-Apache-2.0,
  `rstar` Apache-2.0, `@tmcw/togeojson` BSD-2, PMTiles BSD-3 **[measured, via npm/GitHub API]**)
  are all inbound-compatible with AGPL-3.0.
- `alberto-santini/orienteering-alns` is GPL-3.0 (compatible in spirit) but depends on
  proprietary CPLEX — not usable.
- `Tristramg/osm4routing` is **GPL-3.0 and archived**; the live successor
  [rust-transit/osm4routing2](https://github.com/rust-transit/osm4routing2) is **MIT** and
  actively maintained (last push 2026-03) **[measured]** — use the successor, and note the
  license change.
- **AGPL §13 probably does not bite for a purely static app**, but the reasoning is worth
  writing down. §13's network clause targets running a modified version on a server that
  users interact with remotely. birdseye's engine runs on the user's own machine; serving the
  JS/WASM is straightforward *conveying* under §5/§6, so the ordinary source-availability
  obligation applies and is satisfied by the public repo. That said, the FSF has never given
  a crisp answer for client-side JS ([The JavaScript Trap](https://www.gnu.org/philosophy/javascript-trap.html)
  is the closest thing, and it's about a different concern) — this remains **[unverified]**
  as settled law. Practical mitigation: put a visible "Source" link in the UI footer and
  ship the exact corresponding sources at a stable URL. That satisfies both readings at
  zero cost.
- **Patents:** a search over race-spectator patents turned up the Huston/Coleman
  ["GPS based spectator and participant sport system"](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/7855638)
  family, which covers rendering a *view of the contest from the spectator's perspective*
  (AR/VR-flavoured), not itinerary optimization. Nothing found that reads on birdseye. This is
  not a clearance opinion.
- **Data licensing is the one you must actually honour:** OSM data is **ODbL**. Overpass
  results, PMTiles basemaps, and any derived routing graph you redistribute all carry it.
  Attribute "© OpenStreetMap contributors" in the UI, and if you ship pre-baked graph files
  as a product, that's a Derivative Database under ODbL — publish it under ODbL too.

---

## 2. Stack validation

### 2a. Rust → WASM tooling

**Governance changed and it's good news.** The Rust and WebAssembly Working Group was
archived and the `rustwasm` GitHub org was sunset in September 2025; wasm-bindgen was
transferred to a dedicated [`wasm-bindgen` org](https://github.com/wasm-bindgen/wasm-bindgen)
with new maintainers ([official announcement, 2025-07-21](https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org)).

**[measured]** current state via the GitHub/docs.rs APIs on 2026-08-22:

| Tool | Version / last release | License | Verdict |
|---|---|---|---|
| `wasm-bindgen` | **0.2.127** (2026-08-08); 0.2.125/0.2.126 in June 2026 | Apache-2.0 (dual MIT) | Healthy, frequent releases. Use it. |
| `wasm-pack` | **v0.15.0** (2026-05-15), v0.14.0 (2026-01-20) — after a 15-month gap since v0.13.1 (2024-10-29) | Apache-2.0 | **Revived.** The "wasm-pack is abandoned" concern was true through 2025 and is no longer true. |
| `trunk` | stable 0.21.14 (2025-05); v0.22.0-beta.2 (2026-07) | Apache-2.0 | Fine tool, **wrong tool here** — Trunk owns `index.html` as a build input and is built around compiling a *binary* crate with a `main`, i.e. Yew/Leptos/Dioxus ([asset docs](https://trunk-rs.github.io/trunk/guide/assets/index.html)). birdseye's engine is a `cdylib` with no `main`, driven from a JS shell. It's not incapable of that shape, but it buys nothing over `cargo build` + `wasm-bindgen`, and it would fight you over CSS/sprite/glyph pipelines that belong on the JS side. Skip it. |
| `wee_alloc` | 0.4.5, **[RUSTSEC-2022-0054: unmaintained](https://github.com/rustsec/advisory-db/blob/main/crates/wee_alloc/RUSTSEC-2022-0054.md)** — "open issues including memory leaks and may not be suitable for production use… It may be best to switch to the default Rust standard allocator on wasm32 targets" | — | **Do not use.** Your instinct was right. |

**Consider skipping wasm-pack anyway.** You are not publishing to npm, so the plain pipeline
is enough and removes a moving part:

```
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web target/wasm32-unknown-unknown/release/birdseye.wasm --out-dir web/wasm
wasm-opt -Oz -o web/wasm/birdseye_bg.wasm web/wasm/birdseye_bg.wasm
```

Install the CLI with `cargo binstall wasm-bindgen-cli` (prebuilt). See
["Life after wasm-pack"](https://nickb.dev/blog/life-after-wasm-pack-an-opinionated-deconstruction/)
(2025). **Pin `wasm-bindgen` (lib) and `wasm-bindgen-cli` to the exact same version** —
version skew between them is the single most common build failure in this stack.

**Build size and profile.** Suggested `[profile.release]`:

```toml
opt-level = "s"       # measure "z" too, but "z" disables loop vectorization,
                      # which will cost more in the Dijkstra/ILS hot loops than it saves
lto = "fat"
codegen-units = 1
panic = "abort"
strip = "debuginfo"
```

Then `wasm-opt` from Binaryen — use the **standalone binary** (current `version_132`,
2026-08), not the `wasm-opt` *crate*, which has been dormant since 2024-03 and is ~16
Binaryen versions behind. That skew is a live hazard: Rust 1.87 / LLVM 20 enabled
`bulk-memory` by default and older `wasm-opt` rejects the resulting binaries
([rust-lang/rust#141080](https://github.com/rust-lang/rust/issues/141080)). Note wasm-pack
bundles v130, another reason to drive `wasm-opt` yourself.

`twiggy` still works for size attribution but **its repo is now archived** (last release
0.8.0, 2025-06) — use it, don't depend on it; `wasm-tools objdump` is the maintained
fallback. `wasm-tools` (Bytecode Alliance, 1.257.1, 2026-08) is also worth having in CI for
`validate`/`strip`; its component-model half is irrelevant to a hand-written JS shell.

For a project of birdseye's shape — geometry, a graph, a heuristic solver, no async runtime —
**150–500 KB raw / 60–200 KB gzipped is a reasonable estimate** (extrapolated from real
shipping modules: `lz4-wasm` 25 KB→11 KB gz; `@dimforge/rapier2d` 1.49 MB→554 KB gz; this is
an engineering estimate, **[unverified]** for birdseye specifically). `serde_json` is
typically the single biggest line item at 100 KB+, which is worth weighing in §2f's
parse-where decision.

**Targeting and loading.** Use `--target web`, which emits a self-contained ES module whose
default export is an async `init()` needing no bundler post-processing
([deployment docs](https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html)).
Two documented constraints on that target: it **cannot use NPM dependencies**, and **no
polyfills are provided**, so check your minimum browser versions. Two practical gotchas:
the `.wasm` is fetched relative to the glue module's URL unless you pass an explicit URL to
`init()`, and the server must send `Content-Type: application/wasm` or
`WebAssembly.instantiateStreaming` throws and silently degrades to the slower buffer path.

**Threads — my strong recommendation is: don't.** WASM threads need `SharedArrayBuffer`,
which needs cross-origin isolation via `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp` ([web.dev](https://web.dev/articles/coop-coep)).
Three consequences:
1. **GitHub Pages cannot set custom headers.** A GitHub staff reply in
   [community discussion #13309](https://github.com/orgs/community/discussions/13309) —
   "This is a scenario we would support with custom headers. No ETA at the moment" — is still
   the state of play. Cloudflare Pages supports a `_headers` file
   ([docs](https://developers.cloudflare.com/pages/configuration/headers/), max 100 rules,
   2,000 chars per line, applies to static assets — which is all birdseye has) and Netlify
   supports `_headers`/`netlify.toml` with COOP/COEP shown explicitly in its
   [docs](https://docs.netlify.com/routing/headers/).
2. The [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) workaround (MIT,
   v0.1.7 **[measured]**) fakes the headers from a service worker, but costs a full page
   reload on first visit.
3. **`COEP: require-corp` breaks third-party subresource loading** unless those origins send
   `Cross-Origin-Resource-Policy: cross-origin`. That directly threatens your map tiles. This
   is the killer argument: enabling threads risks breaking the basemap.

There is also a toolchain cost that isn't obvious: threads need `atomics` + `bulk-memory`
target features, which need a **nightly toolchain and `-Zbuild-std`** (stable Rust ships no
atomics-enabled `std`), and since wasm-bindgen 0.2.122 threaded builds additionally require
`-Clink-arg=--export=__heap_base` on recent nightlies — documented only in the changelog.
`wasm-bindgen-rayon` (1.3.0 **[measured]**, last release 2024-12) and `wasm_thread` (last
release 2024-10) are both stale, and neither removes any of the above.
[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) is itself unmaintained
since 2023-12 with documented Firefox flakiness. WASI threads
(`wasm32-wasip1-threads`) target Wasmtime/WAMR, not browsers — irrelevant.

Given the **[measured]** 34 ms full-graph Dijkstra (§2c), there is no performance case for
threads anyway. If you later need parallelism, the clean answer is **one Web Worker running
a single-threaded WASM instance** (`postMessage` with transferable `ArrayBuffer`s) — no
`SharedArrayBuffer`, no COOP/COEP, works on every static host. If you eventually need real
parallelism, shard the ILS search across several independent workers; orienteering search is
embarrassingly parallel and doesn't want shared memory.

**Crossing the JS↔WASM boundary — and a correction to conventional wisdom.**
`serde-wasm-bindgen` (0.6.5, MIT **[measured]**) is the successor to the removed
`JsValue::from_serde`/`into_serde` and describes itself as "nowadays… the officially
preferred approach" ([repo](https://github.com/RReverser/serde-wasm-bindgen)). **But its
"faster than JSON" claim does not hold for birdseye's data shape.** wasm-bindgen's own guide
says JSON "can be anywhere from 2x to 0.2x the speed" and tells you to profile. On
string-heavy, deeply-nested data — which is exactly what an Overpass response with `tags`
maps is — measurements in
[wasm-bindgen PR #3031](https://github.com/wasm-bindgen/wasm-bindgen/pull/3031) found JSON
round-tripping via `serde_json` beat `serde-wasm-bindgen` by roughly **2.4× on average and
3.7× at the tail**, because `serde-wasm-bindgen` must materialize real JS objects
field-by-field across the boundary while JSON does one bulk copy plus one native parse.

So, split by direction:
- **Overpass ingest → into WASM:** pass the raw response bytes (`ArrayBuffer` →
  `Uint8Array`) and parse with `serde_json::from_slice` in Rust. Do *not* `JSON.parse` in JS
  and then re-marshal the object graph — that parses twice and walks every field across the
  boundary. (Counterpoint worth weighing: **[measured]** V8 parses the 26 MB Manhattan
  response in 171 ms, and shipping `serde_json` costs ~100 KB of binary. Both routes are
  viable; **profile it on a real response before committing**.)
- **Geometry out of WASM:** flat `Float64Array`/`Float32Array`, never JSON, never serde.
- **Small structured payloads** (config in, optimizer summary/errors out):
  `serde-wasm-bindgen` is exactly right.

**The zero-copy gotcha, stated precisely.** `js_sys::Float64Array::view()` gives a genuine
zero-copy window into WASM linear memory, but the
[docs](https://docs.rs/js-sys/latest/js_sys/struct.Float64Array.html) warn: *"Views into
WebAssembly memory are only valid so long as the backing buffer isn't resized."* When WASM
memory grows, the engine vends a new `ArrayBuffer` and **detaches** the old one — every
outstanding JS view silently becomes zero-length. This is a live, nondeterministic bug class
([wasm-bindgen#4395](https://github.com/wasm-bindgen/wasm-bindgen/issues/4395)) and it is
especially dangerous for a graph builder that allocates aggressively. **Default to returning
`Vec<T>`** (wasm-bindgen copies it into a fresh, non-aliased JS array — cheap and immune);
use raw views only in a genuinely hot render loop, re-acquiring `wasm.memory.buffer` every
frame and never caching it. Relatedly, `Vec<CustomStruct>` *parameters* get moved and freed
by wasm-bindgen, so calling twice with the same JS array throws
([writeup](https://www.rossng.eu/posts/2025-02-22-wasm-bindgen-vec-parameters/)). Keep the
boundary flat: primitives and typed arrays in and out, with an opaque `Engine` handle holding
all state on the Rust side.

### 2b. Rust geospatial crates

**[measured]** versions from docs.rs on 2026-08-22. All of these are pure Rust with no C
dependencies, which is what makes them WASM-safe.

| Crate | Version | License | Notes |
|---|---|---|---|
| [`geo`](https://docs.rs/geo/latest/geo/) | **0.33.1** | MIT OR Apache-2.0 | Has everything birdseye needs: `Simplify` (Douglas–Peucker) and `SimplifyVw`, `Densify`, `InterpolateLine`/`InterpolatePoint`, `LineLocatePoint`, `ClosestPoint` and `HaversineClosestPoint`, `BooleanOps` + `unary_union`, `Contains`/`Intersects`/`Relate` (DE-9IM), `ConvexHull`/`ConcaveHull`, `TriangulateEarcut`/`TriangulateDelaunay`, geodesic distance/area. **WASM is CI-verified**: `geo` gained a dedicated `wasm32-unknown-unknown` check job in January 2026 after the build was found broken and fixed ([PR #1492](https://github.com/georust/geo/pull/1492)) — which means **pre-0.32 `geo` was not reliably WASM-clean, so pin ≥0.33**. `proj` is only an optional feature; no C deps by default. |
| `geo-types` | 0.7.20 | MIT OR Apache-2.0 | The primitive types; you'll depend on it transitively. |
| [`rstar`](https://github.com/georust/rstar) | **0.13.0** | Apache-2.0 (dual MIT) | R*-tree. 555 stars, last push 2026-08-13 **[measured]**. Pure Rust (`heapless`, `num-traits`/`libm`, `smallvec`), transitively WASM-verified via `geo`'s CI. Use it for snapping points to the graph and for candidate-spot queries. **Version-skew warning:** released `geo` 0.33.1 pins `rstar ^0.12` while `geo` main has moved to 0.13 — don't add a direct `rstar 0.13` dependency alongside released `geo` 0.33.1 or you'll get two incompatible `rstar`s. |
| `petgraph` | 0.8.3 | MIT OR Apache-2.0 | Mature and well maintained, but **skip it for the routing graph.** Two concrete reasons: (1) `Graph` uses intrusive singly-linked adjacency lists, not CSR — ~8 bytes/node + 16 bytes/edge of pure overhead; (2) more importantly, **`petgraph::algo::dijkstra` returns only a `HashMap<NodeId, Cost>` with no predecessors, so you cannot reconstruct a path from it**, and `astar` hashes dense `u32` node IDs on every relaxation. birdseye needs custom search anyway (many-to-many with early termination, custom costs), which doesn't fit petgraph's closed signatures. `petgraph::csr::Csr` exists but maintainers flag it as panic-prone pending rework ([#724](https://github.com/petgraph/petgraph/issues/724)). Hand-roll ~100–300 lines instead. **[unverified]** as a benchmark — this is reasoning from verified struct definitions, not measurement. |
| [`gpx`](https://github.com/georust/gpx) | **0.10.0** (released 2023-12) | MIT | georust-maintained, 122 stars. **Correction to a common assumption: it uses `xml-rs`, not `quick-xml`.** Semi-dormant — ~40 unreleased commits on master, PRs stalled ~9 months. Dependency tree is pure Rust so WASM should work, but there's no wasm CI job — **[unverified]**, prove it with an early `wasm-bindgen-test`. **Consider parsing GPX in JS instead** with [`@tmcw/togeojson`](https://www.npmjs.com/package/@tmcw/togeojson) (7.1.2, BSD-2 **[measured]**) — you need the track as GeoJSON for MapLibre anyway. A ~150-line hand-rolled `quick-xml` (0.42.0, very active) parser over just `<trkpt>`/`<ele>`/`<time>`/`<wpt>` is also a credible option. |
| [`proj4rs`](https://docs.rs/proj4rs/latest/proj4rs/) | 0.1.10 | MIT OR Apache-2.0 | Pure-Rust Proj4 port that **explicitly targets WASM** (has a `wasm-strict` feature and JS console adaptors). Only 42% documented; nadgrid support experimental. |
| `geographiclib-rs` | 0.2.7 | MIT | High-accuracy geodesics if you need them; `geo`'s geodesic algorithms likely suffice. |
| `i_overlay` | 8.1.0 | — | The boolean-ops engine behind `geo`'s `BooleanOps` — a **non-optional** `geo` dependency ([source](https://github.com/georust/geo/blob/main/geo/src/algorithm/bool_ops/mod.rs)), so you get it for free and don't need a separate crate. (`geo-booleanop` is dead — last release 2020.) |
| `osm4routing` | 0.8.0 ([rust-transit/osm4routing2](https://github.com/rust-transit/osm4routing2)) | **MIT** | `.osm.pbf` → nodes/edges CSV, with `clap`/`csv`/`osmpbfreader` non-optional — a CLI batch tool, not a library you can embed. Useful **at build time** for pre-baking course graphs; not a browser component. Its **tag-classification logic** (which `highway=*` values are routable, oneway/access handling) is the most valuable thing to read here. Note the archived GPL-3.0 predecessor `Tristramg/osm4routing`. |

**The `proj` crate is a trap** — it binds the C PROJ library via `proj-sys`/CMake, and the
wasm32 support issue ([georust/proj#115](https://github.com/georust/proj/issues/115)) has
been open since February 2022 with unresolved link failures (`wasm-ld: cannot open crt1.o`)
and no maintainer commitment. Don't reach for it. The `utm` crate is dormant (last release
2022-11) — skip that too.

**Projection recommendation: do it by hand, with the right radii.** For a bbox a few km
across, project once at ingest onto a local tangent plane about the bbox centre, then do all
geometry, routing, and optimization in flat metres, unprojecting only when handing GeoJSON
back to MapLibre.

The naive version is plate carrée with a single earth radius:

```
x = (lon - lon0) * cos(lat0) * R
y = (lat - lat0) * R
```

This is what I used for the **[measured]** benchmark in §2c and it is fine. But there is a
strictly better version for the same two multiplications: use the **meridional (M) and
prime-vertical (N) radii of curvature** of the WGS84 ellipsoid evaluated at `lat0` instead of
a single spherical `R`. Cross-checked against Karney's geodesics, that lands within
**sub-millimetre over 5 km and ~44 µm over 20 km**, roughly four orders of magnitude better
than haversine, which is off by ~0.56% (5.6 m/km) near the equator. The insight is that the
dominant error in both haversine and naive equirectangular is the *sphere* approximation, not
the *flat-earth* approximation — so fixing the radii fixes both at once, for free. Add one
round-trip unit test against `geo::Geodesic::distance` and the question is closed forever.

[`proj4rs`](https://docs.rs/proj4rs/latest/proj4rs/) stays in your back pocket for
arbitrary-CRS input (its `Cargo.toml` target-gates `wasm-bindgen`/`js-sys`/`web-sys`
specifically to `wasm32-unknown-unknown`, and it ships a [live WASM demo](https://docs.3liz.org/proj4rs/)) —
but GPX is always WGS84, so you will probably never need it.

**Design gotcha:** `geo`'s `Simplify` and `LineLocatePoint` operate in raw coordinate space.
Feed them *projected metres*, not degrees, or your simplification tolerance means something
different at every latitude.

**Overpass JSON parsing in Rust:** there is no usable Overpass crate. The ones that exist
(`osm_overpass`, `overpass-lib`, `overpass`) bundle `reqwest` and are HTTP clients first,
parsers second — strictly worse in a browser that already has `fetch`. `osmpbf` (needs
`memmap2` + `rayon`) and `osmio` (needs `bzip2` C bindings) are WASM-hostile *and* irrelevant
— they're continent-scale batch tools. `osm-xml` is dead (2018). **Just write ~20 lines of
`#[derive(Deserialize)]` over `{elements: [{type, id, lat, lon, nodes, geometry, tags}]}` and
use `serde_json`.** See §2a for the "where do I parse it" tradeoff — it is genuinely a
measurement question, not a settled one.

**Practical Overpass detail worth knowing:** `out geom` inlines full way coordinates into the
response, so no separate node-resolution join is needed — but keep the `nodes` ID array too,
because shared node IDs across ways are how you detect intersections when building graph
topology.

**Straight-line shortcuts through park polygons — this is the genuinely novel geometry
work, and there is real literature on it.** The problem is known as *routing through open
spaces*, and it is a known gap in mainstream routers (see
[graphhopper#82, "Area routing for pedestrian/bike"](https://github.com/graphhopper/graphhopper/issues/82),
open for years). Graser (2016), "Integrating Open Spaces into OpenStreetMap Routing Graphs
for Realistic Crossing Behaviour in Pedestrian Navigation" (*GI_Forum*, AGILE 2016)
compares five approaches — **medial axis, straight skeleton, regular grid, visibility graph,
and least-cost path over a cost surface**
([ResearchGate](https://www.researchgate.net/publication/305272744_Integrating_Open_Spaces_into_OpenStreetMap_Routing_Graphs_for_Realistic_Crossing_Behaviour_in_Pedestrian_Navigation),
[slides](https://www.slideshare.net/anitagraser/integrating-open-spaces-into-osm-routing-graphs-for-realistic-crossing-behaviour-in-pedestrian-navigation)).
A follow-up performance comparison exists in *Geo-spatial Information Science*
([10.1080/10095020.2017.1399675](https://www.tandfonline.com/doi/full/10.1080/10095020.2017.1399675),
paywalled during research — **[unverified]** details). Wheelchair-focused work
([arXiv:2011.03850](https://arxiv.org/pdf/2011.03850)) reports visibility and "spider-grid"
subgraphs producing the most realistic routes.

**OpenTripPlanner ships this in production** — its `WalkableAreaBuilder` constructs
visibility graphs across OSM areas, gated by a `maxAreaNodes` config parameter because
"visibility graph construction is a particularly long step of graph building," with heuristics
to bail out of pathological areas
([OTP BuildConfiguration docs](https://opentripplanner.readthedocs.io/en/latest/BuildConfiguration/),
[OTP#1397](https://github.com/opentripplanner/OpenTripPlanner/issues/1397)). Take the
warning seriously: visibility graphs are O(n²) in polygon vertices. Simplify park boundaries
aggressively (`geo`'s `Simplify`) before building one, and cap vertex count per polygon.

**Map matching is not needed.** There is no maintained Rust HMM map-matching crate
(`rhmm`/`hmmm` exist as generic HMM libraries; no OSM-specific one found). Fortunately
birdseye doesn't need it: the course is its own polyline used as-is, and snapping candidate
viewing spots to the graph is a nearest-edge query, which is an `rstar` lookup.

### 2c. In-browser routing: build it yourself

**Every off-the-shelf engine is a dead end in the browser.**

- **Valhalla** ([MIT](https://github.com/valhalla/valhalla)): no WASM build exists. Official
  bindings are native Node addons ([PR #1457](https://github.com/valhalla/valhalla/pull/1457)).
  Architecturally it's an on-disk tiled graph — Germany alone is ~4.6 GB of tiles.
- **OSRM** ([BSD-2](https://github.com/Project-OSRM/osrm-backend)): no WASM build; the
  `osrm-extract`/`osrm-contract` preprocessing is CLI-only and operates on `.osm.pbf`. Its
  public demo server is explicitly capped at **1 request/second**, restricted to "reasonable,
  non-commercial use-cases", with "no guarantees wrt. uptime"
  ([demo server wiki](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server)) — not
  usable in production.
- **GraphHopper** ([Apache-2.0](https://github.com/graphhopper/graphhopper)): a browser build
  was attempted — [cheerpj-demo](https://github.com/graphhopper/cheerpj-demo) and a
  [2014 TeaVM blog post](https://www.graphhopper.com/blog/2014/05/04/graphhopper-in-the-browser-teavm-makes-offline-routing-via-openstreetmap-possible-in-javascript/) —
  and abandoned twelve years ago.
- **BRouter**: server-based Java; "offline" means running the engine locally on Android.
- **openrouteservice**: Apache-2.0 but a hosted backend, which breaks the no-backend premise.
- **Leaflet Routing Machine**: a UI control that talks to a backend; maintainer states
  "This plugin is barely maintained!"

**Rust options that do work:**
- [`fast_paths`](https://github.com/easbar/fast_paths) — contraction hierarchies, v1.0.0
  (2024-05, dual MIT/Apache-2.0, 295 stars **[measured]**). Notably its README explicitly
  addresses WASM: *"To be able to use the graph in a 32bit WebAssembly environment, it needs
  to be transformed to a 32bit representation."* Lightly maintained (low bus factor).
- [`pathfinding`](https://github.com/samueltardieu/pathfinding) — 4.15.0, dual MIT/Apache-2.0,
  generic Dijkstra/A*. Pure Rust, should compile to wasm32 (**[unverified]** — no explicit
  statement, but no FFI or syscalls).

**No existing crate builds an OSM routing graph in a browser.** Every candidate falls into
one of two buckets: server-side batch file processors (`osm4routing` — clap/csv/PBF;
`osmpbf` — mmap/rayon; `osmio` — bzip2 C bindings) or async HTTP wrappers that duplicate
`fetch` (`osmgraph` 0.4.1 is the closest prior art — an Overpass→petgraph pipeline — but
depends on non-optional `tokio` + `reqwest` and pins petgraph 0.6.5; `graphways` is a `pyo3`
Python extension). This is genuinely unoccupied ground, and it's about **300 lines**: parse
JSON → project to local metres → detect intersections via node-ID reuse across ways → split
ways into edges → build CSR arrays.

**But the measurement says you don't need any of them.** **[measured]** on a real Overpass
extract covering ~10 km × 7.6 km of Manhattan — the densest urban pedestrian network you are
plausibly going to hit:

| Metric | Value |
|---|---|
| Raw Overpass elements | 278,545 (214,171 nodes, 64,374 ways) |
| Raw way segments | 264,651 |
| Nodes after edge compaction (junctions + way endpoints) | **97,006** |
| Directed edges after compaction | **294,972** |
| Graph build from parsed JSON, **in plain JavaScript** | **260 ms** |
| Full one-to-all Dijkstra (binary heap), **in plain JavaScript** | **34 ms** (87,462 nodes settled, 105,406 heap pops) |

A 100×100 travel-time matrix between candidate viewing spots is therefore ~3.4 s of
*JavaScript*, before any early termination (stop once all targets are settled — they cluster
near the course, so real cost is a fraction of the full sweep). In Rust/WASM with a bucket
queue over integer seconds, expect a further 3–10×. **Contraction hierarchies are
unnecessary at this scale**, and CH's benefits only really appear at continental sizes
anyway.

**Recommendation:** hand-roll Dijkstra/A* over a flat CSR graph. Use A* with a
haversine-over-max-speed heuristic for point-to-point, and multi-source Dijkstra with early
termination for the matrix. Keep `fast_paths` as a documented escape hatch you almost
certainly won't need.

**Skeptical note worth confronting:** these numbers weaken the case for Rust/WASM in the
routing layer specifically. The honest justification for Rust here is (a) the optimizer's
inner loop, where ILS does millions of O(1) feasibility checks and constant factors matter;
(b) the geometry code (visibility graphs, polygon ops), where `geo` + `rstar` are genuinely
better than anything in JS; and (c) correctness and maintainability of a nontrivial
computational core. Those are good reasons. "JS is too slow to route" is not one, and you
should not tell people it is.

### 2d. Map UI and tiles

**[measured]** current versions from the npm registry on 2026-08-22:

| Package | Version | License |
|---|---|---|
| `maplibre-gl` | **6.5.0** | BSD-3-Clause |
| `leaflet` | **1.9.4** (2.0 still alpha) | BSD-2-Clause |
| `ol` (OpenLayers) | 10.10.0 | BSD-2-Clause |
| `terra-draw` | 1.32.3 | MIT |
| `terra-draw-maplibre-gl-adapter` | 1.4.1 | MIT |
| `@watergis/maplibre-gl-terradraw` | 1.15.3 | MIT |
| `@mapbox/mapbox-gl-draw` | 1.5.1 | ISC |
| `@tmcw/togeojson` | 7.1.2 | BSD-2-Clause |
| `pmtiles` | 4.5.0 | BSD-3-Clause |
| `vite` | 8.2.2 | MIT |
| `coi-serviceworker` | 0.1.7 | MIT |

**MapLibre GL JS is the right choice.** Actively maintained (last push 2026-08-21, 11.4k
stars **[measured]**), BSD-3, needs no API key (it renders; you bring the tiles), native
vector-tile rendering on the GPU, and globe projection since v5. v6 dropped WebGL1 — WebGL2
is now required, which is fine for any browser you'd target in 2026. For performance with
many features, follow the [Large Data guide](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/):
use one GeoJSON source with a `FeatureCollection` and symbol/line layers rather than DOM
`Marker` objects. birdseye's feature counts (a course, a few hundred candidate spots, an
itinerary) are far below where this bites.

Leaflet's 2.0 has been in alpha since 2025-05 with a tracking issue whose target date reads
"unknown" ([Leaflet#9869](https://github.com/Leaflet/Leaflet/issues/9869)), and 1.9.x has no
built-in vector tile rendering. OpenLayers is excellent and has built-in GPX/KML parsers and
proj4 CRS support, but you need neither. **MapLibre.**

**Drawing: use Terra Draw, not mapbox-gl-draw.** `@mapbox/mapbox-gl-draw` works with
MapLibre only accidentally and breaks across versions — it needed a `Constants.classes`
monkey-patch for MapLibre v3 ([maplibre#2601](https://github.com/maplibre/maplibre-gl-js/issues/2601))
and has mobile crashes against v5 ([mapbox-gl-draw#1497](https://github.com/mapbox/mapbox-gl-draw/issues/1497)).
There is **no official `maplibre-gl-draw`**. [Terra Draw](https://github.com/JamesLMilner/terra-draw)
(MIT, 1,087 stars, last push 2026-08-20 **[measured]**) has a first-party
`terra-draw-maplibre-gl-adapter` and is featured in MapLibre's own examples. For ready-made
UI controls on top, `@watergis/maplibre-gl-terradraw`.

**GPX overlay:** `@tmcw/togeojson` (BSD-2). The older `@mapbox/togeojson` is abandoned.

**Tile sources.** Evaluated for "static site, no backend, unpredictable traffic, AGPL hobby
project":

| Source | Cost / limits | Verdict |
|---|---|---|
| **Self-hosted [PMTiles](https://docs.protomaps.com/pmtiles/)** | Free; you pay your own static-hosting bandwidth. A single `.pmtiles` file served over HTTP range requests from any static host. Basemap data ODbL; style/code CC0 + BSD-3 ([LICENSE_DATA.md](https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md)) | **Primary.** A 5–15 km bbox extract is single-digit to low-tens of MB — small enough to regenerate and ship per course. Sidesteps every rate limit and ToS risk. A race-morning traffic spike is just more range requests against your own CDN. |
| **[OpenFreeMap](https://openfreemap.org/)** | Verbatim: *"Using our public instance is completely free: there are no limits on the number of map views or requests"*; *"no registration, no user database, no API keys, and no cookies"*; commercial use "Yes". Run by Zsolt Ero, funded by GitHub Sponsors, **explicitly no SLA**. Attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" | **Fallback.** Best free option that exists, but it is one person's donation-funded servers. Excellent as a fallback, unwise as your only dependency. |
| **[VersaTiles](https://versatiles.org/)** | Fully FLOSS, self-hostable, no keys, PMTiles-compatible | Good alternative pipeline to hand-rolling PMTiles. |
| **[tile.openstreetmap.org](https://operations.osmfoundation.org/policies/tiles/)** | Public web apps are permitted *if* you send a "clear, unique User-Agent string that names your app", send a valid `Referer`, never send no-cache headers, and cache "for at least 7 days". Bulk downloading (pre-seeding areas/zoom levels, building `.mbtiles` archives) and offline use are **prohibited**. "Access may be blocked without prior notice." | **Local dev only.** A spiky public app on OSMF's donated tile budget is exactly what the policy discourages. |
| MapTiler / Stadia / Thunderforest / Jawg / Mapbox / Carto | All require keys; free tiers range from Thunderforest's 150k tiles/mo down to Jawg's ~25k views/mo; Stadia's free tier is non-commercial/eval only. Specific current quotas **[unverified]** — several vendor pages were unreachable during research | Avoid the key-management burden and the quota cliff. Mapbox in particular defeats the point of choosing MapLibre. |
| Esri World Imagery | Embedding outside Esri software generally requires an ArcGIS subscription | Excluded. |

### 2e. Overpass API

**Policy, quoted from [the official commons doc](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html):**
- *"keep their download volume below about 1 GB per day"*
- *"users are expected to send a maximum of about 10000 requests per day"*
- Default timeout if `[timeout:]` is not declared: **180 seconds**. Default `maxsize`: **512 MiB**.
- *"Requests that are denied due to the rate limit are answered with the HTTP status code 429"*; resource-mismatch denials get **504**. *"Requests stay enqueued up to 15 seconds on the server if not yet a slot is available."*
- The [wiki](https://wiki.openstreetmap.org/wiki/Overpass_API) instructs: *"If you receive an HTTP error code 429, pause for 30 seconds before making a new request."*
- There is **no documented `Retry-After` header** — hardcode the 30 s backoff rather than reading one. **[unverified]** that one never appears; treat its absence as the design assumption.
- Explicit anti-abuse language names "stitching bounding boxes to scrape the full data of the complete world" and per-element hammering as abusive.

**CORS: verified empirically, works.** **[measured]** with `curl` against
`https://overpass-api.de/api/interpreter` sending `Origin: https://example.com`:
`Access-Control-Allow-Origin: *` and `Access-Control-Max-Age: 600`. Same on
`/api/status`. **A static site can `fetch()` Overpass directly, no proxy.** The living proof
is [Overpass Turbo](https://overpass-turbo.eu/) ([source](https://github.com/tyrasd/overpass-turbo)),
a purely static client-side app that has done exactly this for over a decade.

One caveat: the ACAO header only appears when an `Origin` request header is present — correct
CORS behaviour, but it means a naive `curl` check without `-H Origin:` shows no CORS header
and looks like a failure. Don't be fooled by that.

**Rate limiting is real and tight.** `GET /api/status` on the main instance returned
`Rate limit: 2` / `2 slots available now` **[measured]**, and one of my test requests came
back **429** within a few seconds of a prior request **[measured]**. Two concurrent slots per
IP is the operative constraint, not bandwidth.

**Public instances, probed live 2026-08-22 [measured]:**

| Instance | Status | CORS | Rate limit |
|---|---|---|---|
| `overpass-api.de` | 200 | `ACAO: *` | **2** slots |
| `overpass.kumi.systems` | 200 | `ACAO: *` | **0** (= unlimited) |
| `overpass.private.coffee` | 200 | `ACAO: *` | **0** (= unlimited) |
| `maps.mail.ru/osm/tools/overpass` | 200 | (per wiki: "no requests limitations") | — |
| `overpass.osm.ch`, `overpass.openstreetmap.fr` | reported up, CORS `*` | — | regional/limited coverage |

(A parallel research pass saw 500s from kumi/private.coffee earlier in the day; my direct
probe an hour later got clean 200s. Treat availability as genuinely variable and rotate.)
The canonical instance list lives on the [OSM wiki](https://wiki.openstreetmap.org/wiki/Overpass_API);
Overpass Turbo now generates its own server picker from that table
([PR #854](https://github.com/tyrasd/overpass-turbo/pull/854)) — birdseye should treat the
wiki as the source of truth rather than hardcoding.

**Practical bbox size — measured, not guessed.** Query: all `way["highway"]` plus
`way["leisure"~"park|garden|pitch"]` over `40.700,-74.020,40.790,-73.930` (~10 km × 7.6 km,
covering essentially all of Manhattan), `out skel qt;>;out skel qt;`:

| Metric | Value **[measured]** |
|---|---|
| Server time | **3.6–4.4 s** |
| Response, uncompressed | **26.1 MB** |
| Response, gzip on the wire (`--compressed`) | **3.88 MB** |
| Elements | 278,545 (214,171 nodes + 64,374 ways) |
| `JSON.parse` in Node/V8 | **171 ms** |

So for a worst-case-dense urban area: ~4 MB over the wire, ~4 s server-side, ~170 ms to
parse. That is fine for a one-off fetch, and **badly antisocial to repeat**. Cache it.

Note this used `out skel` (ids + geometry, no tags), which requires a second pass to resolve
way coordinates. For birdseye you actually need tags (to classify footway vs. cycleway vs.
private service road, and to respect `barrier=*`/`access=*`), so plan on **`out body geom qt;`**
— geometry inlined, tags included, one pass. That will be somewhat larger than the numbers
above; measure before assuming.

**Query hygiene:** always set `[out:json][timeout:N][maxsize:M]`; prefer bbox filters to
`around` (the wiki states plainly: *"the bounding box query filter performs faster"*); use
the `way(...)->.w; node(w.w);` set idiom rather than blanket recursion.

**Alternatives assessed:**
- **Vector tiles are not a substitute** and this is a spec-level limitation, not a gap.
  Protomaps says so directly: *"Tiled formats like PMTiles are usually not sufficient for
  geocoding and routing"* ([protomaps.com/about](https://protomaps.com/about)). Its basemap
  roads layer keeps only `highway, bridge, tunnel, layer, oneway, ref` plus a 5-bucket
  classification ([layers_v2](https://docs.protomaps.com/basemaps/layers_v2)) — no `access`,
  no `surface`, no barriers. Separately, per-tile clipping introduces synthetic boundary
  vertices indistinguishable from real ones ([vector-tile-spec#26](https://github.com/mapbox/vector-tile-spec/issues/26)),
  so cross-tile topology can't be reliably reconstructed.
- **The OSM main API is the wrong tool and says so.** `GET /api/0.6/map` caps at **0.25
  square degrees** and errors above **50,000 nodes**, and the wiki explicitly redirects:
  *"For downloading data for purposes other than editing… you will likely use Overpass API…
  Planet.osm or extracts"* ([API v0.6](https://wiki.openstreetmap.org/wiki/API_v0.6)). The
  [API usage policy](https://operations.osmfoundation.org/policies/api/) caps you at 2
  download threads and warns clients "may be blocked without notice".
- **Build-time extracts:** [Geofabrik](https://download.geofabrik.de/) (country/region only,
  clip locally with `osmium`) and [BBBike extract](https://extract.bbbike.org/) (custom bbox,
  but asynchronous/email delivery — build-time only, not runtime).
- **Pre-baked per-course graphs on static hosting** — see the recommendation below.

**Recommended architecture:** a **hybrid**. For known/popular courses, ship a pre-built,
compressed binary graph file alongside the app (GitHub Releases / R2 / the same static host),
generated at build time from Overpass or a Geofabrik extract. This costs zero live Overpass
traffic on race morning, loads instantly, and eliminates the CORS/429/outage failure mode
entirely. For arbitrary user-drawn courses, fall back to live Overpass with: gzip requested,
`[out:json][timeout:180]`, a rotation across 2–3 CORS-confirmed instances, a single retry
with a 30 s backoff on 429, and results cached in **IndexedDB** keyed by quantized bbox +
query hash. This is the single most important architectural decision in the whole project —
it converts your worst risk into a build step.

### 2f. Plain JavaScript for the shell

**Staying on plain JS is defensible, and the cost is smaller than it looks.** MapLibre ships
its own bundled type declarations — `"types": "dist/maplibre-gl.d.ts"` in its
[package.json](https://github.com/maplibre/maplibre-gl-js/blob/main/package.json) — and
VS Code's built-in JS language service loads a dependency's `.d.ts` automatically in plain
`.js` files with no configuration. You get real autocomplete and signature checking on
`map.addLayer(...)` for free. (The DefinitelyTyped `@types/maplibre-gl` package is stale and
superseded; don't install it.)

What you actually give up: cross-module rename/find-references degrades to text matching, and
nothing catches a shape mismatch at your own JS↔WASM boundary — which is exactly the
interface where a typo costs you an afternoon.

**The cheap middle ground, if you want it:** a `jsconfig.json` with `checkJs: true` (or
per-file `// @ts-check`) runs the TypeScript checker over JSDoc-annotated plain JS with zero
TS syntax in your source ([checkJs docs](https://www.typescriptlang.org/tsconfig/#checkJs),
[supported JSDoc](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)).
It's been stable since TS 2.3 and is unaffected by the TS 6.0 → 7.0 (Go rewrite) transition
in 2026. Applying it to *just* the WASM boundary module — a handful of `@typedef`s describing
what crosses — is high value for very little ceremony. A strictly lighter option is plain
ESLint / non-type-aware `typescript-eslint` rules.

Node's native type-stripping is a red herring here: it's a server runtime feature and has no
bearing on what ships to a browser.

**Build tooling.** wasm-bindgen `--target web` emits a self-contained ES module, and import
maps have been Baseline Widely Available since ~2023
([MDN](https://developer.mozilla.org/docs/Web/HTML/Element/script/type/importmap)) — so a
**bundler-free static site is genuinely realistic** for MapLibre + a few of your own modules
+ the WASM glue. You lose tree-shaking and minification and gain one request per module,
which HTTP/2 multiplexing largely absorbs. If you'd rather bundle, Vite 8 **[measured]** is
the obvious pick; its built-in `?init` WASM handling targets raw `.wasm` exports rather than
wasm-bindgen glue, so you'd likely want `vite-plugin-wasm` — but test whether you need any
plugin at all first, since `--target web` output is already a valid ES module.

**Deployment: prefer Cloudflare Pages or Netlify over GitHub Pages.** Not because of
COOP/COEP — §2a argues you shouldn't want threads — but because you want the ability to
guarantee `Content-Type: application/wasm` and to set cache headers on your PMTiles file.
GitHub Pages' `.wasm` MIME type appears to be correct on live deployments today, but there is
no authoritative "fixed as of X" statement and local `github-pages` gem previews still get it
wrong ([pages-gem#695](https://github.com/github/pages-gem/issues/695)) — **[unverified]**,
smoke-test before depending on it.

**Testing:** `wasm-bindgen-test` for the Rust engine (runs `#[test]`s in headless browsers or
Node — [docs](https://wasm-bindgen.github.io/wasm-bindgen/wasm-bindgen-test/index.html));
Playwright for true end-to-end against the built static site; Vitest (4.x has stabilized
Browser Mode) for the JS glue. None of these require TypeScript. **Additionally: run the KU
Leuven TOPTW benchmark instances (§1.4) as fixtures in CI** — it's the only external
correctness signal a hand-rolled optimizer will ever get.

---

## 3. Risks and recommendations

### Risks, ranked

**R1 — Overpass availability and rate limiting on race morning (highest, and the one most
likely to actually bite).** Two slots per IP **[measured]**, 429s issued aggressively
**[measured]**, and public instances that were returning 500s earlier the same day I probed
them returning 200s. If twenty spectators at the same race open birdseye within a minute, they
are not sharing an IP, so per-IP limits aren't the problem — but a 4 s / 4 MB query per user
on donated infrastructure for a race that happens every year is exactly the pattern the
policy calls antisocial. *Mitigation: the pre-baked hybrid in §2e. This risk is entirely
designable-away for known courses.*

**R2 — Modelling credibility (underrated).** birdseye's output is only as good as its arrival
windows, and pace prediction is genuinely hard. The Riegel formula
(T₂ = T₁ × (D₂/D₁)^1.06) is accurate to ±3–5% for 5K→10K but "dramatically underestimated
marathon time, giving times at least 10 min too fast for half of runners"
([RunPaceLab analysis](https://www.runpacelab.com/guides/riegel-formula-accuracy/),
[empirical study, PMC5000509](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5000509/)); the
exponent varies from ~1.05 for elites to ~1.08 for less-trained runners. A ±10-minute window
at 30 km is wider than most spectators' patience. *Mitigation: make uncertainty first-class
in the UI — show windows, not instants; propagate variance along the course so late-course
windows are visibly wider; let the user tighten a window after a confirmed sighting and
re-solve. An honest wide window beats a confident wrong ETA, and re-solving after a sighting
is a genuinely great feature no competitor has.*

**R3 — Tile hosting sustainability.** OpenFreeMap is explicitly no-SLA and donation-funded by
one person; OSM's own tile server forbids the traffic pattern you'd generate. *Mitigation:
self-hosted PMTiles as primary (§2d), OpenFreeMap as fallback, with a graceful degradation
path if the tile source fails — the app should still be usable with a blank basemap and the
course/graph drawn on top.*

**R4 — Scope creep in the engine.** Visibility graphs over park polygons, contraction
hierarchies, exact OPTW solvers, map matching — every one of these is a rabbit hole and none
is needed for v1. The measurements in §2c say plain Dijkstra is fast enough and §1.4 says
greedy+ILS is good enough. *Mitigation: pick the boring option everywhere in v1 and keep the
interfaces clean so the interesting option can be staged in behind a seam.*

**R5 — Legal/licensing (low, but has sharp edges).** The sharp edges are: (a) don't copy the
unlicensed `Constantino/TOPTW` code — reimplement from the paper; (b) ODbL attribution for
OSM data is mandatory and ODbL share-alike applies to any derived graph files you
redistribute; (c) AGPL §13's applicability to client-side code is unsettled
**[unverified]**, so just ship a visible source link and make it moot.

**R6 — Ecosystem thinness in specific spots.** `fast_paths` had one release in 2024 and a low
bus factor; the `gpx` crate's last release was 2023-12 with ~40 unreleased commits on master;
`proj4rs` is 42% documented with experimental nadgrids; `twiggy` is archived; the `wasm-opt`
crate is 16 Binaryen versions behind; `wasm-bindgen-rayon` and `wasm_thread` are stale; there
is no maintained Rust Overpass or map-matching crate. *Mitigation: none of these are on the
critical path if you follow the recommendations below — that's partly why they're the
recommendations. The one to actually watch is `gpx`; have the `quick-xml` fallback in mind.*

### Recommendations, ranked

1. **Adopt the hybrid data model: pre-baked course graphs primary, live Overpass fallback.**
   This is the highest-leverage decision in the project. It removes R1, makes race-morning
   load a CDN problem, and turns a runtime dependency into a build step you control. Build
   the baking pipeline early — `osm4routing2` (MIT) or a small Overpass + `osmium` script.
2. **Confirm the stack: Rust→WASM (wasm-bindgen 0.2.127, driven by `cargo build` +
   `wasm-bindgen-cli` + standalone `wasm-opt` rather than wasm-pack) + `geo` ≥0.33 (the first
   CI-verified-WASM release) + `rstar` at whatever version `geo` pins + a hand-rolled CSR
   graph + a hand-rolled local-tangent-plane projection + MapLibre GL JS 6.x + Terra Draw +
   self-hosted PMTiles + plain JS.** Every component verified current and permissively
   licensed **[measured]**. Drop `trunk`, drop `wee_alloc`, drop `proj`, drop the `wasm-opt`
   crate, and drop `petgraph` for the routing graph.
3. **Build the optimizer as greedy insertion + ILS with O(1) Wait/MaxShift feasibility, from
   the Vansteenwegen 2009 paper**, and structure the node model for *multiple* time windows
   per node from day one (MC-TOP-MTW, Souffriau 2013) — retrofitting that later is painful.
   Wire the KU Leuven TOPTW benchmarks into CI as fixtures.
4. **Stay single-threaded. No `SharedArrayBuffer`, no COOP/COEP.** It keeps every static host
   viable, avoids `COEP: require-corp` breaking your tile loading, and the measurements say
   you don't need the parallelism. If you ever do, use one Web Worker with a single-threaded
   WASM instance.
5. **Keep the JS↔WASM boundary flat, and settle the Overpass-parse question by measurement.**
   Bytes in, typed arrays out, opaque `Engine` handle holding state in Rust. The two
   candidates are (a) pass the raw `ArrayBuffer` into WASM and parse with
   `serde_json::from_slice`, or (b) `JSON.parse` in JS (**[measured]** 171 ms for 26 MB) and
   marshal. (a) avoids parsing twice; (b) avoids ~100 KB of `serde_json` in the binary. A/B
   them on a real response in week one. Either way: `serde-wasm-bindgen` only for small
   structured payloads, and never cache a typed-array view across a call that can grow WASM
   memory ([#4395](https://github.com/wasm-bindgen/wasm-bindgen/issues/4395)).
6. **Make pace uncertainty a first-class UI concept, and add "I just saw them at X" re-solve.**
   This is the feature that turns R2 from a weakness into birdseye's differentiator, and
   nothing in §1 does it.
7. **Deploy to Cloudflare Pages or Netlify** for header control and correct WASM MIME types.
   Add a "Source" link in the footer, "© OpenStreetMap contributors" attribution in the map
   corner, and note ODbL on any distributed graph files.
8. **Defer:** contraction hierarchies, visibility graphs through parks (start with a simple
   "allow straight-line traversal between boundary nodes of a park polygon, at a walking-speed
   penalty" and only build a real visibility graph if routes look wrong), exact OPTW modes,
   multi-spectator team solving, and transit routing. Each is a clean v2 seam.

---

## Appendix A — Methodology for **[measured]** numbers

All measured on this machine, 2026-08-22, from `~/Code/cowbells`.

- **Overpass CORS:** `curl -D -` against `https://overpass-api.de/api/status` and
  `/api/interpreter`, with and without an `Origin:` request header. ACAO is emitted only when
  `Origin` is present.
- **Overpass rate limit / instance liveness:** `GET /api/status` on overpass-api.de,
  overpass.kumi.systems, overpass.private.coffee, maps.mail.ru; grepped for `Rate limit` and
  `access-control-*`.
- **Overpass extract size/latency:** POST to `overpass-api.de/api/interpreter` with
  `[out:json][timeout:120];(way["highway"](40.700,-74.020,40.790,-73.930);way["leisure"~"park|garden|pitch"](40.700,-74.020,40.790,-73.930););out skel qt;>;out skel qt;`
  measured via `curl -w`, once plain and once with `--compressed`.
- **Element counts / graph compaction:** Python over the saved JSON — counted distinct
  way-nodes, nodes appearing in ≥2 ways (junctions), and way endpoints; graph nodes =
  junctions ∪ endpoints.
- **JSON parse, graph build, Dijkstra:** Node.js (V8) over the same 26 MB file. Graph built by
  splitting each way at junction nodes, accumulating segment lengths under a local
  equirectangular projection about the bbox centre, into flat `head/next/to/weight` arrays.
  Dijkstra used a plain binary heap with lazy deletion, from node 0, to exhaustion.
  Single run each — treat as order-of-magnitude, not benchmark-grade.
- **Package versions and licenses:** npm registry `/{pkg}/latest` endpoints; `docs.rs/crate/{c}/latest`
  page titles; GitHub REST API `/repos/{owner}/{repo}` for license SPDX, stars, `pushed_at`,
  `archived`; GitHub `/search/repositories` for the prior-art sweep. crates.io's API refused
  requests (data-access policy), hence docs.rs.

## Appendix B — Things worth verifying by hand before relying on them

- Whether the **NYRR app** actually optimizes a spectator itinerary or just gives per-spot ETAs (§1.1).
- The **response size of `out body geom qt;`** (with tags) versus the `out skel` numbers measured here (§2e).
- **GitHub Pages `.wasm` MIME type** on a live deployment, if you end up there anyway (§2f).
- The **paywalled open-space routing comparison** ([10.1080/10095020.2017.1399675](https://www.tandfonline.com/doi/full/10.1080/10095020.2017.1399675)) before committing to a specific park-crossing algorithm (§2b).
- Whether the **`gpx` crate** actually parses in-browser — write a `wasm-bindgen-test` for it early, since it has no wasm CI (§2b).
- **A/B the Overpass ingest boundary** on a real response: raw bytes + `serde_json` in WASM vs. `JSON.parse` in JS + marshal (§2a, §2f). This decides both a hot path and ~100 KB of binary size.
- The actual **`.wasm` size contribution of `geo`** — unmeasured, and it's the largest single unknown in the size budget (§2a).
- Current free-tier quotas for any commercial tile vendor you consider — several vendor pages were unreachable during this research (§2d).

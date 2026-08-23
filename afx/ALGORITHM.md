# Race Spectator Optimizer — Algorithm & Data Model

**Status:** v1 spec. Algorithm-focused. Implementation concerns (error messaging, UX
recovery when no feasible plan exists) are deliberately out of scope here.

---

## 1. Problem Statement

A spectator wants to watch one or more racers during a race. The race occurs on a
**closed course** that the spectator generally cannot walk on. The spectator moves on a
separate network of sidewalks, footpaths, roads, and open park polygons.

Given:
- one or more **courses** (race routes), decomposed into segments
- one or more **racers**, each with a pace profile over their course
- a **spectator mobility network** derived from map data
- spectator preferences (start/end anchors, walking speed, priorities)

Produce: an ordered, timed **itinerary** of viewing locations that maximizes a
configurable notion of "racers seen."

### Two-network insight

The race network and the spectator network are largely **disjoint by design**. The
relationship between them is **proximity, not intersection**. A spectator location is
valuable if it sits within viewing distance of some stretch of course.

The course also acts as a **barrier** on the spectator graph. Whether it can be crossed
is a per-race policy (see §2.5).

---

## 2. Data Model

### 2.1 Course

Owns geometry and modality. Shared by any number of racers.

```
Course
  id
  segments: [Segment]
  total_distance
```

```
Segment
  id
  geometry            # polyline
  start_distance      # distance-along-course at segment start
  end_distance
  modality            # run | bike | swim | other
  viewable            # bool — if false, generates no candidate viewpoints
```

`viewable = false` is the mechanism that collapses a swim leg to essentially just its
entry and exit. It is the same machinery as the finish line, inverted.

### 2.2 Racer

A racer is bound to a course, then given a pace profile.

**Key decision:** pace is *decoupled from segment structure*. Rather than nesting
per-racer subsegments inside course segments, each racer owns a **piecewise pace
function over distance-along-course**.

```
Racer
  id
  name
  course_id
  pace_profile: [PaceInterval]
  priority_weight     # optional; e.g. your kid vs. a stranger
```

```
PaceInterval
  start_distance
  end_distance
  pace                # e.g. sec/km
  uncertainty_pct     # e.g. ±10%
```

Course segments are just a convenient authoring default — the UI seeds one interval per
segment, and the user subdivides as finely as they like. Course and racer only ever
meet through **distance**. No boundary matching, no nesting.

**Implications for UI:**
- A racer must be assigned a course *before* pace entry, since distances are unknown
  until then.
- Free validation: the profile must span `0 → total_distance` with no gaps or overlaps.
- Modality mismatches are catchable (a swim pace on a bike leg is obviously wrong).
- Seed sensible defaults per modality so nobody starts from a blank form.

### 2.3 Viewpoint

```
Viewpoint
  id
  node_ref            # position on the spectator network
  course_id
  arc_start           # distance-along-course
  arc_end
  mean_view_distance  # meters; used for quality weighting
```

**Coverage arcs are contiguous.** We do not model gaps (trees, buildings splitting a
view). Broad viewable areas collapse to a single representative viewpoint rather than
twenty viewpoints along a 100 m stretch.

### 2.4 Visibility Window

The join table between racers and viewpoints. Flat, sortable by time, fast to query.
Everything downstream reads from this.

```
Window
  viewpoint_id
  racer_id
  entry_earliest      # pessimistic bound
  entry_latest
  exit_earliest
  exit_latest
  is_finish           # finish sightings tracked on a separate value curve
  lap_index           # multi-lap courses produce multiple windows per pair
```

Multi-lap courses (Ironman bike) are handled for free: the same physical viewpoint
covers the same arc every lap, so it yields *more rows*, not more viewpoints.

### 2.5 Crossing Policy

Per-race setting. **v1 is binary:**

- `never` — course is a hard barrier; no crossing edges in the spectator graph
- `always` — crossing edges added wherever the spectator network approaches the course

Baked into graph construction, so shortest paths stay static and plain. No time
dependence.

*Deferred to v2:* an `opportunistic` third state (running races where you can sneak
across during gaps in the field). This would make crossing edges **stochastic and
time-dependent** — passable only when a gap exists, with traversal cost depending on
arrival time and pack position. We already simulate racer positions, so gap prediction
would come nearly free, but it forces time-expanded shortest paths. Not worth it for v1;
`always`/`never` covers most real races.

### 2.6 Spectator Config

```
SpectatorConfig
  start_anchor        # optional
  end_anchor          # optional
  day_window          # start/end time
  walking_speed       # single value for v1
  safety_buffer       # minutes; default ~2
  required_regions: [RequiredRegion]
  priority_tiers      # ordered; see §5.2
  repeat_curve_steepness
```

Both anchors are optional — with neither, the planner decides where to start and end.

**v1 uses a single walking speed.** Deferred: mode selection (jog/run/bike) with an
*effort budget*, so the optimizer can't plan a half-marathon of sprinting between
viewpoints. A bike also changes which paths are usable and needs somewhere to be parked
— treating it as a speed multiplier on the walking graph is the cheap approximation.

```
RequiredRegion
  center
  radius
  time_window         # optional; prunes aggressively when present
```

Soft-pinned: "I want to watch from roughly here." Modeled as a constraint that at least
one chosen viewpoint falls inside the region — **soft, with a large penalty**, not a hard
filter, so an unreachable region still returns a plan.

---

## 3. Part 1 — Candidate Generation

This part is **fully analytic. No simulation.**

Once a viewpoint has a coverage arc and a racer has a pace function, the racer's arrival
into that arc is a deterministic function. Uncertainty *widens the window* rather than
changing its nature, so it is carried analytically as a ± on each boundary. There is
nothing to Monte Carlo — sampling would only rediscover the same interval.

### Pipeline

**Stage 1 — Sample the course.**
Walk each race line at a fixed interval (~20 m), emitting course points with known
distance-along-course. Skip segments where `viewable = false`. This is ground truth for
what needs watching.

**Stage 2 — Sample the spectator network.**
Nodes at every intersection, plus interpolated points along edges at a similar interval.
These are raw candidate positions.

**Stage 3 — Spatial join.**
For each candidate, find all course points within the **viewing radius (30 m for v1)**.
Use a spatial index — naive comparison is quadratic and will not survive a 180 km
Ironman bike course. Candidates with zero matches are discarded immediately; this kills
the vast majority.

30 m is a hard binary cutoff: if you can't get within 30 m of the race line, it isn't
worth considering. But **quality is weighted inside the radius** — 5 m away is a
different experience from 28 m. Quality is used for tie-breaking between otherwise
equivalent viewpoints, not for feasibility.

**Stage 4 — Build coverage arcs.**
Sort each candidate's matched course points by distance-along-course and collapse into a
contiguous run. At 20 m sampling, consecutive points chain naturally. Emit `arc_start`,
`arc_end`, `mean_view_distance`.

**Stage 5 — Prune.** See below.

### Pruning

The hard part of Part 1 is trimming the search space by *not keeping bad viewpoints*.

**Clustering.** Group candidates whose coverage arcs overlap heavily and whose positions
are close. Keep one representative — widest arc, best mean view distance. This enforces
the "one viewpoint per broad area" rule.

**Dominance elimination.** If viewpoint A covers everything B covers *and more*, and is
not harder to reach, then B can never appear in an optimal itinerary. Drop it. This
alone typically eliminates most of the remaining candidate set.

---

## 4. Uncertainty Model

Two **separate** mechanisms. Worth naming distinctly.

### 4.1 Racer position uncertainty

Intrinsic to prediction. Pace ± some percentage, and **error compounds with distance** —
the window at km 40 is far fuzzier than at km 2. Integrate the uncertainty along the
pace profile to get the bounds on each window.

### 4.2 Spectator safety buffer

A planning discipline on our side, deliberately conservative. The spectator must be
standing at the viewpoint some configurable amount (default ~2 min) **before the earliest
moment the racer could possibly appear**.

```
travel_deadline = window.entry_earliest − safety_buffer
```

Exposed as one number in settings. Nervous users set 5 minutes; gamblers set 30 seconds.

### 4.3 Combining them

Use the **pessimistic bound for feasibility**:
- assume the racer is at their **fastest** when checking whether you'll arrive in time
- assume they're at their **slowest** when deciding when you may leave

So: widen the window on both ends, *then* apply the buffer to the deadline. Clean
separation — **uncertainty widens the window, the buffer shifts the deadline.**

Consequence: deep-course viewpoints are expensive to guarantee. (Open question for
later: surface a confidence percentage per sighting instead of forcing certainty.)

---

## 5. Part 2 — Itinerary Optimization

This is the genuinely hard half: a **team orienteering problem with time windows**. NP-hard,
so heuristics.

### 5.1 Value curves

Each racer has a **concave value curve** — the first sighting is worth a lot, the second
less, the third less still. Diminishing returns are baked in.

**Two counters per racer:** en-route sightings and finish sightings, each on its own
curve with its own weight. A finish sighting is just a normal sighting; the finish line
is just another candidate viewpoint whose windows happen to be each racer's finish time.
**The solver doesn't change at all.**

This separation matters because finishers spread out — you can catch an early finisher,
wander off, and come back.

**One user-facing dial: curve steepness.**
- Steep → breadth (see everybody once)
- Shallow → depth (camp out, watch fewer people repeatedly)

Plus optional per-racer weights.

### 5.2 Priority tiers (lexicographic)

The user orders priorities as tiers, e.g.:

1. Be at the finish before the first finisher
2. See everybody at least once en route
3. See everybody at their finish
4. Additional sightings

Implemented as **weights orders of magnitude apart** (1000 / 100 / 10 / 1) so it behaves
lexicographically while still running through the same scalar solver. Reordering tiers in
the UI is just permuting weights.

The finish-line tier is a useful anchor — it imposes a hard deadline at the end of the
itinerary, which prunes the search space substantially.

### 5.3 Global terms break per-spot scoring

"Everybody at least once" and "everybody at their finish" are **global coverage bonuses**,
evaluated over the whole itinerary rather than spot by spot. Consequence: greedy
insertion **cannot score a viewpoint in isolation**. You must score the full itinerary
before and after insertion and take the difference. More bookkeeping, but it keeps
everything consistent.

### 5.4 Greedy insertion

1. **Seed the skeleton:** start anchor (if any), end anchor (if any), finish-line
   viewpoint (if that tier is prioritized).
2. **Iterate.** For every unused viewpoint × every insertion position:
   - **Feasibility:** can I travel from the previous stop, dwell long enough to catch the
     windows I care about, and still reach the next stop in time? Travel time comes from
     the spectator graph; deadlines come from §4.3.
   - **Marginal gain:** score the whole itinerary with it inserted, subtract the current
     score, divide by added time cost.
3. Insert the best ratio. **Recompute** — insertion shifts every downstream arrival time.
4. Stop when nothing feasible improves the score.

Scoring is **marginal, not absolute**. If you already caught racer #4 at stop 1, seeing
her again at stop 3 is worth much less. This naturally spreads the itinerary across
different racers.

### 5.5 Dwell time as a decision variable

Dwell is **chosen by the optimizer**, not a fixed parameter — staying 10 minutes may
genuinely yield more sightings.

**Key simplification:** dwell only matters at **window boundaries**. An extra 30 seconds
is worthless unless it crosses a racer's entry time. So for each viewpoint, enumerate
only a handful of candidate departure times — essentially the exits of each racer's
window. A continuous variable becomes a small discrete choice the insertion loop can
enumerate directly.

This composes cleanly with marginal scoring: longer dwell costs downstream reachability,
so the ratio naturally penalizes camping unless the extra sightings justify it.

### 5.6 Local search

Polish the greedy result:
- remove a stop and reinsert it elsewhere
- swap pairs / reorder (2-opt style)
- replace a stop with a nearby unused one

Accept any improvement; stop when nothing improves. Simple 2-opt moves get surprisingly
close to optimal.

---

## 6. Deferred to v2

| Item | Note |
|---|---|
| `opportunistic` crossing | Stochastic, time-dependent edges; forces time-expanded shortest paths |
| Non-walking spectator modes | Jog/run/bike, with an **effort budget** so the plan isn't a half-marathon of sprinting |
| Discontinuous coverage arcs | Trees/buildings splitting a view |
| Per-sighting confidence % | Alternative to forcing hard certainty on deep-course viewpoints |
| Infeasibility explanation | "Couldn't fit this — walk faster or drop a requirement." Product concern, not algorithmic |

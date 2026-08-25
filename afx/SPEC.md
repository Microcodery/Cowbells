# cowbells — Product Specification (v1)

## Purpose

cowbells helps a race spectator answer one question: **where should I stand, and when, to see the racers I care about as many times as possible?**

The user describes an event (courses, racers, paces) and themselves (where they start, how they move). cowbells produces an itinerary: an ordered list of stops with arrival/departure times and the racers expected at each.

It runs entirely in the browser as a static web page. No account, no server-side compute, no data leaves the user's machine except map tile and OpenStreetMap data requests.

## Users

- A family member or friend following one or a few racers at a running, cycling, or triathlon event.
- A club supporter following many racers across several distances on the same day.
- A race organizer sketching a spectator guide for a course (stretch).

## Core concepts

| Term | Meaning |
|---|---|
| **Event** | A race day: one or more courses, a set of racers, and the spectator's settings. The unit of save/load/share. |
| **Course** | A route with a start time, split into ordered **segments**. Examples: a 10K; the bike leg plus run leg of a triathlon. |
| **Segment** | A contiguous piece of a course with a mode (run, bike, swim, other). Racers have one pace per segment. |
| **Racer** | A person on exactly one course, with a start offset (wave start), a pace per segment, and optional constraints. |
| **Pace profile** | A racer's pace as a function of distance along the course: contiguous intervals, each with a pace and an uncertainty (±%). Uncertainty accumulates along the course. |
| **Viewpoint** | A spot on the spectator's network within sighting radius of a contiguous stretch (arc) of course. |
| **Visibility window** | For a racer at a viewpoint: from the earliest they could enter the arc to the latest they could leave it. |
| **Sighting** | The spectator is at the viewpoint by the safety buffer before the window opens and stays until it closes. |
| **Stop** | A place the spectator stands for some time. One stop can produce many sightings. |
| **Itinerary** | The spectator's plan: start → stops → (optional) end, with times. |

## Functional requirements

### Courses

- Draw a course on the map by clicking points; edit points after placing.
- Import a course from a GPX file (track or route). Multi-track GPX offers a choice of track.
- Split a course into segments at any point; merge adjacent segments. Each segment has a mode.
- Set the course start time.
- Multiple courses per event. Each course is independent.
- Display cumulative distance along a course and total length.

### Racers

- Add racers with a name and assign each to a course (the course must exist first, since paces are entered by distance along it).
- Set a start offset relative to the course start (for waves/corrals).
- A **pace profile**: contiguous intervals over distance along the course, each with a pace and ±uncertainty. Seeded with one interval per segment and sensible defaults per mode; split and merge intervals freely. Editing course geometry stretches profiles to fit.
- Per-racer **priority** weight (default 1). Higher-priority sightings are worth more.
- Any number of racers.

### Segments

- Each segment has a mode (run, bike, swim, other) and a **viewable** flag; a non-viewable stretch (a swim leg) produces no viewpoints.

### Spectator

- Optional start location and earliest available time; without a start the planner chooses where to begin.
- Optional end of day ("until") and optional end location with a latest arrival (e.g. "be at the finish by noon").
- **Must-visit areas**: circles on the map (optionally time-windowed) the itinerary should include. Soft — an unreachable area is reported, not fatal.
- Movement mode: walk, bike, drive. One mode per plan.
- **Objective**: ordered priority tiers — en-route sightings, then finishes (or the reverse) — set per racer, with a finish they can require outright.
- Settings with defaults:
  - Sighting radius (30 m)
  - Safety buffer: be in place this long before a racer could possibly appear (2 min)
  - Minimum stop duration (1 min)
  - Pace uncertainty default (±5%)
  - Treat the course as closed to crossing (off)

### Map and routing data

- Map tiles from a free, no-backend tile source.
- OpenStreetMap data for the event's bounding box is fetched on demand from a public Overpass instance and cached in the browser for the event.
- Routing follows real roads, paths, and trails appropriate to the mode. Water, buildings, and other impassable areas are never crossed.
- Parks, plazas, grass, and similar open areas may be crossed in a straight line.
- Show the fetched routable network on demand so the user can see why a route was chosen.

### Planning

- Compute an itinerary that maximizes the objective subject to all constraints. Viewpoints are positions on the spectator's network within sighting radius of a stretch of course — mid-block as well as at intersections — with one representative per broad viewable area.
- Report, for each stop: location, arrive-by time, leave-after time, and the list of racers seen with their expected pass time and window.
- Report the walking/cycling/driving legs between stops with durations.
- Report which racers are never seen and which must-visit areas could not be included.
- Planning runs in the background; the UI stays responsive and shows progress. Typical events (few courses, tens of racers, a few km² bbox) plan in seconds.
- Re-plan on demand after edits.

### Results display

- Itinerary as a list and as a route drawn on the map, with stops numbered.
- Click a stop to highlight the course points and racers it covers.
- A timeline view: spectator's stops on the horizontal time axis, each racer's window at that stop drawn as a bar.
- Print/export the itinerary as a simple text or PDF-friendly page.

### Persistence and sharing

- Save/load the event as a JSON file.
- Auto-save the working event in browser storage.
- Share via URL: a compressed encoding of the event in the fragment for small events, with a fallback notice when too large.

## Non-functional requirements

- **Offline after load:** once tiles and OSM data are cached, planning works without network.
- **No backend:** deployable as static files on any host.
- **Performance:** planning for 3 courses × 30 racers × 5 km² completes in under 10 s on a mid-range laptop; UI never blocks.
- **Correctness first:** the engine is deterministic and unit-tested independently of the browser.
- **Accessibility:** keyboard-navigable forms; results readable without the map.
- **License:** BSL 1.1 (converts to Apache 2.0 on the change date).

## Out of scope for v1

- Live tracking / real-time racer positions.
- Line-of-sight (buildings blocking the view).
- Elevation-aware pace or routing.
- Public transit schedules; multi-mode spectator trips (drive then walk).
- Accounts, collaboration, or server-side anything.
- Mobile-native apps.

## Future plans

Ordered roughly by expected value:

1. **Racer groups** — tag racers into groups with group-level priority and "see at least one of this group" tiers.
2. **Opportunistic crossing** — a third crossing policy for running races where gaps in the field allow crossing (time-dependent edges).
3. **Per-sighting confidence** — surface a probability instead of forcing certainty on deep-course viewpoints.
4. **Live re-planning** — import live tracking feeds to update windows mid-race and re-plan from the spectator's current position.
5. **Multi-mode spectator** — drive to a parking area, then walk.
6. **Transit** — GTFS-based public transit legs.
7. **Organizer mode** — publish a read-only event so spectators only enter their racers and start point.
8. **Line-of-sight** — use building footprints to reject viewpoints without a view of the course.
9. **Elevation** — slope-aware pace and spectator travel.
10. **Optional server** — a thin backend only for hosting shared events and pre-fetched OSM extracts; the engine stays the same.

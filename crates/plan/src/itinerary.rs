//! Wires the pieces together and turns a plan back into a human-facing itinerary.

use birdeye_core::geom::{Point, Projection};
use birdeye_core::{Event, LatLon, Seconds};
use birdeye_routing::{NodeId, TravelTime};
use fixedbitset::FixedBitSet;
use geo::{Distance, Euclidean};
use serde::Serialize;
use thiserror::Error;

use crate::planner::{Options, Problem, Region, plan};
use crate::trace::{Trace, leg_traces, network_trace, viewpoint_traces};
use crate::viewpoints::{Kind, Viewpoint, add_sightings, cluster, raw_viewpoints};

#[derive(Debug, Error)]
pub enum SolveError {
    #[error("spectator start is not within {0} m of a road or path")]
    StartOffNetwork(f64),
    #[error("spectator end is not within {0} m of a road or path")]
    EndOffNetwork(f64),
    #[error("no viewpoint is within sight of any course")]
    NoViewpoints,
}

#[derive(Debug, Clone, Serialize)]
pub struct SightingReport {
    pub racer_id: String,
    pub kind: Kind,
    pub expected: Seconds,
    pub open: Seconds,
    pub close: Seconds,
}

#[derive(Debug, Clone, Serialize)]
pub struct StopReport {
    pub location: LatLon,
    pub arrive: Seconds,
    pub depart: Seconds,
    pub seen: Vec<SightingReport>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Leg {
    pub seconds: Seconds,
    pub path: Vec<LatLon>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Itinerary {
    pub stops: Vec<StopReport>,
    /// `legs[i]` connects `stops[i]` to `stops[i + 1]`.
    pub legs: Vec<Leg>,
    pub score: f64,
    pub unseen: Vec<String>,
    /// Indices into `spectator.required_regions`.
    pub unmet_regions: Vec<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Solution {
    pub itinerary: Itinerary,
    /// Present when `Options::trace` was set.
    pub trace: Option<Trace>,
}

/// Snapping tolerance for the spectator's own start and end points.
const SPECTATOR_SNAP_M: f64 = 200.0;

/// Viewpoints, travel times, search, and rendering in one call; the engine's entry point.
pub fn solve(
    event: &Event,
    graph: &impl TravelTime,
    options: Options,
) -> Result<Solution, SolveError> {
    let projection = Projection::new(event.origin);
    let spectator = &event.spectator;
    let raw = raw_viewpoints(event, graph, &projection);
    let raw_locations = options
        .trace
        .then(|| raw.iter().map(|v| projection.to_latlon(v.point)).collect::<Vec<_>>());
    let mut all = cluster(raw, spectator.viewpoint_spacing_m);
    add_sightings(&mut all, event);
    if all.is_empty() {
        return Err(SolveError::NoViewpoints);
    }
    let mut anchor = |latlon: LatLon, err: SolveError| -> Result<usize, SolveError> {
        let node = graph.snap(projection.to_local(latlon), SPECTATOR_SNAP_M).ok_or(err)?;
        if let Some(existing) = all.iter().position(|c| c.node == node) {
            return Ok(existing);
        }
        all.push(Viewpoint {
            node,
            point: graph.point(node),
            arcs: Vec::new(),
            sightings: Vec::new(),
        });
        Ok(all.len() - 1)
    };
    let start = match spectator.start {
        Some(latlon) => Some(anchor(latlon, SolveError::StartOffNetwork(SPECTATOR_SNAP_M))?),
        None => None,
    };
    let end = match spectator.end {
        Some(deadline) => Some((
            anchor(deadline.location, SolveError::EndOffNetwork(SPECTATOR_SNAP_M))?,
            deadline.latest as f64,
        )),
        None => None,
    };

    // Built from `all` after anchoring so trace indices match the ones the search reports.
    let mut trace = raw_locations.map(|raw_viewpoints| Trace {
        network: network_trace(graph, &projection),
        raw_viewpoints,
        viewpoints: viewpoint_traces(&all, event, &projection),
        labels: Vec::new(),
        labels_total: 0,
        legs: Vec::new(),
    });

    let regions = spectator
        .required_regions
        .iter()
        .map(|r| {
            let center = projection.to_local(r.center);
            let mut inside = FixedBitSet::with_capacity(all.len());
            for (i, c) in all.iter().enumerate() {
                if Euclidean.distance(c.point, center) <= r.radius_m {
                    inside.insert(i);
                }
            }
            Region { inside, latest: r.latest.map(|t| t as f64) }
        })
        .collect();

    let nodes: Vec<NodeId> = all.iter().map(|c| c.node).collect();
    let problem = Problem {
        travel: graph.matrix(&nodes),
        viewpoints: all,
        start,
        earliest: spectator.earliest as f64,
        latest: spectator.latest.map(|t| t as f64),
        end,
        min_stop: spectator.min_stop_s,
        priorities: event.racers.iter().map(|r| r.priority).collect(),
        objective: spectator.objective.clone(),
        regions,
    };
    let result = plan(&problem, options);

    let report = |viewpoint: usize, sighting: usize| {
        let s = &problem.viewpoints[viewpoint].sightings[sighting];
        SightingReport {
            racer_id: event.racers[s.racer].id.clone(),
            kind: s.kind,
            expected: s.expected,
            open: s.window.open,
            close: s.window.close,
        }
    };
    let stops: Vec<StopReport> = result
        .stops
        .iter()
        .map(|stop| StopReport {
            location: projection.to_latlon(problem.viewpoints[stop.viewpoint].point),
            arrive: stop.arrive,
            depart: stop.depart,
            seen: stop.sightings.iter().map(|&s| report(stop.viewpoint, s)).collect(),
        })
        .collect();
    let legs = result
        .stops
        .windows(2)
        .map(|pair| {
            let (from, to) = (
                problem.viewpoints[pair[0].viewpoint].node,
                problem.viewpoints[pair[1].viewpoint].node,
            );
            let path: Vec<Point> = graph.path(from, to).unwrap_or_default();
            Leg {
                seconds: pair[1].arrive - pair[0].depart,
                path: path.into_iter().map(|p| projection.to_latlon(p)).collect(),
            }
        })
        .collect();
    let unseen = event
        .racers
        .iter()
        .filter(|r| !stops.iter().any(|s| s.seen.iter().any(|seen| seen.racer_id == r.id)))
        .map(|r| r.id.clone())
        .collect();
    if let Some(trace) = &mut trace {
        trace.legs = leg_traces(&result.events, &nodes, graph, &projection);
        trace.labels = result.events;
        trace.labels_total = result.events_total;
    }
    let itinerary =
        Itinerary { stops, legs, score: result.score, unseen, unmet_regions: result.unmet_regions };
    Ok(Solution { itinerary, trace })
}

#[cfg(test)]
mod tests {
    use birdeye_core::*;
    use birdeye_routing::Graph;

    use super::*;
    use crate::trace::LabelEvent;
    use crate::viewpoints::viewpoints;

    const ORIGIN: LatLon = LatLon { lat: 45.0, lon: -122.0 };

    /// 5×5 street grid, 100 m spacing, walked at 1 m/s; node (i, j) sits at (100 i, 100 j) metres.
    fn grid() -> Graph {
        let points =
            (0..25).map(|n| Point::new(100.0 * (n % 5) as f64, 100.0 * (n / 5) as f64)).collect();
        let mut graph = Graph::new(points);
        for n in 0..25 {
            if n % 5 < 4 {
                graph.add_edge_both_ways(n, n + 1, 100.0);
            }
            if n / 5 < 4 {
                graph.add_edge_both_ways(n, n + 5, 100.0);
            }
        }
        graph
    }

    fn latlon(x: f64, y: f64) -> LatLon {
        Projection::new(ORIGIN).to_latlon(Point::new(x, y))
    }

    /// One racer running west→east 10 m off the bottom row at 200 s per 100 m, spectator starting a block north.
    fn event() -> Event {
        Event {
            name: "grid".into(),
            origin: ORIGIN,
            courses: vec![Course {
                id: "c".into(),
                name: "row".into(),
                start_time: 0,
                segments: vec![Segment {
                    id: "s".into(),
                    mode: Mode::Run,
                    points: vec![latlon(0.0, 10.0), latlon(400.0, 10.0)],
                    viewable: true,
                }],
            }],
            racers: vec![Racer {
                id: "alice".into(),
                name: "Alice".into(),
                course_id: "c".into(),
                start_offset_s: 0.0,
                pace_profile: vec![PaceInterval {
                    start_m: 0.0,
                    end_m: 400.0,
                    seconds_per_km: 2000.0,
                    uncertainty: 0.0,
                }],
                priority: 1.0,
            }],
            spectator: SpectatorConfig {
                start: Some(latlon(0.0, 100.0)),
                earliest: 0,
                latest: None,
                end: None,
                mode: TravelMode::Walk,
                speed_mps: None,
                sighting_radius_m: 30.0,
                skip_start_m: 0.0,
                safety_buffer_s: 10.0,
                min_stop_s: 0.0,
                viewpoint_spacing_m: 50.0,
                course_closed: false,
                required_regions: vec![],
                objective: Objective::default(),
            },
        }
    }

    #[test]
    fn follows_the_racer_down_the_row_and_catches_the_finish() {
        let solution =
            solve(&event(), &grid(), Options { trace: true, ..Options::default() }).unwrap();
        let trace = solution.trace.unwrap();
        assert_eq!(trace.network.len(), 25);
        assert!(!trace.raw_viewpoints.is_empty());
        assert!(
            trace.viewpoints.len() <= trace.raw_viewpoints.len() + 1,
            "clustered plus the start anchor"
        );
        assert!(trace.labels.iter().any(|e| matches!(e, LabelEvent::Kept { .. })));
        assert!(trace.legs.iter().all(|l| l.path.len() >= 2 && l.from != l.to));
        assert!(!trace.legs.is_empty());
        let itinerary = solution.itinerary;
        assert!(itinerary.unseen.is_empty());
        let kinds: Vec<Kind> =
            itinerary.stops.iter().flat_map(|s| s.seen.iter().map(|x| x.kind)).collect();
        assert!(kinds.contains(&Kind::Finish), "{kinds:?}");
        assert!(
            itinerary.score > 100.0,
            "first sighting plus finish at least, got {}",
            itinerary.score
        );
        assert_eq!(itinerary.legs.len(), itinerary.stops.len() - 1);
        assert!(itinerary.legs.iter().all(|l| l.path.len() >= 2));
    }

    #[test]
    fn densified_grid_offers_mid_block_viewpoints() {
        let mut event = event();
        event.spectator.viewpoint_spacing_m = 20.0;
        let mut graph = grid();
        let projection = Projection::new(ORIGIN);
        let course: Vec<Point> = event.courses[0]
            .polylines(&projection)
            .iter()
            .flat_map(|p| p.points().collect::<Vec<_>>())
            .collect();
        let corners_only = viewpoints(&event, &graph, &projection).len();
        graph.densify_near(&course, 30.0, 25.0);
        let all = viewpoints(&event, &graph, &projection);
        assert!(all.len() > corners_only, "expected mid-block viewpoints, got {}", all.len());
    }

    #[test]
    fn out_and_back_course_gives_two_passes_per_corner() {
        let mut event = event();
        event.courses[0].segments[0].points =
            vec![latlon(0.0, 10.0), latlon(400.0, 10.0), latlon(0.0, 10.0)];
        event.racers[0].pace_profile[0].end_m = 800.0;
        event.racers[0].pace_profile[0].uncertainty = 0.3;
        let projection = Projection::new(ORIGIN);
        let all = viewpoints(&event, &grid(), &projection);
        let corner = all.iter().find(|c| c.point == Point::new(200.0, 0.0)).unwrap();
        assert_eq!(corner.sightings.len(), 2);
        assert!(corner.sightings[0].expected < corner.sightings[1].expected);
    }

    #[test]
    fn wide_spacing_merges_corners_but_keeps_the_finish() {
        let mut event = event();
        event.spectator.viewpoint_spacing_m = 120.0;
        let all = viewpoints(&event, &grid(), &Projection::new(ORIGIN));
        assert!(all.len() < 5, "got {}", all.len());
        assert!(all.iter().any(|v| v.arcs.iter().any(|a| a.finish)));
    }

    #[test]
    fn return_leg_on_the_next_street_survives_clustering() {
        let mut event = event();
        event.spectator.viewpoint_spacing_m = 120.0;
        event.courses[0].segments[0].points =
            vec![latlon(0.0, 10.0), latlon(400.0, 10.0), latlon(400.0, 90.0), latlon(0.0, 90.0)];
        event.racers[0].pace_profile[0].end_m = 900.0;
        let all = viewpoints(&event, &grid(), &Projection::new(ORIGIN));
        let sees = |from: f64| all.iter().any(|v| v.arcs.iter().any(|a| a.start_m >= from));
        assert!(sees(500.0) && all.iter().any(|v| v.arcs.iter().any(|a| a.end_m <= 400.0)));
    }

    #[test]
    fn nodes_in_the_roadway_are_not_viewpoints() {
        let mut event = event();
        event.courses[0].segments[0].points = vec![latlon(0.0, 0.0), latlon(400.0, 0.0)];
        let all = viewpoints(&event, &grid(), &Projection::new(ORIGIN));
        assert!(all.is_empty(), "the course runs along the only row in sight");
    }

    #[test]
    fn skipping_the_start_hides_its_stretch() {
        let mut event = event();
        event.spectator.skip_start_m = 150.0;
        let all = viewpoints(&event, &grid(), &Projection::new(ORIGIN));
        assert!(all.iter().all(|v| v.arcs.iter().all(|a| a.start_m >= 150.0)), "{all:?}");
        assert!(!all.is_empty());
    }

    #[test]
    fn swim_legs_produce_no_viewpoints() {
        let mut event = event();
        event.courses[0].segments[0].viewable = false;
        assert!(matches!(
            solve(&event, &grid(), Options::default()),
            Err(SolveError::NoViewpoints)
        ));
    }

    #[test]
    fn spectator_far_from_any_road_is_an_error() {
        let mut event = event();
        event.spectator.start = Some(latlon(5000.0, 5000.0));
        assert!(matches!(
            solve(&event, &grid(), Options::default()),
            Err(SolveError::StartOffNetwork(_))
        ));
    }
}

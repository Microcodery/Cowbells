//! Wires the pieces together and turns a plan back into a human-facing itinerary.

use birdseye_core::geom::{Point, Projection};
use birdseye_core::{Event, LatLon, Seconds};
use birdseye_routing::{NodeId, TravelTime};
use fixedbitset::FixedBitSet;
use geo::{Distance, Euclidean};
use serde::Serialize;
use thiserror::Error;

use crate::planner::{Options, Problem, Region, plan_with};
use crate::trace::{LabelEvent, LegRouter, Progress, viewpoint_traces};
use crate::viewpoints::{Kind, Sighting, Viewpoint, add_sightings, cluster, raw_viewpoints_with};

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

/// Snapping tolerance for the spectator's own start and end points.
const SPECTATOR_SNAP_M: f64 = 200.0;

/// Viewpoints, travel times, search, and rendering in one call; the engine's entry point.
pub fn solve(
    event: &Event,
    graph: &impl TravelTime,
    options: Options,
) -> Result<Itinerary, SolveError> {
    solve_with(event, graph, options, &mut |_| {})
}

/// `solve`, reporting each stage to `progress` as it happens when `options.trace` is set.
pub fn solve_with(
    event: &Event,
    graph: &impl TravelTime,
    options: Options,
    progress: &mut dyn FnMut(Progress),
) -> Result<Itinerary, SolveError> {
    let projection = Projection::new(event.origin);
    let spectator = &event.spectator;
    let mut found = |chunk: &[Viewpoint]| {
        if options.trace {
            let locations = chunk.iter().map(|v| projection.to_latlon(v.point)).collect();
            progress(Progress::Candidates { locations });
        }
    };
    let raw = raw_viewpoints_with(event, graph, &projection, &mut found);
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
    let start = spectator
        .start
        .map(|latlon| anchor(latlon, SolveError::StartOffNetwork(SPECTATOR_SNAP_M)))
        .transpose()?;
    let end = spectator
        .end
        .map(|deadline| {
            let at = anchor(deadline.location, SolveError::EndOffNetwork(SPECTATOR_SNAP_M))?;
            Ok((at, deadline.latest as f64))
        })
        .transpose()?;

    // Reported after anchoring so indices match the ones the search reports.
    if options.trace {
        progress(Progress::Viewpoints { viewpoints: viewpoint_traces(&all, event, &projection) });
    }

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
    let mut routes = graph.routes(&nodes);
    // The search wants only the sightings; `all` stays behind for geometry and rendering.
    let sightings: Vec<Vec<Sighting>> =
        all.iter_mut().map(|v| std::mem::take(&mut v.sightings)).collect();
    let problem = Problem {
        travel: std::mem::take(&mut routes.times),
        sightings,
        start,
        earliest: spectator.earliest as f64,
        latest: spectator.latest.map(|t| t as f64),
        end,
        min_stop: spectator.min_stop_s,
        priorities: event.racers.iter().map(|r| r.priority).collect(),
        prefer: event.racers.iter().map(|r| r.prefer).collect(),
        objective: spectator.objective,
        regions,
    };
    let mut router = LegRouter::default();
    let mut sink = |events: Vec<LabelEvent>| {
        let legs = router.update(&events, &nodes, &routes, graph, &projection);
        progress(Progress::Search { events, legs });
    };
    let result = plan_with(&problem, options, &mut sink);

    let report = |viewpoint: usize, sighting: usize| {
        let s = &problem.sightings[viewpoint][sighting];
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
            location: projection.to_latlon(all[stop.viewpoint].point),
            arrive: stop.arrive,
            depart: stop.depart,
            seen: stop.sightings.iter().map(|&s| report(stop.viewpoint, s)).collect(),
        })
        .collect();
    let legs = result
        .stops
        .windows(2)
        .map(|pair| {
            let to = all[pair[1].viewpoint].node;
            let path: Vec<Point> = routes.path(graph, pair[0].viewpoint, to).unwrap_or_default();
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
    Ok(Itinerary { stops, legs, score: result.score, unseen, unmet_regions: result.unmet_regions })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{event, grid, latlon};
    use crate::trace::LabelEvent;

    #[test]
    fn follows_the_racer_down_the_row_and_catches_the_finish() {
        let mut stages = Vec::new();
        let options = Options { trace: true, ..Options::default() };
        let itinerary = solve_with(&event(), &grid(), options, &mut |p| stages.push(p)).unwrap();
        let (mut candidates, mut viewpoints, mut kept, mut legs) = (0, 0, 0, 0);
        for stage in &stages {
            match stage {
                Progress::Network { .. } => panic!("the network is the caller's to report"),
                Progress::Candidates { locations } => candidates += locations.len(),
                Progress::Viewpoints { viewpoints: v } => viewpoints = v.len(),
                Progress::Search { events, legs: l } => {
                    kept += events.iter().filter(|e| matches!(e, LabelEvent::Kept { .. })).count();
                    assert!(l.iter().all(|leg| leg.path.len() >= 2 && leg.from != leg.to));
                    legs += l.len();
                }
            }
        }
        assert!(candidates > 0 && viewpoints <= candidates + 1, "clustered plus the start anchor");
        assert!(kept > 0 && legs > 0);
        assert!(matches!(stages[0], Progress::Candidates { .. }));
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

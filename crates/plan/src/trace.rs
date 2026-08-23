//! What the engine reports as it works, for drawing its progress.

use std::collections::{HashMap, HashSet};

use birdeye_core::geom::{Polyline, Projection};
use birdeye_core::{Event, LatLon, Seconds};
use birdeye_routing::{NodeId, TravelTime};
use serde::Serialize;

use crate::viewpoints::Viewpoint;

/// Points along an arc are spaced this far apart when drawn.
const ARC_STEP_M: f64 = 10.0;
/// The drawn network is thinned to this many nodes.
pub const MAX_NETWORK_NODES: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
pub struct ArcTrace {
    pub course: usize,
    pub path: Vec<LatLon>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ViewpointTrace {
    pub location: LatLon,
    pub arcs: Vec<ArcTrace>,
    pub sightings: usize,
}

/// One decision in the label-setting search.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LabelEvent {
    /// A label joined the frontier; `label` is its index, `parent` the one it extends,
    /// `score` the penalised score the planner ranks by.
    Kept {
        label: usize,
        parent: Option<usize>,
        viewpoint: usize,
        arrive: Seconds,
        depart: Seconds,
        score: f64,
    },
    /// A candidate was refused because an existing label at the same viewpoint beats it.
    Dominated { parent: Option<usize>, viewpoint: usize },
    /// A kept label died: squeezed out by the beam, or beaten by a newer label.
    Trimmed { label: usize },
}

/// The road path between two viewpoints, for drawing a plan's legs.
#[derive(Debug, Clone, Serialize)]
pub struct LegTrace {
    pub from: usize,
    pub to: usize,
    pub path: Vec<LatLon>,
}

/// Stages arrive in this order; `Candidates` and `Search` repeat as chunks arrive. The caller
/// reports `Network` itself, before any per-plan work, so something shows at once.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum Progress {
    Network {
        points: Vec<LatLon>,
    },
    /// Every spot within sighting distance, before clustering.
    Candidates {
        locations: Vec<LatLon>,
    },
    Viewpoints {
        viewpoints: Vec<ViewpointTrace>,
    },
    /// A batch of search events, plus road paths for any new legs of the best plan so far.
    Search {
        events: Vec<LabelEvent>,
        legs: Vec<LegTrace>,
    },
}

/// Every node of the spectator network, thinned to the cap.
pub fn network_trace(graph: &impl TravelTime, projection: &Projection) -> Vec<LatLon> {
    let count = graph.node_count();
    let stride = count.div_ceil(MAX_NETWORK_NODES).max(1);
    (0..count).step_by(stride).map(|n| projection.to_latlon(graph.point(n))).collect()
}

pub fn viewpoint_traces(
    viewpoints: &[Viewpoint],
    event: &Event,
    projection: &Projection,
) -> Vec<ViewpointTrace> {
    let courses: Vec<Vec<Polyline>> =
        event.courses.iter().map(|c| c.polylines(projection)).collect();
    viewpoints
        .iter()
        .map(|v| ViewpointTrace {
            location: projection.to_latlon(v.point),
            arcs: v
                .arcs
                .iter()
                .map(|a| ArcTrace {
                    course: a.course,
                    path: arc_path(&courses[a.course], a.start_m, a.end_m, projection),
                })
                .collect(),
            sightings: v.sightings.len(),
        })
        .collect()
}

/// Follows the search's best label and routes the legs of its chain as they first appear.
#[derive(Default)]
pub struct BestLegs {
    viewpoint_of: HashMap<usize, usize>,
    parent_of: HashMap<usize, Option<usize>>,
    best: Option<(usize, f64)>,
    sent: HashSet<(usize, usize)>,
}

impl BestLegs {
    /// Legs of the best chain after `events` that have not been reported yet.
    pub fn update(
        &mut self,
        events: &[LabelEvent],
        nodes: &[NodeId],
        graph: &impl TravelTime,
        projection: &Projection,
    ) -> Vec<LegTrace> {
        for event in events {
            if let LabelEvent::Kept { label, parent, viewpoint, score, .. } = event {
                self.viewpoint_of.insert(*label, *viewpoint);
                self.parent_of.insert(*label, *parent);
                if self.best.is_none_or(|(_, top)| *score > top) {
                    self.best = Some((*label, *score));
                }
            }
        }
        let Some((mut current, _)) = self.best else { return Vec::new() };
        let mut legs = Vec::new();
        // An ancestor leg already sent means the rest of the chain was too.
        while let Some(Some(parent)) = self.parent_of.get(&current) {
            let pair = (self.viewpoint_of[parent], self.viewpoint_of[&current]);
            if pair.0 == pair.1 || !self.sent.insert(pair) {
                break;
            }
            let path = graph.path(nodes[pair.0], nodes[pair.1]).unwrap_or_default();
            legs.push(LegTrace {
                from: pair.0,
                to: pair.1,
                path: path.into_iter().map(|p| projection.to_latlon(p)).collect(),
            });
            current = *parent;
        }
        legs
    }
}

/// The stretch of a course between two distances along it, as drawable points.
fn arc_path(
    segments: &[Polyline],
    start_m: f64,
    end_m: f64,
    projection: &Projection,
) -> Vec<LatLon> {
    let steps = ((end_m - start_m) / ARC_STEP_M).ceil().max(1.0) as usize;
    (0..=steps)
        .map(|i| {
            let mut along = start_m + (end_m - start_m) * i as f64 / steps as f64;
            for segment in segments {
                if along <= segment.length() {
                    return projection.to_latlon(segment.point_at(along));
                }
                along -= segment.length();
            }
            projection.to_latlon(segments.last().expect("course has segments").point_at(f64::MAX))
        })
        .collect()
}

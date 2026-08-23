//! What the engine reports as it works, for drawing its progress.

use std::collections::{HashMap, HashSet};

use birdseye_core::geom::{Polyline, Projection};
use birdseye_core::{Event, LatLon, Seconds};
use birdseye_routing::{NodeId, Routes, TravelTime};
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
    /// A batch of search events, plus road paths for legs tried for the first time in it.
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

/// Every distinct leg the search tries, at most this many; the drawing shows them all.
pub const MAX_LEGS: usize = 8_000;

/// Routes each leg the search tries the first time it appears, from the shortest-path trees.
#[derive(Default)]
pub struct LegRouter {
    viewpoint_of: HashMap<usize, usize>,
    sent: HashSet<(usize, usize)>,
}

impl LegRouter {
    /// Road paths for the legs among `events` not reported before.
    pub fn update(
        &mut self,
        events: &[LabelEvent],
        nodes: &[NodeId],
        routes: &Routes,
        graph: &impl TravelTime,
        projection: &Projection,
    ) -> Vec<LegTrace> {
        let mut legs = Vec::new();
        for event in events {
            let LabelEvent::Kept { label, parent, viewpoint, .. } = event else { continue };
            self.viewpoint_of.insert(*label, *viewpoint);
            let Some(from) = parent.map(|p| self.viewpoint_of[&p]) else { continue };
            let pair = (from, *viewpoint);
            if from == *viewpoint || self.sent.len() >= MAX_LEGS || !self.sent.insert(pair) {
                continue;
            }
            let path = routes.path(graph, from, nodes[*viewpoint]).unwrap_or_default();
            legs.push(LegTrace {
                from,
                to: *viewpoint,
                path: path.into_iter().map(|p| projection.to_latlon(p)).collect(),
            });
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

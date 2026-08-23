//! What the engine did, stage by stage, for replaying in the UI.

use std::collections::{HashMap, HashSet};

use birdeye_core::geom::{Polyline, Projection};
use birdeye_core::{Event, LatLon, Seconds};
use birdeye_routing::{NodeId, TravelTime};
use serde::Serialize;

use crate::viewpoints::Viewpoint;

/// Points along an arc are spaced this far apart when drawn.
const ARC_STEP_M: f64 = 10.0;
/// Caps keep the trace a few megabytes at most.
pub const MAX_NETWORK_NODES: usize = 20_000;
pub const MAX_LABEL_EVENTS: usize = 30_000;
pub const MAX_LEGS: usize = 600;

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

#[derive(Debug, Clone, Serialize)]
pub struct Trace {
    pub network: Vec<LatLon>,
    /// Every spot within sighting distance, before clustering.
    pub raw_viewpoints: Vec<LatLon>,
    pub viewpoints: Vec<ViewpointTrace>,
    pub labels: Vec<LabelEvent>,
    pub labels_total: usize,
    /// Road paths for legs the search took: every leg of each best-so-far plan, then other
    /// expansions in order until the cap.
    pub legs: Vec<LegTrace>,
}

pub fn leg_traces(
    events: &[LabelEvent],
    nodes: &[NodeId],
    graph: &impl TravelTime,
    projection: &Projection,
) -> Vec<LegTrace> {
    let mut viewpoint_of = HashMap::new();
    let mut parent_of = HashMap::new();
    let mut alive: HashMap<usize, f64> = HashMap::new();
    let mut best: Option<(usize, f64)> = None;
    let mut best_pairs = OrderedPairs::default();
    let mut other_pairs = OrderedPairs::default();
    for event in events {
        match event {
            LabelEvent::Kept { label, parent, viewpoint, score, .. } => {
                viewpoint_of.insert(*label, *viewpoint);
                parent_of.insert(*label, *parent);
                alive.insert(*label, *score);
                if let Some(parent) = parent {
                    other_pairs.insert((viewpoint_of[parent], *viewpoint));
                }
                if best.is_some_and(|(_, top)| *score <= top) {
                    continue;
                }
                best = Some((*label, *score));
            }
            LabelEvent::Trimmed { label } => {
                alive.remove(label);
                if best.is_some_and(|(top, _)| top == *label) {
                    best = alive.iter().map(|(l, s)| (*l, *s)).max_by(|a, b| a.1.total_cmp(&b.1));
                } else {
                    continue;
                }
            }
            LabelEvent::Dominated { .. } => continue,
        }
        let Some((mut current, _)) = best else { continue };
        // An ancestor leg already recorded means the rest of the chain is too.
        while let Some(Some(parent)) = parent_of.get(&current) {
            if !best_pairs.insert((viewpoint_of[parent], viewpoint_of[&current])) {
                break;
            }
            current = *parent;
        }
    }
    let others = other_pairs.order.into_iter().filter(|p| !best_pairs.seen.contains(p));
    best_pairs
        .order
        .into_iter()
        .chain(others)
        .take(MAX_LEGS)
        .map(|(from, to)| LegTrace {
            from,
            to,
            path: graph
                .path(nodes[from], nodes[to])
                .unwrap_or_default()
                .into_iter()
                .map(|p| projection.to_latlon(p))
                .collect(),
        })
        .collect()
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

/// Insertion-ordered set of viewpoint pairs; self-pairs are ignored.
#[derive(Default)]
struct OrderedPairs {
    order: Vec<(usize, usize)>,
    seen: HashSet<(usize, usize)>,
}

impl OrderedPairs {
    /// True when the pair is new.
    fn insert(&mut self, pair: (usize, usize)) -> bool {
        if pair.0 == pair.1 || !self.seen.insert(pair) {
            return false;
        }
        self.order.push(pair);
        true
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

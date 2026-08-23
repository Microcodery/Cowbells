//! Viewpoints: spectator-network positions within sight of a stretch of course,
//! and when each racer passes through that stretch.

use birdeye_core::geom::{Point, Projection, coords};
use birdeye_core::{Event, Seconds, Trajectory, Window};
use birdeye_routing::{NodeId, TravelTime};
use geo::{Distance, Euclidean};
use rstar::RTree;
use rstar::primitives::GeomWithData;
use serde::Serialize;

/// Course points are sampled this often along viewable segments.
const SAMPLE_SPACING_M: f64 = 20.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Pass,
    Finish,
}

/// A contiguous stretch of one course visible from a viewpoint.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Arc {
    pub course: usize,
    pub start_m: f64,
    pub end_m: f64,
    pub mean_view_m: f64,
    pub finish: bool,
}

/// One racer passing one viewpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct Sighting {
    /// Index into `event.racers`.
    pub racer: usize,
    pub window: Window,
    pub expected: Seconds,
    pub kind: Kind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Viewpoint {
    pub node: NodeId,
    pub point: Point,
    pub arcs: Vec<Arc>,
    /// Sorted by window open time.
    pub sightings: Vec<Sighting>,
}

struct CourseSample {
    course: usize,
    distance: f64,
    finish: bool,
}

type Indexed = GeomWithData<[f64; 2], usize>;

/// Viewpoints with sightings: every network position within sight of a course, clustered.
pub fn viewpoints(
    event: &Event,
    graph: &impl TravelTime,
    projection: &Projection,
) -> Vec<Viewpoint> {
    let mut kept =
        cluster(raw_viewpoints(event, graph, projection), event.spectator.viewpoint_spacing_m);
    add_sightings(&mut kept, event);
    kept
}

/// Every network node within sighting radius of a course, with its coverage arcs; not yet clustered.
pub fn raw_viewpoints(
    event: &Event,
    graph: &impl TravelTime,
    projection: &Projection,
) -> Vec<Viewpoint> {
    let (samples, index) = sample_courses(event, projection);
    let radius = event.spectator.sighting_radius_m;
    (0..graph.node_count())
        .filter_map(|node| {
            let point = graph.point(node);
            let seen: Vec<(&CourseSample, f64)> = index
                .locate_within_distance(coords(point), radius * radius)
                .map(|s| {
                    (
                        &samples[s.data],
                        Euclidean.distance(point, Point::new(s.geom()[0], s.geom()[1])),
                    )
                })
                .collect();
            let arcs = arcs(seen);
            (!arcs.is_empty()).then(|| Viewpoint { node, point, arcs, sightings: Vec::new() })
        })
        .collect()
}

/// Each racer's visibility window at every arc of every viewpoint.
pub fn add_sightings(viewpoints: &mut [Viewpoint], event: &Event) {
    let trajectories: Vec<(usize, Trajectory)> = event
        .racers
        .iter()
        .map(|racer| {
            let course =
                event.courses.iter().position(|c| c.id == racer.course_id).expect("validated");
            let start = event.courses[course].start_time as f64 + racer.start_offset_s;
            (course, Trajectory::new(start, &racer.pace_profile))
        })
        .collect();
    for viewpoint in viewpoints.iter_mut() {
        for (racer, (course, trajectory)) in trajectories.iter().enumerate() {
            for arc in viewpoint.arcs.iter().filter(|a| a.course == *course) {
                let pass = Sighting {
                    racer,
                    window: trajectory.window(
                        arc.start_m,
                        arc.end_m,
                        event.spectator.safety_buffer_s,
                    ),
                    expected: trajectory.expected_at((arc.start_m + arc.end_m) / 2.0),
                    kind: Kind::Pass,
                };
                // The finish line is also a stretch of course: it pays as a pass and as a finish.
                if arc.finish {
                    viewpoint.sightings.push(Sighting { kind: Kind::Finish, ..pass.clone() });
                }
                viewpoint.sightings.push(pass);
            }
        }
        viewpoint.sightings.sort_by(|a, b| a.window.open.total_cmp(&b.window.open));
    }
}

fn sample_courses(event: &Event, projection: &Projection) -> (Vec<CourseSample>, RTree<Indexed>) {
    let mut samples = Vec::new();
    let mut indexed = Vec::new();
    for (course_index, course) in event.courses.iter().enumerate() {
        let polylines = course.polylines(projection);
        let total: f64 = polylines.iter().map(|p| p.length()).sum();
        let mut offset = 0.0;
        for (segment, polyline) in course.segments.iter().zip(&polylines) {
            let length = polyline.length();
            if segment.viewable {
                let steps = (length / SAMPLE_SPACING_M).ceil() as usize;
                for step in 0..=steps {
                    let along = (step as f64 * SAMPLE_SPACING_M).min(length);
                    let distance = offset + along;
                    indexed.push(Indexed::new(coords(polyline.point_at(along)), samples.len()));
                    samples.push(CourseSample {
                        course: course_index,
                        distance,
                        finish: distance >= total,
                    });
                }
            }
            offset += length;
        }
    }
    (samples, RTree::bulk_load(indexed))
}

/// Group visible samples per course into contiguous runs along the course.
fn arcs(mut seen: Vec<(&CourseSample, f64)>) -> Vec<Arc> {
    seen.sort_by(|a, b| a.0.course.cmp(&b.0.course).then(a.0.distance.total_cmp(&b.0.distance)));
    let mut runs: Vec<Vec<&(&CourseSample, f64)>> = Vec::new();
    for entry in &seen {
        let continues = runs.last().and_then(|run| run.last()).is_some_and(|prev| {
            prev.0.course == entry.0.course
                && entry.0.distance - prev.0.distance <= 1.5 * SAMPLE_SPACING_M
        });
        if !continues {
            runs.push(Vec::new());
        }
        runs.last_mut().expect("just pushed").push(entry);
    }
    runs.iter().map(|run| arc_of(run)).collect()
}

fn arc_of(run: &[&(&CourseSample, f64)]) -> Arc {
    let (first, last) = (run[0].0, run[run.len() - 1].0);
    Arc {
        course: first.course,
        start_m: first.distance,
        end_m: last.distance,
        mean_view_m: run.iter().map(|s| s.1).sum::<f64>() / run.len() as f64,
        finish: run.iter().any(|s| s.0.finish),
    }
}

/// Keep one representative per `spacing` metres: the most course covered, then the nearest to it.
/// Neighbours within `spacing` whose every arc lies within `spacing` along the course of one the
/// kept viewpoint sees (finish arcs only against finish arcs) are dropped: their windows differ
/// by at most the walk between them. A return leg passing nearby is a different stretch and stays.
pub fn cluster(mut raw: Vec<Viewpoint>, spacing: f64) -> Vec<Viewpoint> {
    let coverage = |c: &Viewpoint| c.arcs.iter().map(|a| a.end_m - a.start_m).sum::<f64>();
    let view =
        |c: &Viewpoint| c.arcs.iter().map(|a| a.mean_view_m).sum::<f64>() / c.arcs.len() as f64;
    raw.sort_by(|a, b| coverage(b).total_cmp(&coverage(a)).then(view(a).total_cmp(&view(b))));
    let mut kept: Vec<Viewpoint> = Vec::new();
    let mut index: RTree<Indexed> = RTree::new();
    for viewpoint in raw {
        let redundant =
            index.locate_within_distance(coords(viewpoint.point), spacing * spacing).any(|near| {
                let seen = &kept[near.data].arcs;
                viewpoint.arcs.iter().all(|arc| seen.iter().any(|k| same_stretch(k, arc, spacing)))
            });
        if !redundant {
            index.insert(Indexed::new(coords(viewpoint.point), kept.len()));
            kept.push(viewpoint);
        }
    }
    kept
}

fn same_stretch(kept: &Arc, arc: &Arc, spacing: f64) -> bool {
    kept.course == arc.course
        && (kept.finish || !arc.finish)
        && kept.start_m <= arc.end_m + spacing
        && arc.start_m <= kept.end_m + spacing
}

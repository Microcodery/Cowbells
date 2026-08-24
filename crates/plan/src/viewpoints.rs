//! Viewpoints: spectator-network positions within sight of a stretch of course,
//! and when each racer passes through that stretch.

use cowbells_core::geom::{Point, Polyline, Projection, coords};
use cowbells_core::{Event, Seconds, Trajectory, Window};
use cowbells_routing::{NodeId, TravelTime};
use geo::{Distance, Euclidean};
use rstar::RTree;
use rstar::primitives::GeomWithData;
use serde::Serialize;

/// Course points are sampled this often along viewable segments.
const SAMPLE_SPACING_M: f64 = 20.0;
/// Nodes closer than this to a course are not viewpoints. Wider than the roadway itself: a
/// sidewalk node hugging the course sees it best, but is often reachable only via the nearest
/// mapped crossing, so the corner spot it would displace in clustering makes the better stop.
const CLEARANCE_M: f64 = 6.0;
/// Candidates are reported to `found` in chunks of this many as they turn up.
const CANDIDATE_CHUNK: usize = 400;

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
    let raw = raw_viewpoints_with(event, graph, projection, &mut |_| {});
    let mut kept = cluster(raw, event.spectator.viewpoint_spacing_m);
    add_sightings(&mut kept, event);
    kept
}

/// Every network node within sighting radius of a course but not in its roadway, with its
/// coverage arcs and not yet clustered, calling `found` with each chunk as the network is scanned.
pub fn raw_viewpoints_with(
    event: &Event,
    graph: &impl TravelTime,
    projection: &Projection,
    found: &mut dyn FnMut(&[Viewpoint]),
) -> Vec<Viewpoint> {
    let (samples, index) = sample_courses(event, projection);
    let courses: Vec<Vec<Polyline>> =
        event.courses.iter().map(|c| c.polylines(projection)).collect();
    let in_roadway = |point: Point| {
        courses.iter().flatten().any(|line| line.nearest(point).offset < CLEARANCE_M)
    };
    let radius = event.spectator.sighting_radius_m;
    let mut all = Vec::new();
    let mut reported = 0;
    for node in 0..graph.node_count() {
        let point = graph.point(node);
        let seen: Vec<(&CourseSample, f64)> = index
            .locate_within_distance(coords(point), radius * radius)
            .map(|s| {
                (&samples[s.data], Euclidean.distance(point, Point::new(s.geom()[0], s.geom()[1])))
            })
            .collect();
        // The exact clearance test is costly; only nodes near a sample can be in the roadway.
        let nearest = seen.iter().map(|s| s.1).fold(f64::INFINITY, f64::min);
        if nearest < CLEARANCE_M + SAMPLE_SPACING_M / 2.0 && in_roadway(point) {
            continue;
        }
        let arcs = arcs(seen);
        if arcs.is_empty() {
            continue;
        }
        all.push(Viewpoint { node, point, arcs, sightings: Vec::new() });
        if all.len() - reported >= CANDIDATE_CHUNK {
            found(&all[reported..]);
            reported = all.len();
        }
    }
    if reported < all.len() {
        found(&all[reported..]);
    }
    all
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
                viewpoint.sightings.push(Sighting {
                    racer,
                    window: trajectory.window(
                        arc.start_m,
                        arc.end_m,
                        event.spectator.safety_buffer_s,
                    ),
                    expected: trajectory.expected_at((arc.start_m + arc.end_m) / 2.0),
                    kind: if arc.finish { Kind::Finish } else { Kind::Pass },
                });
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
                    if distance < event.spectator.skip_start_m {
                        continue;
                    }
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
    seen.chunk_by(|a, b| {
        a.0.course == b.0.course && b.0.distance - a.0.distance <= 1.5 * SAMPLE_SPACING_M
    })
    .map(arc_of)
    .collect()
}

fn arc_of(run: &[(&CourseSample, f64)]) -> Arc {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{ORIGIN, event, grid, latlon};

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
}

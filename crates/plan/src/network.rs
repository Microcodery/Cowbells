//! Shaping the shared routing graph for one plan: where the spectator may walk, and how finely
//! the network is cut up near the courses.

use birdseye_core::Event;
use birdseye_core::geom::{Point, Polyline, Projection};
use birdseye_routing::Graph;

/// Spectator edges this close to a course are split so viewpoints can sit mid-block.
const DENSIFY_SPACING_M: f64 = 20.0;
/// Edges with both ends this close to a course run along it; sidewalks mapped as their own
/// ways sit 3–6 m out and stay walkable.
const ROADWAY_M: f64 = 3.0;

/// The network the search runs on: `graph` densified near the courses, with the roadway itself
/// removed and, for a closed course, no way across it. `speed_factor` plans as if the spectator
/// moved that many times faster than the graph was built for; anything else is ignored.
pub fn prepare_graph(
    graph: &Graph,
    event: &Event,
    projection: &Projection,
    speed_factor: Option<f64>,
) -> Graph {
    let courses: Vec<Polyline> =
        event.courses.iter().flat_map(|c| c.polylines(projection)).collect();
    let course_points: Vec<Point> = courses.iter().flat_map(samples_along).collect();
    let mut graph = graph.clone();
    // Scale before densifying so the split edges inherit the scaled times.
    if let Some(factor) = speed_factor.filter(|f| *f > 0.0 && f.is_finite()) {
        graph.scale_speed(factor);
    }
    graph.densify_near(&course_points, event.spectator.sighting_radius_m, DENSIFY_SPACING_M);
    graph.clear_roadways(&courses, ROADWAY_M);
    if event.spectator.course_closed {
        graph.close_courses(&courses);
    }
    graph
}

fn samples_along(polyline: &Polyline) -> Vec<Point> {
    let steps = (polyline.length() / DENSIFY_SPACING_M).ceil().max(1.0) as usize;
    (0..=steps).map(|i| polyline.point_at(i as f64 * DENSIFY_SPACING_M)).collect()
}

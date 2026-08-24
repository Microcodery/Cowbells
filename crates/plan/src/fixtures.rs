//! A small grid event the viewpoint and itinerary tests both build on.

use birdseye_core::geom::{Point, Projection};
use birdseye_core::*;
use birdseye_routing::Graph;

pub const ORIGIN: LatLon = LatLon { lat: 45.0, lon: -122.0 };

/// 5×5 street grid, 100 m spacing, walked at 1 m/s; node (i, j) sits at (100 i, 100 j) metres.
pub fn grid() -> Graph {
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

pub fn latlon(x: f64, y: f64) -> LatLon {
    Projection::new(ORIGIN).to_latlon(Point::new(x, y))
}

/// One racer running west→east 10 m off the bottom row at 200 s per 100 m, spectator starting
/// a block north.
pub fn event() -> Event {
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
            prefer: Prefer::EnRoute,
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

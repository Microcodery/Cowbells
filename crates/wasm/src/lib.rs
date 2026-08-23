//! wasm-bindgen facade over the birdeye engine. Everything crosses as JSON strings.

use birdeye_core::geom::{Point, Projection};
use birdeye_core::{Event, TravelMode};
use birdeye_plan::{Options, ROADWAY_M};
use birdeye_routing::profile::default_speed;
use birdeye_routing::{Graph, Osm, TravelTime};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Spectator edges this close to a course are split so viewpoints can sit mid-block.
const DENSIFY_SPACING_M: f64 = 20.0;

#[wasm_bindgen]
pub fn ping(msg: &str) -> String {
    format!("birdeye {}: {msg}", birdeye_core::VERSION)
}

/// Validation errors for an event JSON document, as a JSON array of strings (empty when valid).
#[wasm_bindgen]
pub fn validate(event_json: &str) -> Result<String, JsError> {
    let event: Event = serde_json::from_str(event_json)?;
    let messages: Vec<String> = match event.validate() {
        Ok(()) => Vec::new(),
        Err(errors) => errors.iter().map(ToString::to_string).collect(),
    };
    Ok(serde_json::to_string(&messages)?)
}

/// Courses parsed from a GPX document, as JSON.
#[wasm_bindgen]
pub fn parse_gpx(xml: &str) -> Result<String, JsError> {
    let courses =
        birdeye_core::gpx::courses_from_gpx(xml).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(serde_json::to_string(&courses)?)
}

/// A routing graph built once per OSM extract and travel mode, reused across plans.
#[wasm_bindgen]
pub struct Network {
    graph: Graph,
    mode: TravelMode,
}

#[wasm_bindgen]
impl Network {
    /// `osm_json` is an Overpass response; `origin_json` is the event origin `{lat, lon}`;
    /// `speed_mps` is the spectator's pace, or a typical one for the mode when absent.
    #[wasm_bindgen(constructor)]
    pub fn new(
        osm_json: &str,
        origin_json: &str,
        mode: &str,
        speed_mps: Option<f64>,
    ) -> Result<Network, JsError> {
        let osm = Osm::parse(osm_json)?;
        let origin = serde_json::from_str(origin_json)?;
        let mode: TravelMode = serde_json::from_str(&format!("\"{mode}\""))?;
        let speed = speed_mps.unwrap_or_else(|| default_speed(mode));
        let graph = Graph::build(&osm, &Projection::new(origin), mode, speed);
        Ok(Network { graph, mode })
    }

    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }

    pub fn edge_count(&self) -> usize {
        self.graph.edge_count()
    }

    /// `{ itinerary, trace }` for `event_json`, as JSON; `trace` is null unless options ask for it.
    pub fn plan(&self, event_json: &str, options_json: &str) -> Result<String, JsError> {
        let event: Event = serde_json::from_str(event_json)?;
        if event.spectator.mode != self.mode {
            return Err(JsError::new("network was built for a different travel mode"));
        }
        if let Err(errors) = event.validate() {
            let messages: Vec<String> = errors.iter().map(ToString::to_string).collect();
            return Err(JsError::new(&messages.join("; ")));
        }
        let options: PlanOptions = serde_json::from_str(options_json)?;
        let projection = Projection::new(event.origin);
        let courses: Vec<_> = event.courses.iter().flat_map(|c| c.polylines(&projection)).collect();
        let course_points: Vec<Point> = courses.iter().flat_map(samples_along).collect();
        let mut graph = self.graph.clone();
        graph.densify_near(&course_points, event.spectator.sighting_radius_m, DENSIFY_SPACING_M);
        graph.clear_roadways(&courses, ROADWAY_M);
        if event.spectator.course_closed {
            graph.close_courses(&courses);
        }
        let solution = birdeye_plan::solve(
            &event,
            &graph,
            Options { beam: options.beam, trace: options.trace },
        )
        .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(serde_json::to_string(&solution)?)
    }
}

fn samples_along(polyline: &birdeye_core::geom::Polyline) -> Vec<Point> {
    let steps = (polyline.length() / DENSIFY_SPACING_M).ceil().max(1.0) as usize;
    (0..=steps).map(|i| polyline.point_at(i as f64 * DENSIFY_SPACING_M)).collect()
}

#[derive(Deserialize)]
struct PlanOptions {
    #[serde(default = "default_beam")]
    beam: usize,
    #[serde(default)]
    trace: bool,
}

fn default_beam() -> usize {
    Options::default().beam
}

#[cfg(test)]
mod tests {
    #[test]
    fn ping_format() {
        assert_eq!(super::ping("x"), format!("birdeye {}: x", birdeye_core::VERSION));
    }

    #[test]
    fn validate_reports_messages() {
        let json = r#"{"name":"e","origin":{"lat":0,"lon":0},"courses":[],"racers":[{"id":"r","name":"r","course_id":"x","pace_profile":[]}],
            "spectator":{"earliest":0,"mode":"walk"}}"#;
        let out = super::validate(json).unwrap();
        assert!(out.contains("unknown course"), "{out}");
    }
}

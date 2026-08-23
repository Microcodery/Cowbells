//! wasm-bindgen facade over the birdseye engine. Everything crosses as JSON strings.

use birdseye_core::geom::{Point, Projection};
use birdseye_core::{Event, TravelMode};
use birdseye_plan::trace::network_trace;
use birdseye_plan::{Options, Progress};
use birdseye_routing::profile::default_speed;
use birdseye_routing::{Graph, Osm, TravelTime};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Spectator edges this close to a course are split so viewpoints can sit mid-block.
const DENSIFY_SPACING_M: f64 = 20.0;
/// Edges with both ends this close to a course run along it; sidewalks mapped as their own
/// ways sit 3–6 m out and stay walkable.
const ROADWAY_M: f64 = 3.0;

#[wasm_bindgen]
pub fn ping(msg: &str) -> String {
    format!("birdseye {}: {msg}", birdseye_core::VERSION)
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

/// Courses parsed from a course file (GPX, KML, KMZ, TCX, FIT, GeoJSON), chosen by the
/// file name's extension, as JSON.
#[wasm_bindgen]
pub fn parse_courses(file_name: &str, bytes: &[u8]) -> Result<String, JsError> {
    let courses = birdseye_core::import::courses_from_file(file_name, bytes)
        .map_err(|e| JsError::new(&e.to_string()))?;
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

    /// The itinerary for `event_json`, as JSON. When options ask for a trace, `on_progress`
    /// receives each `Progress` stage as JSON while the engine works.
    pub fn plan(
        &self,
        event_json: &str,
        options_json: &str,
        on_progress: &js_sys::Function,
    ) -> Result<String, JsError> {
        let mut report = |progress: Progress| {
            let json = serde_json::to_string(&progress).unwrap_or_default();
            let _ = on_progress.call1(&JsValue::NULL, &JsValue::from_str(&json));
        };
        self.plan_with(event_json, options_json, &mut report).map_err(|e| JsError::new(&e))
    }
}

impl Network {
    /// `plan` without the JavaScript callback, for native callers and tests.
    pub fn plan_with(
        &self,
        event_json: &str,
        options_json: &str,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<String, String> {
        let event: Event = serde_json::from_str(event_json).map_err(|e| e.to_string())?;
        if event.spectator.mode != self.mode {
            return Err("network was built for a different travel mode".into());
        }
        if let Err(errors) = event.validate() {
            let messages: Vec<String> = errors.iter().map(ToString::to_string).collect();
            return Err(messages.join("; "));
        }
        let options: PlanOptions = serde_json::from_str(options_json).map_err(|e| e.to_string())?;
        let projection = Projection::new(event.origin);
        if options.trace {
            progress(Progress::Network { points: network_trace(&self.graph, &projection) });
        }
        let courses: Vec<_> = event.courses.iter().flat_map(|c| c.polylines(&projection)).collect();
        let course_points: Vec<Point> = courses.iter().flat_map(samples_along).collect();
        let mut graph = self.graph.clone();
        // Scale before densifying so the split edges inherit the scaled times.
        if let Some(factor) = options.speed_factor.filter(|f| *f > 0.0 && f.is_finite()) {
            graph.scale_speed(factor);
        }
        graph.densify_near(&course_points, event.spectator.sighting_radius_m, DENSIFY_SPACING_M);
        graph.clear_roadways(&courses, ROADWAY_M);
        if event.spectator.course_closed {
            graph.close_courses(&courses);
        }
        let options = Options { beam: options.beam, trace: options.trace };
        let itinerary = birdseye_plan::solve_with(&event, &graph, options, progress)
            .map_err(|e| e.to_string())?;
        serde_json::to_string(&itinerary).map_err(|e| e.to_string())
    }
}

fn samples_along(polyline: &birdseye_core::geom::Polyline) -> Vec<Point> {
    let steps = (polyline.length() / DENSIFY_SPACING_M).ceil().max(1.0) as usize;
    (0..=steps).map(|i| polyline.point_at(i as f64 * DENSIFY_SPACING_M)).collect()
}

#[derive(Deserialize)]
struct PlanOptions {
    #[serde(default = "default_beam")]
    beam: usize,
    #[serde(default)]
    trace: bool,
    /// Plan as if the spectator moved this many times faster than the network was built for.
    #[serde(default)]
    speed_factor: Option<f64>,
}

fn default_beam() -> usize {
    Options::default().beam
}

#[cfg(test)]
mod tests {
    #[test]
    fn ping_format() {
        assert_eq!(super::ping("x"), format!("birdseye {}: x", birdseye_core::VERSION));
    }

    #[test]
    fn validate_reports_messages() {
        let json = r#"{"name":"e","origin":{"lat":0,"lon":0},"courses":[],"racers":[{"id":"r","name":"r","course_id":"x","pace_profile":[]}],
            "spectator":{"earliest":0,"mode":"walk"}}"#;
        let out = super::validate(json).unwrap();
        assert!(out.contains("unknown course"), "{out}");
    }
}

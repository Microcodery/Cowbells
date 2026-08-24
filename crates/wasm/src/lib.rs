//! wasm-bindgen facade over the cowbells engine. Everything crosses as JSON strings.

use cowbells_core::geom::Projection;
use cowbells_core::{Event, TravelMode};
use cowbells_plan::{Options, Progress, network_trace, prepare_graph};
use cowbells_routing::profile::default_speed;
use cowbells_routing::{Graph, Osm, TravelTime};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    cowbells_core::VERSION.into()
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
    let courses = cowbells_import::courses_from_file(file_name, bytes)
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
        let mode: TravelMode = mode.parse().map_err(|e: String| JsError::new(&e))?;
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
            let json = serde_json::to_string(&progress).expect("progress serializes");
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
        let graph = prepare_graph(&self.graph, &event, &projection, options.speed_factor);
        let solver_options = Options { beam: options.beam, trace: options.trace };
        let itinerary = cowbells_plan::solve_with(&event, &graph, solver_options, progress)
            .map_err(|e| e.to_string())?;
        serde_json::to_string(&itinerary).map_err(|e| e.to_string())
    }
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
    fn version_matches_the_crate() {
        assert_eq!(super::version(), cowbells_core::VERSION);
    }

    #[test]
    fn validate_reports_messages() {
        let json = r#"{"name":"e","origin":{"lat":0,"lon":0},"courses":[],"racers":[{"id":"r","name":"r","course_id":"x","pace_profile":[]}],
            "spectator":{"earliest":0,"mode":"walk"}}"#;
        let out = super::validate(json).unwrap();
        assert!(out.contains("unknown course"), "{out}");
    }
}

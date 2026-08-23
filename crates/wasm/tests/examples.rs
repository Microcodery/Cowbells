//! The shipped examples double as end-to-end regressions: each must plan to the levels below.

use std::path::Path;

use birdeye_wasm::Network;
use serde_json::Value;

struct Expected {
    name: &'static str,
    seen_en_route: usize,
    finished: usize,
    racers: usize,
    stops: usize,
}

const EXPECTED: &[Expected] = &[
    Expected { name: "downtown-loop", seen_en_route: 2, finished: 2, racers: 2, stops: 3 },
    Expected { name: "three-distances", seen_en_route: 5, finished: 2, racers: 5, stops: 3 },
    Expected { name: "hawthorne-belmont", seen_en_route: 6, finished: 3, racers: 6, stops: 3 },
];

fn plan(name: &str) -> (Value, Value) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../web/public/examples/{name}.bird"));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let event = &saved["event"];
    let spectator = &event["spectator"];
    let network = Network::new(
        saved["osm"].as_str().unwrap(),
        &event["origin"].to_string(),
        spectator["mode"].as_str().unwrap(),
        spectator["speed_mps"].as_f64(),
    )
    .unwrap();
    let solution: Value =
        serde_json::from_str(&network.plan(&event.to_string(), "{}").unwrap()).unwrap();
    (event.clone(), solution["itinerary"].clone())
}

#[test]
fn examples_plan_to_their_expected_levels() {
    for expected in EXPECTED {
        let (event, itinerary) = plan(expected.name);
        let stops = itinerary["stops"].as_array().unwrap();
        let mut seen = std::collections::HashSet::new();
        let mut finished = std::collections::HashSet::new();
        for sighting in stops.iter().flat_map(|s| s["seen"].as_array().unwrap()) {
            let racer = sighting["racer_id"].as_str().unwrap().to_string();
            if sighting["kind"] == "finish" {
                finished.insert(racer)
            } else {
                seen.insert(racer)
            };
        }
        let got =
            (seen.len(), finished.len(), event["racers"].as_array().unwrap().len(), stops.len());
        let want = (expected.seen_en_route, expected.finished, expected.racers, expected.stops);
        assert_eq!(got, want, "{}: (seen en route, finished, racers, stops)", expected.name);
    }
}

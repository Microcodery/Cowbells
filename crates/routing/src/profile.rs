//! Which OSM ways each travel mode may use, how fast, and in which direction.

use birdseye_core::TravelMode;

use crate::osm::Way;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Both,
    /// Only in the way's node order.
    Forward,
    /// Only against the way's node order (`oneway=-1`).
    Backward,
}

/// How a way may be traversed by a mode.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Passage {
    pub metres_per_second: f64,
    pub direction: Direction,
}

const WALK_SPEED: f64 = 1.3;
const BIKE_SPEED: f64 = 4.5;
/// Stairs are climbed at this fraction of walking speed.
const STEPS_FACTOR: f64 = 0.5;
const KMH: f64 = 1000.0 / 3600.0;

/// A typical speed for the mode, used when the spectator gives none.
pub fn default_speed(mode: TravelMode) -> f64 {
    match mode {
        TravelMode::Walk => WALK_SPEED,
        TravelMode::Bike => BIKE_SPEED,
        TravelMode::Drive => 50.0 * KMH,
    }
}

/// How `mode` may use `way`; `speed` is the spectator's own pace on ordinary ways
/// (driving follows posted limits instead).
pub fn passage(mode: TravelMode, way: &Way, speed: f64) -> Option<Passage> {
    let highway = way.tag("highway")?;
    match mode {
        TravelMode::Walk => walk(highway, way, speed),
        TravelMode::Bike => bike(highway, way, speed),
        TravelMode::Drive => drive(highway, way),
    }
}

/// Whether the mode may leave the road network and cut across open ground.
pub fn crosses_open_ground(mode: TravelMode) -> bool {
    matches!(mode, TravelMode::Walk | TravelMode::Bike)
}

/// Parks, plazas, and similar areas a pedestrian or cyclist may cross freely.
pub fn is_open_area(way: &Way) -> bool {
    way.is_closed()
        && (matches!(way.tag("leisure"), Some("park" | "garden" | "pitch" | "playground"))
            || matches!(way.tag("landuse"), Some("grass" | "recreation_ground" | "village_green"))
            || way.tag("amenity") == Some("parking")
            || way.tag("place") == Some("square")
            || (way.tag("highway") == Some("pedestrian") && way.tag("area") == Some("yes")))
}

/// The most specific access tag wins over the generic `access`; `no` and `private` close the way.
fn permitted(way: &Way, mode_tags: &[&str]) -> bool {
    let value = mode_tags.iter().find_map(|t| way.tag(t)).or_else(|| way.tag("access"));
    !matches!(value, Some("no" | "private"))
}

fn direction(way: &Way) -> Direction {
    let roundabout = matches!(way.tag("junction"), Some("roundabout" | "circular"));
    match way.tag("oneway") {
        Some("yes") => Direction::Forward,
        Some("-1") => Direction::Backward,
        None if roundabout => Direction::Forward,
        _ => Direction::Both,
    }
}

fn walk(highway: &str, way: &Way, speed: f64) -> Option<Passage> {
    let allowed = matches!(
        highway,
        "footway"
            | "path"
            | "pedestrian"
            | "steps"
            | "living_street"
            | "residential"
            | "tertiary"
            | "secondary"
            | "primary"
            | "trunk"
            | "unclassified"
            | "service"
            | "track"
            | "cycleway"
            | "corridor"
            | "platform"
            | "tertiary_link"
            | "secondary_link"
            | "primary_link"
            | "trunk_link"
    );
    let speed = if highway == "steps" { speed * STEPS_FACTOR } else { speed };
    (allowed && permitted(way, &["foot"]))
        .then_some(Passage { metres_per_second: speed, direction: Direction::Both })
}

fn bike(highway: &str, way: &Way, speed: f64) -> Option<Passage> {
    let rideable = matches!(
        highway,
        "cycleway"
            | "path"
            | "living_street"
            | "residential"
            | "tertiary"
            | "secondary"
            | "primary"
            | "unclassified"
            | "service"
            | "track"
            | "tertiary_link"
            | "secondary_link"
            | "primary_link"
    );
    let shared_footway =
        matches!(highway, "footway" | "pedestrian") && way.tag("bicycle") == Some("yes");
    if !(rideable || shared_footway) || !permitted(way, &["bicycle", "vehicle"]) {
        return None;
    }
    let speed = if way.tag("bicycle") == Some("dismount") { WALK_SPEED } else { speed };
    let direction = match way.tag("oneway:bicycle") {
        Some("no") => Direction::Both,
        Some("yes") => Direction::Forward,
        Some("-1") => Direction::Backward,
        _ => direction(way),
    };
    Some(Passage { metres_per_second: speed, direction })
}

fn drive(highway: &str, way: &Way) -> Option<Passage> {
    let default_kmh = match highway {
        "motorway" | "motorway_link" => 100.0,
        "trunk" | "trunk_link" => 80.0,
        "primary" | "primary_link" => 60.0,
        "secondary" | "secondary_link" => 50.0,
        "tertiary" | "tertiary_link" | "unclassified" => 40.0,
        "residential" => 30.0,
        "living_street" | "service" => 15.0,
        _ => return None,
    };
    if !permitted(way, &["motor_vehicle", "vehicle"]) {
        return None;
    }
    let kmh = way.tag("maxspeed").and_then(parse_maxspeed_kmh).unwrap_or(default_kmh);
    Some(Passage { metres_per_second: kmh * KMH, direction: direction(way) })
}

fn parse_maxspeed_kmh(value: &str) -> Option<f64> {
    let value = value.trim();
    match value {
        "walk" => Some(7.0),
        "none" => Some(130.0),
        _ => match value.strip_suffix("mph") {
            Some(mph) => mph.trim().parse::<f64>().ok().map(|v| v * 1.609_344),
            None => value.strip_suffix("km/h").unwrap_or(value).trim().parse().ok(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osm::Tags;

    fn way(pairs: &[(&str, &str)]) -> Way {
        let tags: Tags = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Way { nodes: vec![1, 2], tags }
    }

    fn walking(pairs: &[(&str, &str)]) -> Option<Passage> {
        passage(TravelMode::Walk, &way(pairs), WALK_SPEED)
    }
    fn cycling(pairs: &[(&str, &str)]) -> Option<Passage> {
        passage(TravelMode::Bike, &way(pairs), BIKE_SPEED)
    }
    fn driving(pairs: &[(&str, &str)]) -> Option<Passage> {
        passage(TravelMode::Drive, &way(pairs), 0.0)
    }

    #[test]
    fn walking_uses_paths_and_streets_but_not_motorways() {
        assert!(walking(&[("highway", "footway")]).is_some());
        assert_eq!(
            walking(&[("highway", "primary"), ("oneway", "yes")]).unwrap().direction,
            Direction::Both
        );
        assert!(walking(&[("highway", "trunk")]).is_some());
        assert!(walking(&[("highway", "motorway")]).is_none());
        assert_eq!(
            walking(&[("highway", "steps")]).unwrap().metres_per_second,
            WALK_SPEED * STEPS_FACTOR
        );
        assert_eq!(
            passage(TravelMode::Walk, &way(&[("highway", "path")]), 2.0).unwrap().metres_per_second,
            2.0
        );
    }

    #[test]
    fn access_tags_are_mode_specific() {
        assert!(walking(&[("highway", "path"), ("foot", "no")]).is_none());
        assert!(walking(&[("highway", "path"), ("foot", "private")]).is_none());
        assert!(walking(&[("highway", "service"), ("access", "private")]).is_none());
        assert!(
            walking(&[("highway", "service"), ("access", "private"), ("foot", "yes")]).is_some()
        );
        assert!(cycling(&[("highway", "track"), ("vehicle", "no")]).is_none());
        assert!(cycling(&[("highway", "track"), ("vehicle", "no"), ("bicycle", "yes")]).is_some());
        assert!(driving(&[("highway", "residential"), ("motor_vehicle", "no")]).is_none());
    }

    #[test]
    fn cycling_respects_oneway_and_bicycle_tags() {
        assert_eq!(
            cycling(&[("highway", "residential"), ("oneway", "yes")]).unwrap().direction,
            Direction::Forward
        );
        assert_eq!(
            cycling(&[("highway", "residential"), ("oneway", "-1")]).unwrap().direction,
            Direction::Backward
        );
        assert_eq!(
            cycling(&[("highway", "residential"), ("oneway", "yes"), ("oneway:bicycle", "no")])
                .unwrap()
                .direction,
            Direction::Both
        );
        assert!(cycling(&[("highway", "footway")]).is_none());
        assert!(cycling(&[("highway", "footway"), ("bicycle", "yes")]).is_some());
        assert_eq!(
            cycling(&[("highway", "path"), ("bicycle", "dismount")]).unwrap().metres_per_second,
            WALK_SPEED
        );
        assert!(cycling(&[("highway", "steps")]).is_none());
    }

    #[test]
    fn driving_reads_maxspeed_and_roundabouts() {
        let mps = |pairs: &[(&str, &str)]| driving(pairs).unwrap().metres_per_second;
        assert!((mps(&[("highway", "residential"), ("maxspeed", "20 mph")]) - 8.94).abs() < 0.01);
        assert!((mps(&[("highway", "residential"), ("maxspeed", "50 km/h")]) - 13.89).abs() < 0.01);
        assert!((mps(&[("highway", "living_street"), ("maxspeed", "walk")]) - 1.94).abs() < 0.01);
        assert!((mps(&[("highway", "primary")]) - 16.67).abs() < 0.01);
        assert_eq!(
            driving(&[("highway", "primary"), ("junction", "roundabout")]).unwrap().direction,
            Direction::Forward
        );
        assert!(driving(&[("highway", "footway")]).is_none());
    }

    #[test]
    fn open_areas_are_closed_polygons_with_area_tags() {
        let mut park = way(&[("leisure", "park")]);
        assert!(!is_open_area(&park));
        park.nodes = vec![1, 2, 3, 1];
        assert!(is_open_area(&park));
    }
}

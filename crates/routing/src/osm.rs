//! The subset of an Overpass JSON response we use.

use std::collections::HashMap;

use cowbells_core::LatLon;
use serde::Deserialize;

pub type Tags = HashMap<String, String>;

#[derive(Debug, Clone, Deserialize)]
pub struct Way {
    pub nodes: Vec<i64>,
    #[serde(default)]
    pub tags: Tags,
}

impl Way {
    pub fn tag(&self, key: &str) -> Option<&str> {
        self.tags.get(key).map(String::as_str)
    }

    /// A ring: at least a triangle, ending where it starts.
    pub fn is_closed(&self) -> bool {
        self.nodes.len() > 3 && self.nodes.first() == self.nodes.last()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Osm {
    pub nodes: HashMap<i64, LatLon>,
    pub ways: Vec<Way>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Element {
    Node {
        id: i64,
        lat: f64,
        lon: f64,
    },
    Way(Way),
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Response {
    elements: Vec<Element>,
}

impl Osm {
    pub fn parse(json: &str) -> Result<Self, serde_json::Error> {
        let response: Response = serde_json::from_str(json)?;
        let mut osm = Osm::default();
        for element in response.elements {
            match element {
                Element::Node { id, lat, lon } => {
                    osm.nodes.insert(id, LatLon { lat, lon });
                }
                Element::Way(way) => osm.ways.push(way),
                Element::Other => {}
            }
        }
        Ok(osm)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/small.json");

    #[test]
    fn parses_nodes_and_ways_and_ignores_relations() {
        let osm = Osm::parse(FIXTURE).unwrap();
        assert_eq!(osm.nodes.len(), 9);
        assert_eq!(osm.ways.len(), 5);
        let park = osm.ways.iter().find(|w| w.tag("leisure") == Some("park")).unwrap();
        assert!(park.is_closed());
        assert!(!osm.ways[0].is_closed());
    }
}

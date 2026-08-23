//! OpenStreetMap graph construction and travel-time queries.

pub mod graph;
pub mod osm;
pub mod profile;

use birdeye_core::Seconds;
use birdeye_core::geom::Point;
pub use graph::{Graph, NodeId};
pub use osm::Osm;

/// What the planner needs from a road network.
pub trait TravelTime {
    /// Nearest node within `max_distance` metres of `p`.
    fn snap(&self, p: Point, max_distance: f64) -> Option<NodeId>;
    fn node_count(&self) -> usize;
    fn point(&self, id: NodeId) -> Point;
    fn time(&self, from: NodeId, to: NodeId) -> Option<Seconds>;
    fn path(&self, from: NodeId, to: NodeId) -> Option<Vec<Point>>;
    /// Pairwise times between `nodes`; `None` where unreachable.
    fn matrix(&self, nodes: &[NodeId]) -> Vec<Vec<Option<Seconds>>>;
}

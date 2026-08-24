//! OpenStreetMap graph construction and travel-time queries.

pub mod graph;
pub mod osm;
pub mod profile;

use cowbells_core::Seconds;
use cowbells_core::geom::Point;
pub use graph::{Graph, NodeId};
pub use osm::Osm;

/// What the planner needs from a road network.
pub trait TravelTime {
    /// Nearest node within `max_distance` metres of `p`.
    fn snap(&self, p: Point, max_distance: f64) -> Option<NodeId>;
    fn node_count(&self) -> usize;
    fn point(&self, id: NodeId) -> Point;
    /// Pairwise times plus the shortest-path trees behind them, for cheap paths afterwards.
    fn routes(&self, nodes: &[NodeId]) -> Routes;
}

/// Shortest-path trees from each of a set of nodes: any path out of one is a backtrack.
pub struct Routes {
    pub times: Vec<Vec<Option<Seconds>>>,
    /// `trees[i][node]` is the node before `node` on the way from source `i`; `NO_NODE` if none.
    trees: Vec<Vec<u32>>,
    sources: Vec<NodeId>,
}

const NO_NODE: u32 = u32::MAX;

impl Routes {
    pub(crate) fn new(sources: &[NodeId], rows: Vec<(Vec<Seconds>, Vec<Option<NodeId>>)>) -> Self {
        let times = rows
            .iter()
            .map(|(cost, _)| {
                sources.iter().map(|&to| cost[to].is_finite().then_some(cost[to])).collect()
            })
            .collect();
        let trees = rows
            .into_iter()
            .map(|(_, previous)| {
                previous.into_iter().map(|p| p.map_or(NO_NODE, |n| n as u32)).collect()
            })
            .collect();
        Self { times, trees, sources: sources.to_vec() }
    }

    /// The path from source `from` (an index into the sources) to `to`, as points.
    pub fn path(&self, graph: &impl TravelTime, from: usize, to: NodeId) -> Option<Vec<Point>> {
        let tree = &self.trees[from];
        let mut path = vec![graph.point(to)];
        let mut node = to;
        while node != self.sources[from] {
            let previous = tree[node];
            if previous == NO_NODE {
                return None;
            }
            node = previous as NodeId;
            path.push(graph.point(node));
        }
        path.reverse();
        Some(path)
    }
}

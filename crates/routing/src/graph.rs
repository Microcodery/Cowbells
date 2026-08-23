//! Directed travel-time graph built from OSM ways.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use birdseye_core::geom::{Point, Polygon, Polyline, Projection, chord_inside, coords};
use birdseye_core::{Seconds, TravelMode};
use geo::line_intersection::{LineIntersection, line_intersection};
use geo::{BoundingRect, Distance, Euclidean, Intersects, Line, LineString};
use rstar::primitives::GeomWithData;
use rstar::{AABB, RTree};

use crate::Routes;
use crate::TravelTime;
use crate::osm::Osm;
use crate::profile::{Direction, Passage, is_open_area, open_area_speed, passage};

pub type NodeId = usize;

/// Each node in an open area gets shortcuts to this many nearest neighbours inside it; a full
/// mesh is quadratic and buys nothing once chords can chain.
const OPEN_AREA_NEIGHBOURS: usize = 8;
/// A chord saves at most the area's span; below this (a corner parking lot) that is seconds,
/// and city extracts hold thousands of them.
const MIN_OPEN_AREA_SPAN_M: f64 = 60.0;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Edge {
    to: NodeId,
    seconds: Seconds,
}

type Indexed = GeomWithData<[f64; 2], NodeId>;

#[derive(Debug, Clone)]
pub struct Graph {
    points: Vec<Point>,
    edges: Vec<Vec<Edge>>,
    index: RTree<Indexed>,
}

impl Graph {
    pub fn new(points: Vec<Point>) -> Self {
        let indexed =
            points.iter().enumerate().map(|(id, p)| Indexed::new(coords(*p), id)).collect();
        Self { edges: vec![Vec::new(); points.len()], index: RTree::bulk_load(indexed), points }
    }

    /// `speed` is the spectator's pace in m/s on ordinary ways.
    pub fn build(osm: &Osm, projection: &Projection, mode: TravelMode, speed: f64) -> Self {
        let usable: Vec<_> =
            osm.ways.iter().filter_map(|w| passage(mode, w, speed).map(|p| (w, p))).collect();
        let mut ids = HashMap::new();
        let mut points = Vec::new();
        for (way, _) in &usable {
            for osm_id in &way.nodes {
                if let Some(&latlon) = osm.nodes.get(osm_id) {
                    ids.entry(*osm_id).or_insert_with(|| {
                        points.push(projection.to_local(latlon));
                        points.len() - 1
                    });
                }
            }
        }
        let mut graph = Graph::new(points);
        for (way, Passage { metres_per_second, direction }) in usable {
            // A node missing from the extract breaks the way rather than bridging the gap.
            for run in way.nodes.split(|id| !ids.contains_key(id)) {
                for pair in run.windows(2) {
                    let (a, b) = (ids[&pair[0]], ids[&pair[1]]);
                    let seconds = graph.distance(a, b) / metres_per_second;
                    match direction {
                        Direction::Both => graph.add_edge_both_ways(a, b, seconds),
                        Direction::Forward => graph.add_edge(a, b, seconds),
                        Direction::Backward => graph.add_edge(b, a, seconds),
                    }
                }
            }
        }
        if let Some(speed) = open_area_speed(mode, speed) {
            for way in osm.ways.iter().filter(|w| is_open_area(w)) {
                let ring: Vec<_> = way
                    .nodes
                    .iter()
                    .filter_map(|id| osm.nodes.get(id))
                    .map(|&p| projection.to_local(p))
                    .collect();
                let polygon = Polygon::new(LineString::from(ring), vec![]);
                let spans = polygon.bounding_rect().is_some_and(|r| {
                    Euclidean.distance(Point::from(r.min()), Point::from(r.max())) >= MIN_OPEN_AREA_SPAN_M
                });
                if spans {
                    graph.add_open_area(&polygon, speed);
                }
            }
        }
        graph
    }

    pub fn add_edge(&mut self, from: NodeId, to: NodeId, seconds: Seconds) {
        self.edges[from].push(Edge { to, seconds });
    }

    pub fn add_edge_both_ways(&mut self, a: NodeId, b: NodeId, seconds: Seconds) {
        self.add_edge(a, b, seconds);
        self.add_edge(b, a, seconds);
    }

    pub fn edge_count(&self) -> usize {
        self.edges.iter().map(Vec::len).sum()
    }

    /// Split edges that pass within `radius` of any of `points` into pieces no longer than
    /// `spacing`, so viewpoints can sit mid-block rather than only at intersections.
    pub fn densify_near(&mut self, points: &[Point], radius: f64, spacing: f64) {
        let near = RTree::bulk_load(points.iter().map(|p| coords(*p)).collect());
        let mut chains: HashMap<(NodeId, NodeId), Vec<NodeId>> = HashMap::new();
        let old_edges = std::mem::take(&mut self.edges);
        self.edges = vec![Vec::new(); self.points.len()];
        for (from, edges) in old_edges.into_iter().enumerate() {
            for Edge { to, seconds } in edges {
                let key = (from.min(to), from.max(to));
                let chain = chains
                    .entry(key)
                    .or_insert_with(|| self.subdivide(key, &near, radius, spacing));
                let mut path: Vec<NodeId> =
                    std::iter::once(key.0).chain(chain.iter().copied()).chain([key.1]).collect();
                if from != key.0 {
                    path.reverse();
                }
                let piece = seconds / (path.len() - 1) as f64;
                for pair in path.windows(2) {
                    self.edges[pair[0]].push(Edge { to: pair[1], seconds: piece });
                }
            }
        }
        let indexed =
            self.points.iter().enumerate().map(|(id, p)| Indexed::new(coords(*p), id)).collect();
        self.index = RTree::bulk_load(indexed);
    }

    /// Intermediate nodes along `a`→`b` when the edge is long and passes near a point of interest.
    fn subdivide(
        &mut self,
        (a, b): (NodeId, NodeId),
        near: &RTree<[f64; 2]>,
        radius: f64,
        spacing: f64,
    ) -> Vec<NodeId> {
        let (p, q) = (self.points[a], self.points[b]);
        let length = Euclidean.distance(p, q);
        let mid = Point::new((p.x() + q.x()) / 2.0, (p.y() + q.y()) / 2.0);
        let close = near.nearest_neighbor(coords(mid)).is_some_and(|n| {
            Euclidean.distance(mid, Point::new(n[0], n[1])) <= radius + length / 2.0
        });
        if !close || length <= spacing {
            return Vec::new();
        }
        let pieces = (length / spacing).ceil() as usize;
        (1..pieces)
            .map(|i| {
                let t = i as f64 / pieces as f64;
                self.points
                    .push(Point::new(p.x() + t * (q.x() - p.x()), p.y() + t * (q.y() - p.y())));
                self.edges.push(Vec::new());
                self.points.len() - 1
            })
            .collect()
    }

    pub fn distance(&self, a: NodeId, b: NodeId) -> f64 {
        Euclidean.distance(self.points[a], self.points[b])
    }

    /// Straight-line links between nodes in an open area whenever the chord stays inside it.
    pub fn add_open_area(&mut self, polygon: &Polygon, metres_per_second: f64) {
        let inside = self.nodes_inside(polygon);
        let local = RTree::bulk_load(
            inside.iter().map(|&id| Indexed::new(coords(self.points[id]), id)).collect(),
        );
        for &a in &inside {
            let nearest = local.nearest_neighbor_iter(coords(self.points[a])).map(|n| n.data);
            for b in nearest.filter(|&b| b != a).take(OPEN_AREA_NEIGHBOURS) {
                if !self.has_edge(a, b) && chord_inside(polygon, self.points[a], self.points[b]) {
                    self.add_edge_both_ways(a, b, self.distance(a, b) / metres_per_second);
                }
            }
        }
    }

    /// Drop edges that cross a closed course so the spectator routes around it.
    /// Edges that only end on the course survive, so viewpoints on it stay reachable.
    pub fn close_courses(&mut self, courses: &[Polyline]) {
        let course_lines: Vec<Line> = courses
            .iter()
            .flat_map(|c| LineString::from_iter(c.points()).lines().collect::<Vec<_>>())
            .collect();
        for from in 0..self.points.len() {
            let origin = self.points[from];
            self.edges[from].retain(|e| {
                let edge = Line::new(origin, self.points[e.to]);
                !course_lines.iter().any(|l| crosses(edge, *l))
            });
        }
    }

    /// Every edge takes `1 / factor` as long: the spectator moving `factor` times faster.
    pub fn scale_speed(&mut self, factor: f64) {
        for edge in self.edges.iter_mut().flatten() {
            edge.seconds /= factor;
        }
    }

    /// Drop edges running along a course: the roadway belongs to the racers, so the spectator
    /// keeps to sidewalks and other streets. Edges that merely touch or cross the course survive.
    pub fn clear_roadways(&mut self, courses: &[Polyline], width: f64) {
        // Sampling the course finer than `width` guarantees every node within `width` of
        // it is within `2 * width` of a sample, so only those need the exact test.
        let mut in_roadway = vec![false; self.points.len()];
        for course in courses {
            let mut along = 0.0;
            while along <= course.length() {
                let sample = coords(course.point_at(along));
                for node in self.index.locate_within_distance(sample, 4.0 * width * width) {
                    in_roadway[node.data] = true;
                }
                along += width;
            }
        }
        for (flag, point) in in_roadway.iter_mut().zip(&self.points) {
            *flag = *flag && courses.iter().any(|c| c.nearest(*point).offset < width);
        }
        for from in (0..self.points.len()).filter(|&n| in_roadway[n]) {
            self.edges[from].retain(|e| !in_roadway[e.to]);
        }
    }

    fn nodes_inside(&self, polygon: &Polygon) -> Vec<NodeId> {
        let Some(rect) = polygon.bounding_rect() else { return Vec::new() };
        let bounds = AABB::from_corners([rect.min().x, rect.min().y], [rect.max().x, rect.max().y]);
        self.index
            .locate_in_envelope(bounds)
            .map(|n| n.data)
            .filter(|&id| polygon.intersects(&self.points[id]))
            .collect()
    }

    fn has_edge(&self, a: NodeId, b: NodeId) -> bool {
        self.edges[a].iter().any(|e| e.to == b)
    }

    /// Shortest times from `source`, stopping once every `target` is settled.
    fn dijkstra(&self, source: NodeId, targets: &[NodeId]) -> (Vec<Seconds>, Vec<Option<NodeId>>) {
        let mut cost = vec![f64::INFINITY; self.points.len()];
        let mut previous = vec![None; self.points.len()];
        let mut heap = BinaryHeap::new();
        let mut wanted = vec![false; self.points.len()];
        for &t in targets {
            wanted[t] = t != source;
        }
        let mut unsettled = wanted.iter().filter(|&&w| w).count();
        cost[source] = 0.0;
        heap.push(Visit { seconds: 0.0, node: source });
        while let Some(Visit { seconds, node }) = heap.pop() {
            if seconds > cost[node] {
                continue;
            }
            if wanted[node] {
                unsettled -= 1;
                if unsettled == 0 {
                    break;
                }
            }
            for edge in &self.edges[node] {
                let next = seconds + edge.seconds;
                if next < cost[edge.to] {
                    cost[edge.to] = next;
                    previous[edge.to] = Some(node);
                    heap.push(Visit { seconds: next, node: edge.to });
                }
            }
        }
        (cost, previous)
    }
}

/// True for a genuine crossing or overlap, not for merely sharing an endpoint.
fn crosses(a: Line, b: Line) -> bool {
    matches!(
        line_intersection(a, b),
        Some(LineIntersection::SinglePoint { is_proper: true, .. })
            | Some(LineIntersection::Collinear { .. })
    )
}

impl TravelTime for Graph {
    fn snap(&self, p: Point, max_distance: f64) -> Option<NodeId> {
        let nearest = self.index.nearest_neighbor(coords(p))?;
        (Euclidean.distance(p, self.points[nearest.data]) <= max_distance).then_some(nearest.data)
    }

    fn node_count(&self) -> usize {
        self.points.len()
    }

    fn point(&self, id: NodeId) -> Point {
        self.points[id]
    }

    fn time(&self, from: NodeId, to: NodeId) -> Option<Seconds> {
        let (cost, _) = self.dijkstra(from, &[to]);
        cost[to].is_finite().then_some(cost[to])
    }

    fn path(&self, from: NodeId, to: NodeId) -> Option<Vec<Point>> {
        let (cost, previous) = self.dijkstra(from, &[to]);
        if !cost[to].is_finite() {
            return None;
        }
        let mut path = vec![self.points[to]];
        let mut node = to;
        while let Some(prev) = previous[node] {
            path.push(self.points[prev]);
            node = prev;
        }
        path.reverse();
        Some(path)
    }

    fn matrix(&self, nodes: &[NodeId]) -> Vec<Vec<Option<Seconds>>> {
        self.routes(nodes).times
    }

    fn routes(&self, nodes: &[NodeId]) -> Routes {
        Routes::new(nodes, nodes.iter().map(|&from| self.dijkstra(from, nodes)).collect())
    }
}

/// Heap entry ordered so the smallest time pops first.
#[derive(PartialEq)]
struct Visit {
    seconds: Seconds,
    node: NodeId,
}

impl Eq for Visit {}

impl Ord for Visit {
    fn cmp(&self, other: &Self) -> Ordering {
        other.seconds.total_cmp(&self.seconds).then_with(|| other.node.cmp(&self.node))
    }
}

impl PartialOrd for Visit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use approx::assert_abs_diff_eq;
    use birdseye_core::LatLon;
    use geo::polygon;

    use super::*;

    struct Fixture {
        graph: Graph,
        osm: Osm,
        projection: Projection,
    }

    impl Fixture {
        fn build(mode: TravelMode) -> Self {
            let osm = Osm::parse(include_str!("../tests/fixtures/small.json")).unwrap();
            let projection = Projection::new(LatLon { lat: 45.0, lon: -122.0 });
            let graph = Graph::build(&osm, &projection, mode, crate::profile::default_speed(mode));
            Self { graph, osm, projection }
        }

        /// Graph node for an OSM node id.
        fn at(&self, id: i64) -> NodeId {
            self.graph.snap(self.projection.to_local(self.osm.nodes[&id]), 1.0).unwrap()
        }
    }

    /// 3×3 lattice with unit spacing and one second per edge.
    fn lattice() -> Graph {
        let points = (0..9).map(|i| Point::new((i % 3) as f64, (i / 3) as f64)).collect();
        let mut graph = Graph::new(points);
        for i in 0..9 {
            if i % 3 < 2 {
                graph.add_edge_both_ways(i, i + 1, 1.0);
            }
            if i / 3 < 2 {
                graph.add_edge_both_ways(i, i + 3, 1.0);
            }
        }
        graph
    }

    #[test]
    fn lattice_routing() {
        let g = lattice();
        assert_eq!(g.time(0, 8), Some(4.0));
        assert_eq!(g.path(0, 2).unwrap().len(), 3);
        assert_eq!(g.snap(Point::new(1.2, 0.9), 0.5), Some(4));
        assert_eq!(g.snap(Point::new(9.0, 9.0), 0.5), None);
        assert_eq!(g.matrix(&[0, 8])[0][1], Some(4.0));
    }

    #[test]
    fn unreachable_is_none() {
        let lonely = Graph::new(vec![Point::new(0.0, 0.0), Point::new(1.0, 0.0)]);
        assert_eq!(lonely.time(0, 1), None);
        assert_eq!(lonely.path(0, 1), None);
        assert_eq!(lonely.matrix(&[0, 1])[0], vec![Some(0.0), None]);
    }

    #[test]
    fn walking_graph_skips_motorway_and_adds_park_shortcut() {
        let f = Fixture::build(TravelMode::Walk);
        assert_eq!(f.graph.node_count(), 7);
        let (g, a, b, corner) = (&f.graph, f.at(5), f.at(7), f.at(4));
        let direct = g.time(a, b).unwrap();
        let around = (g.distance(a, corner) + g.distance(corner, b)) / 1.3;
        assert!(direct < around, "park diagonal {direct} should beat {around}");
        assert_abs_diff_eq!(direct, g.distance(a, b) / 1.3, epsilon = 1e-9);
    }

    #[test]
    fn driving_respects_reversed_oneway() {
        let f = Fixture::build(TravelMode::Drive);
        assert!(f.graph.time(f.at(6), f.at(4)).is_some());
        assert_eq!(f.graph.time(f.at(4), f.at(6)), None);
    }

    #[test]
    fn closing_a_course_removes_crossing_edges() {
        let mut g = lattice();
        let course = Polyline::new(vec![Point::new(1.5, -1.0), Point::new(1.5, 3.0)]);
        g.close_courses(&[course]);
        assert_eq!(g.time(0, 2), None);
        assert_eq!(g.time(0, 6), Some(2.0));
    }

    #[test]
    fn scaling_speed_shortens_every_edge() {
        let mut g = lattice();
        g.scale_speed(2.0);
        assert_eq!(g.time(0, 2), Some(1.0));
    }

    #[test]
    fn clearing_roadways_keeps_cross_streets() {
        let mut g = lattice();
        let course = Polyline::new(vec![Point::new(-1.0, 0.0), Point::new(3.0, 0.0)]);
        g.clear_roadways(&[course], 0.1);
        assert!(!g.has_edge(0, 1), "along the course");
        assert_eq!(g.time(0, 3), Some(1.0), "away from the course");
        assert_eq!(g.time(0, 1), Some(3.0), "around the block instead");
    }

    #[test]
    fn densify_splits_only_edges_near_the_course() {
        let mut g = lattice();
        g.densify_near(&[Point::new(0.5, 0.0)], 0.1, 0.25);
        assert_eq!(g.node_count(), 9 + 3, "one edge split into four pieces");
        assert_eq!(g.time(0, 1), Some(1.0));
        assert_eq!(g.time(1, 0), Some(1.0));
        assert_eq!(g.snap(Point::new(0.5, 0.0), 0.01), Some(10));
        assert_eq!(g.time(0, 10), Some(0.5));
    }

    #[test]
    fn nodes_on_a_closed_course_stay_reachable() {
        let mut g = lattice();
        let course = Polyline::new(vec![Point::new(1.0, -1.0), Point::new(1.0, 3.0)]);
        g.close_courses(&[course]);
        assert_eq!(g.time(0, 1), Some(1.0));
        assert_eq!(g.time(0, 4), Some(2.0));
    }

    #[test]
    fn ways_break_at_nodes_missing_from_the_extract() {
        let mut osm = Osm::parse(include_str!("../tests/fixtures/small.json")).unwrap();
        osm.nodes.remove(&2);
        let proj = Projection::new(LatLon { lat: 45.0, lon: -122.0 });
        let g = Graph::build(&osm, &proj, TravelMode::Walk, 1.0);
        let at = |id: i64| g.snap(proj.to_local(osm.nodes[&id]), 1.0).unwrap();
        assert_eq!(g.time(at(1), at(3)), None, "must not bridge the gap");
        assert!(g.time(at(1), at(7)).is_some());
    }

    const TINY_LOT: &str = r#"{"elements": [
        {"type": "node", "id": 1, "lat": 45.0, "lon": -122.0},
        {"type": "node", "id": 2, "lat": 45.0, "lon": -121.9996},
        {"type": "node", "id": 3, "lat": 45.0003, "lon": -122.0},
        {"type": "way", "id": 10, "nodes": [1, 2, 3], "tags": {"highway": "footway"}},
        {"type": "way", "id": 11, "nodes": [1, 2, 3, 1], "tags": {"amenity": "parking"}}
    ]}"#;

    #[test]
    fn tiny_lots_get_no_shortcuts() {
        let proj = Projection::new(LatLon { lat: 45.0, lon: -122.0 });
        let osm = Osm::parse(TINY_LOT).unwrap();
        let g = Graph::build(&osm, &proj, TravelMode::Walk, 1.0);
        let at = |id: i64| g.snap(proj.to_local(osm.nodes[&id]), 1.0).unwrap();
        let (a, b, c) = (at(1), at(2), at(3));
        assert_abs_diff_eq!(
            g.time(a, c).unwrap(),
            g.distance(a, b) + g.distance(b, c),
            epsilon = 1e-9
        );
    }

    #[test]
    fn open_area_respects_concavity() {
        let mut g =
            Graph::new(vec![Point::new(1.0, 9.0), Point::new(9.0, 3.0), Point::new(0.0, 0.0)]);
        let l_shape: Polygon = polygon![
            (x: 0.0, y: 0.0), (x: 10.0, y: 0.0), (x: 10.0, y: 5.0),
            (x: 5.0, y: 5.0), (x: 5.0, y: 10.0), (x: 0.0, y: 10.0), (x: 0.0, y: 0.0),
        ];
        g.add_open_area(&l_shape, 1.0);
        assert!(!g.has_edge(0, 1), "no chord across the notch");
        assert!(g.has_edge(0, 2) && g.has_edge(2, 1));
        assert_abs_diff_eq!(
            g.time(0, 1).unwrap(),
            g.distance(0, 2) + g.distance(2, 1),
            epsilon = 1e-9
        );
    }
}

//! Local planar geometry. Everything is in metres once projected.

use geo::{
    Closest, ClosestPoint, Distance, Euclidean, InterpolatableLine, Length, Line, LineString,
    Relate,
};
pub use geo::{Point, Polygon};

use crate::model::{Course, LatLon};

const EARTH_RADIUS_M: f64 = 6_371_008.8;

/// Azimuthal equidistant projection about an origin: distances from the
/// origin are exact, and distortion is negligible at event scale.
#[derive(Debug, Clone, Copy)]
pub struct Projection {
    lat0: f64,
    lon0: f64,
}

impl Projection {
    pub fn new(origin: LatLon) -> Self {
        Self { lat0: origin.lat.to_radians(), lon0: origin.lon.to_radians() }
    }

    pub fn to_local(&self, p: LatLon) -> Point {
        let (lat, dlon) = (p.lat.to_radians(), p.lon.to_radians() - self.lon0);
        let cos_c = self.lat0.sin() * lat.sin() + self.lat0.cos() * lat.cos() * dlon.cos();
        let c = cos_c.clamp(-1.0, 1.0).acos();
        let k = if c == 0.0 { 1.0 } else { c / c.sin() };
        let x = k * lat.cos() * dlon.sin();
        let y = k * (self.lat0.cos() * lat.sin() - self.lat0.sin() * lat.cos() * dlon.cos());
        Point::new(x * EARTH_RADIUS_M, y * EARTH_RADIUS_M)
    }

    pub fn to_latlon(&self, p: Point) -> LatLon {
        let rho = p.x().hypot(p.y());
        if rho == 0.0 {
            return LatLon { lat: self.lat0.to_degrees(), lon: self.lon0.to_degrees() };
        }
        let c = rho / EARTH_RADIUS_M;
        let lat = (c.cos() * self.lat0.sin() + p.y() * c.sin() * self.lat0.cos() / rho).asin();
        let lon = self.lon0
            + (p.x() * c.sin())
                .atan2(rho * self.lat0.cos() * c.cos() - p.y() * self.lat0.sin() * c.sin());
        LatLon { lat: lat.to_degrees(), lon: lon.to_degrees() }
    }
}

/// A projected course segment or path with at least two points.
#[derive(Debug, Clone, PartialEq)]
pub struct Polyline(LineString);

/// The closest point on a polyline to a query point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Nearest {
    pub point: Point,
    /// Distance along the polyline from its start.
    pub along: f64,
    /// Distance from the query point to `point`.
    pub offset: f64,
}

impl Polyline {
    pub fn new(points: Vec<Point>) -> Self {
        assert!(points.len() >= 2, "polyline needs at least two points");
        Self(LineString::from(points))
    }

    pub fn points(&self) -> impl Iterator<Item = Point> + '_ {
        self.0.points()
    }

    pub fn length(&self) -> f64 {
        Euclidean.length(&self.0)
    }

    /// Running distance at each vertex, starting at 0.
    pub fn cumulative(&self) -> Vec<f64> {
        let mut total = 0.0;
        std::iter::once(0.0)
            .chain(self.0.lines().map(|line| {
                total += Euclidean.length(&line);
                total
            }))
            .collect()
    }

    pub fn point_at(&self, distance: f64) -> Point {
        let length = self.length();
        if length == 0.0 {
            return self.0.points().next().expect("polyline has points");
        }
        let fraction = (distance / length).clamp(0.0, 1.0);
        self.0.point_at_ratio_from_start(&Euclidean, fraction).expect("polyline has points")
    }

    /// Single pass so `along` refers to the same segment as `point`, even on looped courses.
    pub fn nearest(&self, p: Point) -> Nearest {
        let mut best = Nearest { point: p, along: 0.0, offset: f64::INFINITY };
        let mut start_distance = 0.0;
        for line in self.0.lines() {
            let point = match line.closest_point(&p) {
                Closest::Intersection(c) | Closest::SinglePoint(c) => c,
                Closest::Indeterminate => line.start_point(),
            };
            let offset = Euclidean.distance(p, point);
            if offset < best.offset {
                let along = start_distance + Euclidean.distance(line.start_point(), point);
                best = Nearest { point, along, offset };
            }
            start_distance += Euclidean.length(&line);
        }
        best
    }
}

impl Course {
    /// One projected polyline per segment, in course order.
    pub fn polylines(&self, projection: &Projection) -> Vec<Polyline> {
        self.segments
            .iter()
            .map(|s| Polyline::new(s.points.iter().map(|&p| projection.to_local(p)).collect()))
            .collect()
    }

    pub fn length(&self, projection: &Projection) -> f64 {
        self.polylines(projection).iter().map(Polyline::length).sum()
    }
}

/// The `[x, y]` form spatial indexes want.
pub fn coords(p: Point) -> [f64; 2] {
    [p.x(), p.y()]
}

/// True when the straight line `a`→`b` never leaves the polygon; running along its boundary is fine.
pub fn chord_inside(polygon: &Polygon, a: Point, b: Point) -> bool {
    Line::new(a, b).relate(polygon).is_coveredby()
}

#[cfg(test)]
mod tests {
    use approx::assert_abs_diff_eq;
    use geo::{Contains, polygon};

    use super::*;

    const ORIGIN: LatLon = LatLon { lat: 45.0, lon: -122.0 };

    #[test]
    fn projection_round_trips() {
        let proj = Projection::new(ORIGIN);
        for (lat, lon) in [(45.0, -122.0), (45.04, -122.05), (44.96, -121.95)] {
            let back = proj.to_latlon(proj.to_local(LatLon { lat, lon }));
            assert_abs_diff_eq!(back.lat, lat, epsilon = 1e-8);
            assert_abs_diff_eq!(back.lon, lon, epsilon = 1e-8);
        }
    }

    #[test]
    fn one_degree_of_latitude_is_about_111km() {
        let proj = Projection::new(ORIGIN);
        let p = proj.to_local(LatLon { lat: 46.0, lon: -122.0 });
        assert_abs_diff_eq!(p.x(), 0.0, epsilon = 1e-6);
        assert_abs_diff_eq!(p.y(), 111_195.0, epsilon = 10.0);
    }

    fn triangle() -> Polyline {
        Polyline::new(vec![
            Point::new(0.0, 0.0),
            Point::new(3.0, 0.0),
            Point::new(3.0, 4.0),
            Point::new(0.0, 0.0),
        ])
    }

    #[test]
    fn lengths_and_interpolation() {
        let line = triangle();
        assert_eq!(line.length(), 12.0);
        assert_eq!(line.cumulative(), vec![0.0, 3.0, 7.0, 12.0]);
        assert_eq!(line.point_at(7.0), Point::new(3.0, 4.0));
        assert_eq!(line.point_at(99.0), Point::new(0.0, 0.0));
    }

    #[test]
    fn zero_length_polyline_has_a_point() {
        let dot = Polyline::new(vec![Point::new(1.0, 1.0), Point::new(1.0, 1.0)]);
        assert_eq!(dot.point_at(0.0), Point::new(1.0, 1.0));
    }

    #[test]
    fn nearest_point_beside_a_vertex() {
        let n = triangle().nearest(Point::new(4.0, 0.0));
        assert_eq!(n.point, Point::new(3.0, 0.0));
        assert_eq!(n.along, 3.0);
        assert_eq!(n.offset, 1.0);
    }

    #[test]
    fn nearest_on_an_out_and_back_reports_the_closer_pass() {
        let out_and_back = Polyline::new(vec![
            Point::new(0.0, 0.0),
            Point::new(10.0, 0.0),
            Point::new(10.0, 1.0),
            Point::new(0.0, 1.0),
        ]);
        let n = out_and_back.nearest(Point::new(5.0, 0.9));
        assert_eq!(n.point, Point::new(5.0, 1.0));
        assert_eq!(n.along, 16.0);
    }

    #[test]
    fn chords_in_an_l_shaped_park() {
        let park: Polygon = polygon![
            (x: 0.0, y: 0.0), (x: 10.0, y: 0.0), (x: 10.0, y: 5.0),
            (x: 5.0, y: 5.0), (x: 5.0, y: 10.0), (x: 0.0, y: 10.0), (x: 0.0, y: 0.0),
        ];
        assert!(park.contains(&Point::new(2.0, 2.0)));
        assert!(chord_inside(&park, Point::new(0.0, 0.0), Point::new(10.0, 5.0)));
        assert!(
            chord_inside(&park, Point::new(2.0, 0.0), Point::new(8.0, 0.0)),
            "along the boundary"
        );
        assert!(
            !chord_inside(&park, Point::new(1.0, 9.0), Point::new(9.0, 3.0)),
            "across the notch"
        );
    }
}

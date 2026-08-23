//! When a racer reaches each point of their course, with pace uncertainty
//! accumulating along the way.

use crate::model::{PaceInterval, Seconds};

/// Time span during which a spectator must be present to be sure of a sighting.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub open: Seconds,
    pub close: Seconds,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Node {
    distance: f64,
    expected: Seconds,
    early: Seconds,
    late: Seconds,
}

/// Arrival times at every pace-interval boundary; linear in between.
#[derive(Debug, Clone, PartialEq)]
pub struct Trajectory {
    nodes: Vec<Node>,
}

impl Trajectory {
    /// `start` is when the racer crosses distance 0; `profile` must be validated and contiguous.
    pub fn new(start: Seconds, profile: &[PaceInterval]) -> Self {
        let mut nodes = vec![Node { distance: 0.0, expected: start, early: start, late: start }];
        for interval in profile {
            let seconds = (interval.end_m - interval.start_m) / 1000.0 * interval.seconds_per_km;
            let last = nodes.last().expect("trajectory starts with a node");
            nodes.push(Node {
                distance: interval.end_m,
                expected: last.expected + seconds,
                early: last.early + seconds * (1.0 - interval.uncertainty),
                late: last.late + seconds * (1.0 + interval.uncertainty),
            });
        }
        Self { nodes }
    }

    pub fn length(&self) -> f64 {
        self.nodes.last().expect("trajectory has nodes").distance
    }

    pub fn expected_at(&self, distance: f64) -> Seconds {
        let (a, b, t) = self.bracket(distance);
        lerp(a.expected, b.expected, t)
    }

    pub fn earliest_at(&self, distance: f64) -> Seconds {
        let (a, b, t) = self.bracket(distance);
        lerp(a.early, b.early, t)
    }

    pub fn latest_at(&self, distance: f64) -> Seconds {
        let (a, b, t) = self.bracket(distance);
        lerp(a.late, b.late, t)
    }

    /// The span a spectator must cover to be certain of seeing the racer anywhere in
    /// `[from, to]`: in place `safety_buffer` before the racer could enter, until they
    /// could not still be there.
    pub fn window(&self, from: f64, to: f64, safety_buffer: Seconds) -> Window {
        Window { open: self.earliest_at(from) - safety_buffer, close: self.latest_at(to) }
    }

    /// The nodes either side of `distance` and how far between them it falls.
    fn bracket(&self, distance: f64) -> (&Node, &Node, f64) {
        let distance = distance.clamp(0.0, self.length());
        let end = self.nodes.partition_point(|n| n.distance < distance).max(1);
        let (a, b) = (&self.nodes[end - 1], &self.nodes[end]);
        let span = b.distance - a.distance;
        let t = if span == 0.0 { 1.0 } else { (distance - a.distance) / span };
        (a, b, t)
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + t * (b - a)
}

#[cfg(test)]
mod tests {
    use approx::assert_abs_diff_eq;

    use super::*;

    fn interval(start_m: f64, end_m: f64, seconds_per_km: f64, uncertainty: f64) -> PaceInterval {
        PaceInterval { start_m, end_m, seconds_per_km, uncertainty }
    }

    #[test]
    fn expected_times_follow_pace_per_interval() {
        let t = Trajectory::new(
            1060.0,
            &[interval(0.0, 1000.0, 300.0, 0.0), interval(1000.0, 2000.0, 600.0, 0.0)],
        );
        assert_eq!(t.length(), 2000.0);
        assert_eq!(t.expected_at(0.0), 1060.0);
        assert_eq!(t.expected_at(500.0), 1210.0);
        assert_eq!(t.expected_at(1000.0), 1360.0);
        assert_eq!(t.expected_at(1500.0), 1660.0);
        assert_eq!(t.expected_at(9999.0), 1960.0);
    }

    #[test]
    fn windows_widen_with_distance_and_open_early() {
        let t = Trajectory::new(
            1060.0,
            &[interval(0.0, 1000.0, 300.0, 0.1), interval(1000.0, 2000.0, 300.0, 0.1)],
        );
        let first = t.window(1000.0, 1000.0, 120.0);
        let second = t.window(2000.0, 2000.0, 120.0);
        assert_abs_diff_eq!(first.open, 1060.0 + 270.0 - 120.0);
        assert_abs_diff_eq!(first.close, 1060.0 + 330.0);
        assert!(second.close - second.open > first.close - first.open);
    }

    #[test]
    fn arc_window_spans_entry_to_exit() {
        let t = Trajectory::new(0.0, &[interval(0.0, 1000.0, 300.0, 0.0)]);
        let w = t.window(100.0, 200.0, 0.0);
        assert_eq!((w.open, w.close), (30.0, 60.0));
    }
}

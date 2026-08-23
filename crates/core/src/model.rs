//! The event document: courses, racers, and spectator settings.

use serde::{Deserialize, Serialize};

/// Seconds since the Unix epoch.
pub type Timestamp = i64;
/// A duration, or a `Timestamp` once arithmetic needs fractions.
pub type Seconds = f64;
pub type CourseId = String;
pub type SegmentId = String;
pub type RacerId = String;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

impl LatLon {
    /// Same place to within about a centimetre.
    pub fn coincides(&self, other: &LatLon) -> bool {
        const TOLERANCE_DEG: f64 = 1e-7;
        (self.lat - other.lat).abs() < TOLERANCE_DEG && (self.lon - other.lon).abs() < TOLERANCE_DEG
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Run,
    Bike,
    Swim,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TravelMode {
    Walk,
    Bike,
    Drive,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub name: String,
    pub origin: LatLon,
    pub courses: Vec<Course>,
    pub racers: Vec<Racer>,
    pub spectator: SpectatorConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Course {
    pub id: CourseId,
    pub name: String,
    pub start_time: Timestamp,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub id: SegmentId,
    pub mode: Mode,
    pub points: Vec<LatLon>,
    /// False for stretches nobody can watch (a swim leg); they produce no viewpoints.
    #[serde(default = "default_viewable")]
    pub viewable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Racer {
    pub id: RacerId,
    pub name: String,
    pub course_id: CourseId,
    #[serde(default)]
    pub start_offset_s: Seconds,
    /// Contiguous intervals spanning the whole course, in metres along it.
    pub pace_profile: Vec<PaceInterval>,
    #[serde(default = "default_priority")]
    pub priority: f64,
    /// Which sighting of this racer the spectator cares about most.
    #[serde(default)]
    pub prefer: Prefer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Prefer {
    #[default]
    EnRoute,
    Finish,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PaceInterval {
    pub start_m: f64,
    pub end_m: f64,
    pub seconds_per_km: f64,
    /// Fraction in `[0, 1)`; arrival windows widen by this much of elapsed time.
    #[serde(default = "default_uncertainty")]
    pub uncertainty: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpectatorConfig {
    /// Where the spectator begins; when absent the planner chooses.
    #[serde(default)]
    pub start: Option<LatLon>,
    pub earliest: Timestamp,
    /// When the day ends; nothing is planned after this.
    #[serde(default)]
    pub latest: Option<Timestamp>,
    #[serde(default)]
    pub end: Option<Deadline>,
    pub mode: TravelMode,
    /// The spectator's own pace on ordinary ways; a typical one for the mode when absent.
    #[serde(default)]
    pub speed_mps: Option<f64>,
    #[serde(default = "default_sighting_radius_m")]
    pub sighting_radius_m: f64,
    /// The first stretch of every course is not worth watching: a crowded start tells you little.
    #[serde(default = "default_skip_start_m")]
    pub skip_start_m: f64,
    /// How long before a racer could possibly appear the spectator must already be in place.
    #[serde(default = "default_safety_buffer_s")]
    pub safety_buffer_s: Seconds,
    #[serde(default = "default_min_stop_s")]
    pub min_stop_s: Seconds,
    /// Spots closer than this that see the same courses collapse to one viewpoint;
    /// about a minute's walk is the finest distinction worth planning over.
    #[serde(default = "default_viewpoint_spacing_m")]
    pub viewpoint_spacing_m: f64,
    #[serde(default)]
    pub course_closed: bool,
    #[serde(default)]
    pub required_regions: Vec<RequiredRegion>,
    #[serde(default)]
    pub objective: Objective,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Deadline {
    pub location: LatLon,
    pub latest: Timestamp,
}

/// "I want to watch from roughly here": soft, with a large penalty when unmet.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RequiredRegion {
    pub center: LatLon,
    pub radius_m: f64,
    /// Be there no later than this.
    #[serde(default)]
    pub latest: Option<Timestamp>,
}

/// What a plan is worth, in strict priority: everyone seen the way they prefer, then everyone's
/// finish, then each racer's preferred sighting, then their other kind, then repeats on a
/// decaying curve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Objective {
    /// Every finish must be seen: a plan missing one is charged more than any level earns.
    #[serde(default)]
    pub require_finishes: bool,
    /// Each repeat en-route sighting of a racer is worth this fraction of the previous one:
    /// 0 is pure breadth (see everybody once), 0.9 is nearly pure depth. Must stay below 1 so
    /// repeats can never add up to a first sighting.
    pub repeat_decay: f64,
}

impl Default for Objective {
    fn default() -> Self {
        Self { require_finishes: false, repeat_decay: 0.5 }
    }
}

/// Objective weights resolved for a field of racers; each level outweighs everything the
/// levels below it could accumulate, so the scalar score ranks plans lexicographically.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Weights {
    /// Bonus once every racer has had their preferred sighting.
    pub everyone_preferred: f64,
    /// Bonus once every racer's finish has been seen; zero when finishes are required instead.
    pub everyone_finished: f64,
    /// A racer's first sighting of their preferred kind, scaled by priority.
    pub preferred: f64,
    /// A racer's first sighting of the other kind, scaled by priority.
    pub other: f64,
    /// The `k`-th en-route sighting of a racer is worth `priority × repeat_decay^k` of this.
    pub repeat: f64,
    /// Charged per finish missed when finishes are required: more than every level earns.
    pub missed_finish: f64,
}

impl Objective {
    pub fn weights(&self, racers: usize, max_priority: f64) -> Weights {
        let level = self.level_base(racers, max_priority);
        let required = self.require_finishes;
        Weights {
            everyone_preferred: level.powi(4),
            everyone_finished: if required { 0.0 } else { level.powi(3) },
            preferred: level.powi(2),
            other: level,
            repeat: 1.0,
            missed_finish: if required { level.powi(5) } else { 0.0 },
        }
    }

    /// Charged per required region missed: more than every level and every finish could earn.
    pub fn missed_region(&self, racers: usize, max_priority: f64) -> f64 {
        self.level_base(racers, max_priority).powi(6)
    }

    /// Ten times the most a single level can be worth, so the scalar stays exact in f64 for
    /// fields of hundreds of racers.
    pub fn level_base(&self, racers: usize, max_priority: f64) -> f64 {
        let repeats = 1.0 / (1.0 - self.repeat_decay.clamp(0.0, 0.9));
        let most = (racers.max(1) as f64 * max_priority.max(1.0) * repeats).max(1.0);
        (10.0 * most).ceil()
    }
}

fn default_viewable() -> bool {
    true
}
fn default_priority() -> f64 {
    1.0
}
fn default_uncertainty() -> f64 {
    0.05
}
fn default_sighting_radius_m() -> f64 {
    30.0
}
fn default_safety_buffer_s() -> f64 {
    120.0
}
fn default_min_stop_s() -> f64 {
    60.0
}
/// About a mile: the pack has spread out by then.
fn default_skip_start_m() -> f64 {
    1600.0
}

fn default_viewpoint_spacing_m() -> f64 {
    120.0
}

impl Event {
    pub fn course(&self, id: &str) -> Option<&Course> {
        self.courses.iter().find(|c| c.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip_with_defaults() {
        let json = r#"{
          "name": "Test", "origin": {"lat": 1.0, "lon": 2.0},
          "courses": [{"id": "c", "name": "5K", "start_time": 100,
            "segments": [{"id": "s", "mode": "run",
              "points": [{"lat": 1.0, "lon": 2.0}, {"lat": 1.01, "lon": 2.0}]}]}],
          "racers": [{"id": "r", "name": "Alice", "course_id": "c",
            "pace_profile": [{"start_m": 0, "end_m": 1112, "seconds_per_km": 300}]}],
          "spectator": {"earliest": 0, "mode": "walk"}
        }"#;
        let event: Event = serde_json::from_str(json).unwrap();
        assert_eq!(event.racers[0].priority, 1.0);
        assert_eq!(event.racers[0].pace_profile[0].uncertainty, 0.05);
        assert!(event.courses[0].segments[0].viewable);
        assert_eq!(event.spectator.start, None);
        let objective = &event.spectator.objective;
        assert_eq!(
            objective.level_base(1, 1.0),
            20.0,
            "one racer, decay 0.5: at most 2 points per level, times ten"
        );
        let weights = objective.weights(1, 1.0);
        assert_eq!(weights.everyone_preferred, 160_000.0);
        assert_eq!(weights.everyone_finished, 8_000.0);
        assert_eq!(weights.preferred, 400.0);
        assert_eq!(weights.other, 20.0);
        assert_eq!((weights.repeat, weights.missed_finish), (1.0, 0.0));
        let required = Objective { require_finishes: true, ..objective.clone() }.weights(1, 1.0);
        assert_eq!((required.everyone_finished, required.missed_finish), (0.0, 3_200_000.0));
        assert_eq!(objective.missed_region(1, 1.0), 64_000_000.0);
        assert_eq!(objective.level_base(30, 1.0), 600.0);

        let again: Event = serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
        assert_eq!(again, event);
    }
}

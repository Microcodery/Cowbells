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

/// What "racers seen" means: ordered tiers, each worth more than everything below it combined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Objective {
    pub tiers: Vec<Tier>,
    /// Each repeat en-route sighting of a racer is worth this fraction of the previous one:
    /// 0 is pure breadth (see everybody once), 1 is pure depth (repeats count fully).
    pub repeat_decay: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// En-route sightings, on the per-racer value curve.
    EnRoute,
    Finish,
}

impl Default for Objective {
    fn default() -> Self {
        Self { tiers: vec![Tier::EnRoute, Tier::Finish], repeat_decay: 0.5 }
    }
}

impl Objective {
    /// Tier weights that behave lexicographically for a field of `racers` with the given
    /// `max_priority`: each tier outweighs everything the tiers below it could accumulate.
    pub fn weight(&self, tier: Tier, racers: usize, max_priority: f64) -> f64 {
        let Some(i) = self.tiers.iter().position(|&t| t == tier) else { return 0.0 };
        self.tier_base(racers, max_priority).powi((self.tiers.len() - 1 - i) as i32)
    }

    /// The most a single tier can be worth, rounded up to a power of ten.
    pub fn tier_base(&self, racers: usize, max_priority: f64) -> f64 {
        let repeats = if self.repeat_decay >= 1.0 { 10.0 } else { 1.0 / (1.0 - self.repeat_decay) };
        let most = (racers.max(1) as f64 * max_priority.max(1.0) * repeats).max(1.0);
        10f64.powi(most.log10().ceil() as i32 + 1)
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
            objective.tier_base(1, 1.0),
            100.0,
            "one racer, decay 0.5: at most 2 points per tier"
        );
        assert_eq!(objective.weight(Tier::EnRoute, 1, 1.0), 100.0);
        assert_eq!(objective.weight(Tier::Finish, 1, 1.0), 1.0);
        assert_eq!(objective.tier_base(30, 1.0), 1000.0);

        let again: Event = serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
        assert_eq!(again, event);
    }
}

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

impl std::str::FromStr for TravelMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "walk" => Ok(TravelMode::Walk),
            "bike" => Ok(TravelMode::Bike),
            "drive" => Ok(TravelMode::Drive),
            other => Err(format!("unknown travel mode {other:?}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub name: String,
    pub origin: LatLon,
    pub courses: Vec<Course>,
    pub racers: Vec<Racer>,
    pub spectator: SpectatorConfig,
}

impl Event {
    pub fn course(&self, id: &str) -> Option<&Course> {
        self.courses.iter().find(|c| c.id == id)
    }
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
    /// Their finish must be seen: a plan that misses it is charged more than any level earns.
    #[serde(default)]
    pub require_finish: bool,
    /// Which sighting of this racer the spectator cares about most.
    #[serde(default)]
    pub prefer: Prefer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Prefer {
    /// The finish above all; seeing them en route is a bonus.
    #[default]
    Finish,
    /// Once en route first, then the finish, then repeats.
    Neutral,
    /// En route always: the finish is worth no more than another pass.
    EnRoute,
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

        let again: Event = serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
        assert_eq!(again, event);
    }
}

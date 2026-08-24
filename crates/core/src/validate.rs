//! Structural checks an `Event` must pass before planning.

use std::collections::HashSet;

use thiserror::Error;

use crate::geom::Projection;
use crate::model::{Course, Event, Racer, SpectatorConfig};

/// Pace profile boundaries may miss the course length by this much.
const PROFILE_TOLERANCE_M: f64 = 5.0;

#[derive(Debug, Clone, PartialEq, Error)]
pub enum ValidationError {
    #[error("duplicate id {id}")]
    DuplicateId { id: String },
    #[error("course {course} has no segments")]
    EmptyCourse { course: String },
    #[error("course {course} segment {segment} needs at least two distinct points")]
    ShortSegment { course: String, segment: String },
    #[error("course {course} segments {from} and {to} do not join")]
    Gap { course: String, from: String, to: String },
    #[error("racer {racer} references unknown course {course}")]
    UnknownCourse { racer: String, course: String },
    #[error("racer {racer} pace profile must run from 0 to {length:.0} m without gaps or overlaps")]
    ProfileCoverage { racer: String, length: f64 },
    #[error("racer {racer} pace interval {index} must be positive")]
    NonPositivePace { racer: String, index: usize },
    #[error("racer {racer} pace interval {index} uncertainty must be in [0, 1)")]
    Uncertainty { racer: String, index: usize },
    #[error("racer {racer} priority must be zero or more")]
    Priority { racer: String },
    #[error("repeat decay must be in [0, 1)")]
    RepeatDecay,
    #[error("the day must end after it starts")]
    DayWindow,
    #[error("spectator speed must be positive and finite")]
    Speed,
    #[error("skipped start length must be zero or more")]
    SkipStart,
    #[error("{setting} must be zero or more")]
    Setting { setting: &'static str },
}

impl Event {
    pub fn validate(&self) -> Result<(), Vec<ValidationError>> {
        let mut errors = Vec::new();
        let ids = self.courses.iter().map(|c| &c.id).chain(self.racers.iter().map(|r| &r.id));
        check_unique(ids, &mut errors);
        for course in &self.courses {
            check_course(course, &mut errors);
        }
        let projection = Projection::new(self.origin);
        for racer in &self.racers {
            check_racer(racer, self.course(&racer.course_id), &projection, &mut errors);
        }
        check_spectator(&self.spectator, &mut errors);
        if errors.is_empty() { Ok(()) } else { Err(errors) }
    }
}

fn check_spectator(spectator: &SpectatorConfig, errors: &mut Vec<ValidationError>) {
    if !(0.0..1.0).contains(&spectator.objective.repeat_decay) {
        errors.push(ValidationError::RepeatDecay);
    }
    let mut ends = spectator.latest.into_iter().chain(spectator.end.map(|e| e.latest));
    if ends.any(|t| t < spectator.earliest) {
        errors.push(ValidationError::DayWindow);
    }
    if spectator.speed_mps.is_some_and(|s| !positive(s)) {
        errors.push(ValidationError::Speed);
    }
    if !nonnegative(spectator.skip_start_m) {
        errors.push(ValidationError::SkipStart);
    }
    let settings = [
        (spectator.sighting_radius_m, "sighting radius"),
        (spectator.viewpoint_spacing_m, "viewpoint spacing"),
        (spectator.min_stop_s, "minimum stop"),
        (spectator.safety_buffer_s, "safety buffer"),
    ];
    for (value, setting) in settings {
        if !nonnegative(value) {
            errors.push(ValidationError::Setting { setting });
        }
    }
}

fn positive(x: f64) -> bool {
    x > 0.0 && x.is_finite()
}

fn nonnegative(x: f64) -> bool {
    x >= 0.0 && x.is_finite()
}

fn check_unique<'a>(ids: impl Iterator<Item = &'a String>, errors: &mut Vec<ValidationError>) {
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            errors.push(ValidationError::DuplicateId { id: id.clone() });
        }
    }
}

fn check_course(course: &Course, errors: &mut Vec<ValidationError>) {
    let id = &course.id;
    if course.segments.is_empty() {
        errors.push(ValidationError::EmptyCourse { course: id.clone() });
        return;
    }
    for segment in &course.segments {
        let distinct = segment
            .points
            .first()
            .is_some_and(|first| segment.points.iter().any(|p| !p.coincides(first)));
        if !distinct {
            errors.push(ValidationError::ShortSegment {
                course: id.clone(),
                segment: segment.id.clone(),
            });
        }
    }
    for pair in course.segments.windows(2) {
        let (from, to) = (&pair[0], &pair[1]);
        let joined = match (from.points.last(), to.points.first()) {
            (Some(a), Some(b)) => a.coincides(b),
            _ => false,
        };
        if !joined {
            errors.push(ValidationError::Gap {
                course: id.clone(),
                from: from.id.clone(),
                to: to.id.clone(),
            });
        }
    }
}

fn check_racer(
    racer: &Racer,
    course: Option<&Course>,
    projection: &Projection,
    errors: &mut Vec<ValidationError>,
) {
    let id = &racer.id;
    let Some(course) = course else {
        errors.push(ValidationError::UnknownCourse {
            racer: id.clone(),
            course: racer.course_id.clone(),
        });
        return;
    };
    if !nonnegative(racer.priority) {
        errors.push(ValidationError::Priority { racer: id.clone() });
    }
    let length = course.length(projection);
    let mut expected_start = 0.0;
    let mut contiguous = true;
    for interval in &racer.pace_profile {
        contiguous &= (interval.start_m - expected_start).abs() <= PROFILE_TOLERANCE_M
            && interval.end_m > interval.start_m;
        expected_start = interval.end_m;
    }
    if !contiguous || (expected_start - length).abs() > PROFILE_TOLERANCE_M {
        errors.push(ValidationError::ProfileCoverage { racer: id.clone(), length });
    }
    for (index, interval) in racer.pace_profile.iter().enumerate() {
        if !positive(interval.seconds_per_km) {
            errors.push(ValidationError::NonPositivePace { racer: id.clone(), index });
        }
        if !(0.0..1.0).contains(&interval.uncertainty) {
            errors.push(ValidationError::Uncertainty { racer: id.clone(), index });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    const KM_DEG: f64 = 1.0 / 111.195;

    fn point(km: f64) -> LatLon {
        LatLon { lat: km * KM_DEG, lon: 0.0 }
    }

    fn segment(id: &str, kms: &[f64]) -> Segment {
        Segment {
            id: id.into(),
            mode: Mode::Run,
            points: kms.iter().map(|&k| point(k)).collect(),
            viewable: true,
        }
    }

    fn interval(start_m: f64, end_m: f64, seconds_per_km: f64, uncertainty: f64) -> PaceInterval {
        PaceInterval { start_m, end_m, seconds_per_km, uncertainty }
    }

    fn event(segments: Vec<Segment>, pace_profile: Vec<PaceInterval>, course_id: &str) -> Event {
        Event {
            name: "e".into(),
            origin: point(0.0),
            courses: vec![Course { id: "c".into(), name: "c".into(), start_time: 0, segments }],
            racers: vec![Racer {
                id: "r".into(),
                name: "r".into(),
                course_id: course_id.into(),
                start_offset_s: 0.0,
                pace_profile,
                priority: 1.0,
                prefer: Prefer::EnRoute,
            }],
            spectator: SpectatorConfig {
                start: None,
                earliest: 0,
                latest: None,
                end: None,
                mode: TravelMode::Walk,
                speed_mps: None,
                sighting_radius_m: 30.0,
                skip_start_m: 0.0,
                safety_buffer_s: 120.0,
                min_stop_s: 60.0,
                viewpoint_spacing_m: 120.0,
                course_closed: false,
                required_regions: vec![],
                objective: Objective::default(),
            },
        }
    }

    #[test]
    fn valid_event_passes() {
        let e = event(
            vec![segment("a", &[0.0, 1.0]), segment("b", &[1.0 + 1e-9, 2.0])],
            vec![interval(0.0, 1000.0, 300.0, 0.05), interval(1000.0, 2000.0, 300.0, 0.1)],
            "c",
        );
        assert_eq!(e.validate(), Ok(()));
    }

    #[test]
    fn reports_every_problem() {
        let e = event(
            vec![segment("a", &[0.0, 1.0]), segment("b", &[5.0, 5.0]), segment("c", &[5.0, 6.0])],
            vec![interval(0.0, 500.0, 0.0, 1.0)],
            "c",
        );
        let errors = e.validate().unwrap_err();
        assert!(
            errors.contains(&ValidationError::ShortSegment {
                course: "c".into(),
                segment: "b".into()
            })
        );
        assert!(errors.contains(&ValidationError::Gap {
            course: "c".into(),
            from: "a".into(),
            to: "b".into()
        }));
        assert!(errors.iter().any(|e| matches!(e, ValidationError::ProfileCoverage { .. })));
        assert!(errors.contains(&ValidationError::NonPositivePace { racer: "r".into(), index: 0 }));
        assert!(errors.contains(&ValidationError::Uncertainty { racer: "r".into(), index: 0 }));
    }

    #[test]
    fn profile_gaps_and_overlaps_are_rejected() {
        let gap = event(
            vec![segment("a", &[0.0, 2.0])],
            vec![interval(0.0, 900.0, 300.0, 0.0), interval(1100.0, 2000.0, 300.0, 0.0)],
            "c",
        );
        assert!(gap.validate().is_err());
        let overlap = event(
            vec![segment("a", &[0.0, 2.0])],
            vec![interval(0.0, 1100.0, 300.0, 0.0), interval(900.0, 2000.0, 300.0, 0.0)],
            "c",
        );
        assert!(overlap.validate().is_err());
    }

    #[test]
    fn spectator_settings_are_checked() {
        let mut e =
            event(vec![segment("a", &[0.0, 1.0])], vec![interval(0.0, 1000.0, 300.0, 0.05)], "c");
        e.spectator.objective.repeat_decay = 1.5;
        e.spectator.latest = Some(-1);
        e.spectator.speed_mps = Some(0.0);
        e.spectator.skip_start_m = -1.0;
        e.spectator.min_stop_s = f64::NAN;
        assert_eq!(
            e.validate(),
            Err(vec![
                ValidationError::RepeatDecay,
                ValidationError::DayWindow,
                ValidationError::Speed,
                ValidationError::SkipStart,
                ValidationError::Setting { setting: "minimum stop" },
            ])
        );
    }

    #[test]
    fn unknown_course_and_empty_course() {
        let e = event(vec![], vec![], "nope");
        let errors = e.validate().unwrap_err();
        assert_eq!(
            errors,
            vec![
                ValidationError::EmptyCourse { course: "c".into() },
                ValidationError::UnknownCourse { racer: "r".into(), course: "nope".into() },
            ]
        );
    }

    #[test]
    fn duplicate_ids_across_courses_and_racers() {
        let mut e =
            event(vec![segment("a", &[0.0, 1.0])], vec![interval(0.0, 1000.0, 300.0, 0.05)], "c");
        e.racers[0].id = "c".into();
        assert_eq!(e.validate(), Err(vec![ValidationError::DuplicateId { id: "c".into() }]));
    }
}

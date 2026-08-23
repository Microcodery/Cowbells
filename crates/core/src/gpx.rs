//! GPX import: one course per track (or per route when there are no tracks),
//! one segment per track segment so recording gaps surface in validation.

pub use gpx::errors::GpxError;

use crate::model::{Course, LatLon, Mode, Segment};

pub fn courses_from_gpx(xml: &str) -> Result<Vec<Course>, GpxError> {
    let doc = gpx::read(xml.as_bytes())?;
    let courses = if doc.tracks.is_empty() {
        doc.routes
            .iter()
            .enumerate()
            .map(|(i, route)| build_course(i, route.name.as_deref(), vec![latlons(&route.points)]))
            .collect()
    } else {
        doc.tracks
            .iter()
            .enumerate()
            .map(|(i, track)| {
                let segments = track.segments.iter().map(|s| latlons(&s.points)).collect();
                build_course(i, track.name.as_deref(), segments)
            })
            .collect()
    };
    Ok(courses)
}

fn latlons(waypoints: &[gpx::Waypoint]) -> Vec<LatLon> {
    waypoints.iter().map(|w| LatLon { lat: w.point().y(), lon: w.point().x() }).collect()
}

fn build_course(index: usize, name: Option<&str>, segments: Vec<Vec<LatLon>>) -> Course {
    let id = format!("gpx-{index}");
    let segments = segments
        .into_iter()
        .enumerate()
        .map(|(j, points)| Segment {
            id: format!("{id}-{j}"),
            mode: Mode::Run,
            points,
            viewable: true,
        })
        .collect();
    Course {
        name: name.map(str::to_owned).unwrap_or_else(|| format!("Track {}", index + 1)),
        start_time: 0,
        segments,
        id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_TRACKS: &str = include_str!("../tests/fixtures/two_tracks.gpx");

    #[test]
    fn one_course_per_track_and_one_segment_per_trkseg() {
        let courses = courses_from_gpx(TWO_TRACKS).unwrap();
        let summary: Vec<_> = courses
            .iter()
            .map(|c| {
                (c.name.as_str(), c.segments.iter().map(|s| s.points.len()).collect::<Vec<_>>())
            })
            .collect();
        assert_eq!(summary, vec![("Morning 5K", vec![2, 1]), ("Evening Loop", vec![2])]);
        assert_eq!(courses[0].segments[0].points[0], LatLon { lat: 45.0, lon: -122.0 });
        assert_eq!(courses[0].segments[1].id, "gpx-0-1");
    }

    #[test]
    fn malformed_xml_is_an_error() {
        assert!(courses_from_gpx("<gpx><trk>").is_err());
    }
}

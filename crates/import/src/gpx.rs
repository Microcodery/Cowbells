//! GPX: one course per track (or per route when there are no tracks), one segment per
//! track segment.

use cowbells_core::LatLon;

use crate::ImportError;

impl From<gpx::errors::GpxError> for ImportError {
    fn from(e: gpx::errors::GpxError) -> Self {
        ImportError::Malformed(e.to_string())
    }
}

/// Each track's name and its segments' points, or the routes when there are no tracks.
pub fn tracks(xml: &str) -> Result<Vec<(Option<String>, Vec<Vec<LatLon>>)>, ImportError> {
    let doc = gpx::read(xml.as_bytes())?;
    if doc.tracks.is_empty() {
        return Ok(doc.routes.iter().map(|r| (r.name.clone(), vec![latlons(&r.points)])).collect());
    }
    Ok(doc
        .tracks
        .iter()
        .map(|t| (t.name.clone(), t.segments.iter().map(|s| latlons(&s.points)).collect()))
        .collect())
}

fn latlons(waypoints: &[gpx::Waypoint]) -> Vec<LatLon> {
    waypoints.iter().map(|w| LatLon { lat: w.point().y(), lon: w.point().x() }).collect()
}

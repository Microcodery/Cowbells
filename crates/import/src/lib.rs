//! Course import from the file types race organisers and GPS devices hand out: GPX, KML/KMZ,
//! TCX, FIT, and GeoJSON. Each track, route, or line becomes one course.

use std::io::{Cursor, Read};

use cowbells_core::{Course, LatLon, Mode, Segment};
use quick_xml::Reader;
use quick_xml::events::Event as Xml;
use thiserror::Error;

mod gpx;

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("unsupported file type: .{0}")]
    Unsupported(String),
    #[error("no track, route, or line with at least two points")]
    Empty,
    #[error("{0}")]
    Malformed(String),
}

impl From<quick_xml::Error> for ImportError {
    fn from(e: quick_xml::Error) -> Self {
        ImportError::Malformed(e.to_string())
    }
}

/// A named line of points, as found in a file before it becomes a course.
struct NamedLine {
    name: Option<String>,
    points: Vec<LatLon>,
}

/// Courses from a file, chosen by its extension.
pub fn courses_from_file(name: &str, bytes: &[u8]) -> Result<Vec<Course>, ImportError> {
    let extension = name.rsplit_once('.').map_or("", |(_, ext)| ext).to_ascii_lowercase();
    let text = || String::from_utf8_lossy(bytes);
    let lines = match extension.as_str() {
        // GPX keeps its track segments so recording gaps surface in validation.
        "gpx" => {
            let tracks = gpx::tracks(&text())?;
            let courses = tracks
                .into_iter()
                .enumerate()
                .map(|(i, (name, segments))| course("gpx", i, name, segments))
                .collect();
            return nonempty(courses);
        }
        "kml" => kml_lines(&text())?,
        "kmz" => kml_lines(&unzip_kml(bytes)?)?,
        "tcx" => tcx_lines(&text())?,
        "fit" => fit_lines(bytes)?,
        "geojson" | "json" => geojson_lines(bytes)?,
        other => return Err(ImportError::Unsupported(other.to_string())),
    };
    nonempty(
        lines
            .into_iter()
            .filter(|line| line.points.len() >= 2)
            .enumerate()
            .map(|(i, line)| course(&extension, i, line.name, vec![line.points]))
            .collect(),
    )
}

fn nonempty(courses: Vec<Course>) -> Result<Vec<Course>, ImportError> {
    if courses.is_empty() { Err(ImportError::Empty) } else { Ok(courses) }
}

fn course(kind: &str, index: usize, name: Option<String>, segments: Vec<Vec<LatLon>>) -> Course {
    let id = format!("{kind}-{index}");
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
        name: name.unwrap_or_else(|| format!("Course {}", index + 1)),
        start_time: 0,
        segments,
        id,
    }
}

/// The first `.kml` inside a KMZ archive.
fn unzip_kml(bytes: &[u8]) -> Result<String, ImportError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| ImportError::Malformed(e.to_string()))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| ImportError::Malformed(e.to_string()))?;
        if file.name().to_ascii_lowercase().ends_with(".kml") {
            let mut text = String::new();
            file.read_to_string(&mut text).map_err(|e| ImportError::Malformed(e.to_string()))?;
            return Ok(text);
        }
    }
    Err(ImportError::Malformed("no .kml inside the .kmz".into()))
}

/// Every `LineString` or `gx:Track` in a KML, named after its Placemark.
fn kml_lines(xml: &str) -> Result<Vec<NamedLine>, ImportError> {
    let mut reader = Reader::from_str(xml);
    let mut path: Vec<String> = Vec::new();
    let mut lines = Vec::new();
    let mut placemark_name = None;
    let mut track: Vec<LatLon> = Vec::new();
    loop {
        match reader.read_event()? {
            Xml::Start(e) => path.push(local_name(e.name().as_ref())),
            Xml::End(_) => {
                let closed = path.pop();
                if closed.as_deref() == Some("Track") {
                    lines.push(NamedLine {
                        name: placemark_name.clone(),
                        points: std::mem::take(&mut track),
                    });
                }
                if closed.as_deref() == Some("Placemark") {
                    placemark_name = None;
                }
            }
            Xml::Text(t) => {
                let text = t.unescape()?.trim().to_string();
                let inside = |tag: &str| path.iter().any(|p| p == tag);
                match path.last().map(String::as_str) {
                    Some("name") if path.iter().nth_back(1).is_some_and(|p| p == "Placemark") => {
                        placemark_name = Some(text);
                    }
                    Some("coordinates") if inside("LineString") => {
                        let points = text
                            .split_whitespace()
                            .filter_map(|triple| {
                                let mut parts = triple.split(',').map(str::parse::<f64>);
                                Some(LatLon { lon: parts.next()?.ok()?, lat: parts.next()?.ok()? })
                            })
                            .collect();
                        lines.push(NamedLine { name: placemark_name.clone(), points });
                    }
                    Some("coord") if inside("Track") => {
                        let mut parts = text.split_whitespace().map(str::parse::<f64>);
                        if let (Some(Ok(lon)), Some(Ok(lat))) = (parts.next(), parts.next()) {
                            track.push(LatLon { lat, lon });
                        }
                    }
                    _ => {}
                }
            }
            Xml::Eof => break,
            _ => {}
        }
    }
    Ok(lines)
}

/// Every `Track` (within a Course or an Activity Lap) in a TCX.
fn tcx_lines(xml: &str) -> Result<Vec<NamedLine>, ImportError> {
    let mut reader = Reader::from_str(xml);
    let mut path: Vec<String> = Vec::new();
    let mut lines = Vec::new();
    let mut name = None;
    let mut track: Vec<LatLon> = Vec::new();
    let mut point = (None, None);
    loop {
        match reader.read_event()? {
            Xml::Start(e) => path.push(local_name(e.name().as_ref())),
            Xml::End(_) => match path.pop().as_deref() {
                Some("Trackpoint") => {
                    if let (Some(lat), Some(lon)) = point {
                        track.push(LatLon { lat, lon });
                    }
                    point = (None, None);
                }
                Some("Track") => {
                    lines
                        .push(NamedLine { name: name.clone(), points: std::mem::take(&mut track) });
                }
                _ => {}
            },
            Xml::Text(t) => {
                let text = t.unescape()?.trim().to_string();
                match path.last().map(String::as_str) {
                    Some("Name") if path.iter().any(|p| p == "Course") => name = Some(text),
                    Some("LatitudeDegrees") => point.0 = text.parse().ok(),
                    Some("LongitudeDegrees") => point.1 = text.parse().ok(),
                    _ => {}
                }
            }
            Xml::Eof => break,
            _ => {}
        }
    }
    Ok(lines)
}

/// The record positions of a FIT activity or course, as one line.
fn fit_lines(bytes: &[u8]) -> Result<Vec<NamedLine>, ImportError> {
    let records =
        fitparser::from_bytes(bytes).map_err(|e| ImportError::Malformed(e.to_string()))?;
    let semicircles = |v: &fitparser::Value| match v {
        fitparser::Value::SInt32(n) => Some(*n as f64 * 180.0 / 2f64.powi(31)),
        fitparser::Value::Float64(n) => Some(*n),
        _ => None,
    };
    let mut points = Vec::new();
    for record in records.iter().filter(|r| r.kind() == fitparser::profile::MesgNum::Record) {
        let field = |name: &str| {
            record.fields().iter().find(|f| f.name() == name).and_then(|f| semicircles(f.value()))
        };
        if let (Some(lat), Some(lon)) = (field("position_lat"), field("position_long")) {
            points.push(LatLon { lat, lon });
        }
    }
    Ok(vec![NamedLine { name: None, points }])
}

/// Every LineString or MultiLineString in a GeoJSON geometry, feature, or collection.
fn geojson_lines(bytes: &[u8]) -> Result<Vec<NamedLine>, ImportError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| ImportError::Malformed(e.to_string()))?;
    let mut lines = Vec::new();
    collect_geojson(&value, None, &mut lines);
    Ok(lines)
}

fn collect_geojson(value: &serde_json::Value, name: Option<String>, out: &mut Vec<NamedLine>) {
    let latlon =
        |p: &serde_json::Value| Some(LatLon { lon: p.get(0)?.as_f64()?, lat: p.get(1)?.as_f64()? });
    let line = |coords: &serde_json::Value| -> Vec<LatLon> {
        coords.as_array().map(|a| a.iter().filter_map(latlon).collect()).unwrap_or_default()
    };
    let own_name =
        value.pointer("/properties/name").and_then(|n| n.as_str()).map(str::to_owned).or(name);
    match value.get("type").and_then(|t| t.as_str()) {
        Some("FeatureCollection") => {
            for feature in value.get("features").and_then(|f| f.as_array()).into_iter().flatten() {
                collect_geojson(feature, None, out);
            }
        }
        Some("Feature") => {
            if let Some(geometry) = value.get("geometry") {
                collect_geojson(geometry, own_name, out);
            }
        }
        Some("GeometryCollection") => {
            for geometry in value.get("geometries").and_then(|g| g.as_array()).into_iter().flatten()
            {
                collect_geojson(geometry, own_name.clone(), out);
            }
        }
        Some("LineString") => {
            out.push(NamedLine { name: own_name, points: line(&value["coordinates"]) })
        }
        Some("MultiLineString") => {
            for coords in value["coordinates"].as_array().into_iter().flatten() {
                out.push(NamedLine { name: own_name.clone(), points: line(coords) });
            }
        }
        _ => {}
    }
}

fn local_name(name: &[u8]) -> String {
    let name = String::from_utf8_lossy(name);
    name.rsplit(':').next().unwrap_or(&name).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_TRACKS: &str = include_str!("../tests/fixtures/two_tracks.gpx");

    const KML: &str = r#"<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>
      <Placemark><name>Route For: Half</name><LineString><coordinates>-104.95,39.75,0 -104.94,39.751,0 -104.93,39.752,0</coordinates></LineString></Placemark>
      <Placemark><name>Warmup</name><gx:Track><gx:coord>-104.9 39.7 0</gx:coord><gx:coord>-104.91 39.71 0</gx:coord></gx:Track></Placemark>
      <Placemark><name>Water stop</name><Point><coordinates>-104.95,39.75,0</coordinates></Point></Placemark>
    </Document></kml>"#;

    const TCX: &str = r#"<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Courses><Course><Name>Loop</Name>
      <Track><Trackpoint><Position><LatitudeDegrees>39.75</LatitudeDegrees><LongitudeDegrees>-104.95</LongitudeDegrees></Position></Trackpoint>
      <Trackpoint><Position><LatitudeDegrees>39.76</LatitudeDegrees><LongitudeDegrees>-104.94</LongitudeDegrees></Position></Trackpoint></Track>
    </Course></Courses></TrainingCenterDatabase>"#;

    const GEOJSON: &str = r#"{"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"name":"Out and back"},"geometry":{"type":"LineString","coordinates":[[-104.95,39.75],[-104.94,39.76]]}},
      {"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[-104.95,39.75]}},
      {"type":"Feature","properties":{"name":"Laps"},"geometry":{"type":"MultiLineString","coordinates":[[[-104.9,39.7],[-104.91,39.71]],[[-104.92,39.72],[-104.93,39.73]]]}}]}"#;

    fn summary(courses: &[Course]) -> Vec<(String, usize)> {
        courses.iter().map(|c| (c.name.clone(), c.segments[0].points.len())).collect()
    }

    #[test]
    fn gpx_gives_one_course_per_track_and_one_segment_per_trkseg() {
        let courses = courses_from_file("morning.gpx", TWO_TRACKS.as_bytes()).unwrap();
        let segments: Vec<_> = courses
            .iter()
            .map(|c| {
                (c.name.as_str(), c.segments.iter().map(|s| s.points.len()).collect::<Vec<_>>())
            })
            .collect();
        assert_eq!(segments, vec![("Morning 5K", vec![2, 1]), ("Evening Loop", vec![2])]);
        assert_eq!(courses[0].segments[0].points[0], LatLon { lat: 45.0, lon: -122.0 });
        assert_eq!(courses[0].segments[1].id, "gpx-0-1");
    }

    #[test]
    fn kml_lines_and_tracks_become_courses_but_points_do_not() {
        let courses = courses_from_file("colfax.KML", KML.as_bytes()).unwrap();
        assert_eq!(summary(&courses), vec![("Route For: Half".into(), 3), ("Warmup".into(), 2)]);
        assert_eq!(courses[0].segments[0].points[1], LatLon { lat: 39.751, lon: -104.94 });
    }

    #[test]
    fn kmz_unpacks_to_its_kml() {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            archive.start_file("doc.kml", options).unwrap();
            std::io::Write::write_all(&mut archive, KML.as_bytes()).unwrap();
            archive.finish().unwrap();
        }
        let courses = courses_from_file("course.kmz", buffer.get_ref()).unwrap();
        assert_eq!(courses.len(), 2);
    }

    #[test]
    fn tcx_course_track_becomes_a_course() {
        let courses = courses_from_file("loop.tcx", TCX.as_bytes()).unwrap();
        assert_eq!(summary(&courses), vec![("Loop".into(), 2)]);
        assert_eq!(courses[0].segments[0].points[0], LatLon { lat: 39.75, lon: -104.95 });
    }

    #[test]
    fn geojson_lines_become_courses() {
        let courses = courses_from_file("race.geojson", GEOJSON.as_bytes()).unwrap();
        assert_eq!(
            summary(&courses),
            vec![("Out and back".into(), 2), ("Laps".into(), 2), ("Laps".into(), 2)]
        );
    }

    #[test]
    fn fit_records_become_one_course() {
        let courses = courses_from_file("ride.fit", &fit_fixture()).unwrap();
        assert_eq!(courses.len(), 1);
        let points = &courses[0].segments[0].points;
        assert_eq!(points.len(), 2);
        assert!((points[0].lat - 39.75).abs() < 1e-6 && (points[0].lon + 104.95).abs() < 1e-6);
    }

    #[test]
    fn unknown_extensions_and_empty_files_are_errors() {
        assert!(matches!(courses_from_file("x.csv", b""), Err(ImportError::Unsupported(_))));
        assert!(matches!(courses_from_file("nodotname", b""), Err(ImportError::Unsupported(_))));
        let empty = r#"{"type":"FeatureCollection","features":[]}"#;
        assert!(matches!(
            courses_from_file("x.geojson", empty.as_bytes()),
            Err(ImportError::Empty)
        ));
        assert!(courses_from_file("x.kml", b"<kml><Placemark>").is_err());
        assert!(courses_from_file("x.gpx", b"<gpx><trk>").is_err());
    }

    /// A minimal FIT file: header, one record definition, two records, CRC.
    fn fit_fixture() -> Vec<u8> {
        let semicircles = |deg: f64| ((deg / 180.0) * 2f64.powi(31)) as i32;
        let mut data = Vec::new();
        // Definition message, local type 0, global message 20 (record), two sint32 fields.
        data.extend_from_slice(&[0x40, 0, 0, 20, 0, 2, 0, 4, 0x85, 1, 4, 0x85]);
        for (lat, lon) in [(39.75, -104.95), (39.76, -104.94)] {
            data.push(0x00);
            data.extend_from_slice(&semicircles(lat).to_le_bytes());
            data.extend_from_slice(&semicircles(lon).to_le_bytes());
        }
        let mut file = vec![14, 0x20, 0x6C, 0x08];
        file.extend_from_slice(&(data.len() as u32).to_le_bytes());
        file.extend_from_slice(b".FIT");
        let header_crc = fit_crc(&file);
        file.extend_from_slice(&header_crc.to_le_bytes());
        file.extend_from_slice(&data);
        let crc = fit_crc(&file);
        file.extend_from_slice(&crc.to_le_bytes());
        file
    }

    fn fit_crc(bytes: &[u8]) -> u16 {
        const TABLE: [u16; 16] = [
            0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800,
            0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
        ];
        let mut crc: u16 = 0;
        for &byte in bytes {
            for nibble in [byte & 0xF, byte >> 4] {
                let tmp = TABLE[(crc & 0xF) as usize];
                crc = (crc >> 4) & 0x0FFF;
                crc = crc ^ tmp ^ TABLE[nibble as usize];
            }
        }
        crc
    }
}

//! Viewpoints and the spectator itinerary planner.

pub mod itinerary;
pub mod planner;
pub mod viewpoints;

pub use itinerary::{Itinerary, Leg, SightingReport, SolveError, StopReport, solve};
pub use planner::{Options, Plan, Problem, Region, Stop, plan};
pub use viewpoints::{Arc, Kind, Sighting, Viewpoint, viewpoints};

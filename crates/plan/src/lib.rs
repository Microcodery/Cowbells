//! Viewpoints and the spectator itinerary planner.

pub mod itinerary;
pub mod planner;
pub mod trace;
pub mod viewpoints;

pub use itinerary::{Itinerary, Leg, SightingReport, Solution, SolveError, StopReport, solve};
pub use planner::{Options, Plan, Problem, Region, Stop, plan};
pub use trace::{LabelEvent, Trace};
pub use viewpoints::{Arc, Kind, Sighting, Viewpoint, viewpoints};

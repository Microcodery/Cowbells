//! Viewpoints and the spectator itinerary planner.

pub mod itinerary;
pub mod planner;
pub mod trace;
pub mod viewpoints;

pub use itinerary::{Itinerary, Leg, SightingReport, SolveError, StopReport, solve, solve_with};
pub use planner::{Options, Plan, Problem, Region, Stop, plan, plan_with};
pub use trace::{LabelEvent, Progress};
pub use viewpoints::{Arc, Kind, Sighting, Viewpoint, viewpoints};

//! Viewpoints and the spectator itinerary planner.

pub mod itinerary;
pub mod network;
pub mod planner;
pub mod trace;
pub mod viewpoints;

#[cfg(test)]
pub(crate) mod fixtures;

pub use itinerary::{Itinerary, Leg, SightingReport, SolveError, StopReport, solve, solve_with};
pub use network::prepare_graph;
pub use planner::{Options, Plan, Problem, Region, Stop, plan, plan_with};
pub use trace::{LabelEvent, MAX_NETWORK_NODES, Progress, network_trace};
pub use viewpoints::{Arc, Kind, Sighting, Viewpoint, viewpoints};

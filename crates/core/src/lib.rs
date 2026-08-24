//! Domain model, geometry, and trajectories for cowbells.

pub mod geom;
pub mod model;
pub mod trajectory;
pub mod validate;

pub use model::*;
pub use trajectory::{Trajectory, Window};
pub use validate::ValidationError;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

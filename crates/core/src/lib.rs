//! Domain model, geometry, and trajectories for birdeye.

pub mod geom;
pub mod gpx;
pub mod model;
pub mod trajectory;
pub mod validate;

pub use model::*;
pub use trajectory::{Trajectory, Window};
pub use validate::ValidationError;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_semver() {
        let parts: Vec<_> = crate::VERSION.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.parse::<u32>().is_ok()));
    }
}

//! wasm-bindgen facade over the birdeye engine.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn ping(msg: &str) -> String {
    format!("birdeye {}: {msg}", birdeye_core::VERSION)
}

#[cfg(test)]
mod tests {
    #[test]
    fn ping_format() {
        assert_eq!(
            super::ping("x"),
            format!("birdeye {}: x", birdeye_core::VERSION)
        );
    }
}

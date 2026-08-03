//! Taffy layout backend (Flexbox subset for MVP).
//!
//! Early slices may use a hand-rolled Column/Row layout; Taffy lands once
//! Host Protocol + FFI are stable (see ADR-004 §6.2 and Slice 4).

use nui_core::VERSION as CORE_VERSION;

#[must_use]
pub fn backend_name() -> &'static str {
    "taffy"
}

#[must_use]
pub fn core_version() -> &'static str {
    CORE_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_is_taffy() {
        assert_eq!(backend_name(), "taffy");
        assert!(!core_version().is_empty());
    }
}

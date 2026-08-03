//! Skia rendering backend.
//!
//! `rust-skia` is deferred until Slice 0 (static window). Early CI must not
//! require native Skia toolchains.

use nui_core::VERSION as CORE_VERSION;

#[must_use]
pub fn backend_name() -> &'static str {
    "skia"
}

#[must_use]
pub fn core_version() -> &'static str {
    CORE_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_is_skia() {
        assert_eq!(backend_name(), "skia");
        assert!(!core_version().is_empty());
    }
}

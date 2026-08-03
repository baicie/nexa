//! Platform window / input via winit.
//!
//! Slice 0 will wire winit event loop here. Dependency intentionally deferred
//! until the first drawable window lands, so CI stays lightweight.

use nui_core::VERSION as CORE_VERSION;

/// Backend identity for diagnostics.
#[must_use]
pub fn backend_name() -> &'static str {
    "winit"
}

/// Confirms the crate links against `nui-core`.
#[must_use]
pub fn core_version() -> &'static str {
    CORE_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_is_winit() {
        assert_eq!(backend_name(), "winit");
        assert!(!core_version().is_empty());
    }
}

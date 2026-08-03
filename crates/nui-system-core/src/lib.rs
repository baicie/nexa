//! Nexa System Host core (ADR-005).
//!
//! Independent of Perry FFI, Skia, and UI adapters. Desktop Slice 12 ships
//! clipboard text read/write via `arboard`.

mod clipboard;
mod permission;

pub use clipboard::{clipboard_read_text, clipboard_write_text, ClipboardError};
pub use permission::{PermissionDenied, PermissionId, PermissionSet};

/// Stable command identifiers for the System Host protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum CommandId {
    ClipboardReadText = 1,
    ClipboardWriteText = 2,
}

#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_non_empty() {
        assert!(!version().is_empty());
    }

    #[test]
    fn clipboard_roundtrip_when_available() {
        // Headless CI may lack a clipboard server — treat that as skip, not fail.
        let marker = format!("nexa-ui-clipboard-{}", std::process::id());
        match clipboard_write_text(&marker) {
            Ok(()) => {
                let got = clipboard_read_text().expect("read after write");
                assert_eq!(got, marker);
            }
            Err(ClipboardError::Unavailable(_)) => {}
            Err(err) => panic!("unexpected clipboard error: {err}"),
        }
    }
}

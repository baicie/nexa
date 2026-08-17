//! Nexa System Host core (ADR-005).
//!
//! Independent of Perry FFI, Skia, and UI adapters. Desktop backends provide
//! clipboard and filesystem text operations.

mod app_manifest;
mod clipboard;
mod dialog;
mod error;
mod filesystem;
mod permission;

pub use app_manifest::{
    load_development_manifest, load_release_manifest, AppManifest, AppManifestError,
    ProtocolRequirement, APP_MANIFEST_SCHEMA_URI, APP_MANIFEST_SCHEMA_VERSION,
    MAX_APP_MANIFEST_BYTES,
};
pub use clipboard::{
    clipboard_read_text, clipboard_read_text_with, clipboard_write_text, clipboard_write_text_with,
    ClipboardBackend, ClipboardError, DesktopClipboard,
};
pub use dialog::{DialogBackend, DialogError, DialogFilter, DialogRequest};
pub use error::{
    cancelled, internal_failure, invalid_argument, invalid_data, invalid_kind, invalid_state,
    not_found, permission_denied, platform_failure, stale_handle, wrong_owner, CommandResult,
    PermissionSource,
};
pub use filesystem::{
    read_text_file, read_text_file_with, write_text_file, write_text_file_uncancelled,
    write_text_file_with, AtomicWriteFile, FileSystemBackend, FileSystemError, FileSystemOperation,
    NativeFileSystem,
};
pub use nui_protocol as protocol;
pub use nui_protocol::system::{CommandId, PermissionId};
pub use permission::{
    active_permissions, permission_from_name, permission_name, required_permissions,
    PermissionDenied, PermissionSet,
};

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
    fn system_protocol_ids_are_generated_types() {
        let command: CommandId = super::protocol::system::CommandId::ClipboardReadText;
        let permission: PermissionId = super::protocol::system::PermissionId::ClipboardRead;

        let _: super::protocol::system::CommandId = command;
        let _: super::protocol::system::PermissionId = permission;
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

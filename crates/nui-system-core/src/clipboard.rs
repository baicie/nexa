//! Desktop clipboard text helpers (ADR-005 Slice 12).

use arboard::Clipboard;

/// Injectable text clipboard contract shared by editor commands and the
/// standalone System Host API.
pub trait ClipboardBackend {
    fn read_text(&mut self) -> Result<String, ClipboardError>;

    fn write_text(&mut self, text: &str) -> Result<(), ClipboardError>;
}

/// Native desktop clipboard backed by `arboard`.
#[derive(Debug, Default, Clone, Copy)]
pub struct DesktopClipboard;

/// Clipboard operation failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardError {
    Unavailable(String),
    Operation(String),
}

impl std::fmt::Display for ClipboardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(msg) | Self::Operation(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for ClipboardError {}

fn open() -> Result<Clipboard, ClipboardError> {
    Clipboard::new().map_err(|e| ClipboardError::Unavailable(e.to_string()))
}

impl ClipboardBackend for DesktopClipboard {
    fn read_text(&mut self) -> Result<String, ClipboardError> {
        let mut clipboard = open()?;
        clipboard
            .get_text()
            .map_err(|e| ClipboardError::Operation(e.to_string()))
    }

    fn write_text(&mut self, text: &str) -> Result<(), ClipboardError> {
        let mut clipboard = open()?;
        clipboard
            .set_text(text)
            .map_err(|e| ClipboardError::Operation(e.to_string()))
    }
}

/// Read UTF-8 text from the system clipboard.
pub fn clipboard_read_text() -> Result<String, ClipboardError> {
    DesktopClipboard.read_text()
}

/// Write UTF-8 text to the system clipboard.
pub fn clipboard_write_text(text: &str) -> Result<(), ClipboardError> {
    DesktopClipboard.write_text(text)
}

/// Read clipboard text through an injected backend.
pub fn clipboard_read_text_with<B>(backend: &mut B) -> Result<String, ClipboardError>
where
    B: ClipboardBackend + ?Sized,
{
    backend.read_text()
}

/// Write clipboard text through an injected backend.
pub fn clipboard_write_text_with<B>(backend: &mut B, text: &str) -> Result<(), ClipboardError>
where
    B: ClipboardBackend + ?Sized,
{
    backend.write_text(text)
}

#[cfg(test)]
mod tests {
    use super::{
        clipboard_read_text_with, clipboard_write_text_with, ClipboardBackend, ClipboardError,
    };

    #[derive(Default)]
    struct MemoryClipboard {
        value: String,
        failure: Option<String>,
    }

    impl ClipboardBackend for MemoryClipboard {
        fn read_text(&mut self) -> Result<String, ClipboardError> {
            if let Some(message) = &self.failure {
                return Err(ClipboardError::Operation(message.clone()));
            }
            Ok(self.value.clone())
        }

        fn write_text(&mut self, text: &str) -> Result<(), ClipboardError> {
            if let Some(message) = &self.failure {
                return Err(ClipboardError::Unavailable(message.clone()));
            }
            self.value = text.to_owned();
            Ok(())
        }
    }

    #[test]
    fn injected_backend_round_trip_does_not_use_desktop_clipboard() {
        let mut backend = MemoryClipboard::default();
        clipboard_write_text_with(&mut backend, "Nexa 中文 📝").expect("write fixture");
        assert_eq!(
            clipboard_read_text_with(&mut backend).expect("read fixture"),
            "Nexa 中文 📝"
        );
    }

    #[test]
    fn injected_backend_preserves_operation_failures() {
        let mut backend = MemoryClipboard {
            failure: Some("fixture unavailable".to_owned()),
            ..MemoryClipboard::default()
        };
        assert!(matches!(
            clipboard_read_text_with(&mut backend),
            Err(ClipboardError::Operation(message)) if message == "fixture unavailable"
        ));
        assert!(matches!(
            clipboard_write_text_with(&mut backend, "text"),
            Err(ClipboardError::Unavailable(message)) if message == "fixture unavailable"
        ));
    }
}

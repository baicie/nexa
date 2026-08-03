//! Desktop clipboard text helpers (ADR-005 Slice 12).

use arboard::Clipboard;

/// Clipboard operation failure.
#[derive(Debug)]
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

/// Read UTF-8 text from the system clipboard.
pub fn clipboard_read_text() -> Result<String, ClipboardError> {
    let mut clipboard = open()?;
    clipboard
        .get_text()
        .map_err(|e| ClipboardError::Operation(e.to_string()))
}

/// Write UTF-8 text to the system clipboard.
pub fn clipboard_write_text(text: &str) -> Result<(), ClipboardError> {
    let mut clipboard = open()?;
    clipboard
        .set_text(text)
        .map_err(|e| ClipboardError::Operation(e.to_string()))
}

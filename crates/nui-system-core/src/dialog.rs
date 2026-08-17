//! Injectable native file-dialog boundary for System Host commands.

use std::path::PathBuf;

/// A filter shown by a file picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Input shared by open and save file dialogs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogRequest {
    pub title: Option<String>,
    pub default_path: Option<PathBuf>,
    pub filters: Vec<DialogFilter>,
}

impl DialogRequest {
    /// Validate the request before a platform backend is invoked.
    pub fn validate(&self) -> Result<(), DialogError> {
        if self
            .title
            .as_ref()
            .is_some_and(|title| title.contains('\0'))
        {
            return Err(DialogError::InvalidRequest(
                "dialog title must not contain NUL".to_owned(),
            ));
        }
        if self
            .default_path
            .as_ref()
            .is_some_and(|path| path.as_os_str().to_string_lossy().contains('\0'))
        {
            return Err(DialogError::InvalidRequest(
                "dialog default path must not contain NUL".to_owned(),
            ));
        }
        for filter in &self.filters {
            if filter.name.trim().is_empty() {
                return Err(DialogError::InvalidRequest(
                    "dialog filter name must not be empty".to_owned(),
                ));
            }
            if filter.extensions.iter().any(|extension| {
                extension.trim().is_empty()
                    || extension.contains('/')
                    || extension.contains('\\')
                    || extension.contains('\0')
            }) {
                return Err(DialogError::InvalidRequest(
                    "dialog filter extensions must be non-empty file suffixes".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

/// Failure from parsing or invoking a platform file dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogError {
    InvalidRequest(String),
    PlatformFailure(String),
}

impl std::fmt::Display for DialogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(formatter, "invalid dialog request: {message}"),
            Self::PlatformFailure(message) => write!(formatter, "file dialog failed: {message}"),
        }
    }
}

impl std::error::Error for DialogError {}

/// Injectable platform boundary used by deterministic tests and the native host.
pub trait DialogBackend: Send + Sync + 'static {
    fn open_file(&self, request: &DialogRequest) -> Result<Option<PathBuf>, DialogError>;

    fn save_file(&self, request: &DialogRequest) -> Result<Option<PathBuf>, DialogError>;
}

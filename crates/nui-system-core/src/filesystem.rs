//! UTF-8 text file operations with cancellable atomic replacement.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const TEMP_FILE_ATTEMPTS: usize = 128;
static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

/// Stage at which a filesystem operation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileSystemOperation {
    ValidatePath,
    Read,
    CreateTemporary,
    WriteTemporary,
    FlushTemporary,
    SyncTemporary,
    CommitTemporary,
    RemoveTemporary,
}

impl FileSystemOperation {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ValidatePath => "validate path",
            Self::Read => "read",
            Self::CreateTemporary => "create temporary file",
            Self::WriteTemporary => "write temporary file",
            Self::FlushTemporary => "flush temporary file",
            Self::SyncTemporary => "sync temporary file",
            Self::CommitTemporary => "commit temporary file",
            Self::RemoveTemporary => "remove temporary file",
        }
    }
}

/// Typed filesystem failure before conversion into the System Host error registry.
#[derive(Debug)]
pub enum FileSystemError {
    Cancelled {
        path: PathBuf,
    },
    NotFound {
        operation: FileSystemOperation,
        path: PathBuf,
        source: io::Error,
    },
    InvalidData {
        operation: FileSystemOperation,
        path: PathBuf,
        message: String,
        source: Option<io::Error>,
    },
    PlatformFailure {
        operation: FileSystemOperation,
        path: PathBuf,
        source: io::Error,
    },
}

impl FileSystemError {
    #[must_use]
    pub fn path(&self) -> &Path {
        match self {
            Self::Cancelled { path }
            | Self::NotFound { path, .. }
            | Self::InvalidData { path, .. }
            | Self::PlatformFailure { path, .. } => path,
        }
    }

    #[must_use]
    pub const fn operation(&self) -> Option<FileSystemOperation> {
        match self {
            Self::Cancelled { .. } => None,
            Self::NotFound { operation, .. }
            | Self::InvalidData { operation, .. }
            | Self::PlatformFailure { operation, .. } => Some(*operation),
        }
    }
}

impl std::fmt::Display for FileSystemError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled { path } => {
                write!(formatter, "filesystem operation cancelled for {path:?}")
            }
            Self::NotFound {
                operation,
                path,
                source,
            }
            | Self::PlatformFailure {
                operation,
                path,
                source,
            } => write!(
                formatter,
                "filesystem {} failed for {path:?}: {source}",
                operation.as_str()
            ),
            Self::InvalidData {
                operation,
                path,
                message,
                ..
            } => write!(
                formatter,
                "filesystem {} rejected data for {path:?}: {message}",
                operation.as_str()
            ),
        }
    }
}

impl std::error::Error for FileSystemError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::NotFound { source, .. } | Self::PlatformFailure { source, .. } => Some(source),
            Self::InvalidData {
                source: Some(source),
                ..
            } => Some(source),
            Self::Cancelled { .. } | Self::InvalidData { source: None, .. } => None,
        }
    }
}

/// File handle used by the atomic-write algorithm.
pub trait AtomicWriteFile: Write {
    fn sync_all(&mut self) -> io::Result<()>;
}

impl AtomicWriteFile for File {
    fn sync_all(&mut self) -> io::Result<()> {
        File::sync_all(self)
    }
}

/// Injectable boundary around filesystem I/O.
pub trait FileSystemBackend {
    type WriteFile: AtomicWriteFile;

    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;

    fn create_new(&self, path: &Path) -> io::Result<Self::WriteFile>;

    fn rename_replace(&self, source: &Path, target: &Path) -> io::Result<()>;

    fn remove_file(&self, path: &Path) -> io::Result<()>;
}

/// Native filesystem backend.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativeFileSystem;

impl FileSystemBackend for NativeFileSystem {
    type WriteFile = File;

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }

    fn create_new(&self, path: &Path) -> io::Result<Self::WriteFile> {
        OpenOptions::new().write(true).create_new(true).open(path)
    }

    fn rename_replace(&self, source: &Path, target: &Path) -> io::Result<()> {
        rename_replace(source, target)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
}

/// Read one native file as UTF-8 text.
pub fn read_text_file(
    path: &Path,
    is_cancelled: impl Fn() -> bool,
) -> Result<String, FileSystemError> {
    read_text_file_with(&NativeFileSystem, path, is_cancelled)
}

/// Read one backend file as UTF-8 text.
pub fn read_text_file_with<B, C>(
    backend: &B,
    path: &Path,
    is_cancelled: C,
) -> Result<String, FileSystemError>
where
    B: FileSystemBackend,
    C: Fn() -> bool,
{
    check_cancelled(path, &is_cancelled)?;
    validate_non_empty_path(path)?;

    let bytes = backend
        .read(path)
        .map_err(|error| io_failure(FileSystemOperation::Read, path, error))?;
    check_cancelled(path, &is_cancelled)?;

    String::from_utf8(bytes).map_err(|error| FileSystemError::InvalidData {
        operation: FileSystemOperation::Read,
        path: path.to_path_buf(),
        message: error.utf8_error().to_string(),
        source: None,
    })
}

/// Atomically replace one native file with UTF-8 text.
pub fn write_text_file(
    path: &Path,
    text: &str,
    is_cancelled: impl Fn() -> bool,
) -> Result<(), FileSystemError> {
    let cancellation = &is_cancelled;
    write_text_file_with(&NativeFileSystem, path, text, cancellation, || {
        !cancellation()
    })
}

/// Atomically replace one native file without a cancellation source.
pub fn write_text_file_uncancelled(path: &Path, text: &str) -> Result<(), FileSystemError> {
    write_text_file_with(&NativeFileSystem, path, text, || false, || true)
}

/// Atomically replace one backend file with UTF-8 text.
pub fn write_text_file_with<B, C>(
    backend: &B,
    path: &Path,
    text: &str,
    is_cancelled: C,
    try_begin_commit: impl Fn() -> bool,
) -> Result<(), FileSystemError>
where
    B: FileSystemBackend,
    C: Fn() -> bool,
{
    check_cancelled(path, &is_cancelled)?;
    validate_non_empty_path(path)?;

    let mut pending = create_temporary_file(backend, path)?;
    pending
        .file_mut()
        .write_all(text.as_bytes())
        .map_err(|error| io_failure(FileSystemOperation::WriteTemporary, path, error))?;
    pending
        .file_mut()
        .flush()
        .map_err(|error| io_failure(FileSystemOperation::FlushTemporary, path, error))?;
    pending
        .file_mut()
        .sync_all()
        .map_err(|error| io_failure(FileSystemOperation::SyncTemporary, path, error))?;
    pending.close();

    // The callback must atomically claim the commit against cancellation. A
    // successful claim linearizes this operation before the rename below.
    if !try_begin_commit() {
        pending
            .remove()
            .map_err(|error| io_failure(FileSystemOperation::RemoveTemporary, path, error))?;
        return Err(FileSystemError::Cancelled {
            path: path.to_path_buf(),
        });
    }

    backend
        .rename_replace(pending.path(), path)
        .map_err(|error| io_failure(FileSystemOperation::CommitTemporary, path, error))?;
    pending.disarm();
    Ok(())
}

fn validate_non_empty_path(path: &Path) -> Result<(), FileSystemError> {
    if path.as_os_str().is_empty() {
        return Err(FileSystemError::InvalidData {
            operation: FileSystemOperation::ValidatePath,
            path: path.to_path_buf(),
            message: "path must not be empty".to_owned(),
            source: None,
        });
    }
    Ok(())
}

fn check_cancelled(path: &Path, is_cancelled: &impl Fn() -> bool) -> Result<(), FileSystemError> {
    if is_cancelled() {
        return Err(FileSystemError::Cancelled {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn io_failure(operation: FileSystemOperation, path: &Path, source: io::Error) -> FileSystemError {
    match source.kind() {
        io::ErrorKind::NotFound => FileSystemError::NotFound {
            operation,
            path: path.to_path_buf(),
            source,
        },
        io::ErrorKind::InvalidData | io::ErrorKind::InvalidInput => FileSystemError::InvalidData {
            operation,
            path: path.to_path_buf(),
            message: source.to_string(),
            source: Some(source),
        },
        _ => FileSystemError::PlatformFailure {
            operation,
            path: path.to_path_buf(),
            source,
        },
    }
}

fn create_temporary_file<'a, B>(
    backend: &'a B,
    target: &Path,
) -> Result<PendingWrite<'a, B>, FileSystemError>
where
    B: FileSystemBackend,
{
    let parent = target.parent().unwrap_or_else(|| Path::new(""));
    if target.file_name().is_none() {
        return Err(FileSystemError::InvalidData {
            operation: FileSystemOperation::ValidatePath,
            path: target.to_path_buf(),
            message: "write target must have a final component".to_owned(),
            source: None,
        });
    }
    for _ in 0..TEMP_FILE_ATTEMPTS {
        let sequence = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
        let name = OsString::from(format!(".nexa-ui-{}-{sequence}.tmp", std::process::id()));
        let temporary_path = parent.join(name);
        match backend.create_new(&temporary_path) {
            Ok(file) => return Ok(PendingWrite::new(backend, temporary_path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(io_failure(
                    FileSystemOperation::CreateTemporary,
                    target,
                    error,
                ));
            }
        }
    }

    Err(io_failure(
        FileSystemOperation::CreateTemporary,
        target,
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a unique temporary file",
        ),
    ))
}

struct PendingWrite<'a, B>
where
    B: FileSystemBackend,
{
    backend: &'a B,
    path: PathBuf,
    file: Option<B::WriteFile>,
    armed: bool,
}

impl<'a, B> PendingWrite<'a, B>
where
    B: FileSystemBackend,
{
    fn new(backend: &'a B, path: PathBuf, file: B::WriteFile) -> Self {
        Self {
            backend,
            path,
            file: Some(file),
            armed: true,
        }
    }

    fn file_mut(&mut self) -> &mut B::WriteFile {
        self.file
            .as_mut()
            .expect("temporary file is open before commit")
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn close(&mut self) {
        drop(self.file.take());
    }

    fn remove(mut self) -> io::Result<()> {
        self.close();
        self.backend.remove_file(&self.path)?;
        self.armed = false;
        Ok(())
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl<B> Drop for PendingWrite<'_, B>
where
    B: FileSystemBackend,
{
    fn drop(&mut self) {
        self.close();
        if self.armed {
            let _ = self.backend.remove_file(&self.path);
        }
    }
}

#[cfg(not(windows))]
fn rename_replace(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn rename_replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        #[link_name = "MoveFileExW"]
        fn move_file_ex_w(source: *const u16, target: *const u16, flags: u32) -> i32;
    }

    fn nul_terminated(path: &Path) -> io::Result<Vec<u16>> {
        let mut encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if encoded.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains a null code unit",
            ));
        }
        encoded.push(0);
        Ok(encoded)
    }

    let source = nul_terminated(source)?;
    let target = nul_terminated(target)?;
    // Both paths name files in the same directory. MoveFileExW provides the
    // Windows replace-existing rename primitive without deleting the target.
    let result = unsafe {
        move_file_ex_w(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

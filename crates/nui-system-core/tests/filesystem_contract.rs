use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use nui_system_core::{
    read_text_file_with, write_text_file_with, AtomicWriteFile, FileSystemBackend, FileSystemError,
    NativeFileSystem,
};

static NEXT_TEMP_DIRECTORY: AtomicU64 = AtomicU64::new(0);

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new(label: &str) -> Self {
        for _ in 0..128 {
            let sequence = NEXT_TEMP_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("nexa-fs-{label}-{}-{sequence}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("create temporary directory: {error}"),
            }
        }
        panic!("could not allocate a unique temporary directory");
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn entries(&self) -> Vec<PathBuf> {
        let mut entries = fs::read_dir(&self.0)
            .expect("read temporary directory")
            .map(|entry| entry.expect("read directory entry").path())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn reads_utf8_text_without_changing_the_path_representation() {
    let temporary = TempDirectory::new("read-utf8");
    let path = temporary.path().join("notes-中文.txt");
    let expected = "Latin\n中文\nالعربية\n📝";
    fs::write(&path, expected.as_bytes()).expect("write UTF-8 fixture");

    let actual = read_text_file_with(&NativeFileSystem, &path, || false).expect("read text");

    assert_eq!(actual, expected);
}

#[test]
fn rejects_invalid_utf8_as_typed_invalid_data() {
    let temporary = TempDirectory::new("invalid-utf8");
    let path = temporary.path().join("invalid.txt");
    fs::write(&path, [0x66, 0x6f, 0x80]).expect("write invalid UTF-8 fixture");

    let error = read_text_file_with(&NativeFileSystem, &path, || false).expect_err("invalid UTF-8");

    assert!(matches!(
        error,
        FileSystemError::InvalidData { path: error_path, .. } if error_path == path
    ));
}

#[test]
fn reports_a_missing_file_as_typed_not_found() {
    let temporary = TempDirectory::new("missing");
    let path = temporary.path().join("missing.txt");

    let error = read_text_file_with(&NativeFileSystem, &path, || false)
        .expect_err("missing file must fail");

    assert!(matches!(
        error,
        FileSystemError::NotFound { path: error_path, .. } if error_path == path
    ));
}

#[cfg(unix)]
#[test]
fn error_paths_preserve_non_utf8_os_paths() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let temporary = TempDirectory::new("non-utf8-path");
    let path = temporary
        .path()
        .join(OsString::from_vec(b"missing-\xff.txt".to_vec()));

    let error = read_text_file_with(&NativeFileSystem, &path, || false)
        .expect_err("missing file must fail");

    assert!(matches!(
        error,
        FileSystemError::NotFound { path: error_path, .. } if error_path == path
    ));
}

#[test]
fn atomic_write_replaces_the_target_and_leaves_no_temporary_file() {
    let temporary = TempDirectory::new("replace");
    let path = temporary.path().join("notes.txt");
    fs::write(&path, "old text").expect("write original target");

    write_text_file_with(&NativeFileSystem, &path, "new 中文 text", || false, || true)
        .expect("replace target");

    assert_eq!(
        fs::read_to_string(&path).expect("read target"),
        "new 中文 text"
    );
    assert_eq!(temporary.entries(), vec![path]);
}

#[test]
fn cancellation_before_commit_publishes_no_target_and_leaves_no_temporary_file() {
    let temporary = TempDirectory::new("cancel-before-commit");
    let path = temporary.path().join("notes.txt");
    let commit_attempts = AtomicUsize::new(0);

    let error = write_text_file_with(
        &NativeFileSystem,
        &path,
        "partial",
        || false,
        || {
            commit_attempts.fetch_add(1, Ordering::AcqRel);
            false
        },
    )
    .expect_err("commit callback must stop the commit");

    assert!(matches!(
        error,
        FileSystemError::Cancelled { path: error_path } if error_path == path
    ));
    assert!(!path.exists());
    assert!(temporary.entries().is_empty());
    assert_eq!(commit_attempts.load(Ordering::Acquire), 1);
}

#[derive(Clone)]
struct RecordingBackend {
    operations: Arc<Mutex<Vec<&'static str>>>,
    cancelled: Arc<AtomicBool>,
}

struct RecordingFile {
    operations: Arc<Mutex<Vec<&'static str>>>,
}

impl Write for RecordingFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.operations.lock().expect("operation log").push("write");
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.operations.lock().expect("operation log").push("flush");
        Ok(())
    }
}

impl AtomicWriteFile for RecordingFile {
    fn sync_all(&mut self) -> io::Result<()> {
        self.operations.lock().expect("operation log").push("sync");
        Ok(())
    }
}

impl FileSystemBackend for RecordingBackend {
    type WriteFile = RecordingFile;

    fn read(&self, _path: &Path) -> io::Result<Vec<u8>> {
        unreachable!("recording backend only exercises writes")
    }

    fn create_new(&self, _path: &Path) -> io::Result<Self::WriteFile> {
        self.operations
            .lock()
            .expect("operation log")
            .push("create");
        Ok(RecordingFile {
            operations: Arc::clone(&self.operations),
        })
    }

    fn rename_replace(&self, source: &Path, target: &Path) -> io::Result<()> {
        assert_eq!(source.parent(), target.parent());
        self.operations
            .lock()
            .expect("operation log")
            .push("rename");
        self.cancelled.store(true, Ordering::Release);
        Ok(())
    }

    fn remove_file(&self, _path: &Path) -> io::Result<()> {
        self.operations
            .lock()
            .expect("operation log")
            .push("remove");
        Ok(())
    }
}

fn recording_backend() -> (
    RecordingBackend,
    Arc<Mutex<Vec<&'static str>>>,
    Arc<AtomicBool>,
) {
    let operations = Arc::new(Mutex::new(Vec::new()));
    let cancelled = Arc::new(AtomicBool::new(false));
    (
        RecordingBackend {
            operations: Arc::clone(&operations),
            cancelled: Arc::clone(&cancelled),
        },
        operations,
        cancelled,
    )
}

#[test]
fn empty_paths_are_rejected_before_backend_io() {
    let (backend, operations, _) = recording_backend();

    let error = write_text_file_with(&backend, Path::new(""), "text", || false, || true)
        .expect_err("empty path must fail");

    assert!(matches!(
        error,
        FileSystemError::InvalidData { path, .. } if path.as_os_str().is_empty()
    ));
    assert!(operations.lock().expect("operation log").is_empty());
}

#[test]
fn cancellation_before_start_performs_no_backend_io() {
    let (backend, operations, _) = recording_backend();
    let path = Path::new("notes.txt");

    let error = write_text_file_with(
        &backend,
        path,
        "text",
        || true,
        || panic!("commit callback must not run when operation is cancelled"),
    )
    .expect_err("cancelled operation must not start");

    assert!(matches!(
        error,
        FileSystemError::Cancelled { path: error_path } if error_path == path
    ));
    assert!(operations.lock().expect("operation log").is_empty());
}

#[test]
fn write_syncs_before_atomic_rename_and_rename_is_the_commit_point() {
    let (backend, operations, cancelled) = recording_backend();
    let commit_operations = Arc::clone(&operations);

    write_text_file_with(
        &backend,
        Path::new("notes.txt"),
        "saved",
        || cancelled.load(Ordering::Acquire),
        || {
            commit_operations
                .lock()
                .expect("operation log")
                .push("begin_commit");
            !cancelled.load(Ordering::Acquire)
        },
    )
    .expect("successful rename commits even when cancellation arrives during rename");

    assert!(cancelled.load(Ordering::Acquire));
    assert_eq!(
        *operations.lock().expect("operation log"),
        ["create", "write", "flush", "sync", "begin_commit", "rename"]
    );
}

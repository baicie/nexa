#[path = "../build_support.rs"]
mod build_support;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use build_support::read_bounded_regular_file;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "nexa-system-host-build-input-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove test directory");
    }
}

#[test]
fn bounded_build_input_accepts_a_regular_file_at_the_limit() {
    let directory = TestDirectory::new();
    let path = directory.path().join("fixture.json");
    fs::write(&path, b"1234").expect("write fixture");

    let bytes =
        read_bounded_regular_file(&path, "NEXA_TEST_INPUT", 4).expect("regular bounded input");

    assert_eq!(bytes, b"1234");
}

#[test]
fn bounded_build_input_rejects_a_directory() {
    let directory = TestDirectory::new();

    let error = read_bounded_regular_file(directory.path(), "NEXA_TEST_INPUT", 4)
        .expect_err("directory must fail closed");

    assert!(error.contains("NEXA_TEST_INPUT"));
    assert!(error.contains("regular file"));
}

#[test]
fn bounded_build_input_rejects_a_file_larger_than_the_limit() {
    let directory = TestDirectory::new();
    let path = directory.path().join("fixture.json");
    fs::write(&path, b"12345").expect("write fixture");

    let error = read_bounded_regular_file(&path, "NEXA_TEST_INPUT", 4)
        .expect_err("oversized input must fail closed");

    assert!(error.contains("NEXA_TEST_INPUT"));
    assert!(error.contains("4 byte limit"));
}

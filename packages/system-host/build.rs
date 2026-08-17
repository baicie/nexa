mod build_support;

use std::env;
use std::fs;
use std::path::PathBuf;

use build_support::read_bounded_regular_file;

const MANIFEST_ENV: &str = "NEXA_APP_MANIFEST_PATH";
const DIALOG_TEST_FIXTURE_ENV: &str = "NEXA_DIALOG_TEST_FIXTURE_PATH";
const MAX_APP_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_DIALOG_TEST_FIXTURE_BYTES: u64 = 64 * 1024;

fn main() {
    println!("cargo:rerun-if-env-changed={MANIFEST_ENV}");
    println!("cargo:rerun-if-env-changed={DIALOG_TEST_FIXTURE_ENV}");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo provides OUT_DIR"));
    let generated = out_dir.join("embedded_app_manifest.rs");

    let source = match env::var_os(MANIFEST_ENV) {
        Some(path) => {
            let path = PathBuf::from(path);
            println!("cargo:rerun-if-changed={}", path.display());
            let bytes = read_bounded_regular_file(&path, MANIFEST_ENV, MAX_APP_MANIFEST_BYTES)
                .unwrap_or_else(|error| panic!("{error}"));
            fs::write(out_dir.join("nexa-app-manifest.json"), bytes)
                .expect("write embedded app manifest");
            "pub const EMBEDDED_APP_MANIFEST: Option<&'static [u8]> = Some(include_bytes!(concat!(env!(\"OUT_DIR\"), \"/nexa-app-manifest.json\")));\n"
        }
        None => "pub const EMBEDDED_APP_MANIFEST: Option<&'static [u8]> = None;\n",
    };

    fs::write(generated, source).expect("write embedded manifest module");

    let dialog_fixture_source = match env::var_os(DIALOG_TEST_FIXTURE_ENV) {
        Some(path) => {
            let path = PathBuf::from(path);
            println!("cargo:rerun-if-changed={}", path.display());
            let bytes = read_bounded_regular_file(
                &path,
                DIALOG_TEST_FIXTURE_ENV,
                MAX_DIALOG_TEST_FIXTURE_BYTES,
            )
            .unwrap_or_else(|error| panic!("{error}"));
            fs::write(out_dir.join("nexa-dialog-test-fixture.json"), bytes)
                .expect("write embedded dialog test fixture");
            "pub const EMBEDDED_DIALOG_TEST_FIXTURE: Option<&'static [u8]> = Some(include_bytes!(concat!(env!(\"OUT_DIR\"), \"/nexa-dialog-test-fixture.json\")));\n"
        }
        None => "pub const EMBEDDED_DIALOG_TEST_FIXTURE: Option<&'static [u8]> = None;\n",
    };
    fs::write(
        out_dir.join("embedded_dialog_test_fixture.rs"),
        dialog_fixture_source,
    )
    .expect("write embedded dialog test fixture module");
}

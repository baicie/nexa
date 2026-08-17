use std::path::{Path, PathBuf};

use nui_system_core::protocol::system::{CommandId, PermissionId};
use nui_system_core::{
    active_permissions, load_development_manifest, load_release_manifest, permission_from_name,
    permission_name, required_permissions, AppManifestError, PermissionSet,
};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures")
        .join(name)
}

fn error_kind(error: &AppManifestError) -> &'static str {
    match error {
        AppManifestError::Io { .. } => "Io",
        AppManifestError::TooLarge { .. } => "TooLarge",
        AppManifestError::InvalidJson { .. } => "InvalidJson",
        AppManifestError::InvalidSchemaUri { .. } => "InvalidSchemaUri",
        AppManifestError::UnsupportedSchemaVersion { .. } => "UnsupportedSchemaVersion",
        AppManifestError::InvalidAppId { .. } => "InvalidAppId",
        AppManifestError::InvalidAppName => "InvalidAppName",
        AppManifestError::InvalidAppVersion { .. } => "InvalidAppVersion",
        AppManifestError::IncompatibleProtocol { .. } => "IncompatibleProtocol",
        AppManifestError::TooManyPermissions { .. } => "TooManyPermissions",
        AppManifestError::UnknownPermission { .. } => "UnknownPermission",
        AppManifestError::DuplicatePermission { .. } => "DuplicatePermission",
    }
}

struct TempManifest(PathBuf);

impl TempManifest {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "nexa-app-manifest-{}-{:?}.json",
            std::process::id(),
            std::thread::current().id()
        )))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempManifest {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[test]
fn development_file_and_release_bytes_share_one_validator() {
    let path = fixture_path("app-manifest.development.json");
    let from_file = load_development_manifest(&path).expect("development manifest");
    let bytes = std::fs::read(path).expect("fixture bytes");
    let from_release = load_release_manifest(&bytes).expect("release loader accepts same bytes");

    assert_eq!(from_file, from_release);
    assert_eq!(from_file.id(), "dev.nexa.notes");
    assert_eq!(from_file.permissions(), &[PermissionId::ClipboardRead]);

    let release = load_release_manifest(include_bytes!(
        "../../../protocol/fixtures/app-manifest.release.json"
    ))
    .expect("release manifest");
    assert_eq!(release.id(), "dev.nexa.notes");
    assert_eq!(
        release.permissions(),
        &[PermissionId::ClipboardRead, PermissionId::ClipboardWrite]
    );
}

#[test]
fn loader_rejects_every_security_relevant_invalid_shape() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/app-manifest-contract-cases.json"
    ))
    .expect("contract cases");
    for contract_case in cases.as_array().expect("case registry") {
        let label = contract_case["label"].as_str().expect("case label");
        let json = contract_case["json"].as_str().expect("raw JSON");
        if contract_case["accepted"] == true {
            load_release_manifest(json.as_bytes())
                .unwrap_or_else(|error| panic!("rejected {label}: {error}"));
        } else {
            let error = match load_release_manifest(json.as_bytes()) {
                Ok(_) => panic!("accepted {label}"),
                Err(error) => error,
            };
            assert_eq!(
                error_kind(&error),
                contract_case["error"].as_str().expect("error kind"),
                "{label}"
            );
        }
    }

    assert!(matches!(
        load_release_manifest(&vec![b' '; 65_537]),
        Err(AppManifestError::TooLarge { .. })
    ));
    assert!(matches!(
        load_development_manifest(fixture_path("missing-app-manifest.json")),
        Err(AppManifestError::Io { .. })
    ));
}

#[test]
fn development_loader_enforces_the_exact_byte_limit_with_bounded_reads() {
    let temporary = TempManifest::new();
    let mut exact =
        include_bytes!("../../../protocol/fixtures/app-manifest.development.json").to_vec();
    exact.resize(nui_system_core::MAX_APP_MANIFEST_BYTES, b' ');
    std::fs::write(temporary.path(), &exact).expect("write exact-limit fixture");
    load_development_manifest(temporary.path()).expect("exact byte limit is accepted");

    exact.push(b' ');
    std::fs::write(temporary.path(), &exact).expect("write over-limit fixture");
    assert!(matches!(
        load_development_manifest(temporary.path()),
        Err(AppManifestError::TooLarge {
            maximum: nui_system_core::MAX_APP_MANIFEST_BYTES,
            actual_at_least
        }) if actual_at_least == nui_system_core::MAX_APP_MANIFEST_BYTES + 1
    ));
}

#[test]
fn permissions_default_to_deny_and_commands_own_their_requirements() {
    let denied = PermissionSet::default();
    let failure = denied
        .require_command(CommandId::ClipboardReadText)
        .expect_err("sensitive command must be denied by default");
    assert_eq!(failure.permission, PermissionId::ClipboardRead);
    assert_eq!(failure.command, CommandId::ClipboardReadText);
    assert!(denied.require_command(CommandId::CancelTask).is_ok());
    assert_eq!(
        denied
            .require_command(CommandId::ReadTextFile)
            .expect_err("file read must be denied by default")
            .permission,
        PermissionId::FsRead
    );
    assert_eq!(
        denied
            .require_command(CommandId::WriteTextFile)
            .expect_err("file write must be denied by default")
            .permission,
        PermissionId::FsWrite
    );
    assert!(denied.require_command(CommandId::AwaitTask).is_ok());

    let manifest = load_release_manifest(include_bytes!(
        "../../../protocol/fixtures/app-manifest.development.json"
    ))
    .expect("development fixture");
    let declared = PermissionSet::from_manifest(&manifest);
    assert!(declared
        .require_command(CommandId::ClipboardReadText)
        .is_ok());
    assert!(declared
        .require_command(CommandId::ClipboardWriteText)
        .is_err());
}

#[test]
fn rust_permission_names_round_trip_the_active_protocol_registry() {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../protocol/system-host.json"))
            .expect("system manifest");
    let active = manifest["permissions"]
        .as_array()
        .expect("permission registry")
        .iter()
        .filter(|entry| entry["lifecycle"]["status"] == "active")
        .map(|entry| format!("system.{}", entry["name"].as_str().expect("name")))
        .collect::<Vec<_>>();

    let rust = active_permissions()
        .iter()
        .map(|(permission, name)| {
            assert_eq!(permission_from_name(name), Some(*permission));
            assert_eq!(permission_name(*permission), *name);
            (*name).to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(rust, active);

    for inactive in [
        "system.ClipboardReadLegacy",
        "system.Unknown",
        "ClipboardRead",
    ] {
        assert_eq!(permission_from_name(inactive), None);
    }
}

#[test]
fn command_permission_mapping_matches_the_system_manifest() {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../protocol/system-host.json"))
            .expect("system manifest");
    let commands = manifest["commands"].as_array().expect("command registry");
    let rust_commands = [
        (CommandId::ClipboardReadText, "ClipboardReadText"),
        (CommandId::ClipboardWriteText, "ClipboardWriteText"),
        (CommandId::CancelTask, "CancelTask"),
        (CommandId::CloseResource, "CloseResource"),
        (CommandId::ResetSession, "ResetSession"),
        (CommandId::ReadTextFile, "ReadTextFile"),
        (CommandId::WriteTextFile, "WriteTextFile"),
        (CommandId::AwaitTask, "AwaitTask"),
        (CommandId::OpenFileDialog, "OpenFileDialog"),
        (CommandId::SaveFileDialog, "SaveFileDialog"),
    ];

    assert_eq!(commands.len(), rust_commands.len());
    for (command, name) in rust_commands {
        let entry = commands
            .iter()
            .find(|entry| entry["name"] == name)
            .expect("Rust command exists in manifest");
        let expected = entry["requiredPermissions"]
            .as_array()
            .expect("required permissions")
            .iter()
            .map(|permission| permission.as_str().expect("permission name"))
            .collect::<Vec<_>>();
        let actual = required_permissions(command)
            .iter()
            .copied()
            .map(permission_name)
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "system.{name}");
    }
}

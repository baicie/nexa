use nui_system_core::load_release_manifest;
use nui_system_core::protocol::system::CommandId;
use perry_ext_nexa_system_host::{PermissionInstallError, SystemHostPermissions};
use std::sync::Arc;
use std::thread;

fn manifest(permissions: &str) -> nui_system_core::AppManifest {
    load_release_manifest(
        format!(
            r#"{{
                "$schema":"https://nexa-ui.dev/schema/app-manifest-v1.json",
                "schemaVersion":1,
                "id":"dev.nexa.permission-test",
                "name":"Permission Test",
                "version":"0.1.0",
                "requiredProtocol":{{"major":1,"minor":0}},
                "permissions":[{permissions}]
            }}"#
        )
        .as_bytes(),
    )
    .expect("test manifest")
}

#[test]
fn host_permissions_fail_closed_and_cannot_be_widened_after_install() {
    let permissions = SystemHostPermissions::default();
    assert!(permissions
        .require_command(CommandId::ClipboardReadText)
        .is_err());
    assert!(permissions.require_command(CommandId::CancelTask).is_ok());

    permissions
        .install(&manifest(r#""system.ClipboardRead""#))
        .expect("first trusted install");
    assert!(permissions
        .require_command(CommandId::ClipboardReadText)
        .is_ok());
    assert!(permissions
        .require_command(CommandId::ClipboardWriteText)
        .is_err());

    assert_eq!(
        permissions.install(&manifest(
            r#""system.ClipboardRead","system.ClipboardWrite""#
        )),
        Err(PermissionInstallError::AlreadyInstalled)
    );
    assert!(permissions
        .require_command(CommandId::ClipboardWriteText)
        .is_err());
}

#[test]
fn global_manifest_install_is_atomic_under_concurrent_launchers() {
    let manifest = Arc::new(manifest(r#""system.ClipboardRead""#));
    let threads = (0..8)
        .map(|_| {
            let manifest = Arc::clone(&manifest);
            thread::spawn(move || perry_ext_nexa_system_host::install_app_manifest(&manifest))
        })
        .collect::<Vec<_>>();
    let results = threads
        .into_iter()
        .map(|thread| thread.join().expect("installer thread"))
        .collect::<Vec<_>>();

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| **result == Err(PermissionInstallError::AlreadyInstalled))
            .count(),
        7
    );
}

#[test]
fn embedded_release_bytes_are_validated_before_permissions_install() {
    let permissions = SystemHostPermissions::default();
    let manifest = br#"{
        "$schema":"https://nexa-ui.dev/schema/app-manifest-v1.json",
        "schemaVersion":1,
        "id":"dev.nexa.notes",
        "name":"Nexa Notes",
        "version":"0.1.0",
        "requiredProtocol":{"major":1,"minor":0},
        "permissions":["system.FsRead","system.FsWrite","system.DialogOpen","system.DialogSave"]
    }"#;

    permissions
        .install_release_bytes(manifest)
        .expect("valid embedded manifest");
    assert!(permissions.require_command(CommandId::ReadTextFile).is_ok());
    assert!(permissions
        .require_command(CommandId::WriteTextFile)
        .is_ok());
    assert!(permissions
        .require_command(CommandId::OpenFileDialog)
        .is_ok());
    assert!(permissions
        .require_command(CommandId::SaveFileDialog)
        .is_ok());

    let invalid = SystemHostPermissions::default();
    let error = invalid
        .install_release_bytes(br#"{"schemaVersion":1}"#)
        .expect_err("incomplete manifest must fail closed");
    assert!(error.to_string().contains("manifest"));
    assert!(invalid.require_command(CommandId::ReadTextFile).is_err());
}

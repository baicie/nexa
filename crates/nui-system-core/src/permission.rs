//! Permission gates for System Host commands (ADR-005 §7).

use crate::{AppManifest, CommandId, PermissionId};

const ACTIVE_PERMISSIONS: &[(PermissionId, &str)] = &[
    (PermissionId::ClipboardRead, "system.ClipboardRead"),
    (PermissionId::ClipboardWrite, "system.ClipboardWrite"),
    (PermissionId::FsRead, "system.FsRead"),
    (PermissionId::FsWrite, "system.FsWrite"),
    (PermissionId::DialogOpen, "system.DialogOpen"),
    (PermissionId::DialogSave, "system.DialogSave"),
];

/// Error returned when a command lacks the required capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionDenied {
    pub permission: PermissionId,
    pub command: CommandId,
}

impl std::fmt::Display for PermissionDenied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "permission {:?} denied for command {:?}",
            self.permission, self.command
        )
    }
}

impl std::error::Error for PermissionDenied {}

/// Declared capabilities for the running app.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PermissionSet {
    granted: Vec<PermissionId>,
}

impl PermissionSet {
    #[must_use]
    pub fn from_manifest(manifest: &AppManifest) -> Self {
        Self::from_permissions(manifest.permissions().iter().copied())
    }

    #[must_use]
    pub(crate) fn from_permissions(permissions: impl IntoIterator<Item = PermissionId>) -> Self {
        let mut granted = Vec::new();
        for permission in permissions {
            if !granted.contains(&permission) {
                granted.push(permission);
            }
        }
        granted.sort_unstable_by_key(|permission| *permission as u16);
        Self { granted }
    }

    #[must_use]
    fn allows(&self, permission: PermissionId) -> bool {
        self.granted.contains(&permission)
    }

    fn require(
        &self,
        permission: PermissionId,
        command: CommandId,
    ) -> Result<(), PermissionDenied> {
        if self.allows(permission) {
            Ok(())
        } else {
            Err(PermissionDenied {
                permission,
                command,
            })
        }
    }

    pub fn require_command(&self, command: CommandId) -> Result<(), PermissionDenied> {
        for permission in required_permissions(command) {
            self.require(*permission, command)?;
        }
        Ok(())
    }
}

#[must_use]
pub const fn active_permissions() -> &'static [(PermissionId, &'static str)] {
    ACTIVE_PERMISSIONS
}

#[must_use]
pub fn permission_name(permission: PermissionId) -> &'static str {
    active_permissions()
        .iter()
        .find_map(|(candidate, name)| (*candidate == permission).then_some(*name))
        .expect("generated PermissionId has an active canonical name")
}

#[must_use]
pub fn permission_from_name(name: &str) -> Option<PermissionId> {
    active_permissions()
        .iter()
        .find_map(|(permission, candidate)| (*candidate == name).then_some(*permission))
}

#[must_use]
pub const fn required_permissions(command: CommandId) -> &'static [PermissionId] {
    match command {
        CommandId::ClipboardReadText => &[PermissionId::ClipboardRead],
        CommandId::ClipboardWriteText => &[PermissionId::ClipboardWrite],
        CommandId::ReadTextFile => &[PermissionId::FsRead],
        CommandId::WriteTextFile => &[PermissionId::FsWrite],
        CommandId::OpenFileDialog => &[PermissionId::DialogOpen],
        CommandId::SaveFileDialog => &[PermissionId::DialogSave],
        CommandId::CancelTask
        | CommandId::CloseResource
        | CommandId::ResetSession
        | CommandId::AwaitTask => &[],
    }
}

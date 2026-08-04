//! Permission gates for System Host commands (ADR-005 §7).

use crate::CommandId;
use crate::PermissionId;

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
#[derive(Debug, Clone)]
pub struct PermissionSet {
    granted: Vec<PermissionId>,
}

impl Default for PermissionSet {
    fn default() -> Self {
        // Desktop Slice 12: clipboard is allowed by default.
        Self {
            granted: vec![PermissionId::ClipboardRead, PermissionId::ClipboardWrite],
        }
    }
}

impl PermissionSet {
    #[must_use]
    pub fn allows(&self, permission: PermissionId) -> bool {
        self.granted.contains(&permission)
    }

    pub fn require(
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
}

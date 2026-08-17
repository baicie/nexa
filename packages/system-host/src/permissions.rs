//! Process-level application permission installation for the trusted launcher.

use std::fmt;
use std::sync::OnceLock;

use nui_system_core::{
    load_release_manifest, AppManifest, AppManifestError, CommandId, PermissionDenied,
    PermissionSet,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionInstallError {
    AlreadyInstalled,
}

impl fmt::Display for PermissionInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyInstalled => write!(formatter, "app permissions are already installed"),
        }
    }
}

impl std::error::Error for PermissionInstallError {}

#[derive(Debug)]
pub enum ManifestPermissionInstallError {
    Manifest(AppManifestError),
    Permissions(PermissionInstallError),
}

impl fmt::Display for ManifestPermissionInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Manifest(error) => write!(formatter, "invalid embedded app manifest: {error}"),
            Self::Permissions(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ManifestPermissionInstallError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Manifest(error) => Some(error),
            Self::Permissions(error) => Some(error),
        }
    }
}

#[derive(Debug, Default)]
pub struct SystemHostPermissions {
    installed: OnceLock<PermissionSet>,
}

impl SystemHostPermissions {
    pub fn install(&self, manifest: &AppManifest) -> Result<(), PermissionInstallError> {
        self.installed
            .set(PermissionSet::from_manifest(manifest))
            .map_err(|_| PermissionInstallError::AlreadyInstalled)
    }

    pub fn install_release_bytes(
        &self,
        bytes: &[u8],
    ) -> Result<(), ManifestPermissionInstallError> {
        let manifest =
            load_release_manifest(bytes).map_err(ManifestPermissionInstallError::Manifest)?;
        self.install(&manifest)
            .map_err(ManifestPermissionInstallError::Permissions)
    }

    pub fn require_command(&self, command: CommandId) -> Result<(), PermissionDenied> {
        self.installed.get().map_or_else(
            || PermissionSet::default().require_command(command),
            |set| set.require_command(command),
        )
    }
}

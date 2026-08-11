//! Strict application-manifest loading for development and packaged apps.

use std::collections::HashSet;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use nui_protocol::common::PROTOCOL_VERSION;
use nui_protocol::system::PermissionId;
use semver::Version;
use serde::de::{self, Unexpected, Visitor};
use serde::Deserialize;

use crate::permission_from_name;

pub const APP_MANIFEST_SCHEMA_URI: &str = "https://nexa-ui.dev/schema/app-manifest-v1.json";
pub const APP_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const MAX_APP_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_PERMISSIONS: usize = 64;
const MAX_SEMVER_CORE_DIGITS: usize = 18;

fn deserialize_u32_value<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct U32ValueVisitor;

    impl Visitor<'_> for U32ValueVisitor {
        type Value = u32;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("an integer from 0 through 4294967295")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            u32::try_from(value).map_err(|_| E::invalid_value(Unexpected::Unsigned(value), &self))
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            u32::try_from(value).map_err(|_| E::invalid_value(Unexpected::Signed(value), &self))
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value.is_finite()
                && value.fract() == 0.0
                && value >= 0.0
                && value <= f64::from(u32::MAX)
            {
                Ok(value as u32)
            } else {
                Err(E::invalid_value(Unexpected::Float(value), &self))
            }
        }
    }

    deserializer.deserialize_any(U32ValueVisitor)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolRequirement {
    #[serde(deserialize_with = "deserialize_u32_value")]
    pub major: u32,
    #[serde(deserialize_with = "deserialize_u32_value")]
    pub minor: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppManifest {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    required_protocol: ProtocolRequirement,
    permissions: Vec<PermissionId>,
}

impl AppManifest {
    #[must_use]
    pub const fn schema_version(&self) -> u32 {
        self.schema_version
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub const fn required_protocol(&self) -> ProtocolRequirement {
        self.required_protocol
    }

    #[must_use]
    pub fn permissions(&self) -> &[PermissionId] {
        &self.permissions
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireAppManifest {
    #[serde(rename = "$schema")]
    schema_uri: String,
    #[serde(deserialize_with = "deserialize_u32_value")]
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    required_protocol: ProtocolRequirement,
    permissions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppManifestError {
    Io {
        path: PathBuf,
        message: String,
    },
    TooLarge {
        maximum: usize,
        actual_at_least: usize,
    },
    InvalidJson {
        line: usize,
        column: usize,
        message: String,
    },
    InvalidSchemaUri {
        actual: String,
    },
    UnsupportedSchemaVersion {
        actual: u32,
    },
    InvalidAppId {
        actual: String,
    },
    InvalidAppName,
    InvalidAppVersion {
        actual: String,
    },
    IncompatibleProtocol {
        required: ProtocolRequirement,
        available: ProtocolRequirement,
    },
    TooManyPermissions {
        maximum: usize,
        actual: usize,
    },
    UnknownPermission {
        permission: String,
    },
    DuplicatePermission {
        permission: String,
    },
}

impl fmt::Display for AppManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, message } => {
                write!(formatter, "could not read {}: {message}", path.display())
            }
            Self::TooLarge {
                maximum,
                actual_at_least,
            } => write!(
                formatter,
                "app manifest is at least {actual_at_least} bytes; maximum is {maximum}"
            ),
            Self::InvalidJson {
                line,
                column,
                message,
            } => write!(
                formatter,
                "invalid app manifest JSON at {line}:{column}: {message}"
            ),
            Self::InvalidSchemaUri { actual } => write!(
                formatter,
                "unsupported app manifest schema URI {actual:?}; expected {APP_MANIFEST_SCHEMA_URI:?}"
            ),
            Self::UnsupportedSchemaVersion { actual } => write!(
                formatter,
                "unsupported app manifest schema version {actual}; expected {APP_MANIFEST_SCHEMA_VERSION}"
            ),
            Self::InvalidAppId { actual } => {
                write!(formatter, "invalid reverse-DNS app id {actual:?}")
            }
            Self::InvalidAppName => write!(formatter, "app name must be 1 to 80 visible characters"),
            Self::InvalidAppVersion { actual } => {
                write!(formatter, "invalid app SemVer {actual:?}")
            }
            Self::IncompatibleProtocol {
                required,
                available,
            } => write!(
                formatter,
                "app requires protocol {}.{}, runtime provides {}.{}",
                required.major, required.minor, available.major, available.minor
            ),
            Self::TooManyPermissions { maximum, actual } => write!(
                formatter,
                "app declares {actual} permissions; maximum is {maximum}"
            ),
            Self::UnknownPermission { permission } => {
                write!(formatter, "unknown or inactive permission {permission:?}")
            }
            Self::DuplicatePermission { permission } => {
                write!(formatter, "duplicate permission {permission:?}")
            }
        }
    }
}

impl std::error::Error for AppManifestError {}

pub fn load_development_manifest(path: impl AsRef<Path>) -> Result<AppManifest, AppManifestError> {
    let path = path.as_ref();
    let file = File::open(path).map_err(|error| AppManifestError::Io {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    let mut bytes = Vec::new();
    file.take((MAX_APP_MANIFEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| AppManifestError::Io {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
    load_release_manifest(&bytes)
}

pub fn load_release_manifest(bytes: &[u8]) -> Result<AppManifest, AppManifestError> {
    if bytes.len() > MAX_APP_MANIFEST_BYTES {
        return Err(AppManifestError::TooLarge {
            maximum: MAX_APP_MANIFEST_BYTES,
            actual_at_least: bytes.len(),
        });
    }

    let wire: WireAppManifest =
        serde_json::from_slice(bytes).map_err(|error| AppManifestError::InvalidJson {
            line: error.line(),
            column: error.column(),
            message: error.to_string(),
        })?;
    validate(wire)
}

fn validate(wire: WireAppManifest) -> Result<AppManifest, AppManifestError> {
    if wire.schema_uri != APP_MANIFEST_SCHEMA_URI {
        return Err(AppManifestError::InvalidSchemaUri {
            actual: wire.schema_uri,
        });
    }
    if wire.schema_version != APP_MANIFEST_SCHEMA_VERSION {
        return Err(AppManifestError::UnsupportedSchemaVersion {
            actual: wire.schema_version,
        });
    }
    if !is_valid_app_id(&wire.id) {
        return Err(AppManifestError::InvalidAppId { actual: wire.id });
    }
    let name_length = wire.name.chars().count();
    if !(1..=80).contains(&name_length)
        || wire.name.chars().all(is_javascript_whitespace)
        || wire.name.chars().any(char::is_control)
    {
        return Err(AppManifestError::InvalidAppName);
    }
    if wire.version.len() > 128
        || !has_canonical_semver_core(&wire.version)
        || Version::parse(&wire.version).is_err()
    {
        return Err(AppManifestError::InvalidAppVersion {
            actual: wire.version,
        });
    }

    let available = ProtocolRequirement {
        major: PROTOCOL_VERSION.major,
        minor: PROTOCOL_VERSION.minor,
    };
    if wire.required_protocol.major != available.major
        || wire.required_protocol.minor > available.minor
    {
        return Err(AppManifestError::IncompatibleProtocol {
            required: wire.required_protocol,
            available,
        });
    }
    if wire.permissions.len() > MAX_PERMISSIONS {
        return Err(AppManifestError::TooManyPermissions {
            maximum: MAX_PERMISSIONS,
            actual: wire.permissions.len(),
        });
    }

    let mut seen = HashSet::with_capacity(wire.permissions.len());
    let mut permissions = Vec::with_capacity(wire.permissions.len());
    for permission_name in wire.permissions {
        let permission = permission_from_name(&permission_name).ok_or_else(|| {
            AppManifestError::UnknownPermission {
                permission: permission_name.clone(),
            }
        })?;
        if !seen.insert(permission) {
            return Err(AppManifestError::DuplicatePermission {
                permission: permission_name,
            });
        }
        permissions.push(permission);
    }

    Ok(AppManifest {
        schema_version: wire.schema_version,
        id: wire.id,
        name: wire.name,
        version: wire.version,
        required_protocol: wire.required_protocol,
        permissions,
    })
}

fn is_valid_app_id(value: &str) -> bool {
    if !(3..=255).contains(&value.len()) {
        return false;
    }
    let mut segment_count = 0;
    let valid_segments = value.split('.').all(|segment| {
        segment_count += 1;
        let bytes = segment.as_bytes();
        !bytes.is_empty()
            && bytes.first().is_some_and(is_ascii_lowercase_or_digit)
            && bytes.last().is_some_and(is_ascii_lowercase_or_digit)
            && bytes
                .iter()
                .all(|byte| is_ascii_lowercase_or_digit(byte) || *byte == b'-')
    });
    valid_segments && segment_count >= 2
}

fn is_ascii_lowercase_or_digit(byte: &u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

fn has_canonical_semver_core(value: &str) -> bool {
    let core = value.split(['-', '+']).next().unwrap_or_default();
    let mut segments = core.split('.');
    let valid = segments
        .by_ref()
        .take(3)
        .all(|segment| !segment.is_empty() && segment.len() <= MAX_SEMVER_CORE_DIGITS);
    valid && segments.next().is_none() && core.matches('.').count() == 2
}

fn is_javascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

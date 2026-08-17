//! Stable System Host command errors (ADR-007 section 5).

use nui_protocol::common::{
    ErrorContext, ErrorContextValue, ErrorSeverity, HandleKind, HandleRef, NexaError,
};
use nui_protocol::system::{ErrorCode, TaskKind};

use crate::PermissionDenied;

/// Native command result before it is encoded for an FFI transport.
pub type CommandResult<T> = Result<T, NexaError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionSource {
    Manifest,
    OperatingSystem,
}

impl PermissionSource {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Manifest => "manifest",
            Self::OperatingSystem => "operatingSystem",
        }
    }
}

fn context(entries: impl IntoIterator<Item = (&'static str, ErrorContextValue)>) -> ErrorContext {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

const fn metadata(code: ErrorCode) -> (&'static str, ErrorSeverity, bool) {
    match code {
        ErrorCode::InvalidArgument => (
            "INVALID_ARGUMENT",
            ErrorSeverity::RecoverableOperation,
            false,
        ),
        ErrorCode::InvalidKind => ("INVALID_KIND", ErrorSeverity::RecoverableOperation, false),
        ErrorCode::WrongOwner => ("WRONG_OWNER", ErrorSeverity::RecoverableOperation, false),
        ErrorCode::StaleHandle => ("STALE_HANDLE", ErrorSeverity::RecoverableOperation, false),
        ErrorCode::InvalidState => ("INVALID_STATE", ErrorSeverity::RecoverableOperation, false),
        ErrorCode::NotFound => ("NOT_FOUND", ErrorSeverity::RecoverableOperation, false),
        ErrorCode::InvalidData => ("INVALID_DATA", ErrorSeverity::RecoverableOperation, false),
        ErrorCode::PermissionDenied => (
            "PERMISSION_DENIED",
            ErrorSeverity::RecoverableOperation,
            false,
        ),
        ErrorCode::Cancelled => ("CANCELLED", ErrorSeverity::RecoverableOperation, false),
        ErrorCode::PlatformFailure => (
            "PLATFORM_FAILURE",
            ErrorSeverity::RecoverableOperation,
            true,
        ),
        ErrorCode::InternalFailure => ("INTERNAL_FAILURE", ErrorSeverity::FatalRuntime, false),
    }
}

fn system_error(
    code: ErrorCode,
    operation: &str,
    message: impl Into<String>,
    context: Option<ErrorContext>,
    platform_code: Option<&str>,
    cause: Option<NexaError>,
) -> NexaError {
    let (name, severity, retryable) = metadata(code);
    NexaError {
        domain: "system".to_owned(),
        code: code as u32,
        name: name.to_owned(),
        severity,
        operation: operation.to_owned(),
        retryable,
        message: message.into(),
        runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
        context,
        platform_code: platform_code.map(str::to_owned),
        cause: cause.map(Box::new),
    }
}

#[must_use]
pub fn invalid_argument(
    operation: &str,
    parameter: &str,
    expected: &str,
    actual: &str,
) -> NexaError {
    system_error(
        ErrorCode::InvalidArgument,
        operation,
        format!("invalid {parameter}: expected {expected}, got {actual}"),
        Some(context([
            ("parameter", ErrorContextValue::String(parameter.to_owned())),
            ("expected", ErrorContextValue::String(expected.to_owned())),
            ("actual", ErrorContextValue::String(actual.to_owned())),
        ])),
        None,
        None,
    )
}

#[must_use]
pub fn invalid_kind(
    operation: &str,
    expected: HandleKind,
    actual: HandleKind,
    handle: HandleRef,
) -> NexaError {
    system_error(
        ErrorCode::InvalidKind,
        operation,
        format!("expected {expected:?} handle, got {actual:?}"),
        Some(context([
            (
                "expectedKind",
                ErrorContextValue::String(format!("{expected:?}")),
            ),
            (
                "actualKind",
                ErrorContextValue::String(format!("{actual:?}")),
            ),
            ("slot", ErrorContextValue::U32(handle.slot)),
            ("generation", ErrorContextValue::U32(handle.generation)),
        ])),
        None,
        None,
    )
}

#[must_use]
pub fn wrong_owner(operation: &str, expected: u64, actual: u64, handle: HandleRef) -> NexaError {
    system_error(
        ErrorCode::WrongOwner,
        operation,
        "handle belongs to another owner",
        Some(context([
            (
                "expectedOwner",
                ErrorContextValue::String(expected.to_string()),
            ),
            ("actualOwner", ErrorContextValue::String(actual.to_string())),
            ("slot", ErrorContextValue::U32(handle.slot)),
            ("generation", ErrorContextValue::U32(handle.generation)),
        ])),
        None,
        None,
    )
}

#[must_use]
pub fn stale_handle(
    operation: &str,
    handle: HandleRef,
    current_generation: Option<u32>,
) -> NexaError {
    let mut values = context([
        ("slot", ErrorContextValue::U32(handle.slot)),
        ("generation", ErrorContextValue::U32(handle.generation)),
    ]);
    if let Some(current_generation) = current_generation {
        values.insert(
            "currentGeneration".to_owned(),
            ErrorContextValue::U32(current_generation),
        );
    }
    system_error(
        ErrorCode::StaleHandle,
        operation,
        "handle generation is stale",
        Some(values),
        None,
        None,
    )
}

#[must_use]
pub fn invalid_state(operation: &str, state: &str, handle: HandleRef) -> NexaError {
    system_error(
        ErrorCode::InvalidState,
        operation,
        format!("{operation} is not valid while the handle is {state}"),
        Some(context([
            ("state", ErrorContextValue::String(state.to_owned())),
            ("operation", ErrorContextValue::String(operation.to_owned())),
            ("slot", ErrorContextValue::U32(handle.slot)),
            ("generation", ErrorContextValue::U32(handle.generation)),
        ])),
        None,
        None,
    )
}

#[must_use]
pub fn not_found(operation: &str, resource: &str, identifier: &str) -> NexaError {
    system_error(
        ErrorCode::NotFound,
        operation,
        format!("{resource} not found: {identifier}"),
        Some(context([
            ("resource", ErrorContextValue::String(resource.to_owned())),
            (
                "identifier",
                ErrorContextValue::String(identifier.to_owned()),
            ),
        ])),
        None,
        None,
    )
}

#[must_use]
pub fn invalid_data(operation: &str, format: &str, identifier: &str) -> NexaError {
    system_error(
        ErrorCode::InvalidData,
        operation,
        format!("invalid {format} data: {identifier}"),
        Some(context([
            ("format", ErrorContextValue::String(format.to_owned())),
            (
                "identifier",
                ErrorContextValue::String(identifier.to_owned()),
            ),
        ])),
        None,
        None,
    )
}

#[must_use]
pub fn permission_denied(
    operation: &str,
    denied: &PermissionDenied,
    source: PermissionSource,
) -> NexaError {
    system_error(
        ErrorCode::PermissionDenied,
        operation,
        denied.to_string(),
        Some(context([
            (
                "permission",
                ErrorContextValue::String(format!("{:?}", denied.permission)),
            ),
            (
                "command",
                ErrorContextValue::String(format!("{:?}", denied.command)),
            ),
            (
                "source",
                ErrorContextValue::String(source.as_str().to_owned()),
            ),
        ])),
        None,
        None,
    )
}

#[must_use]
pub fn cancelled(operation: &str, reason: &str, owner: u64, task_kind: TaskKind) -> NexaError {
    system_error(
        ErrorCode::Cancelled,
        operation,
        format!("task cancelled: {reason}"),
        Some(context([
            ("reason", ErrorContextValue::String(reason.to_owned())),
            ("owner", ErrorContextValue::String(owner.to_string())),
            (
                "taskKind",
                ErrorContextValue::String(format!("{task_kind:?}")),
            ),
        ])),
        None,
        None,
    )
}

#[must_use]
pub fn platform_failure(
    operation: &str,
    platform: &str,
    platform_code: Option<&str>,
    message: impl Into<String>,
    cause: Option<NexaError>,
) -> NexaError {
    system_error(
        ErrorCode::PlatformFailure,
        operation,
        message,
        Some(context([
            ("platform", ErrorContextValue::String(platform.to_owned())),
            ("operation", ErrorContextValue::String(operation.to_owned())),
        ])),
        platform_code,
        cause,
    )
}

#[must_use]
pub fn internal_failure(
    operation: &str,
    invariant: &str,
    phase: &str,
    message: impl Into<String>,
    cause: Option<NexaError>,
) -> NexaError {
    system_error(
        ErrorCode::InternalFailure,
        operation,
        message,
        Some(context([
            ("invariant", ErrorContextValue::String(invariant.to_owned())),
            ("phase", ErrorContextValue::String(phase.to_owned())),
        ])),
        None,
        cause,
    )
}

#[cfg(test)]
mod tests {
    use nui_protocol::common::{ErrorContextValue, ErrorSeverity, HandleKind, HandleRef};
    use nui_protocol::system::{CommandId, ErrorCode, PermissionId, TaskKind};

    use super::{
        cancelled, internal_failure, invalid_argument, invalid_data, invalid_kind, invalid_state,
        not_found, permission_denied, platform_failure, stale_handle, wrong_owner, CommandResult,
        PermissionSource,
    };
    use crate::PermissionDenied;

    const HANDLE: HandleRef = HandleRef {
        slot: 7,
        generation: 11,
    };

    #[test]
    fn public_error_categories_use_the_stable_system_registry() {
        let denied = permission_denied(
            "clipboardReadText",
            &PermissionDenied {
                permission: PermissionId::ClipboardRead,
                command: CommandId::ClipboardReadText,
            },
            PermissionSource::Manifest,
        );
        let errors = [
            invalid_argument("writeTextFile", "path", "non-empty path", "empty"),
            not_found("readTextFile", "file", "/missing.txt"),
            invalid_data("readTextFile", "utf8", "/invalid.txt"),
            denied,
            cancelled(
                "readTextFile",
                "ownerClosed",
                41,
                TaskKind::ClipboardReadText,
            ),
            platform_failure(
                "readTextFile",
                "macos",
                Some("NSFileReadNoSuchFileError"),
                "native read failed",
                None,
            ),
            internal_failure(
                "drainTask",
                "settlement exists",
                "SystemCompletion",
                "missing",
                None,
            ),
        ];
        let expected = [
            (
                ErrorCode::InvalidArgument,
                "INVALID_ARGUMENT",
                false,
                ErrorSeverity::RecoverableOperation,
            ),
            (
                ErrorCode::NotFound,
                "NOT_FOUND",
                false,
                ErrorSeverity::RecoverableOperation,
            ),
            (
                ErrorCode::InvalidData,
                "INVALID_DATA",
                false,
                ErrorSeverity::RecoverableOperation,
            ),
            (
                ErrorCode::PermissionDenied,
                "PERMISSION_DENIED",
                false,
                ErrorSeverity::RecoverableOperation,
            ),
            (
                ErrorCode::Cancelled,
                "CANCELLED",
                false,
                ErrorSeverity::RecoverableOperation,
            ),
            (
                ErrorCode::PlatformFailure,
                "PLATFORM_FAILURE",
                true,
                ErrorSeverity::RecoverableOperation,
            ),
            (
                ErrorCode::InternalFailure,
                "INTERNAL_FAILURE",
                false,
                ErrorSeverity::FatalRuntime,
            ),
        ];

        for (error, (code, name, retryable, severity)) in errors.into_iter().zip(expected) {
            assert_eq!(error.domain, "system");
            assert_eq!(error.code, code as u32);
            assert_eq!(error.name, name);
            assert_eq!(error.retryable, retryable);
            assert_eq!(error.severity, severity);
            assert_eq!(error.runtime_version, env!("CARGO_PKG_VERSION"));
        }
    }

    #[test]
    fn every_rust_constructor_matches_manifest_metadata() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../protocol/system-host.json"))
                .expect("system manifest");
        let denied = PermissionDenied {
            permission: PermissionId::ClipboardRead,
            command: CommandId::ClipboardReadText,
        };
        let errors = [
            invalid_argument("writeTextFile", "path", "non-empty", "empty"),
            invalid_kind(
                "cancelTask",
                HandleKind::Task,
                HandleKind::NativeResource,
                HANDLE,
            ),
            wrong_owner("cancelTask", 41, 42, HANDLE),
            stale_handle("cancelTask", HANDLE, None),
            invalid_state("cancelTask", "Closed", HANDLE),
            not_found("readTextFile", "file", "/missing.txt"),
            invalid_data("readTextFile", "utf8", "/invalid.txt"),
            permission_denied("clipboardReadText", &denied, PermissionSource::Manifest),
            cancelled("readTextFile", "requested", 41, TaskKind::ClipboardReadText),
            platform_failure("readTextFile", "macos", Some("ENOENT"), "failed", None),
            internal_failure(
                "drainTask",
                "settlement exists",
                "SystemCompletion",
                "missing",
                None,
            ),
        ];
        let registry = manifest["errors"].as_array().expect("error registry");

        for error in errors {
            let entry = registry
                .iter()
                .find(|entry| entry["code"].as_u64() == Some(u64::from(error.code)))
                .expect("constructor code exists in manifest");
            assert_eq!(entry["domain"], error.domain);
            assert_eq!(entry["name"], error.name);
            assert_eq!(entry["retryable"], error.retryable);
            assert_eq!(entry["severity"], format!("{:?}", error.severity));
            assert_eq!(entry["lifecycle"]["status"], "active");
        }
    }

    #[test]
    fn handle_failures_keep_machine_readable_context() {
        let errors = [
            invalid_kind(
                "cancelTask",
                HandleKind::Task,
                HandleKind::NativeResource,
                HANDLE,
            ),
            wrong_owner("cancelTask", 41, 42, HANDLE),
            stale_handle("cancelTask", HANDLE, Some(12)),
            invalid_state("cancelTask", "Closed", HANDLE),
        ];

        assert_eq!(errors[0].code, ErrorCode::InvalidKind as u32);
        assert_eq!(errors[1].code, ErrorCode::WrongOwner as u32);
        assert_eq!(errors[2].code, ErrorCode::StaleHandle as u32);
        assert_eq!(errors[3].code, ErrorCode::InvalidState as u32);
        for error in &errors {
            let context = error.context.as_ref().expect("handle error context");
            assert_eq!(context["slot"], ErrorContextValue::U32(7));
            assert_eq!(context["generation"], ErrorContextValue::U32(11));
        }
        assert_eq!(
            errors[2].context.as_ref().unwrap()["currentGeneration"],
            ErrorContextValue::U32(12)
        );
    }

    #[test]
    fn platform_failure_preserves_code_and_structured_cause() {
        let cause = not_found("openFile", "file", "/missing.txt");
        let error = platform_failure(
            "readTextFile",
            "windows",
            Some("ERROR_FILE_NOT_FOUND"),
            "ReadFile failed",
            Some(cause.clone()),
        );

        assert_eq!(error.platform_code.as_deref(), Some("ERROR_FILE_NOT_FOUND"));
        assert_eq!(error.cause.as_deref(), Some(&cause));
        let context = error.context.expect("platform context");
        assert_eq!(
            context["platform"],
            ErrorContextValue::String("windows".to_owned())
        );
        assert_eq!(
            context["operation"],
            ErrorContextValue::String("readTextFile".to_owned())
        );
    }

    #[test]
    fn permission_error_preserves_manifest_or_os_source() {
        let denied = PermissionDenied {
            permission: PermissionId::ClipboardWrite,
            command: CommandId::ClipboardWriteText,
        };
        for (source, expected) in [
            (PermissionSource::Manifest, "manifest"),
            (PermissionSource::OperatingSystem, "operatingSystem"),
        ] {
            let error = permission_denied("clipboardWriteText", &denied, source);
            assert_eq!(
                error.context.as_ref().unwrap()["source"],
                ErrorContextValue::String(expected.to_owned())
            );
        }
    }

    #[test]
    fn command_result_uses_nexa_error_without_a_lossy_sentinel() {
        fn assert_cancelled(result: CommandResult<String>) {
            match result {
                Ok(value) => panic!("unexpected success sentinel: {value}"),
                Err(error) => assert_eq!(error.code, ErrorCode::Cancelled as u32),
            }
        }

        assert_cancelled(Err(cancelled(
            "readTextFile",
            "requested",
            41,
            TaskKind::ClipboardReadText,
        )));
    }
}

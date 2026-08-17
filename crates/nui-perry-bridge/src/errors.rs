//! Stable error construction at Host, renderer, and platform boundaries.

use nui_core::protocol::common::{ErrorContext, ErrorContextValue, ErrorSeverity, NexaError};
use nui_core::MutationError;
use nui_platform_winit::{PlatformError, PlatformFailure};

use crate::host::HostTextInputError;

fn ui_error(
    code: nui_protocol::ui::ErrorCode,
    name: &str,
    severity: ErrorSeverity,
    operation: &str,
    retryable: bool,
    message: impl Into<String>,
    context: Option<ErrorContext>,
) -> NexaError {
    NexaError {
        domain: "ui".to_owned(),
        code: code as u32,
        name: name.to_owned(),
        severity,
        operation: operation.to_owned(),
        retryable,
        message: message.into(),
        runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
        context,
        platform_code: None,
        cause: None,
    }
}

fn context(entries: impl IntoIterator<Item = (&'static str, ErrorContextValue)>) -> ErrorContext {
    entries
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect()
}

/// Convert a rejected Host mutation into the stable operation-error contract.
#[must_use]
pub fn mutation_nexa_error(error: MutationError, operation: &str) -> NexaError {
    let (code, name, message, values) = match error {
        MutationError::OwnerMismatch { expected, actual } => (
            nui_protocol::ui::ErrorCode::WrongOwner,
            "WRONG_OWNER",
            "mutation batch belongs to another host owner",
            context([
                (
                    "expectedOwner",
                    ErrorContextValue::String(expected.to_string()),
                ),
                ("actualOwner", ErrorContextValue::String(actual.to_string())),
            ]),
        ),
        MutationError::InvalidCreatedRef(index) => (
            nui_protocol::ui::ErrorCode::InvalidArgument,
            "INVALID_ARGUMENT",
            "created node reference is not valid in this batch",
            context([
                ("parameter", ErrorContextValue::String("node".to_owned())),
                (
                    "expected",
                    ErrorContextValue::String("created node reference".to_owned()),
                ),
                ("actual", ErrorContextValue::U32(index)),
            ]),
        ),
        MutationError::InvalidNodeType(node_type) => (
            nui_protocol::ui::ErrorCode::InvalidArgument,
            "INVALID_ARGUMENT",
            "node type is not valid for this mutation",
            context([
                (
                    "parameter",
                    ErrorContextValue::String("nodeType".to_owned()),
                ),
                (
                    "expected",
                    ErrorContextValue::String("known ui.NodeType".to_owned()),
                ),
                ("actual", ErrorContextValue::U32(node_type)),
            ]),
        ),
        MutationError::InvalidButtonNode { node, actual } => (
            nui_protocol::ui::ErrorCode::InvalidKind,
            "INVALID_KIND",
            "button registration requires a View node",
            context([
                ("expectedKind", ErrorContextValue::String("View".to_owned())),
                (
                    "actualKind",
                    ErrorContextValue::String(format!("{actual:?}")),
                ),
                ("slot", ErrorContextValue::U32(node.slot())),
                ("generation", ErrorContextValue::U32(node.generation())),
            ]),
        ),
        MutationError::InvalidPropertyId(property) => (
            nui_protocol::ui::ErrorCode::InvalidArgument,
            "INVALID_ARGUMENT",
            "property id is not valid for this mutation",
            context([
                (
                    "parameter",
                    ErrorContextValue::String("property".to_owned()),
                ),
                (
                    "expected",
                    ErrorContextValue::String("known ui.PropertyId".to_owned()),
                ),
                ("actual", ErrorContextValue::U32(property)),
            ]),
        ),
        MutationError::InvalidPropertyValue(property) => (
            nui_protocol::ui::ErrorCode::InvalidArgument,
            "INVALID_ARGUMENT",
            "property value must be finite",
            context([
                ("parameter", ErrorContextValue::String("value".to_owned())),
                (
                    "expected",
                    ErrorContextValue::String("finite number".to_owned()),
                ),
                (
                    "actual",
                    ErrorContextValue::String(format!("property {property:?}")),
                ),
            ]),
        ),
        MutationError::InvalidSemantics => (
            nui_protocol::ui::ErrorCode::InvalidArgument,
            "INVALID_ARGUMENT",
            "semantics must match the ui.Semantics contract",
            context([
                (
                    "parameter",
                    ErrorContextValue::String("semantics".to_owned()),
                ),
                (
                    "expected",
                    ErrorContextValue::String("valid ui.Semantics JSON".to_owned()),
                ),
                (
                    "actual",
                    ErrorContextValue::String("invalid semantics payload".to_owned()),
                ),
            ]),
        ),
        MutationError::SequenceExhausted { sequence } => (
            nui_protocol::ui::ErrorCode::InvalidState,
            "INVALID_STATE",
            "mutation sequence exceeds the v1 protocol range",
            context([
                (
                    "state",
                    ErrorContextValue::String(format!("sequenceExhausted:{sequence}")),
                ),
                ("operation", ErrorContextValue::String(operation.to_owned())),
            ]),
        ),
        MutationError::StaleNode(node) => (
            nui_protocol::ui::ErrorCode::StaleHandle,
            "STALE_HANDLE",
            "node handle is stale or belongs to another owner",
            context([
                ("slot", ErrorContextValue::U32(node.slot())),
                ("generation", ErrorContextValue::U32(node.generation())),
            ]),
        ),
        MutationError::Tree(tree) => (
            nui_protocol::ui::ErrorCode::InvalidArgument,
            "INVALID_ARGUMENT",
            "tree mutation was rejected",
            context([
                ("parameter", ErrorContextValue::String("tree".to_owned())),
                (
                    "expected",
                    ErrorContextValue::String("valid tree mutation".to_owned()),
                ),
                ("actual", ErrorContextValue::String(format!("{tree:?}"))),
            ]),
        ),
        MutationError::PlanInvalidated => (
            nui_protocol::ui::ErrorCode::InvalidState,
            "INVALID_STATE",
            "queued mutation plan was invalidated before commit",
            context([
                (
                    "state",
                    ErrorContextValue::String("planInvalidated".to_owned()),
                ),
                ("operation", ErrorContextValue::String(operation.to_owned())),
            ]),
        ),
    };
    ui_error(
        code,
        name,
        ErrorSeverity::RecoverableOperation,
        operation,
        false,
        message,
        Some(values),
    )
}

/// Convert a renderer failure into a retryable frame error.
#[must_use]
pub fn frame_nexa_error(operation: &str, message: impl Into<String>) -> NexaError {
    ui_error(
        nui_protocol::ui::ErrorCode::PlatformFailure,
        "PLATFORM_FAILURE",
        ErrorSeverity::FrameFailure,
        operation,
        true,
        message,
        Some(context([
            ("platform", ErrorContextValue::String("renderer".to_owned())),
            ("operation", ErrorContextValue::String(operation.to_owned())),
        ])),
    )
}

/// Convert an invalid Host operation state into a recoverable error.
#[must_use]
pub fn operation_state_nexa_error(operation: &str, message: impl Into<String>) -> NexaError {
    ui_error(
        nui_protocol::ui::ErrorCode::InvalidState,
        "INVALID_STATE",
        ErrorSeverity::RecoverableOperation,
        operation,
        false,
        message,
        Some(context([
            (
                "state",
                ErrorContextValue::String("invalidOperationState".to_owned()),
            ),
            ("operation", ErrorContextValue::String(operation.to_owned())),
        ])),
    )
}

/// Convert a TextInputClient boundary failure into the stable UI error contract.
#[must_use]
pub fn text_input_nexa_error(error: HostTextInputError, operation: &str) -> NexaError {
    match error {
        HostTextInputError::StaleNode {
            node,
            current_generation,
        } => {
            let mut values = context([
                ("slot", ErrorContextValue::U32(node.slot())),
                ("generation", ErrorContextValue::U32(node.generation())),
            ]);
            if let Some(current_generation) = current_generation {
                values.insert(
                    "currentGeneration".to_owned(),
                    ErrorContextValue::U32(current_generation),
                );
            }
            ui_error(
                nui_protocol::ui::ErrorCode::StaleHandle,
                "STALE_HANDLE",
                ErrorSeverity::RecoverableOperation,
                operation,
                false,
                "text input node handle is stale or belongs to another owner",
                Some(values),
            )
        }
        HostTextInputError::NotTextInput { node } => ui_error(
            nui_protocol::ui::ErrorCode::InvalidArgument,
            "INVALID_ARGUMENT",
            ErrorSeverity::RecoverableOperation,
            operation,
            false,
            "node is not a registered text input",
            Some(context([
                ("parameter", ErrorContextValue::String("node".to_owned())),
                (
                    "expected",
                    ErrorContextValue::String("registered text input node".to_owned()),
                ),
                (
                    "actual",
                    ErrorContextValue::String(format!(
                        "h1/{:08x}/{:08x}",
                        node.slot(),
                        node.generation()
                    )),
                ),
            ])),
        ),
        HostTextInputError::InvalidUtf16Range {
            start,
            end,
            utf16_length,
        } => ui_error(
            nui_protocol::ui::ErrorCode::InvalidArgument,
            "INVALID_ARGUMENT",
            ErrorSeverity::RecoverableOperation,
            operation,
            false,
            "text replacement range must use UTF-16 grapheme boundaries",
            Some(context([
                ("parameter", ErrorContextValue::String("range".to_owned())),
                (
                    "expected",
                    ErrorContextValue::String(format!(
                        "grapheme boundaries within 0..={utf16_length} UTF-16 code units"
                    )),
                ),
                (
                    "actual",
                    ErrorContextValue::String(format!("{start}..{end}")),
                ),
            ])),
        ),
        HostTextInputError::TextTooLong { utf16_length } => ui_error(
            nui_protocol::ui::ErrorCode::InvalidState,
            "INVALID_STATE",
            ErrorSeverity::RecoverableOperation,
            operation,
            false,
            "text input exceeds the v1 UTF-16 offset range",
            Some(context([
                (
                    "state",
                    ErrorContextValue::String(format!("textTooLong:{utf16_length}")),
                ),
                ("operation", ErrorContextValue::String(operation.to_owned())),
            ])),
        ),
        HostTextInputError::LayoutUnavailable { node } => ui_error(
            nui_protocol::ui::ErrorCode::InvalidState,
            "INVALID_STATE",
            ErrorSeverity::RecoverableOperation,
            operation,
            false,
            "text layout must be current before querying composition bounds",
            Some(context([
                (
                    "state",
                    ErrorContextValue::String(format!(
                        "layoutUnavailable:{}/{}",
                        node.slot(),
                        node.generation()
                    )),
                ),
                ("operation", ErrorContextValue::String(operation.to_owned())),
            ])),
        ),
        HostTextInputError::RevisionMismatch { expected, actual } => ui_error(
            nui_protocol::ui::ErrorCode::InvalidState,
            "INVALID_STATE",
            ErrorSeverity::RecoverableOperation,
            operation,
            false,
            "text input revision is stale",
            Some(context([
                (
                    "state",
                    ErrorContextValue::String(format!("staleRevision:{expected}/{actual}")),
                ),
                ("operation", ErrorContextValue::String(operation.to_owned())),
            ])),
        ),
        HostTextInputError::RevisionExhausted => ui_error(
            nui_protocol::ui::ErrorCode::InternalFailure,
            "INTERNAL_FAILURE",
            ErrorSeverity::FatalRuntime,
            operation,
            false,
            "text input revision counter exhausted",
            Some(context([
                (
                    "invariant",
                    ErrorContextValue::String("monotonic text revision".to_owned()),
                ),
                ("phase", ErrorContextValue::String(operation.to_owned())),
            ])),
        ),
    }
}

/// Convert a caught native panic into a fatal runtime error.
#[must_use]
pub fn fatal_runtime_nexa_error(operation: &str, message: impl Into<String>) -> NexaError {
    ui_error(
        nui_protocol::ui::ErrorCode::InternalFailure,
        "INTERNAL_FAILURE",
        ErrorSeverity::FatalRuntime,
        operation,
        false,
        message,
        Some(context([
            (
                "invariant",
                ErrorContextValue::String("native panic".to_owned()),
            ),
            ("phase", ErrorContextValue::String(operation.to_owned())),
        ])),
    )
}

/// Convert an event-loop-owned platform failure into a frame or fatal error.
#[must_use]
pub fn platform_failure_nexa_error(failure: &PlatformFailure) -> NexaError {
    ui_error(
        nui_protocol::ui::ErrorCode::PlatformFailure,
        "PLATFORM_FAILURE",
        if failure.is_terminal() {
            ErrorSeverity::FatalRuntime
        } else {
            ErrorSeverity::FrameFailure
        },
        failure.operation(),
        failure.retryable(),
        failure.message(),
        Some(context([
            ("platform", ErrorContextValue::String("winit".to_owned())),
            (
                "operation",
                ErrorContextValue::String(failure.operation().to_owned()),
            ),
        ])),
    )
}

/// Convert a `run_app` failure into a fatal structured runtime error.
#[must_use]
pub fn platform_run_nexa_error(error: &PlatformError) -> NexaError {
    let operation = match error {
        PlatformError::EventLoop(_) => "eventLoop",
        PlatformError::Window(_) => "createWindow",
        PlatformError::SoftBuffer(_) => "createSurface",
    };
    ui_error(
        nui_protocol::ui::ErrorCode::PlatformFailure,
        "PLATFORM_FAILURE",
        ErrorSeverity::FatalRuntime,
        operation,
        false,
        error.to_string(),
        Some(context([
            ("platform", ErrorContextValue::String("winit".to_owned())),
            ("operation", ErrorContextValue::String(operation.to_owned())),
        ])),
    )
}

fn context_value_json(value: &ErrorContextValue) -> serde_json::Value {
    match value {
        ErrorContextValue::String(value) => serde_json::Value::String(value.clone()),
        ErrorContextValue::U32(value) => serde_json::json!(value),
        ErrorContextValue::F64(value) => serde_json::json!(value),
        ErrorContextValue::Bool(value) => serde_json::Value::Bool(*value),
    }
}

fn error_json(error: &NexaError) -> serde_json::Value {
    let severity = match error.severity {
        ErrorSeverity::ProtocolViolation => "ProtocolViolation",
        ErrorSeverity::RecoverableOperation => "RecoverableOperation",
        ErrorSeverity::FrameFailure => "FrameFailure",
        ErrorSeverity::FatalRuntime => "FatalRuntime",
    };
    let mut value = serde_json::json!({
        "domain": error.domain,
        "code": error.code,
        "name": error.name,
        "severity": severity,
        "operation": error.operation,
        "retryable": error.retryable,
        "message": error.message,
        "runtimeVersion": error.runtime_version,
    });
    let object = value.as_object_mut().expect("error JSON object");
    if let Some(context) = error.context.as_ref() {
        object.insert(
            "context".to_owned(),
            serde_json::Value::Object(
                context
                    .iter()
                    .map(|(key, value)| (key.clone(), context_value_json(value)))
                    .collect(),
            ),
        );
    }
    if let Some(platform_code) = error.platform_code.as_ref() {
        object.insert(
            "platformCode".to_owned(),
            serde_json::Value::String(platform_code.clone()),
        );
    }
    if let Some(cause) = error.cause.as_deref() {
        object.insert("cause".to_owned(), error_json(cause));
    }
    value
}

/// Encode a typed error in the stable v1 result envelope.
#[must_use]
pub fn error_result_json(error: &NexaError) -> String {
    serde_json::json!({ "ok": false, "error": error_json(error) }).to_string()
}

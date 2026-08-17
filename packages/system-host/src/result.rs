//! ADR-007 `nexa_result_json_v1` encoder and panic boundary.

use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};

use nui_system_core::protocol::common::{ErrorContextValue, ErrorSeverity, NexaError};
use nui_system_core::CommandResult;
use serde_json::{Map, Number, Value};

const MAX_CAUSE_DEPTH: usize = 32;

fn severity_json(severity: ErrorSeverity) -> &'static str {
    match severity {
        ErrorSeverity::ProtocolViolation => "ProtocolViolation",
        ErrorSeverity::RecoverableOperation => "RecoverableOperation",
        ErrorSeverity::FrameFailure => "FrameFailure",
        ErrorSeverity::FatalRuntime => "FatalRuntime",
    }
}

fn context_value_json(value: &ErrorContextValue) -> Result<Value, ()> {
    match value {
        ErrorContextValue::String(value) => Ok(Value::String(value.clone())),
        ErrorContextValue::U32(value) => Ok(Value::Number(Number::from(*value))),
        ErrorContextValue::F64(value) => Number::from_f64(*value).map(Value::Number).ok_or(()),
        ErrorContextValue::Bool(value) => Ok(Value::Bool(*value)),
    }
}

fn error_json(error: &NexaError, depth: usize) -> Result<Value, ()> {
    if depth >= MAX_CAUSE_DEPTH {
        return Err(());
    }
    let mut value = Map::from_iter([
        ("domain".to_owned(), Value::String(error.domain.clone())),
        ("code".to_owned(), Value::Number(Number::from(error.code))),
        ("name".to_owned(), Value::String(error.name.clone())),
        (
            "severity".to_owned(),
            Value::String(severity_json(error.severity).to_owned()),
        ),
        (
            "operation".to_owned(),
            Value::String(error.operation.clone()),
        ),
        ("retryable".to_owned(), Value::Bool(error.retryable)),
        ("message".to_owned(), Value::String(error.message.clone())),
        (
            "runtimeVersion".to_owned(),
            Value::String(error.runtime_version.clone()),
        ),
    ]);
    if let Some(context) = error.context.as_ref() {
        let context = context
            .iter()
            .map(|(key, value)| Ok((key.clone(), context_value_json(value)?)))
            .collect::<Result<Map<_, _>, ()>>()?;
        value.insert("context".to_owned(), Value::Object(context));
    }
    if let Some(platform_code) = error.platform_code.as_ref() {
        value.insert(
            "platformCode".to_owned(),
            Value::String(platform_code.clone()),
        );
    }
    if let Some(cause) = error.cause.as_deref() {
        value.insert("cause".to_owned(), error_json(cause, depth + 1)?);
    }
    Ok(Value::Object(value))
}

fn encode_result(result: CommandResult<Value>) -> Result<String, ()> {
    let envelope = match result {
        Ok(value) => serde_json::json!({ "ok": true, "value": value }),
        Err(error) => serde_json::json!({ "ok": false, "error": error_json(&error, 0)? }),
    };
    Ok(envelope.to_string())
}

fn fallback_internal_result(operation: &str, message: impl Into<String>) -> String {
    serde_json::json!({
        "ok": false,
        "error": {
            "domain": "system",
            "code": nui_system_core::protocol::system::ErrorCode::InternalFailure as u32,
            "name": "INTERNAL_FAILURE",
            "severity": "FatalRuntime",
            "operation": operation,
            "retryable": false,
            "message": message.into(),
            "runtimeVersion": env!("CARGO_PKG_VERSION"),
            "context": {
                "invariant": "command result satisfies nexa_result_json_v1",
                "phase": "ffiBoundary",
            },
        },
    })
    .to_string()
}

#[must_use]
pub fn command_result_json(result: CommandResult<Value>) -> String {
    encode_result(result).unwrap_or_else(|()| {
        fallback_internal_result(
            "encodeCommandResult",
            "command result could not be encoded without losing its contract",
        )
    })
}

#[must_use]
pub fn catch_command_result_json(
    operation: &str,
    command: impl FnOnce() -> CommandResult<Value>,
) -> String {
    match catch_unwind(AssertUnwindSafe(|| command_result_json(command()))) {
        Ok(encoded) => encoded,
        Err(payload) => fallback_internal_result(
            operation,
            format!(
                "native command panicked: {}",
                panic_message(payload.as_ref())
            ),
        ),
    }
}

fn panic_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(message) = payload.downcast_ref::<&str>() {
        message
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.as_str()
    } else {
        "non-string panic payload"
    }
}

#[cfg(test)]
mod tests {
    use nui_system_core::protocol::common::ErrorContextValue;
    use nui_system_core::{not_found, platform_failure, CommandResult};
    use serde_json::{json, Value};

    use super::{catch_command_result_json, command_result_json};

    fn decode(encoded: &str) -> Value {
        serde_json::from_str(encoded).expect("valid result JSON")
    }

    #[test]
    fn codec_emits_exact_success_and_structured_failure_envelopes() {
        assert_eq!(
            decode(&command_result_json(Ok(json!({ "answer": 42 })))),
            json!({ "ok": true, "value": { "answer": 42 } })
        );

        let cause = not_found("openFile", "file", "/missing.txt");
        let error = platform_failure(
            "readTextFile",
            "windows",
            Some("ERROR_FILE_NOT_FOUND"),
            "ReadFile failed",
            Some(cause),
        );
        let encoded = decode(&command_result_json(Err(error)));
        assert_eq!(encoded["ok"], false);
        assert_eq!(encoded["error"]["domain"], "system");
        assert_eq!(encoded["error"]["code"], 0x0200_0009_u32);
        assert_eq!(encoded["error"]["platformCode"], "ERROR_FILE_NOT_FOUND");
        assert_eq!(encoded["error"]["context"]["platform"], "windows");
        assert_eq!(encoded["error"]["cause"]["name"], "NOT_FOUND");
        assert_eq!(
            encoded["error"]["cause"]["context"]["identifier"],
            "/missing.txt"
        );
    }

    #[test]
    fn codec_never_serializes_tagged_context_values() {
        let error = not_found("openFile", "file", "/missing.txt");
        let encoded = decode(&command_result_json(Err(error)));

        assert_eq!(encoded["error"]["context"]["resource"], "file");
        assert_ne!(
            encoded["error"]["context"]["resource"],
            json!({ "String": "file" })
        );
    }

    #[test]
    fn non_finite_context_is_replaced_by_an_internal_failure() {
        let mut error = not_found("openFile", "file", "/missing.txt");
        error
            .context
            .as_mut()
            .unwrap()
            .insert("bad".to_owned(), ErrorContextValue::F64(f64::NAN));

        let encoded = decode(&command_result_json(Err(error)));
        assert_eq!(encoded["ok"], false);
        assert_eq!(encoded["error"]["name"], "INTERNAL_FAILURE");
        assert_eq!(encoded["error"]["operation"], "encodeCommandResult");
    }

    #[test]
    fn panic_is_contained_and_encoded_as_internal_failure() {
        let encoded = decode(&catch_command_result_json(
            "resetSession",
            || -> CommandResult<Value> { panic!("ffi boundary boom") },
        ));

        assert_eq!(encoded["ok"], false);
        assert_eq!(encoded["error"]["name"], "INTERNAL_FAILURE");
        assert_eq!(encoded["error"]["operation"], "resetSession");
        assert_eq!(encoded["error"]["context"]["phase"], "ffiBoundary");
    }
}

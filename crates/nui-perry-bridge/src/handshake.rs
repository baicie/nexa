//! Protocol/ABI negotiation at the Host boundary.
//!
//! The generated Rust protocol types are intentionally not serde-derived: they
//! are the shared semantic contract, while this module owns the JSON wire
//! representation and its strict boundary validation.

use std::collections::BTreeMap;

use nui_protocol::common;
use serde::{Deserialize, Serialize};

const HOST_RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireProtocolVersion {
    major: u32,
    minor: u32,
    patch: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireAbiVersion {
    major: u32,
    minor: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireFeatureBits {
    low: u32,
    high: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireFeatureSet {
    required: WireFeatureBits,
    optional: WireFeatureBits,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireHello {
    protocol: WireProtocolVersion,
    abi: WireAbiVersion,
    client_runtime_version: String,
    client_target_triple: String,
    transport: WireFeatureSet,
    ui: WireFeatureSet,
    system: WireFeatureSet,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireAccepted {
    protocol: WireProtocolVersionOut,
    abi: WireAbiVersionOut,
    host_runtime_version: String,
    host_target_triple: String,
    transport: WireFeatureBits,
    ui: WireFeatureBits,
    system: WireFeatureBits,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireProtocolVersionOut {
    major: u32,
    minor: u32,
    patch: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireAbiVersionOut {
    major: u32,
    minor: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
enum WireSeverity {
    ProtocolViolation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireError {
    domain: String,
    code: u32,
    name: String,
    severity: WireSeverity,
    operation: String,
    retryable: bool,
    message: String,
    runtime_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cause: Option<Box<WireError>>,
}

#[derive(Debug, Serialize)]
struct WireSuccess<T> {
    ok: bool,
    value: T,
}

#[derive(Debug, Serialize)]
struct WireFailure {
    ok: bool,
    error: WireError,
}

const TRANSPORT_SUPPORTED: WireFeatureBits = WireFeatureBits { low: 0b11, high: 0 };
const UI_SUPPORTED: WireFeatureBits = WireFeatureBits {
    low: 0b1100,
    high: 0,
};
const SYSTEM_SUPPORTED: WireFeatureBits = WireFeatureBits {
    low: 0b1_1100,
    high: 0,
};

fn host_target_triple() -> String {
    format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
}

fn protocol_error(code: common::ErrorCode, name: &str, message: impl Into<String>) -> WireError {
    WireError {
        domain: "protocol".to_owned(),
        code: code as u32,
        name: name.to_owned(),
        severity: WireSeverity::ProtocolViolation,
        operation: "handshake".to_owned(),
        retryable: false,
        message: message.into(),
        runtime_version: HOST_RUNTIME_VERSION.to_owned(),
        context: None,
        platform_code: None,
        cause: None,
    }
}

fn contains(required: &WireFeatureBits, supported: &WireFeatureBits) -> bool {
    (required.low & !supported.low) == 0 && (required.high & !supported.high) == 0
}

fn intersect(left: &WireFeatureBits, right: WireFeatureBits) -> WireFeatureBits {
    WireFeatureBits {
        low: left.low & right.low,
        high: left.high & right.high,
    }
}

fn enabled_features(
    namespace: &str,
    requested: &WireFeatureSet,
    supported: WireFeatureBits,
) -> Result<WireFeatureBits, Box<WireError>> {
    if !contains(&requested.required, &supported) {
        let mut context = BTreeMap::new();
        context.insert(
            "featureNamespace".to_owned(),
            serde_json::Value::String(namespace.to_owned()),
        );
        return Err(Box::new(WireError {
            context: Some(context),
            ..protocol_error(
                common::ErrorCode::UnsupportedFeature,
                "UNSUPPORTED_FEATURE",
                format!("required {namespace} feature is not supported by this host"),
            )
        }));
    }

    let requested_bits = WireFeatureBits {
        low: requested.required.low | requested.optional.low,
        high: requested.required.high | requested.optional.high,
    };
    Ok(intersect(&requested_bits, supported))
}

fn negotiate(hello: WireHello) -> Result<WireAccepted, Box<WireError>> {
    let _client_identity = (&hello.client_runtime_version, &hello.client_target_triple);
    let _client_protocol_detail = (hello.protocol.minor, hello.protocol.patch);
    if hello.protocol.major != common::PROTOCOL_VERSION.major
        || hello.abi.major != common::ABI_VERSION.major
    {
        return Err(Box::new(protocol_error(
            common::ErrorCode::ProtocolMismatch,
            "PROTOCOL_MISMATCH",
            "client and host protocol or ABI major versions are incompatible",
        )));
    }

    let transport = enabled_features("transport", &hello.transport, TRANSPORT_SUPPORTED)?;
    let ui = enabled_features("ui", &hello.ui, UI_SUPPORTED)?;
    let system = enabled_features("system", &hello.system, SYSTEM_SUPPORTED)?;

    Ok(WireAccepted {
        protocol: WireProtocolVersionOut {
            major: common::PROTOCOL_VERSION.major,
            minor: common::PROTOCOL_VERSION.minor,
            patch: common::PROTOCOL_VERSION.patch,
        },
        abi: WireAbiVersionOut {
            major: common::ABI_VERSION.major,
            minor: hello.abi.minor.min(common::ABI_VERSION.minor),
        },
        host_runtime_version: HOST_RUNTIME_VERSION.to_owned(),
        host_target_triple: host_target_triple(),
        transport,
        ui,
        system,
    })
}

/// Negotiate the current Host contract and return a versioned JSON result.
///
/// Parsing failures are returned as protocol errors so no malformed Perry
/// input can panic or cross the native boundary as an exception.
#[must_use]
pub fn handshake_json(input: &str) -> String {
    let result = serde_json::from_str::<WireHello>(input)
        .map_err(|error| {
            Box::new(protocol_error(
                common::ErrorCode::ProtocolMismatch,
                "PROTOCOL_MISMATCH",
                format!("invalid handshake payload: {error}"),
            ))
        })
        .and_then(negotiate);

    match result {
        Ok(value) => serde_json::to_string(&WireSuccess { ok: true, value })
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":{}}".to_owned()),
        Err(error) => serde_json::to_string(&WireFailure {
            ok: false,
            error: *error,
        })
        .unwrap_or_else(|_| "{\"ok\":false,\"error\":{}}".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::handshake_json;

    fn hello(protocol_major: u32, required_system: u32, optional_transport: u32) -> String {
        json!({
            "protocol": { "major": protocol_major, "minor": 4, "patch": 2 },
            "abi": { "major": 0, "minor": 8 },
            "clientRuntimeVersion": "client-test",
            "clientTargetTriple": "test-target",
            "transport": {
                "required": { "low": 0, "high": 0 },
                "optional": { "low": optional_transport, "high": 0 }
            },
            "ui": {
                "required": { "low": 0, "high": 0 },
                "optional": { "low": u32::MAX, "high": 0 }
            },
            "system": {
                "required": { "low": required_system, "high": 0 },
                "optional": { "low": 0, "high": 0 }
            }
        })
        .to_string()
    }

    #[test]
    fn accepts_compatible_versions_and_intersects_features() {
        let result: Value = serde_json::from_str(&handshake_json(&hello(1, 0, 0b1_0001))).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(
            result["value"]["protocol"],
            json!({"major": 1, "minor": 0, "patch": 0})
        );
        assert_eq!(result["value"]["abi"], json!({"major": 0, "minor": 5}));
        assert_eq!(result["value"]["transport"], json!({"low": 1, "high": 0}));
        assert_eq!(result["value"]["ui"], json!({"low": 12, "high": 0}));
        assert_eq!(result["value"]["system"], json!({"low": 0, "high": 0}));
    }

    #[test]
    fn rejects_required_features_the_host_does_not_support() {
        let result: Value = serde_json::from_str(&handshake_json(&hello(1, 1 << 5, 0))).unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"]["code"], 65_538);
        assert_eq!(result["error"]["name"], "UNSUPPORTED_FEATURE");
        assert_eq!(result["error"]["context"]["featureNamespace"], "system");
    }

    #[test]
    fn rejects_protocol_major_mismatch() {
        let result: Value = serde_json::from_str(&handshake_json(&hello(2, 0, 0))).unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"]["code"], 65_537);
        assert_eq!(result["error"]["name"], "PROTOCOL_MISMATCH");
    }

    #[test]
    fn rejects_unknown_payload_fields() {
        let mut payload: Value = serde_json::from_str(&hello(1, 0, 0)).unwrap();
        payload["unexpected"] = json!(true);
        let result: Value = serde_json::from_str(&handshake_json(&payload.to_string())).unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"]["code"], 65_537);
    }
}

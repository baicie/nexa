import { Common } from "@nexa/protocol";

import { clearPropertyV1Raw, createNodeV1Raw, handshakeRaw } from "./ffi";
import type { NodeType, PropertyId } from "./ffi";
import { decodeHandleToken } from "./handle";

type JsonRecord = Record<string, unknown>;
const PROTOCOL_MISMATCH_CODE = 0x0001_0001;
const PROTOCOL_ERROR_SEVERITY = "ProtocolViolation" as Common.ErrorSeverity;
const ERROR_SEVERITIES: readonly string[] = [
  "ProtocolViolation",
  "RecoverableOperation",
  "FrameFailure",
  "FatalRuntime",
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => key in value)
  );
}

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isFeatureBits(value: unknown): value is Common.FeatureBits {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["low", "high"]) &&
    isUint32(value.low) &&
    isUint32(value.high)
  );
}

function isProtocolAccepted(value: unknown): value is Common.ProtocolAccepted {
  if (!isRecord(value)) return false;
  const version = value.protocol;
  const abi = value.abi;
  return (
    hasExactKeys(value, [
      "protocol",
      "abi",
      "hostRuntimeVersion",
      "hostTargetTriple",
      "transport",
      "ui",
      "system",
    ]) &&
    isRecord(version) &&
    hasExactKeys(version, ["major", "minor", "patch"]) &&
    isUint32(version.major) &&
    isUint32(version.minor) &&
    isUint32(version.patch) &&
    isRecord(abi) &&
    hasExactKeys(abi, ["major", "minor"]) &&
    isUint32(abi.major) &&
    isUint32(abi.minor) &&
    typeof value.hostRuntimeVersion === "string" &&
    typeof value.hostTargetTriple === "string" &&
    isFeatureBits(value.transport) &&
    isFeatureBits(value.ui) &&
    isFeatureBits(value.system)
  );
}

function isErrorSeverity(value: unknown): value is Common.ErrorSeverity {
  return typeof value === "string" && ERROR_SEVERITIES.includes(value);
}

function isErrorContext(value: unknown): value is Common.ErrorContext {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry)),
  );
}

function isNexaError(value: unknown): value is Common.NexaError {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(
      value,
      ["domain", "code", "name", "severity", "operation", "retryable", "message", "runtimeVersion"],
      ["context", "platformCode", "cause"],
    )
  ) {
    return false;
  }
  return (
    (value.domain === "protocol" || value.domain === "ui" || value.domain === "system") &&
    isUint32(value.code) &&
    typeof value.name === "string" &&
    isErrorSeverity(value.severity) &&
    typeof value.operation === "string" &&
    typeof value.retryable === "boolean" &&
    typeof value.message === "string" &&
    typeof value.runtimeVersion === "string" &&
    (value.context === undefined || isErrorContext(value.context)) &&
    (value.platformCode === undefined || typeof value.platformCode === "string") &&
    (value.cause === undefined || isNexaError(value.cause))
  );
}

function localProtocolError(message: string, operation = "handshake"): Common.NexaError {
  return {
    domain: "protocol",
    code: PROTOCOL_MISMATCH_CODE,
    name: "PROTOCOL_MISMATCH",
    severity: PROTOCOL_ERROR_SEVERITY,
    operation,
    retryable: false,
    message,
    runtimeVersion: "@nexa/nui-host",
  };
}

function parseResult<T>(
  raw: string,
  decodeValue: (value: unknown) => T,
  operation: string,
): Common.NexaResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(`${operation} returned invalid JSON: ${String(error)}`, operation),
    };
  }
  if (!isRecord(value) || !("ok" in value)) {
    return {
      ok: false,
      error: localProtocolError(`${operation} result must be a result envelope`, operation),
    };
  }
  if (value.ok === true && hasExactKeys(value, ["ok", "value"])) {
    try {
      return { ok: true, value: decodeValue(value.value) };
    } catch (error) {
      return {
        ok: false,
        error: localProtocolError(
          `${operation} result value is invalid: ${String(error)}`,
          operation,
        ),
      };
    }
  }
  if (value.ok === false && hasExactKeys(value, ["ok", "error"]) && isNexaError(value.error)) {
    return { ok: false, error: value.error };
  }
  return {
    ok: false,
    error: localProtocolError(`${operation} result failed contract validation`, operation),
  };
}

/** Perform the v1 protocol handshake and validate the native result envelope. */
export function handshake(hello: Common.ProtocolHello): Common.NexaResult<Common.ProtocolAccepted> {
  let raw: string;
  try {
    raw = handshakeRaw(JSON.stringify(hello));
  } catch (error) {
    return { ok: false, error: localProtocolError(`handshake transport failed: ${String(error)}`) };
  }
  return parseResult(
    raw,
    (value) => {
      if (!isProtocolAccepted(value)) throw new TypeError("accepted protocol shape is invalid");
      return value;
    },
    "handshake",
  );
}

/** Create a node through the stable v1 string-result ABI. */
export function createNodeV1(type: NodeType): Common.NexaResult<Common.HandleRef> {
  let raw: string;
  try {
    raw = createNodeV1Raw(type);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(`createNode transport failed: ${String(error)}`, "createNode"),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (typeof value !== "string") throw new TypeError("handle result must be a token string");
      return decodeHandleToken(value);
    },
    "createNode",
  );
}

/** Clear a property through the stable v1 string-result ABI. */
export function clearPropertyV1(node: bigint, property: PropertyId): Common.NexaResult<null> {
  let raw: string;
  try {
    raw = clearPropertyV1Raw(node, property);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(
        `clearProperty transport failed: ${String(error)}`,
        "clearProperty",
      ),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (value !== null) throw new TypeError("clearProperty result must be null");
      return null;
    },
    "clearProperty",
  );
}

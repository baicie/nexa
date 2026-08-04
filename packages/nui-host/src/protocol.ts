import { Common } from "@nexa/protocol";

import {
  addEventListenerV1Raw,
  clearPropertyV1Raw,
  createNodeV1Raw,
  handshakeRaw,
  removeEventListenerV1Raw,
} from "./ffi";
import type { EventId, NodeType, PropertyId } from "./ffi";
import { decodeHandleToken, isHandleRef } from "./handle";

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

function localInvalidArgumentError(
  message: string,
  operation: string,
  parameter: string,
  expected: string,
  actual: string,
): Common.NexaError {
  return {
    domain: "ui",
    code: 0x0100_0001,
    name: "INVALID_ARGUMENT",
    severity: "RecoverableOperation" as Common.ErrorSeverity,
    operation,
    retryable: false,
    message,
    runtimeVersion: "@nexa/nui-host",
    context: { parameter, expected, actual },
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
export function clearPropertyV1(
  node: Common.HandleRef,
  property: PropertyId,
): Common.NexaResult<null> {
  if (!isHandleRef(node)) {
    return {
      ok: false,
      error: localProtocolError("clearProperty node must be a valid HandleRef", "clearProperty"),
    };
  }
  let raw: string;
  try {
    raw = clearPropertyV1Raw(node.slot, node.generation, property);
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

/** Add or replace a listener through the stable v1 CallbackHandle ABI. */
export function addEventListenerV1(
  node: Common.HandleRef,
  event: EventId,
  callback: unknown,
): Common.NexaResult<Common.HandleRef> {
  if (!isHandleRef(node)) {
    return {
      ok: false,
      error: localProtocolError(
        "addEventListener node must be a valid HandleRef",
        "addEventListener",
      ),
    };
  }
  if (typeof callback !== "function") {
    return {
      ok: false,
      error: localInvalidArgumentError(
        "callback must be a function",
        "addEventListener",
        "callback",
        "function",
        typeof callback,
      ),
    };
  }
  let raw: string;
  try {
    raw = addEventListenerV1Raw(
      node.slot,
      node.generation,
      event,
      callback as (value: string) => void,
    );
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(
        `addEventListener transport failed: ${String(error)}`,
        "addEventListener",
      ),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (typeof value !== "string") {
        throw new TypeError("callback handle result must be a token string");
      }
      return decodeHandleToken(value);
    },
    "addEventListener",
  );
}

/** Remove a listener through the stable v1 CallbackHandle ABI. */
export function removeEventListenerV1(listener: Common.HandleRef): Common.NexaResult<null> {
  if (!isHandleRef(listener)) {
    return {
      ok: false,
      error: localProtocolError(
        "removeEventListener listener must be a valid HandleRef",
        "removeEventListener",
      ),
    };
  }
  let raw: string;
  try {
    raw = removeEventListenerV1Raw(listener.slot, listener.generation);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(
        `removeEventListener transport failed: ${String(error)}`,
        "removeEventListener",
      ),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (value !== null) throw new TypeError("removeEventListener result must be null");
      return null;
    },
    "removeEventListener",
  );
}

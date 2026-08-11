import { Common, Ui } from "@nexa/protocol";

import {
  addEventListenerV1Raw,
  clearPropertyV1Raw,
  clearSemanticsV1Raw,
  commitV1Raw,
  createNodeV1Raw,
  getCompositionBoundsV1Raw,
  getTextInputStateV1Raw,
  handshakeRaw,
  removeEventListenerV1Raw,
  registerButtonV1Raw,
  replaceTextInputV1Raw,
  resetSessionV1Raw,
  runV1Raw,
  setSemanticsV1Raw,
} from "./ffi";
import type { EventId, NodeType, PropertyId } from "./ffi";
import { decodeHandleToken, isHandleRef } from "./handle";
import { guardFrameworkCallback } from "./errors";

type JsonRecord = Record<string, unknown>;
const PROTOCOL_MISMATCH_CODE = 0x0001_0001;
const HOST_RUNTIME_VERSION = "0.1.0";
const PROTOCOL_ERROR_SEVERITY = "ProtocolViolation" as Common.ErrorSeverity;
const ERROR_SEVERITIES: readonly string[] = [
  "ProtocolViolation",
  "RecoverableOperation",
  "FrameFailure",
  "FatalRuntime",
];
const SEMANTIC_ROLES: Readonly<Record<Ui.SemanticRole, true>> = {
  None: true,
  Button: true,
  Text: true,
  Image: true,
  TextInput: true,
  Scroll: true,
  Header: true,
};
const SEMANTIC_ACTIONS: Readonly<Record<Ui.SemanticAction, true>> = {
  Invoke: true,
  Focus: true,
  SetValue: true,
};

function hasOwnKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

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

function isTextRange(value: unknown): value is Ui.TextRange {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["start", "end"]) &&
    isUint32(value.start) &&
    isUint32(value.end) &&
    value.start <= value.end
  );
}

function isTextSelection(value: unknown): value is Ui.TextSelection {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["anchor", "focus"]) &&
    isUint32(value.anchor) &&
    isUint32(value.focus)
  );
}

function isRect(value: unknown): value is Ui.Rect {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["x", "y", "width", "height"]) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width >= 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height >= 0
  );
}

function isSemantics(value: unknown): value is Ui.Semantics {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [],
      ["role", "label", "value", "description", "disabled", "checked", "actions"],
    )
  ) {
    return false;
  }
  return (
    (value.role === undefined ||
      (typeof value.role === "string" && hasOwnKey(SEMANTIC_ROLES, value.role))) &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.value === undefined || typeof value.value === "string") &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.disabled === undefined || typeof value.disabled === "boolean") &&
    (value.checked === undefined || typeof value.checked === "boolean") &&
    (value.actions === undefined ||
      (Array.isArray(value.actions) &&
        value.actions.every(
          (action) => typeof action === "string" && hasOwnKey(SEMANTIC_ACTIONS, action),
        )))
  );
}

function isDecimalU64(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) <= 0xffff_ffff_ffff_ffffn;
  } catch {
    return false;
  }
}

function decodeTextInputState(value: unknown): Ui.TextInputState {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["text", "surroundingText", "selection", "compositionBounds", "revision"],
      ["composition"],
    ) ||
    typeof value.text !== "string" ||
    !isTextRange(value.surroundingText) ||
    !isTextSelection(value.selection) ||
    !isRect(value.compositionBounds) ||
    !isDecimalU64(value.revision) ||
    (value.composition !== undefined &&
      value.composition !== null &&
      !isTextRange(value.composition))
  ) {
    throw new TypeError("text input state shape is invalid");
  }
  const utf16Length = value.text.length;
  if (
    value.surroundingText.end > utf16Length ||
    value.selection.anchor > utf16Length ||
    value.selection.focus > utf16Length ||
    (isTextRange(value.composition) && value.composition.end > utf16Length)
  ) {
    throw new TypeError("text input state offsets exceed its UTF-16 text length");
  }
  const state: Ui.TextInputState = {
    text: value.text,
    surroundingText: value.surroundingText,
    selection: value.selection,
    compositionBounds: value.compositionBounds,
    revision: value.revision,
  };
  if (isTextRange(value.composition)) {
    return { ...state, composition: value.composition };
  }
  return state;
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
    runtimeVersion: HOST_RUNTIME_VERSION,
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
    runtimeVersion: HOST_RUNTIME_VERSION,
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

/** Queue explicit visual-tree semantics through the stable v1 JSON ABI. */
export function setSemanticsV1(
  node: Common.HandleRef,
  semantics: Ui.Semantics,
): Common.NexaResult<null> {
  if (!isHandleRef(node)) {
    return {
      ok: false,
      error: localProtocolError("setSemantics node must be a valid HandleRef", "setSemantics"),
    };
  }
  if (!isSemantics(semantics)) {
    return {
      ok: false,
      error: localInvalidArgumentError(
        "semantics must match the ui.Semantics contract",
        "setSemantics",
        "semantics",
        "ui.Semantics",
        String(semantics),
      ),
    };
  }
  let raw: string;
  try {
    raw = setSemanticsV1Raw(node.slot, node.generation, JSON.stringify(semantics));
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(`setSemantics transport failed: ${String(error)}`, "setSemantics"),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (value !== null) throw new TypeError("setSemantics result must be null");
      return null;
    },
    "setSemantics",
  );
}

/** Remove explicit semantics so component defaults can be derived again. */
export function clearSemanticsV1(node: Common.HandleRef): Common.NexaResult<null> {
  if (!isHandleRef(node)) {
    return {
      ok: false,
      error: localProtocolError("clearSemantics node must be a valid HandleRef", "clearSemantics"),
    };
  }
  let raw: string;
  try {
    raw = clearSemanticsV1Raw(node.slot, node.generation);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(
        `clearSemantics transport failed: ${String(error)}`,
        "clearSemantics",
      ),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (value !== null) throw new TypeError("clearSemantics result must be null");
      return null;
    },
    "clearSemantics",
  );
}

/** Register a composite View as a first-party Button for derived semantics. */
export function registerButtonV1(node: Common.HandleRef): Common.NexaResult<null> {
  if (!isHandleRef(node)) {
    return {
      ok: false,
      error: localProtocolError("registerButton node must be a valid HandleRef", "registerButton"),
    };
  }
  let raw: string;
  try {
    raw = registerButtonV1Raw(node.slot, node.generation);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(
        `registerButton transport failed: ${String(error)}`,
        "registerButton",
      ),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (value !== null) throw new TypeError("registerButton result must be null");
      return null;
    },
    "registerButton",
  );
}

/** Commit the current mutation batch and validate its receipt envelope. */
export function commitV1(): Common.NexaResult<Ui.CommitReceipt> {
  let raw: string;
  try {
    raw = commitV1Raw();
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(`commit transport failed: ${String(error)}`, "commit"),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (!isRecord(value) || !hasExactKeys(value, ["sequence", "dirtyFlags"])) {
        throw new TypeError("commit receipt shape is invalid");
      }
      if (!isUint32(value.sequence) || !isUint32(value.dirtyFlags)) {
        throw new TypeError("commit receipt fields must be uint32");
      }
      return {
        sequence: value.sequence,
        dirtyFlags: value.dirtyFlags,
      };
    },
    "commit",
  );
}

/** Close the current owner scope and prepare an empty Host session. */
export function resetSessionV1(): Common.NexaResult<null> {
  let raw: string;
  try {
    raw = resetSessionV1Raw();
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(`resetSession transport failed: ${String(error)}`, "resetSession"),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (value !== null) throw new TypeError("resetSession result must be null");
      return null;
    },
    "resetSession",
  );
}

/** Run the native window through the stable v1 result envelope. */
export function runV1(title: string): Common.NexaResult<null> {
  let raw: string;
  try {
    raw = runV1Raw(title);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(`run transport failed: ${String(error)}`, "run"),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (value !== null) throw new TypeError("run result must be null");
      return null;
    },
    "run",
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
      guardFrameworkCallback(callback as (value: string) => void),
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

/** Query a registered editor through the stable UTF-16 TextInputClient ABI. */
export function getTextInputStateV1(node: Common.HandleRef): Common.NexaResult<Ui.TextInputState> {
  if (!isHandleRef(node)) {
    return {
      ok: false,
      error: localProtocolError(
        "getTextInputState node must be a valid HandleRef",
        "getTextInputState",
      ),
    };
  }
  let raw: string;
  try {
    raw = getTextInputStateV1Raw(node.slot, node.generation);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(
        `getTextInputState transport failed: ${String(error)}`,
        "getTextInputState",
      ),
    };
  }
  return parseResult(raw, decodeTextInputState, "getTextInputState");
}

/** Replace an editor range expressed in JavaScript UTF-16 code units. */
export function replaceTextInputV1(
  node: Common.HandleRef,
  range: Ui.TextRange,
  text: string,
): Common.NexaResult<null> {
  if (!isHandleRef(node)) {
    return {
      ok: false,
      error: localProtocolError(
        "replaceTextInput node must be a valid HandleRef",
        "replaceTextInput",
      ),
    };
  }
  if (!isTextRange(range)) {
    return {
      ok: false,
      error: localInvalidArgumentError(
        "range must contain ordered uint32 UTF-16 offsets",
        "replaceTextInput",
        "range",
        "{ start: uint32, end: uint32, start <= end }",
        String(range),
      ),
    };
  }
  if (typeof text !== "string") {
    return {
      ok: false,
      error: localInvalidArgumentError(
        "replacement text must be a string",
        "replaceTextInput",
        "text",
        "string",
        typeof text,
      ),
    };
  }
  let raw: string;
  try {
    raw = replaceTextInputV1Raw(node.slot, node.generation, range.start, range.end, text);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(
        `replaceTextInput transport failed: ${String(error)}`,
        "replaceTextInput",
      ),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (value !== null) throw new TypeError("replaceTextInput result must be null");
      return null;
    },
    "replaceTextInput",
  );
}

/** Query the paragraph-derived caret rectangle used by platform IME UI. */
export function getCompositionBoundsV1(node: Common.HandleRef): Common.NexaResult<Ui.Rect> {
  if (!isHandleRef(node)) {
    return {
      ok: false,
      error: localProtocolError(
        "getCompositionBounds node must be a valid HandleRef",
        "getCompositionBounds",
      ),
    };
  }
  let raw: string;
  try {
    raw = getCompositionBoundsV1Raw(node.slot, node.generation);
  } catch (error) {
    return {
      ok: false,
      error: localProtocolError(
        `getCompositionBounds transport failed: ${String(error)}`,
        "getCompositionBounds",
      ),
    };
  }
  return parseResult(
    raw,
    (value) => {
      if (!isRect(value)) throw new TypeError("composition bounds shape is invalid");
      return value;
    },
    "getCompositionBounds",
  );
}

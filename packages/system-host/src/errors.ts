import type { Common } from "@nexa/protocol";

type JsonRecord = Record<string, unknown>;
type SystemErrorMetadata = Readonly<{
  name: string;
  severity: Common.ErrorSeverity;
  retryable: boolean;
}>;

const PROTOCOL_MISMATCH_CODE = 0x0001_0001;
const RUNTIME_VERSION = "0.1.0";
const MAX_CAUSE_DEPTH = 32;
const ERROR_SEVERITIES = new Set<string>([
  "ProtocolViolation",
  "RecoverableOperation",
  "FrameFailure",
  "FatalRuntime",
]);
const RECOVERABLE = "RecoverableOperation" as Common.ErrorSeverity;
export const SYSTEM_ERROR_METADATA: ReadonlyMap<number, SystemErrorMetadata> = new Map([
  [0x0200_0001, { name: "INVALID_ARGUMENT", severity: RECOVERABLE, retryable: false }],
  [0x0200_0002, { name: "INVALID_KIND", severity: RECOVERABLE, retryable: false }],
  [0x0200_0003, { name: "WRONG_OWNER", severity: RECOVERABLE, retryable: false }],
  [0x0200_0004, { name: "STALE_HANDLE", severity: RECOVERABLE, retryable: false }],
  [0x0200_0005, { name: "INVALID_STATE", severity: RECOVERABLE, retryable: false }],
  [0x0200_0006, { name: "NOT_FOUND", severity: RECOVERABLE, retryable: false }],
  [0x0200_0007, { name: "PERMISSION_DENIED", severity: RECOVERABLE, retryable: false }],
  [0x0200_0008, { name: "CANCELLED", severity: RECOVERABLE, retryable: false }],
  [0x0200_0009, { name: "PLATFORM_FAILURE", severity: RECOVERABLE, retryable: true }],
  [0x0200_000b, { name: "INVALID_DATA", severity: RECOVERABLE, retryable: false }],
  [
    0x0200_000a,
    {
      name: "INTERNAL_FAILURE",
      severity: "FatalRuntime" as Common.ErrorSeverity,
      retryable: false,
    },
  ],
]);

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
    Object.keys(value).every((key) => allowed.has(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function errorDomainMatchesCode(domain: Common.NexaError["domain"], code: number): boolean {
  const prefix = code >>> 16;
  switch (domain) {
    case "protocol":
      return prefix === 0x0001;
    case "ui":
      return prefix === 0x0100;
    case "system":
      return prefix === 0x0200;
  }
}

function isErrorContext(value: unknown): value is Common.ErrorContext {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry)),
    )
  );
}

function isNexaError(value: unknown, depth = 0): value is Common.NexaError {
  if (depth >= MAX_CAUSE_DEPTH || !isRecord(value)) return false;
  if (
    !hasExactKeys(
      value,
      ["domain", "code", "name", "severity", "operation", "retryable", "message", "runtimeVersion"],
      ["context", "platformCode", "cause"],
    )
  ) {
    return false;
  }
  if (
    (value.domain !== "protocol" && value.domain !== "ui" && value.domain !== "system") ||
    !isUint32(value.code) ||
    typeof value.name !== "string" ||
    typeof value.severity !== "string" ||
    !ERROR_SEVERITIES.has(value.severity) ||
    typeof value.operation !== "string" ||
    typeof value.retryable !== "boolean" ||
    typeof value.message !== "string" ||
    typeof value.runtimeVersion !== "string" ||
    (value.context !== undefined && !isErrorContext(value.context)) ||
    (value.platformCode !== undefined && typeof value.platformCode !== "string") ||
    (value.cause !== undefined && !isNexaError(value.cause, depth + 1))
  ) {
    return false;
  }
  if (!errorDomainMatchesCode(value.domain, value.code)) return false;

  const metadata = value.domain === "system" ? SYSTEM_ERROR_METADATA.get(value.code) : undefined;
  return (
    metadata === undefined ||
    (value.name === metadata.name &&
      value.severity === metadata.severity &&
      value.retryable === metadata.retryable)
  );
}

function protocolMismatch(message: string, operation: string): Common.NexaError {
  return {
    domain: "protocol",
    code: PROTOCOL_MISMATCH_CODE,
    name: "PROTOCOL_MISMATCH",
    severity: "ProtocolViolation" as Common.ErrorSeverity,
    operation,
    retryable: false,
    message,
    runtimeVersion: RUNTIME_VERSION,
  };
}

export type CommandResult<T> = Common.NexaResult<T>;
export type CommandValueDecoder<T> = (value: unknown) => T;

/** Decode and fully validate one `nexa_result_json_v1` command envelope. */
export function decodeCommandResult<T>(
  raw: string,
  decodeValue: CommandValueDecoder<T>,
  operation: string,
): CommandResult<T> {
  let value: unknown;
  try {
    if (typeof raw !== "string") throw new TypeError("result transport must be a string");
    value = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: protocolMismatch(`${operation} returned invalid JSON: ${String(error)}`, operation),
    };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      error: protocolMismatch(`${operation} result must be an object envelope`, operation),
    };
  }
  if (value.ok === true && hasExactKeys(value, ["ok", "value"])) {
    try {
      return { ok: true, value: decodeValue(value.value) };
    } catch (error) {
      return {
        ok: false,
        error: protocolMismatch(
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
    error: protocolMismatch(`${operation} result failed contract validation`, operation),
  };
}

/** Error object retaining the complete native System Host failure contract. */
export class NexaSystemError extends Error {
  readonly detail: Common.NexaError;
  readonly domain: Common.NexaError["domain"];
  readonly code: number;
  readonly severity: Common.ErrorSeverity;
  readonly operation: string;
  readonly retryable: boolean;
  readonly context: Common.ErrorContext | undefined;
  readonly platformCode: string | undefined;
  readonly cause: NexaSystemError | undefined;

  constructor(detail: Common.NexaError) {
    const cause = detail.cause === undefined ? undefined : new NexaSystemError(detail.cause);
    super(`${detail.name}: ${detail.message}`, cause === undefined ? undefined : { cause });
    this.name = "NexaSystemError";
    this.detail = detail;
    this.domain = detail.domain;
    this.code = detail.code;
    this.severity = detail.severity;
    this.operation = detail.operation;
    this.retryable = detail.retryable;
    this.context = detail.context;
    this.platformCode = detail.platformCode;
    this.cause = cause;
  }
}

/** Return a decoded value or throw a structured `NexaSystemError`. */
export function unwrapCommandResult<T>(result: CommandResult<T>): T {
  if (result.ok) return result.value;
  throw new NexaSystemError(result.error);
}

/** Match a raw or wrapped error by System domain and stable numeric code. */
export function isSystemError(error: unknown, code: number): boolean {
  if (!isUint32(code)) return false;
  const detail = error instanceof NexaSystemError ? error.detail : error;
  return isNexaError(detail) && detail.domain === "system" && detail.code === code;
}

import type { Common } from "@nexa/protocol";

const ERROR_HISTORY_LIMIT = 64;
const errorHistory: NexaHostError[] = [];
let errorHandler: ((error: NexaHostError) => void) | null = null;

/** Error object that keeps the complete native NexaError contract available. */
export class NexaHostError extends Error {
  readonly detail: Common.NexaError;
  readonly domain: Common.NexaError["domain"];
  readonly code: number;
  readonly severity: Common.ErrorSeverity;
  readonly operation: string;
  readonly retryable: boolean;
  readonly context: Common.ErrorContext | undefined;
  readonly platformCode: string | undefined;
  readonly cause: NexaHostError | undefined;

  constructor(detail: Common.NexaError) {
    const cause = detail.cause === undefined ? undefined : new NexaHostError(detail.cause);
    super(`${detail.name}: ${detail.message}`, cause === undefined ? undefined : { cause });
    this.name = "NexaHostError";
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

function frameworkError(error: unknown, operation: string): NexaHostError {
  if (error instanceof NexaHostError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : typeof error;
  return new NexaHostError({
    domain: "ui",
    code: 0x0100_0009,
    name: "INTERNAL_FAILURE",
    severity: "RecoverableOperation" as Common.ErrorSeverity,
    operation,
    retryable: false,
    message: `framework callback failed: ${message}`,
    runtimeVersion: "0.1.0",
    context: { source: "frameworkCallback", errorName },
  });
}

function reportFrameworkError(error: unknown, operation: string): void {
  const structured = frameworkError(error, operation);
  if (errorHistory.length === ERROR_HISTORY_LIMIT) errorHistory.shift();
  errorHistory.push(structured);
  if (errorHandler !== null) {
    try {
      errorHandler(structured);
    } catch {
      // A top-level handler must never escape back through Perry's callback ABI.
    }
  }
}

/** Guard a Perry callback so JS exceptions cannot longjmp through Rust. */
export function guardFrameworkCallback<Args extends unknown[]>(
  callback: (...args: Args) => unknown,
  operation = "dispatchEvent",
): (...args: Args) => void {
  return (...args: Args): void => {
    try {
      const result = callback(...args);
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        void Promise.resolve(result).catch((error: unknown) => {
          reportFrameworkError(error, operation);
        });
      }
    } catch (error) {
      reportFrameworkError(error, operation);
    }
  };
}

/** Register the process-level JS error observer. `null` removes it. */
export function setErrorHandler(handler: ((error: NexaHostError) => void) | null): void {
  errorHandler = handler;
}

/** Snapshot framework errors in report order. */
export function getErrorHistory(): readonly NexaHostError[] {
  return errorHistory.slice();
}

/** Clear JS-side framework diagnostics without changing the registered handler. */
export function clearErrorHistory(): void {
  errorHistory.length = 0;
}

/** Typed asynchronous filesystem surface (ADR-012). */

import {
  awaitTask,
  cancelTask,
  decodeCommandResult,
  readTextFileStart,
  unwrapCommandResult,
  writeTextFileStart,
} from "@nexa/system-host";
import type { CommandResult, TaskId } from "@nexa/system-host";

export type Task<T> = {
  readonly id: TaskId;
  readonly result: Promise<T>;
  cancel(): void;
};

function decodeText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("readTextFile result must be a string");
  return value;
}

function decodeUnit(value: unknown): void {
  if (value !== null) throw new TypeError("writeTextFile result must be null");
}

function createTask<T>(
  started: CommandResult<TaskId>,
  decodeValue: (value: unknown) => T,
  operation: string,
): Task<T> {
  const id = unwrapCommandResult(started);
  const result = awaitTask(id).then((encoded) =>
    unwrapCommandResult(decodeCommandResult(encoded, decodeValue, operation)),
  );
  let cancellationRequested = false;

  return {
    id,
    result,
    cancel(): void {
      if (cancellationRequested) return;
      cancellationRequested = true;
      unwrapCommandResult(cancelTask(id));
    },
  };
}

/** Start reading a UTF-8 text file without blocking the UI thread. */
export function readTextFile(path: string): Task<string> {
  return createTask(readTextFileStart(path), decodeText, "readTextFile");
}

/** Start atomically replacing a UTF-8 text file without blocking the UI thread. */
export function writeTextFile(path: string, text: string): Task<void> {
  return createTask(writeTextFileStart(path, text), decodeUnit, "writeTextFile");
}

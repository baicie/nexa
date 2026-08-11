/** Typed asynchronous system clipboard surface (G4-07). */

import {
  awaitTask,
  cancelTask,
  clipboardReadTextStart,
  clipboardWriteTextStart,
  decodeCommandResult,
  unwrapCommandResult,
} from "@nexa/system-host";
import type { CommandResult, TaskId } from "@nexa/system-host";

export type ClipboardTask<T> = {
  readonly id: TaskId;
  readonly result: Promise<T>;
  cancel(): void;
};

/** Generic alias matching the other typed System packages. */
export type Task<T> = ClipboardTask<T>;

function decodeText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("clipboard result must be a string");
  return value;
}

function decodeUnit(value: unknown): void {
  if (value !== null) throw new TypeError("clipboard result must be null");
}

function createTask<T>(
  started: CommandResult<TaskId>,
  decodeValue: (value: unknown) => T,
  operation: string,
): ClipboardTask<T> {
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

/** Start a non-blocking UTF-8 clipboard read. */
export function readText(): ClipboardTask<string> {
  return createTask(clipboardReadTextStart(), decodeText, "clipboardReadText");
}

/** Start a non-blocking UTF-8 clipboard write. */
export function writeText(text: string): ClipboardTask<void> {
  return createTask(clipboardWriteTextStart(text), decodeUnit, "clipboardWriteText");
}

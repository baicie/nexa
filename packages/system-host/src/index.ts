/**
 * Perry System Host FFI wrappers (ADR-005).
 *
 * Each wrapper must call the `js_*` symbol named in package.json.
 */

import type { Common } from "@nexa/protocol";
import { decodeCommandResult } from "./errors";

declare function js_nexa_clipboard_read_text(): string;
declare function js_nexa_clipboard_write_text(text: string): number;
declare function js_nexa_clipboard_read_text_v1(): string;
declare function js_nexa_clipboard_write_text_v1(text: string): string;
declare function js_nexa_read_text_file_v1(path: string): string;
declare function js_nexa_write_text_file_v1(path: string, text: string): string;
declare function js_nexa_await_task_v1(taskSlot: number, taskGeneration: number): Promise<string>;
declare function js_nexa_cancel_task_v1(taskSlot: number, taskGeneration: number): string;
declare function js_nexa_open_file_dialog_v1(
  title: string,
  defaultPath: string,
  filtersJson: string,
): string;
declare function js_nexa_save_file_dialog_v1(
  title: string,
  defaultPath: string,
  filtersJson: string,
): string;

export { decodeCommandResult, isSystemError, NexaSystemError, unwrapCommandResult } from "./errors";
export type { CommandResult, CommandValueDecoder } from "./errors";

export type TaskId = Common.HandleRef;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

/** Decode the exact public Task identity shape used by the System Host ABI. */
export function decodeTaskId(value: unknown): TaskId {
  if (!isRecord(value)) {
    throw new TypeError("TaskId must be an object");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "generation" ||
    keys[1] !== "slot" ||
    !isUint32(value.slot) ||
    !isUint32(value.generation) ||
    value.generation === 0
  ) {
    throw new TypeError("TaskId must contain only uint32 slot and non-zero generation fields");
  }
  return { slot: value.slot, generation: value.generation } as TaskId;
}

function decodeUnit(value: unknown): void {
  if (value !== null) throw new TypeError("command result must be null");
}

/** @deprecated Use @nexa/clipboard readText, which returns a typed Task. */
export function clipboardReadText(): string {
  return js_nexa_clipboard_read_text();
}

/** @deprecated Use @nexa/clipboard writeText, which returns a typed Task. */
export function clipboardWriteText(text: string): boolean {
  return js_nexa_clipboard_write_text(String(text ?? "")) === 0;
}

/** Start a non-blocking clipboard text read. */
export function clipboardReadTextStart(): Common.NexaResult<TaskId> {
  return decodeCommandResult(js_nexa_clipboard_read_text_v1(), decodeTaskId, "clipboardReadText");
}

/** Start a non-blocking clipboard text write. */
export function clipboardWriteTextStart(text: string): Common.NexaResult<TaskId> {
  return decodeCommandResult(
    js_nexa_clipboard_write_text_v1(String(text ?? "")),
    decodeTaskId,
    "clipboardWriteText",
  );
}

/** Start a non-blocking UTF-8 file read. */
export function readTextFileStart(path: string): Common.NexaResult<TaskId> {
  return decodeCommandResult(
    js_nexa_read_text_file_v1(String(path ?? "")),
    decodeTaskId,
    "readTextFile",
  );
}

/** Start a non-blocking atomic UTF-8 file write. */
export function writeTextFileStart(path: string, text: string): Common.NexaResult<TaskId> {
  return decodeCommandResult(
    js_nexa_write_text_file_v1(String(path ?? ""), String(text ?? "")),
    decodeTaskId,
    "writeTextFile",
  );
}

/** Start a non-blocking open-file dialog. */
export function openFileDialogStart(
  title: string,
  defaultPath: string,
  filtersJson: string,
): Common.NexaResult<TaskId> {
  return decodeCommandResult(
    js_nexa_open_file_dialog_v1(
      String(title ?? ""),
      String(defaultPath ?? ""),
      String(filtersJson ?? "[]"),
    ),
    decodeTaskId,
    "openFileDialog",
  );
}

/** Start a non-blocking save-file dialog. */
export function saveFileDialogStart(
  title: string,
  defaultPath: string,
  filtersJson: string,
): Common.NexaResult<TaskId> {
  return decodeCommandResult(
    js_nexa_save_file_dialog_v1(
      String(title ?? ""),
      String(defaultPath ?? ""),
      String(filtersJson ?? "[]"),
    ),
    decodeTaskId,
    "saveFileDialog",
  );
}

/** Register the one Promise transport associated with a Task. */
export function awaitTask(task: TaskId): Promise<string> {
  const id = decodeTaskId(task);
  return js_nexa_await_task_v1(id.slot, id.generation);
}

/** Cooperatively cancel a Task; native cancellation is idempotent. */
export function cancelTask(task: TaskId): Common.NexaResult<void> {
  const id = decodeTaskId(task);
  return decodeCommandResult(
    js_nexa_cancel_task_v1(id.slot, id.generation),
    decodeUnit,
    "cancelTask",
  );
}

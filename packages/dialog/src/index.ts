/** Typed asynchronous native open/save dialogs (G4-06). */

import {
  awaitTask,
  cancelTask,
  decodeCommandResult,
  openFileDialogStart,
  saveFileDialogStart,
  unwrapCommandResult,
} from "@nexa/system-host";
import type { CommandResult, TaskId } from "@nexa/system-host";

export type DialogFilter = Readonly<{
  readonly name: string;
  readonly extensions: readonly string[];
}>;

export type FileDialogOptions = Readonly<{
  readonly title?: string;
  readonly defaultPath?: string;
  readonly filters?: readonly DialogFilter[];
}>;

export type DialogTask<T> = {
  readonly id: TaskId;
  readonly result: Promise<T>;
  cancel(): void;
};

function decodeSelectedPath(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError("dialog result must be a path or null");
  if (value.length === 0) throw new TypeError("dialog result path must not be empty");
  return value;
}

function encodeFilters(filters: readonly DialogFilter[] | undefined): string {
  return JSON.stringify(
    (filters ?? []).map((filter) => ({
      name: String(filter.name),
      extensions: filter.extensions.map((extension) => String(extension)),
    })),
  );
}

function createDialogTask(
  started: CommandResult<TaskId>,
  operation: string,
): DialogTask<string | null> {
  const id = unwrapCommandResult(started);
  const result = awaitTask(id).then((encoded) =>
    unwrapCommandResult(decodeCommandResult(encoded, decodeSelectedPath, operation)),
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

/** Start an asynchronous open-file picker. User cancellation resolves to null. */
export function openFile(options: FileDialogOptions = {}): DialogTask<string | null> {
  return createDialogTask(
    openFileDialogStart(
      options.title ?? "Open File",
      options.defaultPath ?? "",
      encodeFilters(options.filters),
    ),
    "openFileDialog",
  );
}

/** Start an asynchronous save-file picker. User cancellation resolves to null. */
export function saveFile(options: FileDialogOptions = {}): DialogTask<string | null> {
  return createDialogTask(
    saveFileDialogStart(
      options.title ?? "Save File",
      options.defaultPath ?? "",
      encodeFilters(options.filters),
    ),
    "saveFileDialog",
  );
}

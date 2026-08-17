/** @jsxImportSource @nexa/ui */

import { readTextFile, writeTextFile } from "@nexa/fs";
import { mount, type WindowLifecycleEvent } from "@nexa/ui";

import { NotesApp } from "./app";
import { createNotesController, type NotesTask } from "./state";

export const FS_RUNTIME_SMOKE_FILE = "nexa-ui-fs-runtime-smoke.txt";
export const FS_RUNTIME_SMOKE_INVALID_FILE = "nexa-ui-fs-runtime-invalid.txt";
export const FS_RUNTIME_SMOKE_BODY = "Nexa UI UTF-8 smoke: 你好, مرحبا, 😀\n";
export const FS_RUNTIME_SMOKE_MARKER = "nexa-ui reference notes fs runtime smoke ok";
export const FS_RUNTIME_SMOKE_FAILURE = "nexa-ui reference notes fs runtime smoke failed";
export const FS_RUNTIME_SMOKE_STATE_PREFIX = "nexa-ui reference notes state: ";
export const FS_RUNTIME_SMOKE_INVALID_PREFIX = "nexa-ui reference notes invalid utf-8: ";

type Diagnostic = Readonly<{
  code?: number;
  operation?: string;
  context?: Readonly<Record<string, unknown>>;
}>;

const completedTask = <T,>(value: T): NotesTask<T> => ({
  result: Promise.resolve(value),
  cancel() {},
});

let diagnostic: unknown;
const controller = createNotesController({
  open: () => completedTask(FS_RUNTIME_SMOKE_INVALID_FILE),
  save: () => completedTask(FS_RUNTIME_SMOKE_FILE),
  read: readTextFile,
  write: writeTextFile,
  reportError(error) {
    diagnostic = error;
  },
});

let started = false;

async function runSmoke(): Promise<void> {
  try {
    controller.editBody(FS_RUNTIME_SMOKE_BODY);
    await controller.save();
    const body = await readTextFile(FS_RUNTIME_SMOKE_FILE).result;
    if (body !== FS_RUNTIME_SMOKE_BODY) {
      throw new Error("filesystem round-trip content mismatch");
    }
    const afterSave = controller.snapshot();
    if (
      afterSave.path !== FS_RUNTIME_SMOKE_FILE ||
      afterSave.title !== FS_RUNTIME_SMOKE_FILE ||
      afterSave.body !== FS_RUNTIME_SMOKE_BODY ||
      afterSave.revision !== 2 ||
      afterSave.savedRevision !== 2 ||
      afterSave.dirty ||
      afterSave.status !== "已保存" ||
      afterSave.busy ||
      afterSave.operation !== "idle" ||
      afterSave.window !== "active"
    ) {
      throw new Error("Notes controller did not reach the saved state");
    }

    await controller.open();
    const afterInvalidOpen = controller.snapshot();
    const invalidStatus = `打开失败: INVALID_DATA: invalid utf-8 data: ${FS_RUNTIME_SMOKE_INVALID_FILE}`;
    if (
      afterInvalidOpen.path !== afterSave.path ||
      afterInvalidOpen.title !== afterSave.title ||
      afterInvalidOpen.body !== afterSave.body ||
      afterInvalidOpen.revision !== afterSave.revision ||
      afterInvalidOpen.savedRevision !== afterSave.savedRevision ||
      afterInvalidOpen.dirty ||
      afterInvalidOpen.status !== invalidStatus ||
      afterInvalidOpen.busy ||
      afterInvalidOpen.operation !== "idle" ||
      afterInvalidOpen.window !== "active"
    ) {
      throw new Error("invalid UTF-8 open changed the saved Notes document");
    }
    const error = diagnostic as Diagnostic | undefined;
    if (
      error?.code !== 0x0200_000b ||
      error.operation !== "readTextFile" ||
      error.context?.format !== "utf-8" ||
      error.context.identifier !== FS_RUNTIME_SMOKE_INVALID_FILE
    ) {
      throw new Error("invalid UTF-8 open did not preserve the structured System diagnostic");
    }

    console.log(`${FS_RUNTIME_SMOKE_STATE_PREFIX}${JSON.stringify(afterSave)}`);
    console.log(
      `${FS_RUNTIME_SMOKE_INVALID_PREFIX}${JSON.stringify({
        afterInvalidOpen,
        diagnostic: {
          code: error.code,
          operation: error.operation,
          context: error.context,
        },
      })}`,
    );
    console.log(FS_RUNTIME_SMOKE_MARKER);
  } catch (error) {
    console.log(`${FS_RUNTIME_SMOKE_FAILURE}: ${String(error)}`);
  }
}

function handleLifecycle(event: WindowLifecycleEvent): void {
  if (event.kind !== "Ready" || started) return;
  started = true;
  void runSmoke();
}

mount(() => <NotesApp controller={controller} onLifecycle={handleLifecycle} />);

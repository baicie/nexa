/** @jsxImportSource @nexa/ui */

import { openFile, saveFile } from "@nexa/dialog";
import { readTextFile, writeTextFile } from "@nexa/fs";
import { mount, type WindowLifecycleEvent } from "@nexa/ui";

import { NotesApp } from "./app";
import { createNotesController, type NotesSnapshot } from "./state";

declare const process: Readonly<{ cwd(): string }>;

const OPEN_FILE = "nexa-ui-picker-probe-open.txt";
const OPEN_BODY = "Opened through real OS picker: 你好, مرحبا, 😀\n";
const SAVE_FILE = "nexa-ui-picker-probe-save.txt";
const SAVE_BODY = "Saved through real OS picker: 会议记录 📝\n";
const SAVE_TITLE = "Nexa UI Picker Probe - Save";
const OPEN_TITLE = "Nexa UI Picker Probe - Open";
const CANCEL_TITLE = "Nexa UI Picker Probe - Cancel";
const SUCCESS = "nexa-ui reference notes real dialog picker smoke ok";
const FAILURE = "nexa-ui reference notes real dialog picker smoke failed";
const STATE_PREFIX = "nexa-ui reference notes real dialog picker journey: ";
const STAGE_PREFIX = "nexa-ui reference notes picker stage: ";

let openCount = 0;
const controller = createNotesController({
  open: () => {
    const cancel = openCount > 0;
    openCount += 1;
    console.log(`${STAGE_PREFIX}${cancel ? "cancel" : "open"}`);
    return openFile({
      title: cancel ? CANCEL_TITLE : OPEN_TITLE,
      defaultPath: `${process.cwd()}/${OPEN_FILE}`,
      filters: [{ name: "Text", extensions: ["txt", "md"] }],
    });
  },
  save: () => {
    console.log(`${STAGE_PREFIX}save`);
    return saveFile({
      title: SAVE_TITLE,
      defaultPath: `${process.cwd()}/${SAVE_FILE}`,
      filters: [{ name: "Text", extensions: ["txt", "md"] }],
    });
  },
  read: readTextFile,
  write: writeTextFile,
});

let started = false;

function fileName(value: string): string {
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return value.slice(separator + 1);
}

function assertSnapshot(
  snapshot: NotesSnapshot,
  expectedFile: string,
  expectedBody: string,
  expectedRevision: number,
): void {
  if (
    snapshot.path === null ||
    fileName(snapshot.path) !== expectedFile ||
    snapshot.title !== expectedFile ||
    snapshot.body !== expectedBody ||
    snapshot.revision !== expectedRevision ||
    snapshot.savedRevision !== expectedRevision ||
    snapshot.dirty ||
    snapshot.status !== "已保存" ||
    snapshot.busy ||
    snapshot.operation !== "idle" ||
    snapshot.window !== "active"
  ) {
    throw new Error(`Picker did not commit the expected ${expectedFile} Notes state`);
  }
}

async function runSmoke(): Promise<void> {
  try {
    controller.editBody(SAVE_BODY);
    await controller.save();
    const afterSave = controller.snapshot();
    assertSnapshot(afterSave, SAVE_FILE, SAVE_BODY, 2);

    await controller.open();
    const afterOpen = controller.snapshot();
    assertSnapshot(afterOpen, OPEN_FILE, OPEN_BODY, 3);

    await controller.open();
    const afterCancel = controller.snapshot();
    assertSnapshot(afterCancel, OPEN_FILE, OPEN_BODY, 3);

    console.log(
      `${STATE_PREFIX}${JSON.stringify({ version: 1, afterSave, afterOpen, afterCancel })}`,
    );
    console.log(SUCCESS);
  } catch (error) {
    console.log(`${FAILURE}: ${String(error)}`);
  }
}

function handleLifecycle(event: WindowLifecycleEvent): void {
  if (event.kind !== "Ready" || started) return;
  started = true;
  void runSmoke();
}

mount(() => <NotesApp controller={controller} onLifecycle={handleLifecycle} />);

/** @jsxImportSource @nexa/ui */

import { openFile, saveFile } from "@nexa/dialog";
import { readTextFile, writeTextFile } from "@nexa/fs";
import { mount, type WindowLifecycleEvent } from "@nexa/ui";

import { NotesApp } from "./app";
import { createNotesController, type NotesSnapshot } from "./state";

const OPEN_FILE = "nexa-ui-dialog-open.txt";
const OPEN_BODY = "Opened through native Dialog: 你好, مرحبا, 😀\n";
const SAVE_FILE = "nexa-ui-dialog-save.txt";
const SAVE_BODY = "Saved through native Dialog: 会议记录 📝\n";
const SUCCESS = "nexa-ui reference notes dialog runtime smoke ok";
const FAILURE = "nexa-ui reference notes dialog runtime smoke failed";
const STATE_PREFIX = "nexa-ui reference notes dialog journey: ";

const controller = createNotesController({
  open: () =>
    openFile({
      title: "打开笔记",
      filters: [{ name: "Text", extensions: ["txt", "md"] }],
    }),
  save: () =>
    saveFile({
      title: "保存笔记",
      filters: [{ name: "Text", extensions: ["txt", "md"] }],
    }),
  read: readTextFile,
  write: writeTextFile,
});

let started = false;

function assertSavedSnapshot(snapshot: NotesSnapshot): void {
  if (
    snapshot.path !== SAVE_FILE ||
    snapshot.title !== SAVE_FILE ||
    snapshot.body !== SAVE_BODY ||
    snapshot.revision !== 2 ||
    snapshot.savedRevision !== 2 ||
    snapshot.dirty ||
    snapshot.status !== "已保存" ||
    snapshot.busy ||
    snapshot.operation !== "idle" ||
    snapshot.window !== "active"
  ) {
    throw new Error("Save dialog did not commit the expected Notes state");
  }
}

function assertOpenedSnapshot(snapshot: NotesSnapshot): void {
  if (
    snapshot.path !== OPEN_FILE ||
    snapshot.title !== OPEN_FILE ||
    snapshot.body !== OPEN_BODY ||
    snapshot.revision !== 3 ||
    snapshot.savedRevision !== 3 ||
    snapshot.dirty ||
    snapshot.status !== "已保存" ||
    snapshot.busy ||
    snapshot.operation !== "idle" ||
    snapshot.window !== "active"
  ) {
    throw new Error("Open dialog did not commit the expected Notes state");
  }
}

async function runSmoke(): Promise<void> {
  try {
    controller.editBody(SAVE_BODY);
    await controller.save();
    const afterSave = controller.snapshot();
    assertSavedSnapshot(afterSave);

    await controller.open();
    const afterOpen = controller.snapshot();
    assertOpenedSnapshot(afterOpen);

    await controller.open();
    const afterCancel = controller.snapshot();
    assertOpenedSnapshot(afterCancel);

    console.log(`${STATE_PREFIX}${JSON.stringify({ afterSave, afterOpen, afterCancel })}`);
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

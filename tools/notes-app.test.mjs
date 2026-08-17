import assert from "node:assert/strict";
import test from "node:test";

import "./typescript-test-hooks.mjs";

const { createNotesController } = await import("../examples/reference-notes/state.ts");

function deferredTask() {
  let resolve;
  let reject;
  let cancelCalls = 0;
  const result = new Promise((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  return {
    result,
    cancel() {
      cancelCalls += 1;
    },
    resolve(value) {
      resolve(value);
    },
    reject(error) {
      reject(error);
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

function fixture() {
  const openTasks = [];
  const saveTasks = [];
  const readTasks = [];
  const writeTasks = [];
  const controller = createNotesController({
    open: () => {
      const task = openTasks.shift() ?? deferredTask();
      return task;
    },
    save: () => {
      const task = saveTasks.shift() ?? deferredTask();
      return task;
    },
    read: () => {
      const task = readTasks.shift() ?? deferredTask();
      return task;
    },
    write: () => {
      const task = writeTasks.shift() ?? deferredTask();
      return task;
    },
  });
  return { controller, openTasks, saveTasks, readTasks, writeTasks };
}

test("editing title or body marks a new document dirty", () => {
  const { controller } = fixture();

  controller.editTitle("Meeting notes");
  controller.editBody("Agenda");

  assert.equal(controller.snapshot().title, "Meeting notes");
  assert.equal(controller.snapshot().body, "Agenda");
  assert.equal(controller.snapshot().dirty, true);
  assert.equal(controller.snapshot().status, "未保存");
});

test("open dialog cancellation preserves the current document", async () => {
  const { controller, openTasks } = fixture();
  controller.editBody("Keep me");
  const dialog = deferredTask();
  openTasks.push(dialog);

  const opening = controller.open();
  dialog.resolve(null);
  await opening;

  assert.equal(controller.snapshot().body, "Keep me");
  assert.equal(controller.snapshot().dirty, true);
  assert.equal(controller.snapshot().status, "未保存");
});

test("save dialog cancellation preserves the dirty document", async () => {
  const { controller, saveTasks, writeTasks } = fixture();
  controller.editTitle("Draft title");
  controller.editBody("Keep this unsaved body");
  const dialog = deferredTask();
  saveTasks.push(dialog);

  const saving = controller.save();
  dialog.resolve(null);
  await saving;

  assert.deepEqual(
    {
      path: controller.snapshot().path,
      title: controller.snapshot().title,
      body: controller.snapshot().body,
      dirty: controller.snapshot().dirty,
      status: controller.snapshot().status,
      busy: controller.snapshot().busy,
      operation: controller.snapshot().operation,
    },
    {
      path: null,
      title: "Draft title",
      body: "Keep this unsaved body",
      dirty: true,
      status: "未保存",
      busy: false,
      operation: "idle",
    },
  );
  assert.equal(writeTasks.length, 0, "cancel must not start a write task");
});

test("successful open replaces the document only after the read completes", async () => {
  const { controller, openTasks, readTasks } = fixture();
  controller.editBody("Old body");
  const dialog = deferredTask();
  const read = deferredTask();
  openTasks.push(dialog);
  readTasks.push(read);

  const opening = controller.open();
  dialog.resolve("/tmp/meeting.txt");
  await Promise.resolve();
  assert.equal(controller.snapshot().body, "Old body");
  read.resolve("New body");
  await opening;

  assert.equal(controller.snapshot().path, "/tmp/meeting.txt");
  assert.equal(controller.snapshot().title, "meeting.txt");
  assert.equal(controller.snapshot().body, "New body");
  assert.equal(controller.snapshot().dirty, false);
  assert.equal(controller.snapshot().status, "已保存");
});

test("open failure keeps the existing document and exposes an operation error", async () => {
  const { controller, openTasks, readTasks } = fixture();
  controller.editBody("Keep on failure");
  const dialog = deferredTask();
  const read = deferredTask();
  openTasks.push(dialog);
  readTasks.push(read);

  const opening = controller.open();
  dialog.resolve("/tmp/broken.txt");
  await Promise.resolve();
  read.reject(new Error("INVALID_DATA"));
  await opening;

  assert.equal(controller.snapshot().body, "Keep on failure");
  assert.equal(controller.snapshot().dirty, true);
  assert.match(controller.snapshot().status, /^打开失败:/u);
});

test("successful save writes the current body and clears dirty", async () => {
  const { controller, saveTasks, writeTasks } = fixture();
  controller.editBody("Saved body");
  const dialog = deferredTask();
  const write = deferredTask();
  saveTasks.push(dialog);
  writeTasks.push(write);

  const saving = controller.save();
  dialog.resolve("/tmp/saved.txt");
  await Promise.resolve();
  assert.equal(controller.snapshot().dirty, true);
  write.resolve(undefined);
  await saving;

  assert.equal(controller.snapshot().path, "/tmp/saved.txt");
  assert.equal(controller.snapshot().body, "Saved body");
  assert.equal(controller.snapshot().dirty, false);
  assert.equal(controller.snapshot().status, "已保存");
});

test("save failure keeps the current body and dirty revision", async () => {
  const { controller, saveTasks, writeTasks } = fixture();
  controller.editBody("Keep this body");
  const dialog = deferredTask();
  const write = deferredTask();
  saveTasks.push(dialog);
  writeTasks.push(write);

  const saving = controller.save();
  dialog.resolve("/tmp/denied.txt");
  await Promise.resolve();
  write.reject(new Error("PERMISSION_DENIED"));
  await saving;

  assert.equal(controller.snapshot().body, "Keep this body");
  assert.equal(controller.snapshot().dirty, true);
  assert.match(controller.snapshot().status, /^保存失败:/u);
});

test("editing while a write is pending remains dirty after that write completes", async () => {
  const { controller, saveTasks, writeTasks } = fixture();
  controller.editBody("Revision sent to disk");
  const dialog = deferredTask();
  const write = deferredTask();
  saveTasks.push(dialog);
  writeTasks.push(write);

  const saving = controller.save();
  dialog.resolve("/tmp/revisions.txt");
  await Promise.resolve();
  controller.editBody("Newer unsaved revision");
  write.resolve(undefined);
  await saving;

  assert.equal(controller.snapshot().body, "Newer unsaved revision");
  assert.equal(controller.snapshot().dirty, true);
  assert.equal(controller.snapshot().status, "未保存");
});

test("a second foreground operation is ignored while the first is busy", async () => {
  const { controller, openTasks } = fixture();
  const first = deferredTask();
  openTasks.push(first);

  const opening = controller.open();
  const ignored = controller.open();
  first.resolve(null);
  await Promise.all([opening, ignored]);

  assert.equal(controller.snapshot().operation, "idle");
  assert.equal(controller.snapshot().busy, false);
  assert.equal(openTasks.length, 0);
});

test("close cancels the active task and ignores late completion", async () => {
  const { controller, openTasks } = fixture();
  controller.editBody("Before close");
  const dialog = deferredTask();
  openTasks.push(dialog);

  const opening = controller.open();
  controller.close();
  dialog.resolve("/tmp/late.txt");
  await opening;

  assert.equal(dialog.cancelCalls, 1);
  assert.equal(controller.snapshot().window, "closed");
  assert.equal(controller.snapshot().path, null);
  assert.equal(controller.snapshot().body, "Before close");
  assert.equal(controller.snapshot().busy, false);
});

test("close during a pending read cancels it and rejects the late document", async () => {
  const { controller, openTasks, readTasks } = fixture();
  controller.editTitle("Existing title");
  controller.editBody("Existing body");
  const dialog = deferredTask();
  const read = deferredTask();
  openTasks.push(dialog);
  readTasks.push(read);

  const opening = controller.open();
  dialog.resolve("/tmp/late-read.txt");
  await Promise.resolve();
  controller.close();

  assert.equal(read.cancelCalls, 1);
  read.resolve("Late replacement");
  await opening;

  assert.deepEqual(
    {
      path: controller.snapshot().path,
      title: controller.snapshot().title,
      body: controller.snapshot().body,
      savedRevision: controller.snapshot().savedRevision,
      dirty: controller.snapshot().dirty,
      status: controller.snapshot().status,
      window: controller.snapshot().window,
    },
    {
      path: null,
      title: "Existing title",
      body: "Existing body",
      savedRevision: 0,
      dirty: true,
      status: "已关闭",
      window: "closed",
    },
  );
});

test("close during a pending write cancels it and rejects the late save", async () => {
  const { controller, saveTasks, writeTasks } = fixture();
  controller.editTitle("Unsaved title");
  controller.editBody("Unsaved body");
  const dialog = deferredTask();
  const write = deferredTask();
  saveTasks.push(dialog);
  writeTasks.push(write);

  const saving = controller.save();
  dialog.resolve("/tmp/late-write.txt");
  await Promise.resolve();
  const revisionAtClose = controller.snapshot().revision;
  controller.close();

  assert.equal(write.cancelCalls, 1);
  write.resolve(undefined);
  await saving;

  assert.deepEqual(
    {
      path: controller.snapshot().path,
      title: controller.snapshot().title,
      body: controller.snapshot().body,
      revision: controller.snapshot().revision,
      savedRevision: controller.snapshot().savedRevision,
      dirty: controller.snapshot().dirty,
      status: controller.snapshot().status,
      busy: controller.snapshot().busy,
      operation: controller.snapshot().operation,
      window: controller.snapshot().window,
    },
    {
      path: null,
      title: "Unsaved title",
      body: "Unsaved body",
      revision: revisionAtClose,
      savedRevision: 0,
      dirty: true,
      status: "已关闭",
      busy: false,
      operation: "idle",
      window: "closed",
    },
  );
});

test("suspend and resume preserve the document while blocking new work", async () => {
  const { controller, openTasks } = fixture();
  controller.editBody("Keep across suspend");

  controller.suspend();
  controller.editBody("Ignored while suspended");
  await controller.open();

  assert.equal(controller.snapshot().window, "suspended");
  assert.equal(controller.snapshot().body, "Keep across suspend");
  assert.equal(controller.snapshot().dirty, true);
  assert.equal(openTasks.length, 0);

  controller.resume();
  assert.equal(controller.snapshot().window, "active");
  assert.equal(controller.snapshot().body, "Keep across suspend");
  assert.equal(controller.snapshot().dirty, true);
});

test("a pending save settles while suspended and remains committed after resume", async () => {
  const { controller, saveTasks, writeTasks } = fixture();
  controller.editBody("Suspend-safe body");
  const dialog = deferredTask();
  const write = deferredTask();
  saveTasks.push(dialog);
  writeTasks.push(write);

  const saving = controller.save();
  dialog.resolve("/tmp/suspend-safe.txt");
  await Promise.resolve();
  controller.suspend();
  write.resolve(undefined);
  await saving;

  assert.equal(controller.snapshot().window, "suspended");
  assert.equal(controller.snapshot().busy, false);
  assert.equal(controller.snapshot().path, "/tmp/suspend-safe.txt");
  assert.equal(controller.snapshot().dirty, false);

  controller.resume();
  assert.equal(controller.snapshot().window, "active");
  assert.equal(controller.snapshot().dirty, false);
});

test("close reaches its terminal state even when task cancellation throws", async () => {
  const { controller, openTasks } = fixture();
  const dialog = deferredTask();
  dialog.cancel = () => {
    throw new Error("stale native task");
  };
  openTasks.push(dialog);

  const opening = controller.open();
  assert.doesNotThrow(() => controller.close());
  assert.equal(controller.snapshot().window, "closed");
  assert.equal(controller.snapshot().busy, false);

  dialog.resolve("/tmp/late-after-throw.txt");
  await opening;
  assert.equal(controller.snapshot().path, null);
  assert.equal(controller.snapshot().window, "closed");
});

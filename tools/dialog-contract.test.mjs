import assert from "node:assert/strict";
import test from "node:test";

import "./typescript-test-hooks.mjs";

let nextHandle = 0;
let starts = [];
let awaits = [];
let cancels = [];
let resolveAwait;

const ok = (value) => JSON.stringify({ ok: true, value });

globalThis.js_nexa_open_file_dialog_v1 = (title, defaultPath, filtersJson) => {
  starts.push({ operation: "open", title, defaultPath, filtersJson });
  return ok({ slot: nextHandle++, generation: 1 });
};
globalThis.js_nexa_save_file_dialog_v1 = (title, defaultPath, filtersJson) => {
  starts.push({ operation: "save", title, defaultPath, filtersJson });
  return ok({ slot: nextHandle++, generation: 1 });
};
globalThis.js_nexa_await_task_v1 = (slot, generation) => {
  awaits.push({ slot, generation });
  return new Promise((resolve) => {
    resolveAwait = resolve;
  });
};
globalThis.js_nexa_cancel_task_v1 = (slot, generation) => {
  cancels.push({ slot, generation });
  return ok(null);
};

const dialog = await import("../packages/dialog/src/index.ts");

test("openFile serializes typed options and resolves a selected path", async () => {
  starts = [];
  awaits = [];
  const task = dialog.openFile({
    title: "Open notes",
    defaultPath: "/tmp/notes.md",
    filters: [{ name: "Text", extensions: ["txt", "md"] }],
  });
  assert.equal(awaits.length, 1);
  assert.deepEqual(starts[0], {
    operation: "open",
    title: "Open notes",
    defaultPath: "/tmp/notes.md",
    filtersJson: '[{"name":"Text","extensions":["txt","md"]}]',
  });
  resolveAwait(ok("/tmp/chosen.md"));
  assert.equal(await task.result, "/tmp/chosen.md");
});

test("saveFile treats user cancellation as a normal null result", async () => {
  const task = dialog.saveFile();
  resolveAwait(ok(null));
  assert.equal(await task.result, null);
});

test("dialog cancellation is idempotent", () => {
  const task = dialog.openFile();
  task.cancel();
  task.cancel();
  assert.equal(cancels.length, 1);
});

test("dialog result decoder rejects an empty selected path", async () => {
  const task = dialog.openFile();
  resolveAwait(ok(""));
  await assert.rejects(task.result, /dialog result path must not be empty/);
});

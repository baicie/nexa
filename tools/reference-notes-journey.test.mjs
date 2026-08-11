import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

const host = await import("../packages/nui-host/src/index.ts");
const { mountNode } = await import("../packages/ui/src/mount/materialize.ts");
const { NotesApp } = await import("../examples/reference-notes/app.tsx");
const { createNotesController } = await import("../examples/reference-notes/state.ts");
const scenario = JSON.parse(
  readFileSync(new URL("../examples/reference-notes/mvp-journey.json", import.meta.url), "utf8"),
);

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
    resolve,
    reject,
    cancel() {
      cancelCalls += 1;
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

function semanticSnapshot(trace) {
  const snapshot = new Map();
  for (const entry of trace) {
    if (entry.op === "setSemantics") snapshot.set(entry.node, entry.semantics);
    if (entry.op === "clearSemantics" || entry.op === "remove") snapshot.delete(entry.node);
  }
  return snapshot;
}

function findSemanticNode(trace, query) {
  for (const [node, semantics] of semanticSnapshot(trace)) {
    if (semantics.role === query.role && semantics.label === query.name) return node;
  }
  return undefined;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("the actual Notes tree completes one semantic, IME, save, lifecycle, and close journey", async () => {
  assert.equal(scenario.schemaVersion, 1);
  const openDialog = deferredTask();
  const cancelledSaveDialog = deferredTask();
  const saveDialog = deferredTask();
  const firstWrite = deferredTask();
  const lateWrite = deferredTask();
  let writeNumber = 0;
  let saveDialogNumber = 0;
  const writes = [];
  const controller = createNotesController({
    open: () => openDialog,
    save: () => (saveDialogNumber++ === 0 ? cancelledSaveDialog : saveDialog),
    read: () => deferredTask(),
    write(path, body) {
      writes.push({ path, body });
      writeNumber += 1;
      return writeNumber === 1 ? firstWrite : lateWrite;
    },
  });

  hostFfiHarness.resetTrace();
  const mounted = mountNode(NotesApp({ controller }));
  assert.notEqual(mounted, null);
  host.commit();

  const body = findSemanticNode(hostFfiHarness.rawTrace(), scenario.semantics.body);
  const open = findSemanticNode(hostFfiHarness.rawTrace(), scenario.semantics.open);
  const save = findSemanticNode(hostFfiHarness.rawTrace(), scenario.semantics.save);
  assert.notEqual(open, undefined);
  assert.notEqual(body, undefined);
  assert.notEqual(save, undefined);

  assert.equal(hostFfiHarness.dispatchSemanticAction(open, host.SemanticAction.Invoke), true);
  openDialog.resolve(null);
  await flushMicrotasks();
  assert.equal(controller.snapshot().body, "");
  assert.equal(controller.snapshot().status, "未保存");

  assert.equal(hostFfiHarness.dispatchSemanticAction(body, host.SemanticAction.Focus), true);
  assert.equal(
    hostFfiHarness.dispatchSemanticAction(
      body,
      host.SemanticAction.SetValue,
      scenario.document.initial,
    ),
    true,
  );

  assert.equal(hostFfiHarness.beginComposition(body), true);
  assert.equal(hostFfiHarness.updateComposition(body, scenario.document.committed), true);
  assert.equal(
    hostFfiHarness.textInputDisplayValue(body),
    `${scenario.document.initial}${scenario.document.committed}`,
    "preedit must be visible before the application receives a committed value",
  );
  assert.equal(controller.snapshot().body, scenario.document.initial);
  assert.equal(hostFfiHarness.commitComposition(body), true);
  assert.equal(
    controller.snapshot().body,
    `${scenario.document.initial}${scenario.document.committed}`,
  );

  const committedBody = controller.snapshot().body;
  assert.equal(hostFfiHarness.beginComposition(body), true);
  assert.equal(hostFfiHarness.updateComposition(body, scenario.document.cancelled), true);
  assert.match(hostFfiHarness.textInputDisplayValue(body), /取消$/u);
  assert.equal(hostFfiHarness.cancelComposition(body), true);
  assert.equal(hostFfiHarness.textInputDisplayValue(body), committedBody);
  assert.equal(controller.snapshot().body, committedBody);

  assert.equal(hostFfiHarness.dispatchSemanticAction(save, host.SemanticAction.Invoke), true);
  cancelledSaveDialog.resolve(null);
  await flushMicrotasks();
  assert.equal(controller.snapshot().dirty, true);
  assert.equal(controller.snapshot().status, "未保存");
  assert.equal(writes.length, 0);

  assert.equal(hostFfiHarness.dispatchSemanticAction(save, host.SemanticAction.Invoke), true);
  saveDialog.resolve(scenario.savePath);
  await flushMicrotasks();
  assert.deepEqual(writes[0], { path: scenario.savePath, body: committedBody });
  firstWrite.resolve();
  await flushMicrotasks();
  assert.equal(controller.snapshot().dirty, false);

  hostFfiHarness.dispatchRecorded(
    host.EventId.WindowLifecycle,
    JSON.stringify({ kind: "Suspended", surfaceGeneration: 1 }),
  );
  assert.equal(controller.snapshot().window, "suspended");
  assert.equal(controller.snapshot().body, committedBody);
  hostFfiHarness.dispatchRecorded(
    host.EventId.WindowLifecycle,
    JSON.stringify({ kind: "Resumed", surfaceGeneration: 2 }),
  );
  assert.equal(controller.snapshot().window, "active");

  assert.equal(
    hostFfiHarness.dispatchSemanticAction(body, host.SemanticAction.SetValue, `${committedBody}!`),
    true,
  );
  assert.equal(hostFfiHarness.dispatchSemanticAction(save, host.SemanticAction.Invoke), true);
  await flushMicrotasks();
  assert.deepEqual(writes[1], { path: scenario.savePath, body: `${committedBody}!` });
  hostFfiHarness.dispatchRecorded(
    host.EventId.WindowLifecycle,
    JSON.stringify({ kind: "CloseRequested" }),
  );
  assert.equal(lateWrite.cancelCalls, 1);
  assert.equal(controller.snapshot().window, "closed");
  lateWrite.resolve();
  await flushMicrotasks();
  assert.equal(controller.snapshot().window, "closed");
  assert.equal(controller.snapshot().status, "已关闭");

  const compositionTrace = hostFfiHarness
    .rawTrace()
    .filter(({ op }) => op.startsWith("composition"));
  assert.deepEqual(
    compositionTrace.map(({ op }) => op),
    [
      "compositionStart",
      "compositionUpdate",
      "compositionCommit",
      "compositionStart",
      "compositionUpdate",
      "compositionCancel",
    ],
  );

  if (mounted !== null) host.remove(mounted);
  host.commit();
});

import assert from "node:assert/strict";
import test from "node:test";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

const host = await import("../packages/nui-host/src/index.ts");
const systemHost = await import("../packages/system-host/src/index.ts");
const { PropertyId } = host;
const { mountNode } = await import("../packages/ui/src/mount/materialize.ts");
const { NotesApp } = await import("../examples/reference-notes/app.tsx");
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
    resolve,
    reject,
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

test("the real Notes tree exposes and reports a typed save permission denial", async () => {
  const saveDialog = deferredTask();
  const writeTask = deferredTask();
  const diagnostics = [];
  const controller = createNotesController({
    open: () => deferredTask(),
    save: () => saveDialog,
    read: () => deferredTask(),
    write: () => writeTask,
    reportError: (error) => diagnostics.push(error),
  });
  const denial = new systemHost.NexaSystemError({
    domain: "system",
    code: 0x0200_0007,
    name: "PERMISSION_DENIED",
    severity: "RecoverableOperation",
    operation: "writeTextFile",
    retryable: false,
    message: "manifest denied system.FsWrite",
    runtimeVersion: "0.1.0",
    context: { permission: "system.FsWrite", source: "manifest" },
  });

  hostFfiHarness.resetTrace();
  const mounted = mountNode(NotesApp({ controller }));
  assert.notEqual(mounted, null);
  host.commit();

  const initialTrace = hostFfiHarness.rawTrace();
  const body = findInputByName(initialTrace, "正文");
  const save = findButtonByName(initialTrace, "保存");
  assert.notEqual(body, undefined);
  assert.notEqual(save, undefined);

  hostFfiHarness.dispatch(body, host.EventId.Change, "必须保留的正文");
  hostFfiHarness.dispatch(save, host.EventId.Click);
  saveDialog.resolve("/tmp/denied.txt");
  await flushMicrotasks();
  writeTask.reject(denial);
  await flushMicrotasks();

  assert.equal(controller.snapshot().dirty, true);
  assert.match(controller.snapshot().status, /保存失败: PERMISSION_DENIED/u);
  assert.equal(diagnostics.length, 1);
  assert.strictEqual(diagnostics[0], denial);
  assert.equal(diagnostics[0].code, 0x0200_0007);
  assert.equal(diagnostics[0].operation, "writeTextFile");
  assert.deepEqual(diagnostics[0].context, {
    permission: "system.FsWrite",
    source: "manifest",
  });
  assert.ok(
    hostFfiHarness
      .rawTrace()
      .some(({ op, text }) => op === "setText" && /保存失败: PERMISSION_DENIED/u.test(text)),
    "dirty state must not hide the typed permission error from the status line",
  );

  if (mounted !== null) host.remove(mounted);
  host.commit();
});

function findInputByName(trace, name) {
  return trace.find(({ op, placeholder }) => op === "registerInput" && placeholder === name)?.node;
}

function findButtonByName(trace, name) {
  for (const registration of trace.filter(({ op }) => op === "registerButton")) {
    const label = trace.find(
      ({ op, parent, child }) =>
        op === "insert" &&
        parent === registration.node &&
        trace.some(
          ({ op: textOp, node, text }) => textOp === "setText" && node === child && text === name,
        ),
    );
    if (label !== undefined) return registration.node;
  }
  return undefined;
}

function semanticSnapshot(trace) {
  const snapshot = new Map();
  for (const entry of trace) {
    if (entry.op === "setSemantics") snapshot.set(entry.node, entry.semantics);
    if (entry.op === "clearSemantics" || entry.op === "remove") snapshot.delete(entry.node);
  }
  return snapshot;
}

function findSemanticNode(trace, role, name) {
  for (const [node, semantics] of semanticSnapshot(trace)) {
    if (semantics.role === role && semantics.label === name) return { node, semantics };
  }
  return undefined;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("the real Notes tree exposes five stable semantic nodes and routes their actions", async () => {
  const saveDialog = deferredTask();
  const writeTask = deferredTask();
  let written;
  const controller = createNotesController({
    open: () => deferredTask(),
    save: () => saveDialog,
    read: () => deferredTask(),
    write: (path, body) => {
      written = { path, body };
      return writeTask;
    },
  });

  hostFfiHarness.resetTrace();
  const mounted = mountNode(NotesApp({ controller }));
  assert.notEqual(mounted, null);
  host.commit();

  const initialTrace = hostFfiHarness.rawTrace();
  assert.equal(
    initialTrace.find(({ op }) => op === "createNode")?.nodeType,
    host.NodeType.Root,
    "Window must materialize as a viewport-managed Root",
  );
  const expectedSemantics = [
    [host.SemanticRole.Button, "打开", [host.SemanticAction.Invoke], "打开"],
    [host.SemanticRole.Button, "保存", [host.SemanticAction.Invoke], "保存"],
    [
      host.SemanticRole.TextInput,
      "标题",
      [host.SemanticAction.Focus, host.SemanticAction.SetValue],
      "未命名",
    ],
    [
      host.SemanticRole.TextInput,
      "正文",
      [host.SemanticAction.Focus, host.SemanticAction.SetValue],
      "",
    ],
    [host.SemanticRole.Text, "当前状态", [], "未保存"],
  ];
  const resolved = new Map();
  for (const [role, name, actions, value] of expectedSemantics) {
    const match = findSemanticNode(initialTrace, role, name);
    assert.notEqual(match, undefined, `${role}/${name} must resolve from explicit Host semantics`);
    assert.deepEqual(match.semantics.actions, actions, `${role}/${name} actions`);
    assert.equal(match.semantics.value, value, `${role}/${name} value`);
    assert.equal(match.semantics.disabled, false, `${role}/${name} disabled state`);
    resolved.set(`${role}/${name}`, match.node);
  }
  assert.equal(
    semanticSnapshot(initialTrace).size,
    5,
    "Notes must expose exactly five semantic nodes",
  );

  const open = resolved.get(`${host.SemanticRole.Button}/打开`);
  const save = resolved.get(`${host.SemanticRole.Button}/保存`);
  const title = resolved.get(`${host.SemanticRole.TextInput}/标题`);
  const body = resolved.get(`${host.SemanticRole.TextInput}/正文`);
  const status = resolved.get(`${host.SemanticRole.Text}/当前状态`);
  assert.ok(
    initialTrace.some(
      ({ op, node, property }) =>
        op === "clearProperty" && node === title && property === PropertyId.Width,
    ),
    "the title editor must stretch instead of retaining its fixed Host default",
  );
  assert.ok(
    initialTrace.some(
      ({ op, node, property }) =>
        op === "clearProperty" && node === body && property === PropertyId.Width,
    ),
    "the body editor must stretch instead of retaining its fixed Host default",
  );
  assert.equal(
    initialTrace.some(
      ({ op, property, value }) =>
        op === "setNumber" &&
        (property === PropertyId.Width || property === PropertyId.Height) &&
        (value === 720 || value === 560),
    ),
    false,
    "the Notes shell must not hard-code a window-sized content rectangle",
  );

  assert.equal(hostFfiHarness.dispatchSemanticAction(title, host.SemanticAction.Focus), true);
  assert.equal(
    hostFfiHarness.dispatchSemanticAction(title, host.SemanticAction.SetValue, "会议记录"),
    true,
  );
  assert.equal(hostFfiHarness.dispatchSemanticAction(body, host.SemanticAction.Focus), true);
  assert.equal(hostFfiHarness.focusedSemanticNode(), body);
  assert.equal(
    hostFfiHarness.dispatchSemanticAction(body, host.SemanticAction.SetValue, "议程\n下一步"),
    true,
  );
  assert.equal(hostFfiHarness.dispatchSemanticAction(save, host.SemanticAction.Invoke), true);
  await flushMicrotasks();

  assert.equal(controller.snapshot().status, "保存中");
  const busyTrace = hostFfiHarness.rawTrace();
  const busyOpen = findSemanticNode(busyTrace, host.SemanticRole.Button, "打开");
  const busySave = findSemanticNode(busyTrace, host.SemanticRole.Button, "保存");
  const busyTitle = findSemanticNode(busyTrace, host.SemanticRole.TextInput, "标题");
  const busyBody = findSemanticNode(busyTrace, host.SemanticRole.TextInput, "正文");
  const busyStatus = findSemanticNode(busyTrace, host.SemanticRole.Text, "当前状态");
  assert.deepEqual(
    [busyOpen?.semantics.value, busyOpen?.semantics.disabled],
    ["打开中", true],
    "Open must keep its name while exposing busy value/disabled state",
  );
  assert.deepEqual(
    [busySave?.semantics.value, busySave?.semantics.disabled],
    ["保存中", true],
    "Save must keep its name while exposing busy value/disabled state",
  );
  assert.equal(busyTitle?.semantics.value, "会议记录");
  assert.equal(busyBody?.semantics.value, "议程\n下一步");
  assert.equal(busyStatus?.semantics.value, "保存中");
  assert.equal(busyStatus?.node, status, "the status name must stay bound to the same Host node");
  assert.equal(
    hostFfiHarness.dispatchSemanticAction(save, host.SemanticAction.Invoke),
    false,
    "disabled semantics must reject a duplicate Invoke",
  );
  assert.equal(
    hostFfiHarness.dispatchSemanticAction(open, host.SemanticAction.Invoke),
    false,
    "busy Open semantics must reject Invoke",
  );
  assert.ok(
    hostFfiHarness
      .rawTrace()
      .some(
        ({ op, property, value }) =>
          op === "setNumber" && property === PropertyId.Disabled && value === 1,
      ),
    "busy state must disable the Notes toolbar actions",
  );

  saveDialog.resolve("/tmp/会议记录.txt");
  await flushMicrotasks();
  assert.deepEqual(written, { path: "/tmp/会议记录.txt", body: "议程\n下一步" });
  writeTask.resolve(undefined);
  await flushMicrotasks();

  assert.equal(controller.snapshot().title, "会议记录.txt");
  assert.equal(controller.snapshot().dirty, false);
  assert.equal(controller.snapshot().status, "已保存");
  const completedTrace = hostFfiHarness.rawTrace();
  const completedOpen = findSemanticNode(completedTrace, host.SemanticRole.Button, "打开");
  const completedSave = findSemanticNode(completedTrace, host.SemanticRole.Button, "保存");
  const completedTitle = findSemanticNode(completedTrace, host.SemanticRole.TextInput, "标题");
  const completedStatus = findSemanticNode(completedTrace, host.SemanticRole.Text, "当前状态");
  assert.deepEqual(
    [completedOpen?.semantics.value, completedOpen?.semantics.disabled],
    ["打开", false],
  );
  assert.deepEqual(
    [completedSave?.semantics.value, completedSave?.semantics.disabled],
    ["保存", false],
  );
  assert.equal(completedTitle?.semantics.value, "会议记录.txt");
  assert.equal(completedStatus?.semantics.value, "已保存");
  assert.deepEqual(
    completedTrace.filter(({ op }) => op === "dispatchSemanticAction").map(({ action }) => action),
    [
      host.SemanticAction.Focus,
      host.SemanticAction.SetValue,
      host.SemanticAction.Focus,
      host.SemanticAction.SetValue,
      host.SemanticAction.Invoke,
    ],
  );
  assert.ok(
    hostFfiHarness
      .rawTrace()
      .some(
        ({ op, property, value }) =>
          op === "setNumber" && property === PropertyId.Disabled && value === 0,
      ),
    "completed save must re-enable the Notes toolbar actions",
  );

  if (mounted !== null) host.remove(mounted);
  host.commit();
});

test("the real Notes Window cancels a pending write and rejects its late completion", async () => {
  const saveDialog = deferredTask();
  const writeTask = deferredTask();
  const controller = createNotesController({
    open: () => deferredTask(),
    save: () => saveDialog,
    read: () => deferredTask(),
    write: () => writeTask,
  });

  hostFfiHarness.resetTrace();
  const mounted = mountNode(NotesApp({ controller }));
  assert.notEqual(mounted, null);
  host.commit();

  const initialTrace = hostFfiHarness.rawTrace();
  const body = findSemanticNode(initialTrace, host.SemanticRole.TextInput, "正文")?.node;
  const save = findSemanticNode(initialTrace, host.SemanticRole.Button, "保存")?.node;
  assert.notEqual(body, undefined);
  assert.notEqual(save, undefined);
  assert.equal(
    hostFfiHarness.dispatchSemanticAction(body, host.SemanticAction.SetValue, "关闭前未保存正文"),
    true,
  );
  assert.equal(hostFfiHarness.dispatchSemanticAction(save, host.SemanticAction.Invoke), true);
  await flushMicrotasks();

  saveDialog.resolve("/tmp/late-write.txt");
  await flushMicrotasks();
  assert.equal(controller.snapshot().operation, "saving");
  assert.equal(controller.snapshot().busy, true);

  assert.equal(
    hostFfiHarness.dispatchRecorded(
      host.EventId.WindowLifecycle,
      JSON.stringify({ kind: "CloseRequested" }),
    ),
    true,
  );
  assert.equal(writeTask.cancelCalls, 1);
  assert.deepEqual(
    {
      path: controller.snapshot().path,
      body: controller.snapshot().body,
      savedRevision: controller.snapshot().savedRevision,
      dirty: controller.snapshot().dirty,
      status: controller.snapshot().status,
      busy: controller.snapshot().busy,
      operation: controller.snapshot().operation,
      window: controller.snapshot().window,
    },
    {
      path: null,
      body: "关闭前未保存正文",
      savedRevision: 0,
      dirty: true,
      status: "已关闭",
      busy: false,
      operation: "idle",
      window: "closed",
    },
  );

  writeTask.resolve(undefined);
  await flushMicrotasks();
  assert.equal(controller.snapshot().path, null);
  assert.equal(controller.snapshot().savedRevision, 0);
  assert.equal(controller.snapshot().status, "已关闭");
  assert.equal(controller.snapshot().window, "closed");

  if (mounted !== null) host.remove(mounted);
  host.commit();
});

test("the real Notes Window forwards idempotent lifecycle events to its controller", async () => {
  const openDialog = deferredTask();
  const controller = createNotesController({
    open: () => openDialog,
    save: () => deferredTask(),
    read: () => deferredTask(),
    write: () => deferredTask(),
  });

  hostFfiHarness.resetTrace();
  const mounted = mountNode(NotesApp({ controller }));
  assert.notEqual(mounted, null);
  host.commit();

  const initialTrace = hostFfiHarness.rawTrace();
  const body = findInputByName(initialTrace, "正文");
  const open = findButtonByName(initialTrace, "打开");
  assert.notEqual(body, undefined, "TextArea/正文 must resolve from the Notes tree");
  assert.notEqual(open, undefined, "Button/打开 must resolve from the Notes tree");

  hostFfiHarness.dispatch(body, host.EventId.Change, "Keep across lifecycle events");
  assert.deepEqual(
    {
      body: controller.snapshot().body,
      dirty: controller.snapshot().dirty,
      window: controller.snapshot().window,
    },
    { body: "Keep across lifecycle events", dirty: true, window: "active" },
  );

  const dispatchLifecycle = (event) =>
    hostFfiHarness.dispatchRecorded(host.EventId.WindowLifecycle, JSON.stringify(event));

  assert.equal(dispatchLifecycle({ kind: "Ready", surfaceGeneration: 1 }), true);
  assert.equal(controller.snapshot().window, "active");

  assert.equal(dispatchLifecycle({ kind: "Suspended" }), true);
  assert.equal(dispatchLifecycle({ kind: "Suspended" }), true);
  assert.equal(controller.snapshot().window, "suspended");

  assert.equal(dispatchLifecycle({ kind: "Resumed", surfaceGeneration: 2 }), true);
  assert.equal(dispatchLifecycle({ kind: "Resumed", surfaceGeneration: 2 }), true);
  assert.equal(controller.snapshot().window, "active");

  hostFfiHarness.dispatch(open, host.EventId.Click);
  await flushMicrotasks();
  assert.equal(controller.snapshot().busy, true);

  assert.equal(dispatchLifecycle({ kind: "CloseRequested" }), true);
  assert.equal(dispatchLifecycle({ kind: "CloseRequested" }), true);
  assert.equal(openDialog.cancelCalls, 1);
  assert.deepEqual(
    {
      body: controller.snapshot().body,
      dirty: controller.snapshot().dirty,
      busy: controller.snapshot().busy,
      window: controller.snapshot().window,
    },
    {
      body: "Keep across lifecycle events",
      dirty: true,
      busy: false,
      window: "closed",
    },
  );

  for (const event of [
    { kind: "Suspended" },
    { kind: "Resumed", surfaceGeneration: 3 },
    { kind: "Ready", surfaceGeneration: 3 },
  ]) {
    assert.equal(dispatchLifecycle(event), true);
  }
  assert.equal(controller.snapshot().window, "closed");

  openDialog.resolve(null);
  await flushMicrotasks();
  if (mounted !== null) host.remove(mounted);
  host.commit();
});

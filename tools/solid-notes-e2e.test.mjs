import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

const host = await import("../packages/nui-host/src/index.ts");
const solid = await import("../packages/adapter-solid/src/index.ts");
const { createNotesController } = await import("../examples/reference-notes/state.ts");

const solidOutputDirectory = new URL("../examples/reference-notes/dist-solid/", import.meta.url);

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

test("the Solid Notes core slice routes semantic actions and releases its lifecycle", async (t) => {
  t.after(() => rmSync(solidOutputDirectory, { force: true, recursive: true }));
  const compiled = spawnSync("pnpm", ["--filter", "@nexa/example-reference-notes", "solid:babel"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);

  const { SolidNotesApp } = await import(
    new URL(`solid-app.js?test=${Date.now()}`, solidOutputDirectory).href
  );
  const saveDialog = deferredTask();
  const writeTask = deferredTask();
  let written;
  const controller = createNotesController({
    open: () => deferredTask(),
    save: () => saveDialog,
    read: () => deferredTask(),
    write(path, body) {
      written = { path, body };
      return writeTask;
    },
  });

  host.resetSession();
  hostFfiHarness.resetTrace();
  const container = host.createHostRoot();
  const mounted = solid.mount(
    () => solid.createComponent(SolidNotesApp, { controller }),
    container,
  );
  host.commit();

  assert.equal(mounted.container, container);
  const initialTrace = hostFfiHarness.rawTrace();
  const expected = [
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
    [host.SemanticRole.Button, "保存", [host.SemanticAction.Invoke], "保存"],
    [host.SemanticRole.Text, "当前状态", [], "未保存"],
  ];
  const nodes = new Map();
  for (const [role, name, actions, value] of expected) {
    const match = findSemanticNode(initialTrace, role, name);
    assert.notEqual(match, undefined, `${role}/${name} must exist in the Solid tree`);
    assert.deepEqual(match.semantics.actions, actions);
    assert.equal(match.semantics.value, value);
    assert.equal(match.semantics.disabled, false);
    nodes.set(`${role}/${name}`, match.node);
  }
  assert.equal(semanticSnapshot(initialTrace).size, 4);

  const title = nodes.get(`${host.SemanticRole.TextInput}/标题`);
  const body = nodes.get(`${host.SemanticRole.TextInput}/正文`);
  const save = nodes.get(`${host.SemanticRole.Button}/保存`);
  assert.equal(hostFfiHarness.dispatchSemanticAction(title, host.SemanticAction.Focus), true);
  assert.equal(
    hostFfiHarness.dispatchSemanticAction(title, host.SemanticAction.SetValue, "Solid 会议记录"),
    true,
  );
  assert.equal(hostFfiHarness.dispatchSemanticAction(body, host.SemanticAction.Focus), true);
  assert.equal(
    hostFfiHarness.dispatchSemanticAction(body, host.SemanticAction.SetValue, "第一行\n第二行"),
    true,
  );
  assert.equal(hostFfiHarness.focusedSemanticNode(), body);
  assert.equal(hostFfiHarness.dispatchSemanticAction(save, host.SemanticAction.Invoke), true);
  await flushMicrotasks();

  assert.equal(controller.snapshot().status, "保存中");
  const busyTrace = hostFfiHarness.rawTrace();
  assert.deepEqual(
    findSemanticNode(busyTrace, host.SemanticRole.Button, "保存")?.semantics,
    {
      role: host.SemanticRole.Button,
      label: "保存",
      value: "保存中",
      disabled: true,
      actions: [host.SemanticAction.Invoke],
    },
  );
  assert.equal(
    findSemanticNode(busyTrace, host.SemanticRole.Text, "当前状态")?.semantics.value,
    "保存中",
  );
  assert.equal(
    hostFfiHarness.dispatchSemanticAction(save, host.SemanticAction.Invoke),
    false,
    "busy Save must reject a duplicate Invoke",
  );

  saveDialog.resolve("/tmp/solid-note.txt");
  await flushMicrotasks();
  assert.deepEqual(written, { path: "/tmp/solid-note.txt", body: "第一行\n第二行" });
  writeTask.resolve(undefined);
  await flushMicrotasks();

  assert.deepEqual(
    {
      title: controller.snapshot().title,
      body: controller.snapshot().body,
      dirty: controller.snapshot().dirty,
      status: controller.snapshot().status,
    },
    { title: "solid-note.txt", body: "第一行\n第二行", dirty: false, status: "已保存" },
  );
  const completedTrace = hostFfiHarness.rawTrace();
  assert.equal(
    findSemanticNode(completedTrace, host.SemanticRole.TextInput, "标题")?.semantics.value,
    "solid-note.txt",
  );
  assert.equal(
    findSemanticNode(completedTrace, host.SemanticRole.Text, "当前状态")?.semantics.value,
    "已保存",
  );

  const dispatchLifecycle = (event) =>
    hostFfiHarness.dispatchRecorded(host.EventId.WindowLifecycle, JSON.stringify(event));
  assert.equal(dispatchLifecycle({ kind: "Suspended" }), true);
  assert.equal(controller.snapshot().window, "suspended");
  assert.equal(dispatchLifecycle({ kind: "Resumed", surfaceGeneration: 2 }), true);
  assert.equal(controller.snapshot().window, "active");

  const liveNodeCount = host.activeNodeCount();
  assert.ok(liveNodeCount > 1);
  mounted.dispose();
  mounted.dispose();
  assert.deepEqual(container.children, []);
  assert.equal(host.activeNodeCount(), 1, "the caller-owned Host container must remain alive");
  assert.equal(hostFfiHarness.dispatchSemanticAction(save, host.SemanticAction.Invoke), false);

  const traceLengthAfterDispose = hostFfiHarness.rawTrace().length;
  controller.editBody("卸载后不应触发 Host 更新");
  assert.equal(
    hostFfiHarness.rawTrace().length,
    traceLengthAfterDispose,
    "Solid onCleanup must unsubscribe from the shared Notes controller",
  );
  host.resetSession();
});

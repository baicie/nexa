import assert from "node:assert/strict";
import test from "node:test";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

const host = await import("../packages/nui-host/src/index.ts");

test("semantics Host prop queues typed set and explicit clear commands", () => {
  hostFfiHarness.resetTrace();
  const node = host.createHostElement("view");
  const semantics = {
    role: host.SemanticRole.Button,
    label: "Save",
    value: "draft",
    description: "Save note",
    disabled: false,
    checked: true,
    actions: [host.SemanticAction.Invoke, host.SemanticAction.Focus],
  };

  host.applyHostProp(node, "semantics", semantics);
  assert.deepEqual(node.hostProps.semantics, semantics);
  host.applyHostProp(node, "semantics", null);
  assert.equal("semantics" in node.hostProps, false);

  assert.deepEqual(
    hostFfiHarness
      .normalizedTrace()
      .filter(({ op }) => op === "setSemantics" || op === "clearSemantics"),
    [
      { op: "setSemantics", node: "n1", semantics },
      { op: "clearSemantics", node: "n1" },
    ],
  );
});

test("removing semantics through Host prop diff queues ClearSemantics", () => {
  hostFfiHarness.resetTrace();
  const node = host.createHostElement("view");

  host.applyHostProps(node, {
    semantics: { role: host.SemanticRole.Text, label: "Status" },
  });
  host.applyHostProps(node, {});

  assert.deepEqual(
    hostFfiHarness
      .normalizedTrace()
      .filter(({ op }) => op === "setSemantics" || op === "clearSemantics"),
    [
      {
        op: "setSemantics",
        node: "n1",
        semantics: { role: "Text", label: "Status" },
      },
      { op: "clearSemantics", node: "n1" },
    ],
  );
});

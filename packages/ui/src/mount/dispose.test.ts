import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeNodeCount,
  attachNode,
  disposeNode,
  registerNodeCleanup,
  resetNodeLifecycle,
} from "../../../nui-host/src/lifecycle.ts";
import { effect, signal } from "../signal.ts";

test("disposing an ancestor stops descendant effects exactly once", () => {
  const root = 9101n;
  const child = 9102n;
  const grandchild = 9103n;
  attachNode(child, root);
  attachNode(grandchild, child);

  const value = signal(0);
  let runs = 0;
  registerNodeCleanup(
    grandchild,
    effect(() => {
      void value.value;
      runs += 1;
    }),
  );
  assert.equal(runs, 1);
  assert.equal(activeNodeCount(), 3);

  disposeNode(root);
  value.value = 1;
  disposeNode(root);

  assert.equal(runs, 1);
  assert.equal(activeNodeCount(), 0);
});

test("cleanup registration after disposal runs immediately", () => {
  const node = 9201n;
  disposeNode(node);
  let cleaned = 0;
  registerNodeCleanup(node, () => {
    cleaned += 1;
  });
  assert.equal(cleaned, 1);
  disposeNode(node);
  assert.equal(cleaned, 1);
});

test("reset disposes every node and permits ids to be reused by the next session", () => {
  const root = 9301n;
  const child = 9302n;
  attachNode(child, root);
  let cleaned = 0;
  registerNodeCleanup(child, () => {
    cleaned += 1;
  });

  resetNodeLifecycle();

  assert.equal(cleaned, 1);
  assert.equal(activeNodeCount(), 0);
  registerNodeCleanup(root, () => {
    cleaned += 1;
  });
  assert.equal(activeNodeCount(), 1);
  assert.equal(cleaned, 1);

  resetNodeLifecycle();
  assert.equal(cleaned, 2);
  assert.equal(activeNodeCount(), 0);
});

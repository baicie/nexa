/**
 * Slice 3: fine-grained signal / effect smoke tests (Node).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { effect, onCleanup, signal } from "./signal.ts";

test("signal notifies effect on write", () => {
  const count = signal(0);
  const seen: number[] = [];
  const stop = effect(() => {
    seen.push(count.value);
  });
  assert.deepEqual(seen, [0]);
  count.value = 1;
  count.value = 2;
  assert.deepEqual(seen, [0, 1, 2]);
  stop();
  count.value = 3;
  assert.deepEqual(seen, [0, 1, 2]);
});

test("onCleanup runs before re-run and on stop", () => {
  const count = signal(0);
  const cleanups: string[] = [];
  const stop = effect(() => {
    const v = count.value;
    onCleanup(() => cleanups.push(`c${v}`));
  });
  count.value = 1;
  assert.deepEqual(cleanups, ["c0"]);
  stop();
  assert.deepEqual(cleanups, ["c0", "c1"]);
});

import assert from "node:assert/strict";
import test from "node:test";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

const host = await import("../packages/nui-host/src/index.ts");

function handleRefFromPacked(id) {
  const slot = Number(id & 0xffff_ffffn);
  const generation = Number(id >> 32n);
  return host.decodeHandleToken(
    `h1/${slot.toString(16).padStart(8, "0")}/${generation.toString(16).padStart(8, "0")}`,
  );
}

test("TextInputClient preserves UTF-16 ranges, selection, bounds, and revision", () => {
  hostFfiHarness.resetTrace();
  const input = host.createHostInput("Draft");
  host.setText(input.children[0].id, "A😀B");
  const handle = handleRefFromPacked(input.id);
  const client = host.createTextInputClient(handle);

  assert.deepEqual(client.surroundingText(), { start: 0, end: 4 });
  assert.deepEqual(client.selection(), { anchor: 4, focus: 4 });
  assert.deepEqual(client.compositionBounds(), { x: 0, y: 0, width: 1, height: 16 });

  client.replace({ start: 1, end: 3 }, "中");

  assert.deepEqual(client.surroundingText(), { start: 0, end: 3 });
  assert.deepEqual(client.selection(), { anchor: 2, focus: 2 });
  const state = host.getTextInputStateV1(handle);
  assert.equal(state.ok, true);
  assert.equal(state.value.text, "A中B");
  assert.equal(state.value.revision, "1");
  assert.equal("composition" in state.value, false);
  const trace = hostFfiHarness.normalizedTrace();
  assert.ok(
    trace.some(
      ({ op, rangeStart, rangeEnd, text }) =>
        op === "replaceTextInput" && rangeStart === 1 && rangeEnd === 3 && text === "中",
    ),
  );
});

test("TextInputClient rejects malformed handles before native transport", () => {
  hostFfiHarness.resetTrace();
  const result = host.getTextInputStateV1({ slot: 0, generation: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.error.name, "PROTOCOL_MISMATCH");
  assert.equal(
    hostFfiHarness.normalizedTrace().some(({ op }) => op === "getTextInputState"),
    false,
  );
});

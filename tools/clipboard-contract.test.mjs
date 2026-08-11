import assert from "node:assert/strict";
import test from "node:test";

import "./typescript-test-hooks.mjs";

const ERROR_CODES = {
  PlatformFailure: 0x0200_0009,
};

let nextHandle = 0;
let starts = [];
let awaits = [];
let cancels = [];
let pendingAwaiters = [];

const ok = (value) => JSON.stringify({ ok: true, value });

function resetFixtures() {
  nextHandle = 0;
  starts = [];
  awaits = [];
  cancels = [];
  pendingAwaiters = [];
}

globalThis.js_nexa_clipboard_read_text = () => {
  throw new Error("legacy clipboard read must not be called");
};
globalThis.js_nexa_clipboard_write_text = () => {
  throw new Error("legacy clipboard write must not be called");
};
globalThis.js_nexa_clipboard_read_text_v1 = () => {
  starts.push({ operation: "read" });
  return ok({ slot: nextHandle++, generation: 7 });
};
globalThis.js_nexa_clipboard_write_text_v1 = (text) => {
  starts.push({ operation: "write", text });
  return ok({ slot: nextHandle++, generation: 7 });
};
globalThis.js_nexa_await_task_v1 = (slot, generation) => {
  awaits.push({ slot, generation });
  return new Promise((resolve) => pendingAwaiters.push(resolve));
};
globalThis.js_nexa_cancel_task_v1 = (slot, generation) => {
  cancels.push({ slot, generation });
  return ok(null);
};

const clipboard = await import("../packages/clipboard/src/index.ts");
const systemHost = await import("../packages/system-host/src/index.ts");

test("clipboard tasks use v1 start and await transport", async () => {
  resetFixtures();
  const read = clipboard.readText();
  const write = clipboard.writeText("Nexa 中文 📝");

  assert.deepEqual(starts, [{ operation: "read" }, { operation: "write", text: "Nexa 中文 📝" }]);
  assert.equal(awaits.length, 2);
  pendingAwaiters.shift()(ok("fixture clipboard"));
  pendingAwaiters.shift()(ok(null));
  assert.equal(await read.result, "fixture clipboard");
  assert.equal(await write.result, undefined);
});

test("clipboard cancel is idempotent", () => {
  resetFixtures();
  const task = clipboard.readText();
  task.cancel();
  task.cancel();
  assert.deepEqual(cancels, [{ slot: 0, generation: 7 }]);
});

test("clipboard errors stay structured instead of becoming empty values", async () => {
  resetFixtures();
  const task = clipboard.readText();
  pendingAwaiters.shift()(
    JSON.stringify({
      ok: false,
      error: {
        domain: "system",
        code: ERROR_CODES.PlatformFailure,
        name: "PLATFORM_FAILURE",
        severity: "RecoverableOperation",
        operation: "clipboardReadText",
        retryable: true,
        message: "clipboard unavailable",
        runtimeVersion: "0.1.0",
        platformCode: "CLIPBOARD_UNAVAILABLE",
      },
    }),
  );

  await assert.rejects(
    task.result,
    (error) =>
      error instanceof systemHost.NexaSystemError &&
      error.code === ERROR_CODES.PlatformFailure &&
      error.platformCode === "CLIPBOARD_UNAVAILABLE",
  );
});

test("clipboard start rejects malformed Task handles", () => {
  globalThis.js_nexa_clipboard_read_text_v1 = () => ok({ slot: 1, generation: 0 });
  const result = systemHost.clipboardReadTextStart();
  assert.equal(result.ok, false);
  assert.equal(result.error.name, "PROTOCOL_MISMATCH");
});

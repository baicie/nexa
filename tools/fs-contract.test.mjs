import assert from "node:assert/strict";
import test from "node:test";

import "./typescript-test-hooks.mjs";

const U32_MAX = 0xffff_ffff;
const ERROR_CODES = {
  InvalidData: 0x0200_000b,
};

let nextHandle = 0;
let startCalls = [];
let awaitCalls = [];
let cancelCalls = [];
let pendingAwaiters = [];
let nativeAwaitPromises = [];

function ok(value) {
  return JSON.stringify({ ok: true, value });
}

function errorResult({ code, name, operation }) {
  return JSON.stringify({
    ok: false,
    error: {
      domain: "system",
      code,
      name,
      severity: "RecoverableOperation",
      operation,
      retryable: false,
      message: `${name} fixture`,
      runtimeVersion: "0.1.0",
    },
  });
}

function resetFixtures() {
  nextHandle = 0;
  startCalls = [];
  awaitCalls = [];
  cancelCalls = [];
  pendingAwaiters = [];
  nativeAwaitPromises = [];
}

globalThis.js_nexa_read_text_file_v1 = (path) => {
  startCalls.push({ operation: "read", path });
  const handle = { slot: nextHandle++, generation: 7 };
  return ok(handle);
};
globalThis.js_nexa_write_text_file_v1 = (path, text) => {
  startCalls.push({ operation: "write", path, text });
  const handle = { slot: nextHandle++, generation: 7 };
  return ok(handle);
};
globalThis.js_nexa_await_task_v1 = (slot, generation) => {
  awaitCalls.push({ slot, generation });
  const promise = new Promise((resolve) => pendingAwaiters.push(resolve));
  nativeAwaitPromises.push(promise);
  return promise;
};
globalThis.js_nexa_cancel_task_v1 = (slot, generation) => {
  cancelCalls.push({ slot, generation });
  return ok(null);
};

const systemHost = await import("../packages/system-host/src/index.ts");
const fs = await import("../packages/fs/src/index.ts");

test("start wrappers strictly decode a uint32 HandleRef", () => {
  resetFixtures();

  const result = systemHost.readTextFileStart("/tmp/notes.txt");

  assert.deepEqual(result, { ok: true, value: { slot: 0, generation: 7 } });
  assert.deepEqual(startCalls, [{ operation: "read", path: "/tmp/notes.txt" }]);
});

test("start wrappers reject non-canonical HandleRef shapes", () => {
  const invalidValues = [
    { slot: 1, generation: 0 },
    { slot: -1, generation: 1 },
    { slot: 1.5, generation: 1 },
    { slot: U32_MAX + 1, generation: 1 },
    { slot: 1, generation: 1, extra: true },
    { slot: 1 },
    [1, 1],
  ];

  for (const value of invalidValues) {
    globalThis.js_nexa_read_text_file_v1 = () => ok(value);
    const result = systemHost.readTextFileStart("bad");
    assert.equal(result.ok, false);
    assert.equal(result.error.domain, "protocol");
    assert.equal(result.error.name, "PROTOCOL_MISMATCH");
  }
});

test("read task caches one native await and resolves the encoded success", async () => {
  resetFixtures();
  globalThis.js_nexa_read_text_file_v1 = (path) => {
    startCalls.push({ operation: "read", path });
    return ok({ slot: 11, generation: 3 });
  };

  const task = fs.readTextFile("notes.txt");
  assert.deepEqual(task.id, { slot: 11, generation: 3 });
  assert.strictEqual(task.result, task.result);
  assert.equal(awaitCalls.length, 1);

  pendingAwaiters.shift()(ok("hello from task"));
  assert.equal(await task.result, "hello from task");
});

test("business errors resolve over native transport and become structured API errors", async () => {
  resetFixtures();
  globalThis.js_nexa_read_text_file_v1 = () => ok({ slot: 12, generation: 3 });
  const task = fs.readTextFile("invalid.txt");
  const encoded = errorResult({
    code: ERROR_CODES.InvalidData,
    name: "INVALID_DATA",
    operation: "readTextFile",
  });

  const nativePromise = nativeAwaitPromises[0];
  const result = task.result;
  assert.equal(awaitCalls.length, 1);
  pendingAwaiters.shift()(encoded);
  assert.equal(await nativePromise, encoded);
  await assert.rejects(
    result,
    (error) =>
      error instanceof systemHost.NexaSystemError &&
      error.code === ERROR_CODES.InvalidData &&
      error.operation === "readTextFile",
  );
});

test("write task returns void and cancel is idempotent", async () => {
  resetFixtures();
  globalThis.js_nexa_write_text_file_v1 = (path, text) => {
    startCalls.push({ operation: "write", path, text });
    return ok({ slot: 20, generation: 4 });
  };

  const task = fs.writeTextFile("notes.txt", "updated");
  task.cancel();
  task.cancel();
  assert.deepEqual(cancelCalls, [{ slot: 20, generation: 4 }]);

  pendingAwaiters.shift()(ok(null));
  assert.equal(await task.result, undefined);
});

test("result promise settles only once even when native completion is attempted twice", async () => {
  resetFixtures();
  globalThis.js_nexa_read_text_file_v1 = () => ok({ slot: 21, generation: 4 });
  const task = fs.readTextFile("once.txt");
  let settled = 0;
  task.result.then(() => {
    settled += 1;
  });
  const resolve = pendingAwaiters.shift();
  resolve(ok("first"));
  resolve(ok("second"));
  assert.equal(await task.result, "first");
  await Promise.resolve();
  assert.equal(settled, 1);
});

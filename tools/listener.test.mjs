import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("listener wrapper rejects non-functions before entering the raw ptr ABI", () => {
  const source = readFileSync(
    new URL("../packages/nui-host/src/protocol.ts", import.meta.url),
    "utf8",
  );
  const guard = source.indexOf('typeof callback !== "function"');
  const rawCall = source.indexOf("addEventListenerV1Raw(");
  assert.notEqual(guard, -1, "wrapper must guard callback typeof");
  assert.ok(guard < rawCall, "callback guard must run before the raw ptr call");
});

test("listener wrapper validates the callback handle before transport", () => {
  const source = readFileSync(
    new URL("../packages/nui-host/src/protocol.ts", import.meta.url),
    "utf8",
  );
  const guard = source.indexOf("removeEventListener listener must be a valid HandleRef");
  const rawCall = source.indexOf("removeEventListenerV1Raw(");
  assert.notEqual(guard, -1, "wrapper must validate callback HandleRef");
  assert.ok(guard < rawCall, "callback handle validation must precede transport");
});

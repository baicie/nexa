import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const materializePath = new URL("../packages/ui/src/mount/materialize.ts", import.meta.url);

test("Minimal TSX delegates Host defaults and property semantics to the shared kit", async () => {
  const source = await readFile(materializePath, "utf8");
  assert.match(source, /createHostElement\(/);
  assert.match(source, /applyHostProps\(/);
  assert.doesNotMatch(source, /\bsetNumber\(/);
  assert.doesNotMatch(source, /\badd(?:Click|Change|Submit)Listener\(/);
  assert.doesNotMatch(source, /\bregisterInput\(/);
  assert.doesNotMatch(source, /\bsetImage\(/);
});

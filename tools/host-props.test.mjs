import assert from "node:assert/strict";
import test from "node:test";

import { diffPropRecord } from "../packages/nui-host/src/props-state.ts";

test("host prop diff emits null for a removed top-level property", () => {
  assert.deepEqual(diffPropRecord({ padding: 8, width: 320 }, { width: 320 }), [["padding", null]]);
});

test("host prop diff clears removed style entries and preserves explicit null", () => {
  assert.deepEqual(
    diffPropRecord({ padding: 8, opacity: 0.5, fontWeight: 700 }, { opacity: 1, fontWeight: null }),
    [
      ["padding", null],
      ["opacity", 1],
      ["fontWeight", null],
    ],
  );
});

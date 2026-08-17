import assert from "node:assert/strict";
import test from "node:test";

import { Button, Spacer, Window } from "./primitives.ts";

test("no-prop JSX calls normalize Perry null props to an empty object", () => {
  for (const component of [Button, Spacer, Window]) {
    const element = component(null as never);
    assert.deepEqual(element.props, {});
  }
});

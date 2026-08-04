import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTRACT_SCENARIOS,
  createMockAdapter,
  runAdapterConformance,
} from "./adapter-contracts.mjs";

test("reference Host adapter passes every shared conformance scenario", () => {
  const passed = runAdapterConformance("mock", createMockAdapter);
  assert.equal(passed.length, CONTRACT_SCENARIOS.length);
  assert.deepEqual(
    passed,
    CONTRACT_SCENARIOS.map(({ name }) => `mock/${name}`),
  );
});

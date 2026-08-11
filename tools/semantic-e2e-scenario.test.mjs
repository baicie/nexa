import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

const root = new URL("../", import.meta.url);
const host = await import("../packages/nui-host/src/index.ts");
const { mountNode } = await import("../packages/ui/src/mount/materialize.ts");
const { App } = await import("../examples/semantic-e2e/app.tsx");

function findInputByName(trace, name) {
  return trace.find(({ op, placeholder }) => op === "registerInput" && placeholder === name)?.node;
}

function findButtonByName(trace, name) {
  for (const registration of trace.filter(({ op }) => op === "registerButton")) {
    const label = trace.find(
      ({ op, parent, child }) =>
        op === "insert" &&
        parent === registration.node &&
        trace.some(
          ({ op: textOp, node, text }) => textOp === "setText" && node === child && text === name,
        ),
    );
    if (label !== undefined) return registration.node;
  }
  return undefined;
}

test("G3B-05 fixture exposes role/name queries for both desktop platforms", () => {
  const workspace = readFileSync(new URL("pnpm-workspace.yaml", root), "utf8");
  const matrix = JSON.parse(readFileSync(new URL("tools/workspace-checks.json", root), "utf8"));
  const packageJson = JSON.parse(
    readFileSync(new URL("examples/semantic-e2e/package.json", root), "utf8"),
  );
  const source = readFileSync(new URL("examples/semantic-e2e/app.tsx", root), "utf8");
  const scenario = JSON.parse(
    readFileSync(new URL("examples/semantic-e2e/scenario.json", root), "utf8"),
  );

  assert.match(workspace, /^\s*- "examples\/semantic-e2e"$/m);
  assert.ok(matrix.projects.some(({ path }) => path === "examples/semantic-e2e"));
  assert.equal(packageJson.name, "@nexa/example-semantic-e2e");
  assert.match(source, /<Button\b/);
  assert.match(source, /<Input\b/);
  assert.match(source, /<TextArea\b/);
  assert.match(source, /onClick=/);
  assert.doesNotMatch(source, /onPointer|clientX|clientY|screenX|screenY/);
  assert.deepEqual(
    scenario.platforms.map(({ id, primaryModifier }) => [id, primaryModifier]),
    [
      ["macos", "Meta"],
      ["windows", "Control"],
    ],
  );
  assert.deepEqual(
    scenario.queries.map(({ role, name }) => [role, name]),
    [
      ["TextInput", "Title"],
      ["TextInput", "Body"],
      ["Button", "Save"],
    ],
  );
  assert.ok(
    scenario.queries.every(
      ({ actions }) =>
        Array.isArray(actions) && actions.every((action) => typeof action === "string"),
    ),
  );
  assert.ok(
    scenario.assertions.every(
      (assertion) => !/coordinate/i.test(assertion) || /no query/i.test(assertion),
    ),
  );

  hostFfiHarness.resetTrace();
  const mounted = mountNode(App());
  assert.notEqual(mounted, null);
  host.commit();

  const trace = hostFfiHarness.rawTrace();
  const resolved = new Map();
  for (const query of scenario.queries) {
    const node =
      query.role === "TextInput"
        ? findInputByName(trace, query.name)
        : query.role === "Button"
          ? findButtonByName(trace, query.name)
          : undefined;
    assert.notEqual(node, undefined, `${query.role}/${query.name} must resolve from the fixture`);
    resolved.set(`${query.role}/${query.name}`, node);
  }

  for (const query of scenario.queries) {
    const node = resolved.get(`${query.role}/${query.name}`);
    if (query.actions.includes("SetValue")) {
      assert.equal(typeof query.setValue, "string");
      hostFfiHarness.dispatch(node, host.EventId.Change, query.setValue);
    }
    if (query.actions.includes("Invoke")) {
      hostFfiHarness.dispatch(node, host.EventId.Click);
    }
  }

  const actionTrace = hostFfiHarness.rawTrace();
  assert.ok(actionTrace.some(({ op, text }) => op === "setText" && text === "Meeting notes"));
  assert.ok(actionTrace.some(({ op, text }) => op === "setText" && text === "Agenda"));
  assert.ok(
    actionTrace.some(({ op, text }) => op === "setText" && text === "Saved: Meeting notes"),
  );

  if (mounted !== null) host.remove(mounted);
  host.commit();
});

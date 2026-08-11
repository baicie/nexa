import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("G3A-11 fixture exposes the shared macOS and Windows CJK/Emoji scenario", () => {
  const workspace = readFileSync(new URL("pnpm-workspace.yaml", root), "utf8");
  const matrix = JSON.parse(readFileSync(new URL("tools/workspace-checks.json", root), "utf8"));
  const packageJson = JSON.parse(
    readFileSync(new URL("examples/input-e2e/package.json", root), "utf8"),
  );
  const source = readFileSync(new URL("examples/input-e2e/main.tsx", root), "utf8");
  const scenario = JSON.parse(
    readFileSync(new URL("examples/input-e2e/scenario.json", root), "utf8"),
  );

  assert.match(workspace, /^\s*- "examples\/input-e2e"$/m);
  assert.ok(matrix.projects.some(({ path }) => path === "examples/input-e2e"));
  assert.equal(packageJson.name, "@nexa/example-input-e2e");
  assert.match(source, /<Input\b/);
  assert.match(source, /<TextArea\b/);
  assert.equal((source.match(/onComposition=/g) ?? []).length, 2);
  assert.deepEqual(
    scenario.platforms.map(({ id, primaryModifier }) => [id, primaryModifier]),
    [
      ["macos", "Meta"],
      ["windows", "Control"],
    ],
  );
  assert.equal(scenario.singleLine.preedit, "們");
  assert.match(scenario.multiline.preedit, /\u200d/u);
  assert.match(scenario.clipboard.selectedText, /\n/u);
  assert.deepEqual(scenario.clipboard.shortcuts, ["Copy", "Cut", "Paste"]);
});

import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkspaceTypeScript } from "./typescript-test-hooks.mjs";

test("workspace package tests resolve source without generated dist", () => {
  assert.match(
    resolveWorkspaceTypeScript("@nexa/system-host"),
    /packages\/system-host\/src\/index\.ts$/u,
  );
  assert.match(
    resolveWorkspaceTypeScript("@nexa/ui/jsx-runtime"),
    /packages\/ui\/src\/jsx-runtime\.ts$/u,
  );
  assert.match(
    resolveWorkspaceTypeScript("@nexa/compiler-svelte/runtime"),
    /packages\/compiler-svelte\/src\/runtime\/index\.ts$/u,
  );
  assert.equal(resolveWorkspaceTypeScript("node:fs"), null);
  assert.equal(resolveWorkspaceTypeScript("@nexa/not-a-package"), null);
});

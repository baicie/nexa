import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

const corePackages = ["@nexa/ui", "@nexa/protocol", "@nexa/nui-host", "@nexa/system-host"];

const systemPackages = [
  "@nexa/ui",
  "@nexa/fs",
  "@nexa/dialog",
  "@nexa/clipboard",
  "@nexa/protocol",
  "@nexa/nui-host",
  "@nexa/system-host",
];

const solidNotesPackages = [
  "@nexa/ui",
  "@nexa/adapter-solid",
  "@nexa/fs",
  "@nexa/dialog",
  "@nexa/clipboard",
  "@nexa/protocol",
  "@nexa/nui-host",
  "@nexa/system-host",
  "solid-js",
];

const solidCounterPackages = [...corePackages, "@nexa/adapter-solid", "solid-js"];

const projects = new Map([
  ["package.json", systemPackages],
  ["examples/clipboard-demo/package.json", systemPackages],
  ["examples/counter/package.json", corePackages],
  ["examples/image-demo/package.json", corePackages],
  ["examples/input-e2e/package.json", corePackages],
  ["examples/layout-playground/package.json", corePackages],
  ["examples/perry-counter/package.json", corePackages],
  [
    "examples/react-counter/package.json",
    [...corePackages, "react", "react-reconciler", "scheduler"],
  ],
  ["examples/reference-notes/package.json", solidNotesPackages],
  ["examples/semantic-e2e/package.json", corePackages],
  ["examples/solid-counter/package.json", solidCounterPackages],
  ["examples/svelte-counter/package.json", corePackages],
  ["examples/todo/package.json", corePackages],
  [
    "examples/vue-counter/package.json",
    [...corePackages, "@vue/runtime-core", "@vue/reactivity", "@vue/shared"],
  ],
]);

function manifest(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

test("first-party Perry projects explicitly compile the JavaScript release closure", () => {
  for (const [relativePath, expected] of projects) {
    const perry = manifest(relativePath).perry;
    assert.deepEqual(perry?.compilePackages, expected, `${relativePath} compilePackages`);
    assert.deepEqual(
      perry?.allow?.compilePackages,
      expected,
      `${relativePath} allow.compilePackages`,
    );
  }
});

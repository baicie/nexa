import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { matchesGlob } from "node:path";
import { parse } from "yaml";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");

const ci = parse(workflow);
const filterStep = ci.jobs.changes.steps.find((step) => step.id === "filter");
assert.ok(filterStep, "ci.yml must contain the paths-filter step");
const filters = parse(filterStep.with.filters);

function routes(path, filter) {
  return filters[filter].some((pattern) => matchesGlob(path, pattern));
}

test("all ten pnpm examples trigger TypeScript checks", () => {
  const examples = [...workspace.matchAll(/^\s*- "(examples\/[^"]+)"$/gm)].map(([, path]) => path);

  assert.equal(examples.length, 10);
  for (const example of examples) {
    assert.equal(
      routes(`${example}/package.json`, "typescript"),
      true,
      `${example} must route to TypeScript`,
    );
  }
});

test("both independent FFI crates trigger Rust and future FFI checks", () => {
  for (const packageName of ["nui-host", "system-host"]) {
    for (const path of ["Cargo.toml", "Cargo.lock", "src/lib.rs"]) {
      const fixture = `packages/${packageName}/${path}`;
      assert.equal(routes(fixture, "rust"), true, `${fixture} must route to Rust`);
      assert.equal(routes(fixture, "ffi"), true, `${fixture} must route to FFI`);
    }

    assert.equal(
      routes(`packages/${packageName}/package.json`, "ffi"),
      true,
      `${packageName}'s Perry manifest must route to FFI`,
    );
  }

  assert.match(workflow, /^\s+ffi: \$\{\{ steps\.filter\.outputs\.ffi \}\}$/m);
});

test("workflow, script, and root config changes route to their owners", () => {
  const fixtures = new Map([
    [".github/workflows/ci.yml", ["rust", "typescript", "ffi", "native"]],
    [".github/workflows/rust.yml", ["rust"]],
    [".github/workflows/typescript.yml", ["typescript"]],
    [".github/workflows/ffi.yml", ["ffi"]],
    [".github/workflows/native-smoke.yml", ["native"]],
    [".github/workflows/docs.yml", ["docs"]],
    ["scripts/build-native.sh", ["rust", "typescript", "ffi", "native"]],
    ["tools/ci-path-filters.test.mjs", ["typescript"]],
    ["Cargo.toml", ["rust", "native"]],
    ["rust-toolchain.toml", ["rust", "ffi", "native"]],
    ["tsconfig.base.json", ["typescript"]],
  ]);

  for (const [path, expectedFilters] of fixtures) {
    for (const filter of expectedFilters) {
      assert.equal(routes(path, filter), true, `${path} must route to ${filter}`);
    }
  }
});

test("the required result check fails closed when change detection fails", () => {
  assert.match(workflow, /^\s+if: always\(\)$/m);
  assert.match(workflow, /^\s+needs: \[changes, rust, typescript, docs, native-smoke\]$/m);
  assert.match(workflow, /^\s+CHANGES: \$\{\{ needs\.changes\.result \}\}$/m);
  assert.match(workflow, /if \[\[ "\$CHANGES" != "success" \]\]; then/);
});

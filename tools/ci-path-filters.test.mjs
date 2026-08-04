import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { matchesGlob } from "node:path";
import { parse } from "yaml";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const ffiWorkflowUrl = new URL("../.github/workflows/ffi.yml", import.meta.url);
const typescriptWorkflowUrl = new URL("../.github/workflows/typescript.yml", import.meta.url);

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
  assert.match(workflow, /^\s+needs: \[changes, rust, typescript, ffi, docs, native-smoke\]$/m);
  assert.match(workflow, /^\s+CHANGES: \$\{\{ needs\.changes\.result \}\}$/m);
  assert.match(workflow, /if \[\[ "\$CHANGES" != "success" \]\]; then/);
});

test("the FFI route runs a required two-package verification gate", () => {
  assert.ok(existsSync(ffiWorkflowUrl), "ffi.yml must exist");
  assert.match(workflow, /^  ffi:\n(?:    .+\n)+?    uses: \.\/\.github\/workflows\/ffi\.yml$/m);
  assert.match(workflow, /^\s+needs: \[changes, rust, typescript, ffi, docs, native-smoke\]$/m);
  assert.match(workflow, /^\s+FFI: \$\{\{ needs\.ffi\.result \}\}$/m);
  assert.match(workflow, /^\s+FFI_NEEDED: \$\{\{ needs\.changes\.outputs\.ffi \}\}$/m);
  assert.match(workflow, /if \[\[ "\$FFI_NEEDED" == "true" && "\$FFI" != "success" \]\]; then/);

  const ffiWorkflow = parse(readFileSync(ffiWorkflowUrl, "utf8"));
  const gate = ffiWorkflow.jobs.gate;
  assert.deepEqual(gate.strategy.matrix.package, ["nui-host", "system-host"]);
  const commands = gate.steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
  for (const expected of [
    "cargo fmt",
    "cargo check",
    "cargo clippy",
    "cargo test",
    "perry native validate",
  ]) {
    assert.ok(
      commands.some((command) => command.includes(expected)),
      `FFI gate must run ${expected}`,
    );
  }
});

test("the TypeScript gate runs the complete workspace quality sequence", () => {
  const typescriptWorkflow = parse(readFileSync(typescriptWorkflowUrl, "utf8"));
  const job = Object.values(typescriptWorkflow.jobs)[0];
  const commands = job.steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));

  assert.deepEqual(
    commands.filter((command) => command.startsWith("pnpm ")),
    [
      "pnpm install --frozen-lockfile",
      "pnpm workspace:validate",
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
    ],
  );
});

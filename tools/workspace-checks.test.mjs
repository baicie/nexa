import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = fileURLToPath(new URL("./workspace-checks.mjs", import.meta.url));
const lintPath = fileURLToPath(new URL("./lint.mjs", import.meta.url));

function runCli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
}

test("validation matrix classifies every workspace check", () => {
  const result = runCli("validate", "--json");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.checks, ["typecheck", "test", "build", "lint"]);
  assert.equal(report.projectCount, 20);
  assert.equal(report.classifiedCheckCount, 80);
  assert.deepEqual(report.unclassified, []);
});

const expectedPlans = {
  typecheck: { runnable: 19, skipped: 1, inherited: 0 },
  test: { runnable: 2, skipped: 18, inherited: 0 },
  build: { runnable: 11, skipped: 9, inherited: 0 },
  lint: { runnable: 1, skipped: 0, inherited: 19 },
};

for (const [check, expected] of Object.entries(expectedPlans)) {
  test(`${check} dry run reports every workspace instead of silently skipping`, () => {
    const result = runCli(check, "--dry-run", "--json");

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.check, check);
    assert.equal(report.entries.length, 20);
    assert.equal(report.runnableCount, expected.runnable);
    assert.equal(report.skippedCount, expected.skipped);
    assert.equal(report.inheritedCount, expected.inherited);
  });
}

test("root check scripts route through the explicit workspace matrix", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  for (const check of Object.keys(expectedPlans)) {
    assert.equal(packageJson.scripts[check], `node tools/workspace-checks.mjs ${check}`);
    assert.doesNotMatch(packageJson.scripts[check], /--if-present/);
  }
});

test("lint discovery reports a non-zero source file count", () => {
  const result = spawnSync(process.execPath, [lintPath, "--list-only"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Oxlint will check [1-9]\d* source files\./);
});

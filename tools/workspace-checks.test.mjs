import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = fileURLToPath(new URL("./workspace-checks.mjs", import.meta.url));

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

test("typecheck dry run reports every workspace instead of silently skipping", () => {
  const result = runCli("typecheck", "--dry-run", "--json");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.check, "typecheck");
  assert.equal(report.entries.length, 20);
  assert.equal(report.runnableCount, 19);
  assert.equal(report.skippedCount, 1);
  assert.deepEqual(
    report.entries.filter((entry) => entry.status === "skip").map((entry) => entry.path),
    ["."],
  );
});

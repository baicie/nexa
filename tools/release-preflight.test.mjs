import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectReleasePreflight } from "./release-preflight.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const revision = "a".repeat(40);
const policyFiles = [
  "release/readiness-policy.json",
  "release/signing-policy.json",
  "release/performance-budgets.json",
];

test("preflight aggregates every external release blocker without mutating policy", () => {
  const before = policyFiles.map((file) => readFileSync(path.join(root, file), "utf8"));
  const report = collectReleasePreflight({
    root,
    phase: "final",
    source: { clean: false, ref: "refs/heads/mvp", revision },
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.channel, "technical-preview");
  assert.equal(report.phase, "final");
  assert.equal(report.ready, false);
  assert.equal(report.version, "0.1.0");
  assert.deepEqual(report.source.blockers, [
    "working tree is not clean",
    "source ref refs/heads/mvp is not refs/tags/v0.1.0",
  ]);
  assert.deepEqual(report.release.requiredGates, [
    "mvp",
    "contracts",
    "security",
    "performance",
    "consumer",
    "signing",
    "rehearsal",
    "registry",
  ]);
  for (const gate of report.release.requiredGates) {
    assert.match(
      report.release.blockers.join("\n"),
      new RegExp(`${gate} evidence is pending`, "u"),
    );
  }
  assert.match(report.signing.staging.blockers.join("\n"), /credential owner is unassigned/u);
  assert.match(
    report.signing.release.blockers.join("\n"),
    /staging signed-release evidence is pending/u,
  );
  assert.deepEqual(Object.keys(report.performance), ["darwin-arm64", "win32-x64"]);
  for (const platform of Object.values(report.performance)) {
    assert.equal(platform.status, "active");
    assert.deepEqual(platform.pending, []);
  }
  assert.deepEqual(
    policyFiles.map((file) => readFileSync(path.join(root, file), "utf8")),
    before,
  );
});

test("bootstrap preflight excludes only the registry gate", () => {
  const report = collectReleasePreflight({
    root,
    phase: "bootstrap",
    source: { clean: true, ref: "refs/tags/v0.1.0", revision },
  });

  assert.equal(report.ready, false);
  assert.equal(report.source.status, "pass");
  assert.deepEqual(report.release.requiredGates, [
    "mvp",
    "contracts",
    "security",
    "performance",
    "consumer",
    "signing",
    "rehearsal",
  ]);
  assert.doesNotMatch(report.release.blockers.join("\n"), /registry evidence is pending/u);
});

test("preflight CLI always emits structured blockers and has a workspace entry point", () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const runbook = readFileSync(path.join(root, "docs/RELEASE-REHEARSAL.md"), "utf8");
  assert.equal(packageJson.scripts["release:preflight"], "node tools/release-preflight.mjs --json");
  assert.match(packageJson.scripts["test:release"], /tools\/release-preflight\.test\.mjs/u);
  assert.match(runbook, /pnpm release:preflight/u);
  assert.match(runbook, /Exit `0` means[\s\S]+exit `1` means[\s\S]+exit `2` means/u);

  const result = spawnSync(
    process.execPath,
    [path.join(root, "tools/release-preflight.mjs"), "--phase", "final", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.release.requiredGates.length, 8);

  const invalid = spawnSync(
    process.execPath,
    [path.join(root, "tools/release-preflight.mjs"), "--unknown"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Usage: node tools\/release-preflight\.mjs/u);
});

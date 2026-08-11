import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  collectReferenceNotesNativeRuntimeProof,
  validateReferenceNotesNativeRuntimeProof,
  verifyReferenceNotesNativeRuntimeProof,
} from "./reference-notes-native-runtime-proof.mjs";

const revision = "a".repeat(40);
const ref = "refs/tags/v0.1.0";
const runId = "123";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hostedEnvironment(platform = "darwin") {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "baicie/nexa-ui",
    GITHUB_SHA: revision,
    GITHUB_REF: ref,
    GITHUB_RUN_ID: runId,
    GITHUB_JOB: "package",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: platform === "darwin" ? "macOS" : "Windows",
    RUNNER_ARCH: platform === "darwin" ? "ARM64" : "X64",
  };
}

function fixture(t, platform = "darwin") {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-native-runtime-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suffix = platform === "win32" ? ".exe" : "";
  const filesystem = path.join(root, `reference-notes-fs-runtime-smoke${suffix}`);
  const picker = path.join(root, `reference-notes-dialog-picker-smoke${suffix}`);
  writeFileSync(filesystem, `filesystem-${platform}\n`);
  writeFileSync(picker, `picker-${platform}\n`);
  return {
    root,
    filesystem,
    picker,
    output: path.join(
      root,
      `reference-notes-native-runtime-${platform}-${platform === "darwin" ? "arm64" : "x64"}.json`,
    ),
  };
}

test("collects a canonical revision-bound proof for native FS and real picker journeys", (t) => {
  const files = fixture(t);
  const proof = collectReferenceNotesNativeRuntimeProof({
    output: files.output,
    filesystemBinary: files.filesystem,
    pickerBinary: files.picker,
    environment: hostedEnvironment(),
  });

  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.outcome, "passed");
  assert.equal(proof.revision, revision);
  assert.equal(proof.ref, ref);
  assert.equal(proof.runId, runId);
  assert.deepEqual(proof.target, { platform: "darwin", arch: "arm64", runner: "macos-15" });
  assert.deepEqual(
    proof.probes.map(({ id, cases, journey, gate }) => ({ id, cases, journey, gate })),
    [
      { id: "filesystem", cases: ["N-05", "N-06"], journey: ["invalid-utf8", "save"], gate: "MVP" },
      {
        id: "real-picker",
        cases: ["N-04"],
        journey: ["save", "open", "cancel"],
        gate: "G5-04P",
      },
    ],
  );
  assert.equal(proof.probes[0].executable.sha256, digest("filesystem-darwin\n"));
  assert.equal(proof.probes[1].executable.sha256, digest("picker-darwin\n"));
  assert.equal(readFileSync(files.output, "utf8"), `${JSON.stringify(proof, null, 2)}\n`);
  assert.deepEqual(
    verifyReferenceNotesNativeRuntimeProof(files.output, {
      revision,
      ref,
      runId,
      target: proof.target,
    }),
    proof,
  );
});

test("runtime proof rejects wrong custody, missing cases, digest drift, and noncanonical bytes", (t) => {
  const files = fixture(t, "win32");
  const proof = collectReferenceNotesNativeRuntimeProof({
    output: files.output,
    filesystemBinary: files.filesystem,
    pickerBinary: files.picker,
    environment: hostedEnvironment("win32"),
  });

  assert.throws(
    () =>
      validateReferenceNotesNativeRuntimeProof(
        { ...proof, runId: "456", runUrl: "https://github.com/baicie/nexa-ui/actions/runs/456" },
        { revision, ref, runId, target: proof.target },
      ),
    /run identity/u,
  );
  const missingCase = structuredClone(proof);
  missingCase.probes[0].cases = ["N-06"];
  assert.throws(
    () => validateReferenceNotesNativeRuntimeProof(missingCase),
    /filesystem.*N-05.*N-06/u,
  );
  const changedDigest = structuredClone(proof);
  changedDigest.probes[1].executable.sha256 = "0".repeat(64);
  assert.throws(
    () =>
      validateReferenceNotesNativeRuntimeProof(changedDigest, {
        expectedExecutables: {
          filesystem: files.filesystem,
          "real-picker": files.picker,
        },
      }),
    /real-picker.*digest/u,
  );

  writeFileSync(files.output, JSON.stringify(proof));
  assert.throws(() => verifyReferenceNotesNativeRuntimeProof(files.output), /canonical JSON/u);
});

test("package workflow persists native runtime proof before clean-launch promotion", () => {
  const workflow = parseYaml(
    readFileSync(
      new URL("../.github/workflows/reference-notes-package.yml", import.meta.url),
      "utf8",
    ),
  );
  const packageSteps = workflow.jobs.package.steps;
  const fsIndex = packageSteps.findIndex((step) => `${step.run ?? ""}`.includes("smoke:fs"));
  const pickerIndex = packageSteps.findIndex((step) =>
    `${step.run ?? ""}`.includes("smoke:picker"),
  );
  const collectIndex = packageSteps.findIndex((step) =>
    `${step.run ?? ""}`.includes("reference-notes-native-runtime-proof.mjs collect"),
  );
  assert.ok(fsIndex >= 0 && pickerIndex > fsIndex && collectIndex > pickerIndex);
  const proofUpload = packageSteps.find((step) =>
    String(step.with?.name).startsWith("reference-notes-native-runtime-"),
  );
  assert.equal(proofUpload.if, "inputs.collect_mvp_proof");

  const launchSteps = workflow.jobs.launch.steps;
  const proofDownload = launchSteps.find((step) =>
    String(step.with?.name).startsWith("reference-notes-native-runtime-"),
  );
  assert.equal(proofDownload.if, "inputs.collect_mvp_proof");
  const launchCommands = launchSteps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(launchCommands, /runtimeProof/u);
  assert.match(launchCommands, /reference-notes-native-runtime/u);
});

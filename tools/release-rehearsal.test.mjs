import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { PERRY_SOURCE_REVISION } from "../packages/cli/src/constants.mjs";
import { generateEvidence } from "./release-evidence.mjs";
import {
  createRehearsalDecision,
  enforceRehearsalDecision,
  launchDownloadedCandidate,
  prepareCandidateBundle,
  rehearseRollback,
  releaseWorkflowPlan,
  validateRehearsalPolicy,
  validateSourceState,
  verifyDownloadedBundle,
} from "./release-rehearsal.mjs";

const policy = JSON.parse(
  readFileSync(new URL("../release/rehearsal-policy.json", import.meta.url), "utf8"),
);
const publicPackages = [
  "@nexa/cli",
  "@nexa/ui",
  "@nexa/adapter-solid",
  "@nexa/fs",
  "@nexa/dialog",
  "@nexa/clipboard",
  "@nexa/protocol",
  "@nexa/nui-host",
  "@nexa/system-host",
];
const revision = "0123456789abcdef0123456789abcdef01234567";

function dependencyGraph() {
  const npmRef = `urn:nexa:dependency:npm:sha256:${"a".repeat(64)}`;
  const cargoRef = `urn:nexa:dependency:cargo:sha256:${"b".repeat(64)}`;
  return {
    schemaVersion: 1,
    sources: [
      {
        ecosystem: "npm",
        lockfile: "pnpm-lock.yaml",
        resolver: "pnpm list --prod --json --depth Infinity",
        digest: { sha256: "c".repeat(64) },
      },
      {
        ecosystem: "cargo",
        lockfile: "Cargo.lock",
        resolver: "cargo metadata --locked --format-version 1",
        digest: { sha256: "d".repeat(64) },
      },
    ],
    roots: { npm: [npmRef], cargo: [cargoRef] },
    components: [
      {
        ref: cargoRef,
        ecosystem: "cargo",
        type: "library",
        name: "serde",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
      {
        ref: npmRef,
        ecosystem: "npm",
        type: "library",
        name: "@nexa/ui",
        version: "0.1.0",
      },
    ],
    dependencies: [
      { ref: cargoRef, dependsOn: [] },
      { ref: npmRef, dependsOn: [] },
    ],
  };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nexa-release-rehearsal-"));
  const releaseOutputDirectory = path.join(fixtureRoot, "producer");
  const producerArtifacts = path.join(releaseOutputDirectory, "artifacts");
  const producerEvidence = path.join(releaseOutputDirectory, "evidence");
  const descriptorPath = path.join(releaseOutputDirectory, "descriptor.json");
  const applicationDirectory = path.join(fixtureRoot, "probe-app");
  mkdirSync(producerArtifacts, { recursive: true });
  mkdirSync(applicationDirectory);

  for (const name of publicPackages) {
    const tarball = `${name.replace("@nexa/", "nexa-")}-0.1.0.tgz`;
    writeFileSync(path.join(producerArtifacts, tarball), `${name}\n`);
  }
  writeJson(descriptorPath, {
    schemaVersion: 1,
    release: { name: "nexa-ui", version: "0.1.0" },
    source: {
      repository: "https://github.com/baicie/nexa-ui",
      revision,
      dirty: true,
    },
    build: {
      builderId: "https://github.com/baicie/nexa-ui/.github/workflows/release-rehearsal.yml",
      buildType: "https://nexa-ui.dev/build-types/technical-preview/v1",
      sourceDateEpoch: 1_786_233_600,
    },
    materials: dependencyGraph().sources.map(({ lockfile, digest }) => ({
      uri: `https://github.com/baicie/nexa-ui/blob/${revision}/${lockfile}`,
      digest,
    })),
    dependencyGraph: dependencyGraph(),
  });
  generateEvidence({
    artifactsDir: producerArtifacts,
    evidenceDir: producerEvidence,
    descriptorPath,
  });
  writeJson(path.join(releaseOutputDirectory, "result.json"), {
    schemaVersion: 1,
    native: true,
    packages: publicPackages,
    output: releaseOutputDirectory,
  });
  writeFileSync(
    path.join(applicationDirectory, "probe.mjs"),
    "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n",
  );

  return {
    root: fixtureRoot,
    releaseOutputDirectory,
    applicationDirectory,
    bundleDirectory: path.join(fixtureRoot, "producer-bundle"),
    downloadDirectory: path.join(fixtureRoot, "fresh-download"),
    extractDirectory: path.join(fixtureRoot, "launch-extract"),
    rollbackDirectory: path.join(fixtureRoot, "rollback-rehearsal"),
  };
}

function prepareFixture(current) {
  return prepareCandidateBundle({
    releaseOutputDirectory: current.releaseOutputDirectory,
    bundleDirectory: current.bundleDirectory,
    mode: "candidate",
    ref: "refs/heads/local-rehearsal",
    revision,
    platform: process.platform === "win32" ? "win32-x64" : "darwin-arm64",
    applicationDirectory: current.applicationDirectory,
    executableRelativePath: "probe.mjs",
    launchKind: "node-probe",
    observationMs: 30,
  });
}

test("rehearsal policy keeps every mode non-publishing and non-signing", () => {
  assert.equal(validateRehearsalPolicy(policy), policy);
  assert.deepEqual(policy.execution, {
    publishes: false,
    signs: false,
    notarizes: false,
    dispatchesRemoteWorkflows: false,
  });
  assert.equal(policy.modes.candidate.requireCleanSource, false);
  for (const mode of ["publishable", "tag"]) {
    assert.equal(policy.modes[mode].requireCleanSource, true);
    assert.equal(policy.modes[mode].requireVersionTag, true);
  }
  assert.equal(policy.verification.freshDownloadRequired, true);
  assert.equal(policy.verification.independentJobRequired, true);
  assert.deepEqual(policy.requiredGates, [
    "source",
    "contracts",
    "security",
    "performance",
    "consumer",
    "freshVerification",
    "launch",
    "rollback",
  ]);
  assert.equal(policy.launch.integrityVerificationRequired, true);
  assert.equal(policy.launch.observationMs, 5_000);
});

test("publishable and tag modes require a clean, version-matched tag", () => {
  const base = {
    policy,
    version: "0.1.0",
    refType: "tag",
    refName: "v0.1.0",
    revision: "a".repeat(40),
    head: "a".repeat(40),
    status: "",
  };

  assert.doesNotThrow(() => validateSourceState({ ...base, mode: "publishable" }));
  assert.doesNotThrow(() => validateSourceState({ ...base, mode: "tag" }));
  assert.throws(
    () => validateSourceState({ ...base, mode: "publishable", status: "?? dist/file" }),
    /clean source/u,
  );
  assert.throws(
    () => validateSourceState({ ...base, mode: "tag", refName: "v0.1.1" }),
    /version tag v0\.1\.0/u,
  );
  assert.throws(
    () => validateSourceState({ ...base, mode: "publishable", refType: "branch" }),
    /version tag/u,
  );
});

test("candidate mode permits local changes but still binds the checked-out revision", () => {
  const source = {
    mode: "candidate",
    policy,
    version: "0.1.0",
    refType: "branch",
    refName: "feature/rehearsal",
    revision: "b".repeat(40),
    head: "b".repeat(40),
    status: " M package.json",
  };

  assert.doesNotThrow(() => validateSourceState(source));
  assert.throws(
    () => validateSourceState({ ...source, head: "c".repeat(40) }),
    /checked-out revision/u,
  );
});

test("prototype-inherited names are rejected as unknown rehearsal modes", () => {
  const gates = Object.fromEntries(policy.requiredGates.map((gate) => [gate, "success"]));
  const source = {
    mode: "__proto__",
    policy,
    version: "0.1.0",
    refType: "branch",
    refName: "feature/rehearsal",
    revision,
    head: revision,
    status: "",
  };

  assert.throws(() => validateSourceState(source), /unknown rehearsal mode/u);
  assert.throws(
    () =>
      createRehearsalDecision({
        policy,
        mode: "__proto__",
        ref: "refs/heads/feature/rehearsal",
        revision,
        gates,
      }),
    /unknown rehearsal mode/u,
  );
  assert.throws(
    () =>
      enforceRehearsalDecision({
        policy,
        decision: {
          schemaVersion: 1,
          mode: "__proto__",
          ref: "refs/heads/feature/rehearsal",
          revision,
          gates,
          outcome: "passed",
          failedGates: [],
          rollback: null,
        },
        expectedMode: "__proto__",
        expectedRef: "refs/heads/feature/rehearsal",
        expectedRevision: revision,
      }),
    /unknown expected rehearsal mode/u,
  );
});

test("decision records rollback for every incomplete or failed gate", () => {
  const passingGates = Object.fromEntries(policy.requiredGates.map((gate) => [gate, "success"]));
  const passed = createRehearsalDecision({
    policy,
    mode: "tag",
    ref: "refs/tags/v0.1.0",
    revision: "d".repeat(40),
    gates: passingGates,
  });
  assert.equal(passed.outcome, "passed");
  assert.equal(passed.promotion, "owner-review-required");
  assert.equal(passed.rollback, null);

  for (const status of ["failure", "cancelled", "skipped"]) {
    const failed = createRehearsalDecision({
      policy,
      mode: "tag",
      ref: "refs/tags/v0.1.0",
      revision: "d".repeat(40),
      gates: { ...passingGates, freshVerification: status },
    });
    assert.equal(failed.outcome, "rollback-required");
    assert.equal(failed.promotion, "blocked");
    assert.equal(failed.rollback.state, "quarantined");
    assert.ok(failed.rollback.actions.includes("keep-last-known-good-current"));
    assert.ok(failed.rollback.actions.includes("use-new-version-for-next-candidate"));
  }
});

test("release enforcement accepts only the exact successful tag rehearsal", () => {
  const gates = Object.fromEntries(policy.requiredGates.map((gate) => [gate, "success"]));
  const decision = createRehearsalDecision({
    policy,
    mode: "tag",
    ref: "refs/tags/v0.1.0",
    revision,
    gates,
  });
  const expected = {
    policy,
    expectedMode: "tag",
    expectedRef: "refs/tags/v0.1.0",
    expectedRevision: revision,
  };

  assert.equal(enforceRehearsalDecision({ ...expected, decision }), decision);
  assert.throws(
    () =>
      enforceRehearsalDecision({
        ...expected,
        decision: { ...decision, mode: "candidate", promotion: "candidate-only" },
      }),
    /mode tag/u,
  );
  assert.throws(
    () =>
      enforceRehearsalDecision({
        ...expected,
        decision: { ...decision, ref: "refs/tags/v0.1.1" },
      }),
    /ref refs\/tags\/v0\.1\.0/u,
  );
  assert.throws(
    () =>
      enforceRehearsalDecision({
        ...expected,
        decision: { ...decision, revision: "f".repeat(40) },
      }),
    /revision/u,
  );
  assert.throws(
    () =>
      enforceRehearsalDecision({
        ...expected,
        decision: { ...decision, promotion: "candidate-only" },
      }),
    /promotion.*owner-review-required/u,
  );
  assert.throws(
    () =>
      enforceRehearsalDecision({
        ...expected,
        decision: { ...decision, gates: { ...decision.gates, launch: "skipped" } },
      }),
    /gate launch.*success/u,
  );
});

test("workflow plan preserves the tag-to-rollback order and forbidden execution boundary", () => {
  const plan = releaseWorkflowPlan(policy);
  assert.deepEqual(plan.stages, [
    "validate-tag-source",
    "run-required-gates",
    "build-unsigned-artifacts",
    "upload-candidate",
    "fresh-download",
    "verify-integrity",
    "launch-downloaded-application",
    "rehearse-quarantine-rollback",
    "record-promotion-decision",
  ]);
  assert.deepEqual(plan.forbiddenOperations, [
    "publish",
    "sign",
    "notarize",
    "dispatch-remote-workflow",
  ]);
});

test("fresh download verifies the complete transport inventory and release evidence", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const prepared = prepareFixture(current);
  cpSync(current.bundleDirectory, current.downloadDirectory, { recursive: true });

  const verified = verifyDownloadedBundle({
    bundleDirectory: current.downloadDirectory,
    mode: "candidate",
    ref: "refs/heads/local-rehearsal",
    revision,
    platform: process.platform === "win32" ? "win32-x64" : "darwin-arm64",
  });

  assert.equal(prepared.manifest.source.revision, revision);
  assert.equal(verified.manifest.integrity.files.length, prepared.manifest.integrity.files.length);
  assert.ok(
    verified.manifest.integrity.files.some(({ path: relativePath }) =>
      relativePath.startsWith("artifacts/application/"),
    ),
  );
  assert.deepEqual(verified.consumer.packages, publicPackages);
});

test("fresh verification rejects artifact or transport-manifest tampering", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  prepareFixture(current);
  cpSync(current.bundleDirectory, current.downloadDirectory, { recursive: true });
  const artifact = path.join(current.downloadDirectory, "artifacts", "npm", "nexa-cli-0.1.0.tgz");
  appendFileSync(artifact, "tampered\n");
  assert.throws(
    () =>
      verifyDownloadedBundle({
        bundleDirectory: current.downloadDirectory,
        mode: "candidate",
        ref: "refs/heads/local-rehearsal",
        revision,
        platform: process.platform === "win32" ? "win32-x64" : "darwin-arm64",
      }),
    /integrity mismatch.*nexa-cli-0\.1\.0\.tgz/u,
  );

  rmSync(current.downloadDirectory, { recursive: true, force: true });
  cpSync(current.bundleDirectory, current.downloadDirectory, { recursive: true });
  const manifestPath = path.join(current.downloadDirectory, policy.transport.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.source.revision = "f".repeat(40);
  writeJson(manifestPath, manifest);
  assert.throws(
    () =>
      verifyDownloadedBundle({
        bundleDirectory: current.downloadDirectory,
        mode: "candidate",
        ref: "refs/heads/local-rehearsal",
        revision,
        platform: process.platform === "win32" ? "win32-x64" : "darwin-arm64",
      }),
    /revision does not match/u,
  );
});

test("launch happens only after verification and terminates after the observation window", async (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  prepareFixture(current);
  cpSync(current.bundleDirectory, current.downloadDirectory, { recursive: true });

  const report = await launchDownloadedCandidate({
    bundleDirectory: current.downloadDirectory,
    extractDirectory: current.extractDirectory,
    mode: "candidate",
    ref: "refs/heads/local-rehearsal",
    revision,
    platform: process.platform === "win32" ? "win32-x64" : "darwin-arm64",
  });
  assert.equal(report.verified, true);
  assert.equal(report.survivedObservation, true);
  assert.equal(report.terminated, true);

  appendFileSync(
    path.join(current.downloadDirectory, "artifacts", "npm", "nexa-cli-0.1.0.tgz"),
    "tampered\n",
  );
  await assert.rejects(
    launchDownloadedCandidate({
      bundleDirectory: current.downloadDirectory,
      extractDirectory: path.join(current.root, "must-not-extract"),
      mode: "candidate",
      ref: "refs/heads/local-rehearsal",
      revision,
      platform: process.platform === "win32" ? "win32-x64" : "darwin-arm64",
    }),
    /integrity mismatch/u,
  );
  assert.equal(existsSync(path.join(current.root, "must-not-extract")), false);
});

test("rollback rehearsal quarantines a tampered copy without changing the candidate", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const prepared = prepareFixture(current);
  const originalManifest = readFileSync(
    path.join(current.bundleDirectory, policy.transport.manifest),
    "utf8",
  );

  const decision = rehearseRollback({
    bundleDirectory: current.bundleDirectory,
    outputDirectory: current.rollbackDirectory,
    mode: "candidate",
    ref: "refs/heads/local-rehearsal",
    revision,
    platform: process.platform === "win32" ? "win32-x64" : "darwin-arm64",
    lastKnownGood: "none-first-preview",
  });

  assert.equal(decision.outcome, "rollback-required");
  assert.equal(decision.rollback.state, "quarantined");
  assert.equal(decision.exercise.detectedTampering, true);
  assert.equal(decision.exercise.lastKnownGood, "none-first-preview");
  assert.equal(
    readFileSync(path.join(current.bundleDirectory, policy.transport.manifest), "utf8"),
    originalManifest,
  );
  assert.equal(
    existsSync(path.join(current.rollbackDirectory, "quarantine", policy.transport.manifest)),
    true,
  );
  assert.equal(prepared.manifest.source.revision, revision);
});

test("isolated workflow and runbook encode fresh jobs, rollback, and no release side effects", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release-rehearsal.yml", import.meta.url),
    "utf8",
  );
  const runbook = readFileSync(new URL("../docs/RELEASE-REHEARSAL.md", import.meta.url), "utf8");

  for (const job of [
    "source",
    "contracts",
    "security",
    "performance",
    "performance-gate",
    "consumer",
    "fresh-verify",
    "launch",
    "rollback",
    "decision",
  ]) {
    assert.match(workflow, new RegExp(`^  ${job}:`, "mu"));
  }
  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- "v\*"/u);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /release-rehearsal\.mjs verify/u);
  assert.match(workflow, /release-rehearsal\.mjs launch/u);
  assert.match(workflow, /release-rehearsal\.mjs rollback/u);
  assert.match(
    workflow,
    /release-rehearsal\.mjs enforce[\s\S]*--decision "\$\{\{ runner\.temp \}\}\/rehearsal-decision\.json"[\s\S]*--mode "\$REHEARSAL_MODE"[\s\S]*--ref "\$GITHUB_REF"[\s\S]*--revision "\$GITHUB_SHA"/u,
  );
  assert.doesNotMatch(
    workflow,
    /npm publish|pnpm publish|gh workflow run|codesign|notarytool|signtool/iu,
  );
  assert.match(runbook, /tag.*artifact.*fresh download.*integrity.*launch.*rollback/isu);
  assert.match(runbook, /none-first-preview/u);
  assert.match(runbook, /does not publish|不发布/iu);
});

test("nested rehearsal performance artifacts use an invocation-unique suffix", () => {
  const rehearsal = parseYaml(
    readFileSync(new URL("../.github/workflows/release-rehearsal.yml", import.meta.url), "utf8"),
  );
  const performance = parseYaml(
    readFileSync(new URL("../.github/workflows/performance.yml", import.meta.url), "utf8"),
  );
  const producer = performance.jobs["candidate-producer"];
  const capture = performance.jobs["hosted-capture"];
  const aggregate = performance.jobs["platform-aggregate"];
  assert.ok(producer, "performance.yml must define the candidate-producer job");
  assert.ok(capture, "performance.yml must define the hosted-capture job");
  assert.ok(aggregate, "performance.yml must define the platform-aggregate job");

  const candidateUpload = producer.steps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@"),
  );
  const candidateDownload = capture.steps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/download-artifact@"),
  );
  const rawUpload = capture.steps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@"),
  );
  const rawDownloads = aggregate.steps.filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/download-artifact@"),
  );

  assert.equal(performance.on.workflow_call.inputs.artifact_suffix.default, "");
  assert.equal(rehearsal.jobs.performance.with.artifact_suffix, "-rehearsal");
  assert.equal(
    candidateUpload.with.name,
    "performance-candidate-${{ matrix.platform }}${{ inputs.artifact_suffix }}",
  );
  assert.equal(candidateDownload.with.name, candidateUpload.with.name);
  assert.equal(
    rawUpload.with.name,
    "performance-report-${{ matrix.platform }}-replica-${{ matrix.replica }}${{ inputs.artifact_suffix }}",
  );
  assert.deepEqual(
    rawDownloads.map((step) => step.with.name),
    [1, 2, 3].map(
      (replica) =>
        `performance-report-\${{ matrix.platform }}-replica-${replica}\${{ inputs.artifact_suffix }}`,
    ),
  );
});

test("CI rehearsals reuse one active performance result while tag rehearsals capture locally", () => {
  const rehearsal = parseYaml(
    readFileSync(new URL("../.github/workflows/release-rehearsal.yml", import.meta.url), "utf8"),
  );
  const input = rehearsal.on.workflow_call.inputs.upstream_performance_result;
  const performance = rehearsal.jobs.performance;
  const gate = rehearsal.jobs["performance-gate"];

  assert.equal(input.type, "string");
  assert.equal(input.required, false);
  assert.equal(input.default, "");
  assert.equal(performance.if, "inputs.upstream_performance_result == ''");
  assert.deepEqual(gate.needs, ["source", "performance"]);
  assert.equal(gate.if, "always() && needs.source.result == 'success'");
  assert.equal(gate.env.UPSTREAM_PERFORMANCE_RESULT, "${{ inputs.upstream_performance_result }}");
  assert.equal(gate.env.INTERNAL_PERFORMANCE_RESULT, "${{ needs.performance.result }}");
  const command = gate.steps.find((step) => typeof step.run === "string")?.run ?? "";
  assert.match(command, /UPSTREAM_PERFORMANCE_RESULT.*success/su);
  assert.match(command, /INTERNAL_PERFORMANCE_RESULT.*success/su);
  assert.match(command, /INTERNAL_PERFORMANCE_RESULT.*skipped/su);
  assert.deepEqual(rehearsal.jobs.consumer.needs, [
    "source",
    "contracts",
    "security",
    "performance-gate",
  ]);
  assert.equal(
    rehearsal.jobs.consumer.if,
    "always() && needs.source.result == 'success' && needs.contracts.result == 'success' && needs.security.result == 'success' && needs.performance-gate.result == 'success'",
  );
  assert.equal(rehearsal.jobs["fresh-verify"].if, "always() && needs.consumer.result == 'success'");
  assert.equal(rehearsal.jobs.launch.if, "always() && needs.fresh-verify.result == 'success'");
  assert.ok(rehearsal.jobs.decision.needs.includes("performance-gate"));
  assert.equal(rehearsal.jobs.decision.needs.includes("performance"), false);
  const decision = rehearsal.jobs.decision.steps.find((step) =>
    step.run?.includes("release-rehearsal.mjs decision"),
  );
  assert.match(decision.run, /--gate-performance "\$\{\{ needs\.performance-gate\.result \}\}"/u);
});

test("rehearsal consumer builds with the pinned native toolchain and clean installed Hosts", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/release-rehearsal.yml", import.meta.url), "utf8"),
  );
  const job = workflow.jobs.consumer;
  assert.equal(job.env.RUSTUP_TOOLCHAIN, "1.95.0");
  assert.equal(job.env.PERRY_WORKSPACE_ROOT, "${{ github.workspace }}/.perry-source");
  assert.equal(job.env.PERRY_RUNTIME_DIR, "${{ github.workspace }}/.perry-source/target/release");
  assert.equal(job.env.PERRY_LIB_DIR, "${{ github.workspace }}/.perry-source/target/release");
  assert.equal(job.env.NEXA_WINDOWS_RUNTIME_ROOT, "${{ github.workspace }}/.nexa-windows-runtime");

  const checkout = job.steps.find((step) => step.with?.repository === "PerryTS/perry");
  assert.equal(checkout.with.ref, PERRY_SOURCE_REVISION);
  assert.equal(checkout.with.path, ".perry-source");
  assert.equal(checkout.with["persist-credentials"], false);
  const toolchain = job.steps.find(
    (step) => step.name === "Install Perry-compatible Rust toolchain",
  );
  assert.equal(toolchain.with.toolchain, "1.95.0");

  const macRuntime = job.steps.find(
    (step) => step.name === "Build pinned Perry full unwind runtime closure (macOS)",
  );
  assert.equal(macRuntime.if, "runner.os == 'macOS'");
  assert.equal(macRuntime.env.CARGO_PROFILE_RELEASE_PANIC, "unwind");
  assert.equal(macRuntime.env.PERRY_SOURCE_REVISION, PERRY_SOURCE_REVISION);
  assert.match(macRuntime.run, /-p perry-runtime-static/u);
  assert.match(macRuntime.run, /-p perry-stdlib-static/u);

  const windowsCompiler = job.steps.find(
    (step) => step.name === "Build patched Perry compiler (Windows)",
  );
  assert.equal(windowsCompiler.if, "runner.os == 'Windows'");
  assert.equal(windowsCompiler.env.PERRY_SOURCE_REVISION, PERRY_SOURCE_REVISION);
  assert.match(windowsCompiler.run, /0001-windows-reject-duplicate-symbols\.patch/u);
  assert.match(windowsCompiler.run, /apply --check \$patch/u);
  assert.match(windowsCompiler.run, /apply --reverse --check \$patch/u);
  assert.match(windowsCompiler.run, /-p perry/u);
  assert.doesNotMatch(windowsCompiler.run, /FORCE:MULTIPLE|windows-static-closure/u);
  assert.match(windowsCompiler.run, /NEXA_PERRY_BIN=\$compiler/u);

  const skia = job.steps.find((step) => step.name === "Download pinned Windows Skia archive");
  assert.equal(skia.if, "runner.os == 'Windows'");
  assert.match(skia.run, /Get-FileHash -Algorithm SHA256/u);
  assert.match(skia.run, /NEXA_WINDOWS_SKIA_ARCHIVE=\$archive/u);
  assert.doesNotMatch(skia.run, /tar\.exe|packages\/nui-host/u);
  assert.match(skia.run, /SKIA_BINARIES_URL=\$fileUrl/u);
  const consume = job.steps.find(
    (step) => step.name === "Build, pack, and consume public tarballs",
  );
  assert.ok(job.steps.indexOf(skia) < job.steps.indexOf(consume));
});

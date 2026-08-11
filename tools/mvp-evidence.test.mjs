import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  collectHostedMvpProof,
  collectMvpEvidence,
  promoteHostedMvpEvidence,
  verifyMvpEvidence,
} from "./mvp-evidence.mjs";
import { collectReferenceNotesNativeRuntimeProof } from "./reference-notes-native-runtime-proof.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function successfulRunner(calls = []) {
  return (request) => {
    calls.push(request);
    const ordinal = Number.parseInt(request.id.slice(-2), 10);
    return {
      exitStatus: 0,
      stdout: `stdout for ${request.id}\n`,
      stderr: "",
      durationMs: ordinal,
    };
  };
}

function collectFixture(output, runner = successfulRunner()) {
  return collectMvpEvidence({
    output,
    revision: "a".repeat(40),
    ref: "WORKTREE",
    sourceDirty: true,
    capturedAt: "2026-08-10T00:00:00.000Z",
    runner,
  });
}

const hostedTargets = [
  { platform: "darwin", arch: "arm64", runner: "macos-15", runnerOs: "macOS", runnerArch: "ARM64" },
  {
    platform: "win32",
    arch: "x64",
    runner: "windows-2022",
    runnerOs: "Windows",
    runnerArch: "X64",
  },
];

const gateDefinitions = [
  { id: "typescript", producerWorkflow: ".github/workflows/typescript.yml" },
  { id: "rust", producerWorkflow: ".github/workflows/rust.yml" },
  { id: "ffi", producerWorkflow: ".github/workflows/ffi.yml" },
  { id: "perry-frameworks", producerWorkflow: ".github/workflows/perry-frameworks.yml" },
  { id: "docs", producerWorkflow: ".github/workflows/docs.yml" },
  { id: "native-accessibility", producerWorkflow: ".github/workflows/native-smoke.yml" },
  {
    id: "clean-package-launch",
    producerWorkflow: ".github/workflows/reference-notes-package.yml",
  },
];

function successfulGateJobs() {
  return Object.fromEntries(gateDefinitions.map(({ id }) => [id, "success"]));
}

function hostedProofFixture(root, gate, revision, ref, runId) {
  const proofDirectory = path.join(root, `${gate}-proofs`);
  mkdirSync(proofDirectory, { recursive: true });
  for (const target of hostedTargets) {
    const artifactNames =
      gate === "native-accessibility"
        ? [`semantic-accessibility-smoke${target.platform === "win32" ? ".exe" : ""}`]
        : ["generic.tar.gz", "reference-notes.tar.gz"];
    const artifactDirectory = path.join(root, `${gate}-${target.platform}-artifacts`);
    mkdirSync(artifactDirectory, { recursive: true });
    const artifactPaths = artifactNames.map((name) => {
      const file = path.join(artifactDirectory, name);
      writeFileSync(file, `${gate}:${target.platform}:${name}\n`);
      return file;
    });
    let runtimeProof;
    if (gate === "clean-package-launch") {
      const suffix = target.platform === "win32" ? ".exe" : "";
      const filesystem = path.join(artifactDirectory, `reference-notes-fs-runtime-smoke${suffix}`);
      const picker = path.join(artifactDirectory, `reference-notes-dialog-picker-smoke${suffix}`);
      writeFileSync(filesystem, `${gate}:${target.platform}:filesystem\n`);
      writeFileSync(picker, `${gate}:${target.platform}:picker\n`);
      runtimeProof = path.join(
        artifactDirectory,
        `reference-notes-native-runtime-${target.platform}-${target.arch}.json`,
      );
      collectReferenceNotesNativeRuntimeProof({
        output: runtimeProof,
        filesystemBinary: filesystem,
        pickerBinary: picker,
        environment: {
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "baicie/nexa-ui",
          GITHUB_SHA: revision,
          GITHUB_REF: ref,
          GITHUB_RUN_ID: runId,
          GITHUB_JOB: "package",
          RUNNER_ENVIRONMENT: "github-hosted",
          RUNNER_OS: target.runnerOs,
          RUNNER_ARCH: target.runnerArch,
        },
      });
    }
    collectHostedMvpProof({
      output: path.join(proofDirectory, `${gate}-${target.platform}-${target.arch}.json`),
      gate,
      runner: target.runner,
      artifacts: artifactPaths,
      runtimeProof,
      environment: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "baicie/nexa-ui",
        GITHUB_SHA: revision,
        GITHUB_REF: ref,
        GITHUB_RUN_ID: runId,
        GITHUB_JOB: gate === "native-accessibility" ? "smoke" : "launch",
        RUNNER_ENVIRONMENT: "github-hosted",
        RUNNER_OS: target.runnerOs,
        RUNNER_ARCH: target.runnerArch,
      },
    });
  }
  return proofDirectory;
}

test("collect executes every local MVP case and binds structured command results", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "mvp-status.json");
  const calls = [];
  const record = collectFixture(output, successfulRunner(calls));

  assert.equal(record.schemaVersion, 5);
  assert.equal(record.gates, null);
  assert.deepEqual(
    record.cases.map(({ id }) => id),
    Array.from({ length: 11 }, (_, index) => `N-${String(index + 1).padStart(2, "0")}`),
  );
  assert.deepEqual(
    calls.map(({ id }) => id),
    Array.from({ length: 9 }, (_, index) => `N-${String(index + 1).padStart(2, "0")}`),
  );
  assert.ok(calls.every(({ executable, args }) => executable && Array.isArray(args)));

  for (const entry of record.cases.slice(0, 9)) {
    assert.equal(entry.status, "passed");
    assert.equal(entry.execution.exitStatus, 0);
    assert.ok(entry.execution.durationMs > 0);
    assert.equal(entry.execution.stdout.summary, `stdout for ${entry.id}\n`);
    assert.equal(entry.execution.stdout.summarySha256, sha256(entry.execution.stdout.summary));
    assert.equal(entry.execution.stderr.summarySha256, sha256(""));
    assert.equal(entry.hosted, null);
  }
  for (const entry of record.cases.slice(9)) {
    assert.equal(entry.status, "blocked");
    assert.equal(entry.execution, null);
    assert.equal(entry.hosted, null);
  }
  assert.deepEqual(verifyMvpEvidence(output, { revision: "a".repeat(40) }), record);
});

test("hosted promotion closes N-10 and N-11 only after clean local evidence and both platform jobs", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-hosted-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = path.join(root, "local.json");
  const output = path.join(root, "hosted.json");
  const revision = "a".repeat(40);
  const ref = "refs/tags/v0.1.0";
  const runId = "123";
  collectMvpEvidence({
    output: local,
    revision,
    ref,
    sourceDirty: false,
    capturedAt: "2026-08-10T00:00:00.000Z",
    runner: successfulRunner(),
  });
  const record = promoteHostedMvpEvidence({
    input: local,
    output,
    revision,
    ref,
    runId,
    runUrl: "https://github.com/baicie/nexa-ui/actions/runs/123",
    capturedAt: "2026-08-10T01:00:00.000Z",
    jobs: successfulGateJobs(),
    proofDirectories: {
      "native-accessibility": hostedProofFixture(
        root,
        "native-accessibility",
        revision,
        ref,
        runId,
      ),
      "clean-package-launch": hostedProofFixture(
        root,
        "clean-package-launch",
        revision,
        ref,
        runId,
      ),
    },
  });
  assert.ok(record.cases.every(({ status }) => status === "passed"));
  assert.deepEqual(record.gates, {
    workflow: ".github/workflows/mvp-evidence.yml",
    runId,
    runUrl: "https://github.com/baicie/nexa-ui/actions/runs/123",
    revision,
    ref,
    results: gateDefinitions.map((gate) => ({ ...gate, conclusion: "success" })),
  });
  assert.deepEqual(
    record.cases.slice(9).map(({ id, hosted }) => ({
      id,
      job: hosted.job,
      targets: hosted.platforms.map(({ platform, arch, proof }) => ({
        platform,
        arch,
        proof: { name: proof.name, sha256: proof.sha256 },
      })),
    })),
    [
      {
        id: "N-10",
        job: "native-accessibility",
        targets: [
          {
            platform: "darwin",
            arch: "arm64",
            proof: {
              name: "native-accessibility-darwin-arm64.json",
              sha256: sha256(
                readFileSync(
                  path.join(
                    root,
                    "native-accessibility-proofs/native-accessibility-darwin-arm64.json",
                  ),
                ),
              ),
            },
          },
          {
            platform: "win32",
            arch: "x64",
            proof: {
              name: "native-accessibility-win32-x64.json",
              sha256: sha256(
                readFileSync(
                  path.join(
                    root,
                    "native-accessibility-proofs/native-accessibility-win32-x64.json",
                  ),
                ),
              ),
            },
          },
        ],
      },
      {
        id: "N-11",
        job: "clean-package-launch",
        targets: [
          {
            platform: "darwin",
            arch: "arm64",
            proof: {
              name: "clean-package-launch-darwin-arm64.json",
              sha256: sha256(
                readFileSync(
                  path.join(
                    root,
                    "clean-package-launch-proofs/clean-package-launch-darwin-arm64.json",
                  ),
                ),
              ),
            },
          },
          {
            platform: "win32",
            arch: "x64",
            proof: {
              name: "clean-package-launch-win32-x64.json",
              sha256: sha256(
                readFileSync(
                  path.join(
                    root,
                    "clean-package-launch-proofs/clean-package-launch-win32-x64.json",
                  ),
                ),
              ),
            },
          },
        ],
      },
    ],
  );
  for (const entry of record.cases.slice(9)) {
    for (const platform of entry.hosted.platforms) {
      assert.equal(platform.proof.payload.revision, revision);
      assert.equal(platform.proof.payload.ref, ref);
      assert.equal(platform.proof.payload.runId, runId);
      assert.deepEqual(platform.proof.payload.artifacts, platform.artifacts);
    }
  }
  assert.deepEqual(verifyMvpEvidence(output, { revision }), record);

  const tampered = structuredClone(record);
  tampered.cases[9].hosted.job = "contract-only";
  writeFileSync(output, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => verifyMvpEvidence(output, { revision }), /N-10.*hosted job/u);
});

test("hosted promotion rejects dirty, failed, or partial local evidence", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-hosted-reject-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const revision = "a".repeat(40);
  const input = path.join(root, "local.json");
  collectFixture(input);
  assert.throws(
    () =>
      promoteHostedMvpEvidence({
        input,
        output: path.join(root, "hosted.json"),
        revision,
        ref: "refs/tags/v0.1.0",
        runId: "123",
        runUrl: "https://github.com/baicie/nexa-ui/actions/runs/123",
        jobs: {
          typescript: "success",
          rust: "success",
          ffi: "success",
          "perry-frameworks": "success",
          docs: "success",
          "native-accessibility": "success",
          "clean-package-launch": "success",
        },
      }),
    /clean tag evidence/u,
  );
});

test("hosted promotion fails closed when any current quality gate result is missing", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-gate-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const revision = "a".repeat(40);
  const ref = "refs/tags/v0.1.0";
  const runId = "123";
  const input = path.join(root, "local.json");
  collectMvpEvidence({
    output: input,
    revision,
    ref,
    sourceDirty: false,
    capturedAt: "2026-08-10T00:00:00.000Z",
    runner: successfulRunner(),
  });
  const jobs = successfulGateJobs();
  delete jobs.docs;

  assert.throws(
    () =>
      promoteHostedMvpEvidence({
        input,
        output: path.join(root, "hosted.json"),
        revision,
        ref,
        runId,
        runUrl: "https://github.com/baicie/nexa-ui/actions/runs/123",
        jobs,
        proofDirectories: {
          "native-accessibility": hostedProofFixture(
            root,
            "native-accessibility",
            revision,
            ref,
            runId,
          ),
          "clean-package-launch": hostedProofFixture(
            root,
            "clean-package-launch",
            revision,
            ref,
            runId,
          ),
        },
      }),
    /jobs.*exactly.*docs/u,
  );
});

test("hosted promotion rejects every non-success conclusion for every current gate", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-gate-conclusion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const revision = "a".repeat(40);
  const ref = "refs/tags/v0.1.0";
  const runId = "123";
  const input = path.join(root, "local.json");
  collectMvpEvidence({
    output: input,
    revision,
    ref,
    sourceDirty: false,
    capturedAt: "2026-08-10T00:00:00.000Z",
    runner: successfulRunner(),
  });
  const proofDirectories = {
    "native-accessibility": hostedProofFixture(root, "native-accessibility", revision, ref, runId),
    "clean-package-launch": hostedProofFixture(root, "clean-package-launch", revision, ref, runId),
  };

  for (const { id } of gateDefinitions) {
    for (const conclusion of ["failure", "cancelled", "skipped"]) {
      const jobs = successfulGateJobs();
      jobs[id] = conclusion;
      assert.throws(
        () =>
          promoteHostedMvpEvidence({
            input,
            output: path.join(root, `${id}-${conclusion}.json`),
            revision,
            ref,
            runId,
            runUrl: "https://github.com/baicie/nexa-ui/actions/runs/123",
            jobs,
            proofDirectories,
          }),
        new RegExp(`${id}.*succeed`, "u"),
      );
    }
  }
});

test("hosted gate evidence rejects forged contracts and incomplete or reordered results", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-gate-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const revision = "a".repeat(40);
  const ref = "refs/tags/v0.1.0";
  const runId = "123";
  const local = path.join(root, "local.json");
  const output = path.join(root, "hosted.json");
  collectMvpEvidence({
    output: local,
    revision,
    ref,
    sourceDirty: false,
    capturedAt: "2026-08-10T00:00:00.000Z",
    runner: successfulRunner(),
  });
  const record = promoteHostedMvpEvidence({
    input: local,
    output,
    revision,
    ref,
    runId,
    runUrl: "https://github.com/baicie/nexa-ui/actions/runs/123",
    capturedAt: "2026-08-10T01:00:00.000Z",
    jobs: successfulGateJobs(),
    proofDirectories: {
      "native-accessibility": hostedProofFixture(
        root,
        "native-accessibility",
        revision,
        ref,
        runId,
      ),
      "clean-package-launch": hostedProofFixture(
        root,
        "clean-package-launch",
        revision,
        ref,
        runId,
      ),
    },
  });

  let fixtureNumber = 0;
  function tamperedRecord(mutator) {
    fixtureNumber += 1;
    const file = path.join(root, `tampered-${fixtureNumber}.json`);
    const tampered = structuredClone(record);
    mutator(tampered);
    writeFileSync(file, `${JSON.stringify(tampered, null, 2)}\n`);
    return file;
  }

  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.gates.results[4].conclusion = "failure";
        }),
        { revision },
      ),
    /gates.*docs.*conclusion/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.gates.results[4].producerWorkflow = ".github/workflows/typescript.yml";
        }),
        { revision },
      ),
    /gates.*docs.*producer workflow/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.gates.revision = "b".repeat(40);
        }),
        { revision },
      ),
    /gates.*revision/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.gates.runId = "456";
          evidence.gates.runUrl = "https://github.com/baicie/nexa-ui/actions/runs/456";
        }),
        { revision },
      ),
    /gates.*run identity/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.ref = "refs/tags/v0.2.0";
          evidence.gates.ref = "refs/tags/v0.2.0";
        }),
        { revision },
      ),
    /hosted proof source identity/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.gates.runId = "456";
          evidence.gates.runUrl = "https://github.com/baicie/nexa-ui/actions/runs/456";
          for (const entry of evidence.cases.slice(9)) {
            entry.hosted.runId = "456";
            entry.hosted.runUrl = "https://github.com/baicie/nexa-ui/actions/runs/456";
          }
        }),
        { revision },
      ),
    /hosted proof run identity/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          for (const entry of evidence.cases.slice(9)) {
            for (const platform of entry.hosted.platforms) platform.artifacts = [];
          }
        }),
        { revision },
      ),
    /artifacts.*hosted proof/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          const platform = evidence.cases[9].hosted.platforms[0];
          const forgedArtifact = {
            name: "unrelated-binary",
            size: 1,
            sha256: "0".repeat(64),
          };
          platform.artifacts = [forgedArtifact];
          platform.proof.payload.artifacts = [structuredClone(forgedArtifact)];
          platform.proof.sha256 = sha256(`${JSON.stringify(platform.proof.payload, null, 2)}\n`);
        }),
        { revision },
      ),
    /semantic accessibility client binary/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.cases[0].execution.exitStatus = 1;
          evidence.cases[0].status = "failed";
          evidence.cases[0].reason = "command exited with status 1";
        }),
        { revision },
      ),
    /gates.*N-01 through N-11.*pass/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.cases[9].hosted.platforms[0].artifacts[0].size += 1;
        }),
        { revision },
      ),
    /artifacts.*hosted proof/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.gates.results.splice(4, 1);
        }),
        { revision },
      ),
    /gates.*results.*seven/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          evidence.gates.results.push({
            id: "extra",
            producerWorkflow: ".github/workflows/extra.yml",
            conclusion: "success",
          });
        }),
        { revision },
      ),
    /gates.*results.*seven/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          [evidence.gates.results[0], evidence.gates.results[1]] = [
            evidence.gates.results[1],
            evidence.gates.results[0],
          ];
        }),
        { revision },
      ),
    /gates.*results\[0\].*typescript/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((evidence) => {
          const platform = evidence.cases[10].hosted.platforms[0];
          platform.proof.payload.runtimeProof.payload.probes[0].cases = ["N-06"];
          const runtimeBytes = `${JSON.stringify(
            platform.proof.payload.runtimeProof.payload,
            null,
            2,
          )}\n`;
          platform.proof.payload.runtimeProof.size = Buffer.byteLength(runtimeBytes);
          platform.proof.payload.runtimeProof.sha256 = sha256(runtimeBytes);
          platform.proof.sha256 = sha256(`${JSON.stringify(platform.proof.payload, null, 2)}\n`);
        }),
        { revision },
      ),
    /filesystem.*N-05.*N-06/u,
  );
});

test("hosted platform proof binds GitHub runner identity and exact artifact bytes", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-platform-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = path.join(root, "semantic-accessibility-smoke");
  const output = path.join(root, "native-accessibility-darwin-arm64.json");
  writeFileSync(artifact, "native accessibility client\n");
  const record = collectHostedMvpProof({
    output,
    gate: "native-accessibility",
    runner: "macos-15",
    artifacts: [artifact],
    environment: {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "baicie/nexa-ui",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_REF: "refs/tags/v0.1.0",
      GITHUB_RUN_ID: "123",
      GITHUB_JOB: "smoke",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "macOS",
      RUNNER_ARCH: "ARM64",
    },
  });
  assert.deepEqual(record.target, { platform: "darwin", arch: "arm64", runner: "macos-15" });
  assert.deepEqual(record.artifacts, [
    {
      name: "semantic-accessibility-smoke",
      size: Buffer.byteLength("native accessibility client\n"),
      sha256: sha256("native accessibility client\n"),
    },
  ]);

  assert.throws(
    () =>
      collectHostedMvpProof({
        output: path.join(root, "local.json"),
        gate: "native-accessibility",
        runner: "macos-15",
        artifacts: [artifact],
        environment: {},
      }),
    /GitHub Actions custody/u,
  );
});

test("collect records a failed local command instead of claiming static passed evidence", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "mvp-status.json");
  const calls = [];
  const runner = (request) => {
    calls.push(request);
    if (request.id === "N-06") {
      return {
        exitStatus: 17,
        stdout: "partial proof\n",
        stderr: "save assertion failed\n",
        durationMs: 23,
      };
    }
    return successfulRunner()(request);
  };

  const record = collectFixture(output, runner);
  const failed = record.cases.find(({ id }) => id === "N-06");
  assert.equal(calls.length, 9, "a failed case must not prevent later evidence collection");
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "command exited with status 17");
  assert.equal(failed.execution.exitStatus, 17);
  assert.equal(failed.execution.stderr.summary, "save assertion failed\n");
  assert.deepEqual(verifyMvpEvidence(output, { revision: "a".repeat(40) }), record);
});

test("collect stores bounded and digest-bound stdout and stderr summaries", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "mvp-status.json");
  const runner = (request) => ({
    exitStatus: 0,
    stdout: request.id === "N-01" ? "x".repeat(5_000) : "",
    stderr: request.id === "N-01" ? "y".repeat(6_000) : "",
    durationMs: 1,
  });

  const record = collectFixture(output, runner);
  const execution = record.cases[0].execution;
  assert.deepEqual([execution.stdout.bytes, execution.stdout.truncated], [5_000, true]);
  assert.deepEqual([execution.stderr.bytes, execution.stderr.truncated], [6_000, true]);
  assert.ok(Buffer.byteLength(execution.stdout.summary, "utf8") < execution.stdout.bytes);
  assert.ok(Buffer.byteLength(execution.stderr.summary, "utf8") < execution.stderr.bytes);
  assert.equal(execution.stdout.summarySha256, sha256(execution.stdout.summary));
  assert.equal(execution.stderr.summarySha256, sha256(execution.stderr.summary));
  assert.deepEqual(verifyMvpEvidence(output, { revision: "a".repeat(40) }), record);
});

test("MVP evidence rejects revision, command, status, and summary digest drift", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let fixtureNumber = 0;
  function tamperedRecord(mutator) {
    fixtureNumber += 1;
    const output = path.join(root, `${fixtureNumber}.json`);
    const record = collectFixture(output);
    mutator(record);
    writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
    return output;
  }

  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((record) => {
          record.revision = "b".repeat(40);
        }),
        { revision: "a".repeat(40) },
      ),
    /revision/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((record) => {
          record.cases[0].command = "node pretend-proof.mjs";
        }),
        { revision: "a".repeat(40) },
      ),
    /command/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((record) => {
          record.cases[0].execution.exitStatus = 1;
        }),
        { revision: "a".repeat(40) },
      ),
    /status.*exitStatus/u,
  );
  assert.throws(
    () =>
      verifyMvpEvidence(
        tamperedRecord((record) => {
          record.cases[0].execution.stdout.summary += "tampered";
        }),
        { revision: "a".repeat(40) },
      ),
    /stdout.*summarySha256/u,
  );
});

test("collect rejects malformed structured runner output", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-mvp-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      collectFixture(path.join(root, "mvp-status.json"), () => ({
        exitStatus: 0,
        stdout: "missing duration",
        stderr: "",
      })),
    /durationMs/u,
  );
});

test("hosted MVP workflow binds promotion to every quality, docs, and platform workflow", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/mvp-evidence.yml", import.meta.url), "utf8"),
  );
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.equal(workflow.permissions.actions, "read");
  assert.equal(workflow.jobs.typescript.uses, "./.github/workflows/typescript.yml");
  assert.equal(workflow.jobs.rust.uses, "./.github/workflows/rust.yml");
  assert.equal(workflow.jobs.ffi.uses, "./.github/workflows/ffi.yml");
  assert.equal(workflow.jobs.perry_frameworks.uses, "./.github/workflows/perry-frameworks.yml");
  assert.equal(workflow.jobs.docs.uses, "./.github/workflows/docs.yml");
  assert.equal(workflow.jobs.native_accessibility.uses, "./.github/workflows/native-smoke.yml");
  assert.equal(
    workflow.jobs.clean_package_launch.uses,
    "./.github/workflows/reference-notes-package.yml",
  );
  assert.deepEqual(workflow.jobs.promote.needs, [
    "local_cases",
    "typescript",
    "rust",
    "ffi",
    "perry_frameworks",
    "docs",
    "native_accessibility",
    "clean_package_launch",
  ]);
  assert.equal(workflow.jobs.promote.if, "always()");
  const localCommands = workflow.jobs.local_cases.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(localCommands, /mvp-evidence\.mjs collect/u);
  assert.match(localCommands, /mvp-evidence\.mjs verify/u);
  const promoteCommands = workflow.jobs.promote.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(promoteCommands, /mvp-evidence\.mjs promote-hosted/u);
  for (const [flag, job] of [
    ["typescript", "typescript"],
    ["rust", "rust"],
    ["ffi", "ffi"],
    ["perry", "perry_frameworks"],
    ["docs", "docs"],
    ["native", "native_accessibility"],
    ["package", "clean_package_launch"],
  ]) {
    assert.match(
      promoteCommands,
      new RegExp(`--${flag}-result "\\$\\{\\{ needs\\.${job}\\.result \\}\\}"`, "u"),
    );
  }
  assert.match(promoteCommands, /--native-proofs "\$RUNNER_TEMP\/mvp-hosted\/native"/u);
  assert.match(promoteCommands, /--package-proofs "\$RUNNER_TEMP\/mvp-hosted\/package"/u);
  const proofDownloads = workflow.jobs.promote.steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  for (const expected of [
    ["mvp-native-accessibility-*", "${{ runner.temp }}/mvp-hosted/native"],
    ["mvp-clean-package-launch-*", "${{ runner.temp }}/mvp-hosted/package"],
  ]) {
    const download = proofDownloads.find((step) => step.with?.pattern === expected[0]);
    assert.ok(download, `missing hosted proof download ${expected[0]}`);
    assert.equal(download.with.path, expected[1]);
    assert.equal(download.with["merge-multiple"], true);
  }
  const upload = workflow.jobs.promote.steps.find((step) => step.with?.name === "mvp-evidence");
  assert.equal(upload.with["if-no-files-found"], "error");

  const native = parseYaml(
    readFileSync(new URL("../.github/workflows/native-smoke.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(native.jobs.smoke.strategy.matrix.os, ["macos-15", "windows-2022"]);
  const nativeCommands = native.jobs.smoke.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(nativeCommands, /mvp-evidence\.mjs collect-hosted[\s\S]*native-accessibility/u);
  assert.ok(
    native.jobs.smoke.steps.some(
      (step) => step.with?.name === "mvp-native-accessibility-${{ runner.os }}-${{ runner.arch }}",
    ),
  );

  const packages = parseYaml(
    readFileSync(
      new URL("../.github/workflows/reference-notes-package.yml", import.meta.url),
      "utf8",
    ),
  );
  const packageCommands = packages.jobs.launch.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(packageCommands, /gate[:=]\s*"?clean-package-launch/u);
  assert.match(packageCommands, /shasum -a 256/u);
  assert.match(packageCommands, /ConvertTo-Json -Depth 12/u);
  assert.match(packageCommands, /runtimeProof/u);
  assert.ok(
    packages.jobs.launch.steps.some(
      (step) => step.with?.name === "mvp-clean-package-launch-${{ runner.os }}-${{ runner.arch }}",
    ),
  );
});

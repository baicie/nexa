import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  validateReferenceNotesNativeRuntimeProof,
  verifyReferenceNotesNativeRuntimeProof,
} from "./reference-notes-native-runtime-proof.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const REF_PATTERN = /^refs\/tags\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_STORED_SUMMARY_BYTES = MAX_SUMMARY_BYTES + 128;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const HOSTED_WORKFLOW = ".github/workflows/mvp-evidence.yml";
const MVP_GATES = Object.freeze(
  [
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
  ].map((gate) => Object.freeze(gate)),
);
const MVP_GATE_IDS = Object.freeze(MVP_GATES.map(({ id }) => id));
const MVP_GATE_PRODUCER_WORKFLOWS = Object.freeze(
  Object.fromEntries(MVP_GATES.map(({ id, producerWorkflow }) => [id, producerWorkflow])),
);
const HOSTED_GATE_IDS = Object.freeze(["native-accessibility", "clean-package-launch"]);
const HOSTED_PRODUCER_WORKFLOWS = Object.freeze(
  Object.fromEntries(HOSTED_GATE_IDS.map((id) => [id, MVP_GATE_PRODUCER_WORKFLOWS[id]])),
);
const HOSTED_TARGETS = Object.freeze([
  { platform: "darwin", arch: "arm64", runner: "macos-15", runnerOs: "macOS", runnerArch: "ARM64" },
  {
    platform: "win32",
    arch: "x64",
    runner: "windows-2022",
    runnerOs: "Windows",
    runnerArch: "X64",
  },
]);
const HOSTED_PROOF_SCHEMA = 1;
const CASE_IDS = Object.freeze(
  Array.from({ length: 11 }, (_, index) => `N-${String(index + 1).padStart(2, "0")}`),
);

const LOCAL_CASES = Object.freeze(
  [
    {
      id: "N-01",
      title: "Latin/CJK/Arabic/Emoji multiline editing",
      executable: "cargo",
      args: [
        "test",
        "-p",
        "nui-text",
        "--test",
        "multilingual_golden",
        "--test",
        "editable_text_property",
      ],
      evidence: "nui-text multilingual golden and editable-text property tests",
    },
    {
      id: "N-02",
      title: "Chinese IME update to commit",
      executable: "node",
      args: ["--test", "tools/reference-notes-journey.test.mjs"],
      evidence: "Notes TSX journey asserts preedit visibility and one committed value",
    },
    {
      id: "N-03",
      title: "Chinese IME update to cancel",
      executable: "node",
      args: ["--test", "tools/reference-notes-journey.test.mjs"],
      evidence: "Notes TSX journey asserts cancelled preedit restores committed text",
    },
    {
      id: "N-04",
      title: "Open dialog cancellation",
      executable: "node",
      args: ["--test", "tools/reference-notes-journey.test.mjs"],
      evidence: "Notes TSX journey invokes Open and resolves the dialog with null",
    },
    {
      id: "N-05",
      title: "Invalid UTF-8 open",
      executable: "node",
      args: ["--test", "tools/reference-notes-fs-runtime-smoke.test.mjs"],
      evidence:
        "FS runner contract preserves the document and exposes typed invalid-data error; hosted promotion additionally binds the native FS probe",
    },
    {
      id: "N-06",
      title: "Successful save",
      executable: "node",
      args: [
        "--test",
        "tools/reference-notes-journey.test.mjs",
        "tools/reference-notes-fs-runtime-smoke.test.mjs",
      ],
      evidence:
        "Notes journey and FS runner contract verify bytes, path, and dirty=false; hosted promotion additionally binds the native FS probe",
    },
    {
      id: "N-07",
      title: "Permission-denied save",
      executable: "node",
      args: ["--test", "tools/reference-notes-e2e.test.mjs"],
      evidence: "Notes E2E retains dirty state and preserves NexaSystemError diagnostics",
    },
    {
      id: "N-08",
      title: "Close while saving",
      executable: "node",
      args: ["--test", "tools/reference-notes-e2e.test.mjs", "tools/notes-app.test.mjs"],
      evidence: "Close race tests cancel the Task and discard late write completion",
    },
    {
      id: "N-09",
      title: "Suspend and resume",
      executable: "node",
      args: ["--test", "tools/reference-notes-journey.test.mjs", "tools/notes-app.test.mjs"],
      evidence: "Lifecycle tests preserve document state and settle pending work",
    },
  ].map((entry) => Object.freeze({ ...entry, args: Object.freeze(entry.args) })),
);

const BLOCKED_CASES = Object.freeze(
  [
    {
      id: "N-10",
      title: "Native accessibility client through AccessKit and Dispatcher",
      reason:
        "Windows UI Automation hosted runtime evidence is still required; local deterministic and macOS process smoke are not sufficient.",
      hostedJob: "native-accessibility",
      hostedEvidence:
        "macOS NSAccessibility and Windows UI Automation hosted accessibility clients succeeded",
    },
    {
      id: "N-11",
      title: "Clean package launch",
      reason:
        "Fresh macOS and Windows hosted artifact download, checksum, and five-second launch evidence is still required.",
      hostedJob: "clean-package-launch",
      hostedEvidence:
        "macOS and Windows clean jobs downloaded, verified, and launched packaged artifacts",
    },
  ].map((entry) => Object.freeze(entry)),
);

const CASES = Object.freeze([...LOCAL_CASES, ...BLOCKED_CASES]);

function fail(message) {
  throw new Error(`MVP evidence contract: ${message}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireRevision(value, label = "revision") {
  if (!REVISION_PATTERN.test(value ?? "")) fail(`${label} must be a full lowercase commit SHA`);
  return value;
}

function requireRef(value, label = "ref") {
  if (!REF_PATTERN.test(value ?? "")) fail(`${label} must be a release tag ref`);
  return value;
}

function regularFile(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch {
    fail(`${label} does not exist`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file`);
  return metadata;
}

function portableName(name, label) {
  requireString(name, label);
  if (path.basename(name) !== name || name.includes("\\") || /[\0\r\n]/u.test(name)) {
    fail(`${label} must be a portable file name`);
  }
  return name;
}

function hostedRunUrl(runId) {
  return `https://github.com/baicie/nexa-ui/actions/runs/${runId}`;
}

function validateHostedEnvironment(environment, gate) {
  if (environment.GITHUB_ACTIONS !== "true") {
    fail(`${gate} hosted proof requires GitHub Actions custody`);
  }
  if (environment.GITHUB_REPOSITORY !== "baicie/nexa-ui") {
    fail(`${gate} hosted proof requires baicie/nexa-ui custody`);
  }
  requireRevision(environment.GITHUB_SHA, `${gate} GITHUB_SHA`);
  requireRef(environment.GITHUB_REF, `${gate} GITHUB_REF`);
  if (!/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID ?? "")) {
    fail(`${gate} GITHUB_RUN_ID must be a positive integer`);
  }
  if (environment.RUNNER_ENVIRONMENT !== "github-hosted") {
    fail(`${gate} hosted proof requires a GitHub-hosted runner`);
  }
}

function hostedTarget(environment, gate) {
  const target = HOSTED_TARGETS.find(
    ({ runnerOs, runnerArch }) =>
      runnerOs === environment.RUNNER_OS && runnerArch === environment.RUNNER_ARCH,
  );
  if (!target) fail(`${gate} runner OS/architecture is not an approved MVP target`);
  return target;
}

function artifactProof(file, label) {
  const metadata = regularFile(file, label);
  const name = portableName(path.basename(file), `${label} name`);
  return { name, size: metadata.size, sha256: sha256(readFileSync(file)) };
}

function validateArtifactProof(artifact, label) {
  exactKeys(artifact, ["name", "size", "sha256"], label);
  portableName(artifact.name, `${label}.name`);
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    fail(`${label}.size must be a positive safe integer`);
  }
  if (!SHA256_PATTERN.test(artifact.sha256)) fail(`${label}.sha256 must be SHA-256`);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function commandFor(entry) {
  return [entry.executable, ...entry.args].join(" ");
}

function normalizeOutput(value, label) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return Buffer.from(value).toString("utf8");
  fail(`${label} must be a string or byte buffer`);
}

function summarizeOutput(value, label) {
  const output = normalizeOutput(value, label);
  const bytes = Buffer.from(output, "utf8");
  let summary = output;
  let truncated = false;
  if (bytes.length > MAX_SUMMARY_BYTES) {
    const retained = Math.floor(MAX_SUMMARY_BYTES / 2);
    const omitted = bytes.length - retained * 2;
    summary = `${bytes.subarray(0, retained).toString("utf8")}\n...[${omitted} bytes omitted]...\n${bytes.subarray(bytes.length - retained).toString("utf8")}`;
    truncated = true;
  }
  return {
    bytes: bytes.length,
    truncated,
    summary,
    summarySha256: sha256(summary),
  };
}

function defaultRunner({ executable, args }) {
  const started = process.hrtime.bigint();
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  const elapsed = process.hrtime.bigint() - started;
  const durationMs = Number((elapsed + 999_999n) / 1_000_000n);
  const processError = result.error ? `${result.error.name}: ${result.error.message}\n` : "";
  return {
    exitStatus: Number.isSafeInteger(result.status) && result.status >= 0 ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${processError}`,
    durationMs,
  };
}

function executionRecord(result, id) {
  exactKeys(result, ["durationMs", "exitStatus", "stderr", "stdout"], `${id} runner result`);
  if (!Number.isSafeInteger(result.exitStatus) || result.exitStatus < 0) {
    fail(`${id} runner result.exitStatus must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(result.durationMs) || result.durationMs < 0) {
    fail(`${id} runner result.durationMs must be a non-negative safe integer`);
  }
  return {
    exitStatus: result.exitStatus,
    durationMs: result.durationMs,
    stdout: summarizeOutput(result.stdout, `${id} runner result.stdout`),
    stderr: summarizeOutput(result.stderr, `${id} runner result.stderr`),
  };
}

function validateOutputSummary(output, label) {
  exactKeys(output, ["bytes", "summary", "summarySha256", "truncated"], label);
  if (!Number.isSafeInteger(output.bytes) || output.bytes < 0) {
    fail(`${label}.bytes must be a non-negative safe integer`);
  }
  if (typeof output.truncated !== "boolean") fail(`${label}.truncated must be boolean`);
  if (typeof output.summary !== "string") fail(`${label}.summary must be a string`);
  if (Buffer.byteLength(output.summary, "utf8") > MAX_STORED_SUMMARY_BYTES) {
    fail(`${label}.summary exceeds the stored summary limit`);
  }
  if (!SHA256_PATTERN.test(output.summarySha256)) fail(`${label}.summarySha256 must be SHA-256`);
  if (sha256(output.summary) !== output.summarySha256) {
    fail(`${label}.summarySha256 does not match the stored summary`);
  }
  if (!output.truncated && Buffer.byteLength(output.summary, "utf8") !== output.bytes) {
    fail(`${label}.bytes does not match the stored summary`);
  }
  if (output.truncated !== output.bytes > MAX_SUMMARY_BYTES) {
    fail(`${label}.truncated does not match the output byte count`);
  }
}

function validateExecution(execution, index) {
  const label = `cases[${index}].execution`;
  exactKeys(execution, ["durationMs", "exitStatus", "stderr", "stdout"], label);
  if (!Number.isSafeInteger(execution.exitStatus) || execution.exitStatus < 0) {
    fail(`${label}.exitStatus must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(execution.durationMs) || execution.durationMs < 0) {
    fail(`${label}.durationMs must be a non-negative safe integer`);
  }
  validateOutputSummary(execution.stdout, `${label}.stdout`);
  validateOutputSummary(execution.stderr, `${label}.stderr`);
}

function validateHostedProof(proof, { gate, revision, ref, runId, runUrl }) {
  const keys = [
    "artifacts",
    "gate",
    "job",
    "outcome",
    "producerWorkflow",
    "ref",
    "revision",
    "runId",
    "runUrl",
    "schemaVersion",
    "target",
    "workflow",
  ];
  if (gate === "clean-package-launch") keys.push("runtimeProof");
  exactKeys(proof, keys, `${gate} hosted proof`);
  if (proof.schemaVersion !== HOSTED_PROOF_SCHEMA || proof.gate !== gate) {
    fail(`${gate} hosted proof schema or gate is invalid`);
  }
  if (proof.outcome !== "passed") fail(`${gate} hosted proof outcome must be passed`);
  if (proof.workflow !== HOSTED_WORKFLOW) fail(`${gate} hosted proof workflow does not match`);
  if (proof.producerWorkflow !== HOSTED_PRODUCER_WORKFLOWS[gate]) {
    fail(`${gate} hosted proof producer workflow does not match`);
  }
  if (proof.revision !== revision || proof.ref !== ref) {
    fail(`${gate} hosted proof source identity does not match`);
  }
  if (proof.runId !== runId || proof.runUrl !== runUrl) {
    fail(`${gate} hosted proof run identity does not match`);
  }
  if (!/^[1-9][0-9]*$/u.test(proof.runId)) fail(`${gate} hosted proof runId is invalid`);
  if (!proof.runUrl.startsWith("https://") || proof.runUrl !== hostedRunUrl(proof.runId)) {
    fail(`${gate} hosted proof runUrl is invalid`);
  }
  exactKeys(proof.target, ["arch", "platform", "runner"], `${gate} hosted proof target`);
  const target = HOSTED_TARGETS.find(
    (candidate) =>
      candidate.platform === proof.target.platform &&
      candidate.arch === proof.target.arch &&
      candidate.runner === proof.target.runner,
  );
  if (!target) fail(`${gate} hosted proof target is not approved`);
  if (proof.job !== (gate === "native-accessibility" ? "smoke" : "launch")) {
    fail(`${gate} hosted proof job does not match`);
  }
  if (!Array.isArray(proof.artifacts) || proof.artifacts.length === 0) {
    fail(`${gate} hosted proof must include artifacts`);
  }
  const names = new Set();
  for (const [index, artifact] of proof.artifacts.entries()) {
    validateArtifactProof(artifact, `${gate} hosted proof artifacts[${index}]`);
    if (names.has(artifact.name)) fail(`${gate} hosted proof has duplicate artifacts`);
    names.add(artifact.name);
  }
  if (
    gate === "native-accessibility" &&
    (proof.artifacts.length !== 1 ||
      !/^semantic-accessibility-smoke(?:\.exe)?$/u.test(proof.artifacts[0].name))
  ) {
    fail("native-accessibility proof must bind the semantic accessibility client binary");
  }
  if (gate === "clean-package-launch") {
    for (const expected of ["generic.tar.gz", "reference-notes.tar.gz"]) {
      if (!names.has(expected)) fail(`${gate} hosted proof is missing ${expected}`);
    }
    if (names.size !== 2) fail(`${gate} hosted proof contains unexpected artifacts`);
    exactKeys(
      proof.runtimeProof,
      ["name", "payload", "sha256", "size"],
      `${gate} native runtime proof`,
    );
    const expectedRuntimeName = `reference-notes-native-runtime-${target.platform}-${target.arch}.json`;
    if (proof.runtimeProof.name !== expectedRuntimeName) {
      fail(`${gate} native runtime proof name does not match target`);
    }
    if (!Number.isSafeInteger(proof.runtimeProof.size) || proof.runtimeProof.size <= 0) {
      fail(`${gate} native runtime proof size must be a positive safe integer`);
    }
    if (!SHA256_PATTERN.test(proof.runtimeProof.sha256 ?? "")) {
      fail(`${gate} native runtime proof digest must be SHA-256`);
    }
    const runtimeBytes = canonicalJson(proof.runtimeProof.payload);
    if (
      Buffer.byteLength(runtimeBytes) !== proof.runtimeProof.size ||
      sha256(runtimeBytes) !== proof.runtimeProof.sha256
    ) {
      fail(`${gate} native runtime proof bytes do not match its binding`);
    }
    validateReferenceNotesNativeRuntimeProof(proof.runtimeProof.payload, {
      revision,
      ref,
      runId,
      target: proof.target,
    });
  }
  return proof;
}

function validateHosted(hosted, definition, revision, ref) {
  exactKeys(
    hosted,
    ["job", "platforms", "producerWorkflow", "revision", "runId", "runUrl", "workflow"],
    `${definition.id}.hosted`,
  );
  if (hosted.workflow !== HOSTED_WORKFLOW) fail(`${definition.id} hosted workflow does not match`);
  if (hosted.producerWorkflow !== HOSTED_PRODUCER_WORKFLOWS[definition.hostedJob]) {
    fail(`${definition.id} hosted producer workflow does not match`);
  }
  if (hosted.job !== definition.hostedJob) fail(`${definition.id} hosted job does not match`);
  if (!/^[1-9][0-9]*$/u.test(hosted.runId)) fail(`${definition.id} hosted runId is invalid`);
  if (!hosted.runUrl.startsWith("https://") || hosted.runUrl !== hostedRunUrl(hosted.runId)) {
    fail(`${definition.id} hosted runUrl is invalid`);
  }
  if (hosted.revision !== revision) fail(`${definition.id} hosted revision does not match`);
  if (!REF_PATTERN.test(ref)) fail(`${definition.id} hosted ref is invalid`);
  if (!Array.isArray(hosted.platforms) || hosted.platforms.length !== HOSTED_TARGETS.length) {
    fail(`${definition.id} hosted evidence must contain both platform proofs`);
  }
  const seen = new Set();
  for (const [index, platform] of hosted.platforms.entries()) {
    exactKeys(
      platform,
      ["arch", "artifacts", "job", "platform", "proof", "runner"],
      `${definition.id}.hosted.platforms[${index}]`,
    );
    const key = `${platform.platform}-${platform.arch}`;
    if (seen.has(key)) fail(`${definition.id} hosted evidence has duplicate target ${key}`);
    seen.add(key);
    const target = HOSTED_TARGETS.find(
      (candidate) => candidate.platform === platform.platform && candidate.arch === platform.arch,
    );
    if (!target || platform.runner !== target.runner) {
      fail(`${definition.id} hosted platform target is invalid`);
    }
    if (platform.job !== (definition.hostedJob === "native-accessibility" ? "smoke" : "launch")) {
      fail(`${definition.id} hosted platform job is invalid`);
    }
    exactKeys(
      platform.proof,
      ["name", "payload", "sha256"],
      `${definition.id} hosted platform proof`,
    );
    portableName(platform.proof.name, `${definition.id} hosted platform proof name`);
    if (!SHA256_PATTERN.test(platform.proof.sha256)) {
      fail(`${definition.id} hosted platform proof digest is invalid`);
    }
    const expectedProofName = `${definition.hostedJob}-${platform.platform}-${platform.arch}.json`;
    if (platform.proof.name !== expectedProofName) {
      fail(`${definition.id} hosted platform proof name does not match target`);
    }
    if (sha256(canonicalJson(platform.proof.payload)) !== platform.proof.sha256) {
      fail(`${definition.id} hosted platform proof digest does not match payload`);
    }
    validateHostedProof(platform.proof.payload, {
      gate: definition.hostedJob,
      revision,
      ref,
      runId: hosted.runId,
      runUrl: hosted.runUrl,
    });
    if (
      platform.proof.payload.target.platform !== platform.platform ||
      platform.proof.payload.target.arch !== platform.arch ||
      platform.proof.payload.target.runner !== platform.runner ||
      platform.proof.payload.job !== platform.job
    ) {
      fail(`${definition.id} hosted platform summary does not match hosted proof target`);
    }
    if (!isDeepStrictEqual(platform.artifacts, platform.proof.payload.artifacts)) {
      fail(`${definition.id} hosted platform artifacts do not match hosted proof payload`);
    }
    for (const [artifactIndex, artifact] of platform.artifacts.entries()) {
      validateArtifactProof(
        artifact,
        `${definition.id} hosted platforms[${index}].artifacts[${artifactIndex}]`,
      );
    }
  }
  for (const target of HOSTED_TARGETS) {
    if (!seen.has(`${target.platform}-${target.arch}`)) {
      fail(`${definition.id} hosted evidence is missing ${target.platform}-${target.arch}`);
    }
  }
}

function validateCase(entry, index, revision, recordRef) {
  exactKeys(
    entry,
    ["command", "evidence", "execution", "hosted", "id", "reason", "status", "title"],
    `cases[${index}]`,
  );
  const definition = CASES[index];
  if (entry.id !== CASE_IDS[index]) fail(`cases[${index}].id must be ${CASE_IDS[index]}`);
  if (entry.title !== definition.title) fail(`cases[${index}].title does not match ${entry.id}`);

  if (index < LOCAL_CASES.length) {
    const expectedCommand = commandFor(definition);
    if (entry.command !== expectedCommand)
      fail(`cases[${index}].command does not match ${entry.id}`);
    if (entry.evidence !== definition.evidence) {
      fail(`cases[${index}].evidence does not match ${entry.id}`);
    }
    if (entry.hosted !== null) fail(`cases[${index}].hosted must be null for local evidence`);
    validateExecution(entry.execution, index);
    const expectedStatus = entry.execution.exitStatus === 0 ? "passed" : "failed";
    if (entry.status !== expectedStatus) {
      fail(`cases[${index}].status does not match execution.exitStatus`);
    }
    const expectedReason =
      expectedStatus === "passed"
        ? null
        : `command exited with status ${entry.execution.exitStatus}`;
    if (entry.reason !== expectedReason) fail(`cases[${index}].reason does not match execution`);
    return;
  }

  if (entry.status === "blocked") {
    if (
      entry.command !== null ||
      entry.evidence !== null ||
      entry.execution !== null ||
      entry.hosted !== null
    ) {
      fail(
        `cases[${index}] blocked evidence cannot contain command, evidence, execution, or hosted proof`,
      );
    }
    if (entry.reason !== definition.reason)
      fail(`cases[${index}].reason does not match ${entry.id}`);
    return;
  }
  if (entry.status !== "passed") fail(`cases[${index}].status must be blocked or hosted passed`);
  if (entry.command !== null || entry.execution !== null || entry.reason !== null) {
    fail(`cases[${index}] hosted passed evidence cannot contain command, execution, or reason`);
  }
  if (entry.evidence !== definition.hostedEvidence) {
    fail(`cases[${index}].evidence does not match hosted ${entry.id}`);
  }
  validateHosted(entry.hosted, definition, revision, recordRef);
}

function validateGates(gates, record) {
  const hostedCases = record.cases.slice(LOCAL_CASES.length);
  if (gates === null) {
    if (hostedCases.some(({ status }) => status !== "blocked")) {
      fail("gates must be present for hosted promoted evidence");
    }
    return;
  }

  exactKeys(gates, ["ref", "results", "revision", "runId", "runUrl", "workflow"], "gates");
  if (record.sourceDirty) fail("gates require clean source evidence");
  if (record.cases.some(({ status }) => status !== "passed")) {
    fail("gates require N-01 through N-11 to pass");
  }
  if (gates.workflow !== HOSTED_WORKFLOW) fail("gates workflow does not match");
  if (gates.revision !== record.revision) fail("gates revision does not match record revision");
  if (gates.ref !== record.ref) fail("gates ref does not match record ref");
  if (!/^[1-9][0-9]*$/u.test(gates.runId ?? "")) fail("gates runId is invalid");
  if (gates.runUrl !== hostedRunUrl(gates.runId)) fail("gates runUrl is invalid");
  if (!Array.isArray(gates.results) || gates.results.length !== MVP_GATES.length) {
    fail("gates results must contain exactly seven current gates");
  }
  for (const [index, result] of gates.results.entries()) {
    const definition = MVP_GATES[index];
    exactKeys(result, ["conclusion", "id", "producerWorkflow"], `gates.results[${index}]`);
    if (result.id !== definition.id) {
      fail(`gates.results[${index}].id must be ${definition.id}`);
    }
    if (result.producerWorkflow !== definition.producerWorkflow) {
      fail(`gates.results[${index}] ${definition.id} producer workflow does not match`);
    }
    if (result.conclusion !== "success") {
      fail(`gates.results[${index}] ${definition.id} conclusion must be success`);
    }
  }
  for (const entry of hostedCases) {
    if (
      entry.hosted.workflow !== gates.workflow ||
      entry.hosted.revision !== gates.revision ||
      entry.hosted.runId !== gates.runId ||
      entry.hosted.runUrl !== gates.runUrl
    ) {
      fail("gates run identity does not match hosted case evidence");
    }
  }
}

export function validateMvpEvidence(record, { revision } = {}) {
  exactKeys(
    record,
    ["capturedAt", "cases", "gates", "product", "ref", "revision", "schemaVersion", "sourceDirty"],
    "record",
  );
  if (record.schemaVersion !== 5) fail("schemaVersion must be 5");
  if (record.product !== "desktop-notes-mvp") fail("product must be desktop-notes-mvp");
  if (!REVISION_PATTERN.test(record.revision)) fail("revision must be a full lowercase commit SHA");
  if (revision !== undefined && record.revision !== revision)
    fail(`revision does not match ${revision}`);
  if (record.sourceDirty !== true && record.sourceDirty !== false)
    fail("sourceDirty must be boolean");
  if (record.sourceDirty ? record.ref !== "WORKTREE" : !REF_PATTERN.test(record.ref)) {
    fail("ref must be WORKTREE for dirty evidence or a version tag for clean evidence");
  }
  requireString(record.capturedAt, "capturedAt");
  if (Number.isNaN(Date.parse(record.capturedAt))) fail("capturedAt must be an ISO timestamp");
  if (!Array.isArray(record.cases) || record.cases.length !== CASE_IDS.length) {
    fail("cases must contain N-01 through N-11");
  }
  record.cases.forEach((entry, index) => validateCase(entry, index, record.revision, record.ref));
  validateGates(record.gates, record);
  return record;
}

export function collectMvpEvidence({
  output,
  revision = git(["rev-parse", "HEAD"]),
  ref = process.env.GITHUB_REF || "WORKTREE",
  sourceDirty = git(["status", "--porcelain"]) !== "",
  capturedAt = new Date().toISOString(),
  runner = defaultRunner,
} = {}) {
  requireString(output, "output");
  if (typeof runner !== "function") fail("runner must be a function");
  const localCases = LOCAL_CASES.map((definition) => {
    const command = commandFor(definition);
    const execution = executionRecord(
      runner({
        id: definition.id,
        command,
        executable: definition.executable,
        args: [...definition.args],
        cwd: ROOT,
      }),
      definition.id,
    );
    const passed = execution.exitStatus === 0;
    return {
      id: definition.id,
      title: definition.title,
      status: passed ? "passed" : "failed",
      command,
      evidence: definition.evidence,
      reason: passed ? null : `command exited with status ${execution.exitStatus}`,
      execution,
      hosted: null,
    };
  });
  const blockedCases = BLOCKED_CASES.map((definition) => ({
    id: definition.id,
    title: definition.title,
    status: "blocked",
    command: null,
    evidence: null,
    reason: definition.reason,
    execution: null,
    hosted: null,
  }));
  const record = {
    schemaVersion: 5,
    product: "desktop-notes-mvp",
    revision,
    ref,
    sourceDirty,
    capturedAt,
    gates: null,
    cases: [...localCases, ...blockedCases],
  };
  validateMvpEvidence(record);
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return record;
}

export function collectHostedMvpProof({
  output,
  gate,
  runner,
  artifacts,
  runtimeProof,
  environment = process.env,
} = {}) {
  requireString(output, "output");
  if (!Object.hasOwn(HOSTED_PRODUCER_WORKFLOWS, gate)) fail("unknown hosted MVP gate");
  validateHostedEnvironment(environment, gate);
  const target = hostedTarget(environment, gate);
  if (runner !== target.runner) fail(`${gate} runner does not match ${target.runner}`);
  const expectedJob = gate === "native-accessibility" ? "smoke" : "launch";
  if (environment.GITHUB_JOB !== expectedJob) {
    fail(`${gate} GITHUB_JOB must be ${expectedJob}`);
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    fail(`${gate} artifacts must be a non-empty array`);
  }
  const artifactRecords = artifacts
    .map((file, index) => artifactProof(path.resolve(file), `${gate} artifact ${index}`))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (new Set(artifactRecords.map(({ name }) => name)).size !== artifactRecords.length) {
    fail(`${gate} artifacts must have unique file names`);
  }
  let runtimeProofRecord;
  if (gate === "clean-package-launch") {
    requireString(runtimeProof, "clean-package-launch runtimeProof");
    const runtimeFile = path.resolve(runtimeProof);
    const runtimeMetadata = regularFile(runtimeFile, "clean-package-launch runtime proof");
    const payload = verifyReferenceNotesNativeRuntimeProof(runtimeFile, {
      revision: environment.GITHUB_SHA,
      ref: environment.GITHUB_REF,
      runId: environment.GITHUB_RUN_ID,
      target: { platform: target.platform, arch: target.arch, runner: target.runner },
    });
    const runtimeBytes = readFileSync(runtimeFile);
    runtimeProofRecord = {
      name: path.basename(runtimeFile),
      size: runtimeMetadata.size,
      sha256: sha256(runtimeBytes),
      payload,
    };
  } else if (runtimeProof !== undefined) {
    fail(`${gate} does not accept a native runtime proof`);
  }
  const record = {
    schemaVersion: HOSTED_PROOF_SCHEMA,
    gate,
    outcome: "passed",
    revision: environment.GITHUB_SHA,
    ref: environment.GITHUB_REF,
    workflow: HOSTED_WORKFLOW,
    producerWorkflow: HOSTED_PRODUCER_WORKFLOWS[gate],
    runId: environment.GITHUB_RUN_ID,
    runUrl: hostedRunUrl(environment.GITHUB_RUN_ID),
    job: expectedJob,
    target: { platform: target.platform, arch: target.arch, runner: target.runner },
    artifacts: artifactRecords,
    ...(runtimeProofRecord === undefined ? {} : { runtimeProof: runtimeProofRecord }),
  };
  validateHostedProof(record, {
    gate,
    revision: record.revision,
    ref: record.ref,
    runId: record.runId,
    runUrl: record.runUrl,
  });
  const destination = path.resolve(output);
  if (existsSync(destination)) fail("hosted proof output already exists");
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return record;
}

function loadHostedProofDirectory({ directory, gate, revision, ref, runId, runUrl }) {
  requireString(directory, `${gate} proof directory`);
  const root = path.resolve(directory);
  let metadata;
  try {
    metadata = lstatSync(root);
  } catch {
    fail(`${gate} proof directory does not exist`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${gate} proof directory must be a regular directory`);
  }
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
  if (entries.length !== HOSTED_TARGETS.length) {
    fail(`${gate} proof directory must contain exactly two platform proofs`);
  }
  const proofs = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
      fail(`${gate} proof directory contains an unexpected entry`);
    }
    const file = path.join(root, entry.name);
    regularFile(file, `${gate} platform proof`);
    let proof;
    let proofBytes;
    try {
      proofBytes = readFileSync(file, "utf8");
      proof = JSON.parse(proofBytes);
    } catch (error) {
      fail(`${gate} platform proof is invalid JSON: ${error.message}`);
    }
    validateHostedProof(proof, { gate, revision, ref, runId, runUrl });
    if (proofBytes !== canonicalJson(proof)) {
      fail(`${gate} platform proof must use canonical JSON encoding`);
    }
    const expectedName = `${gate}-${proof.target.platform}-${proof.target.arch}.json`;
    if (entry.name !== expectedName) fail(`${gate} platform proof file name does not match target`);
    proofs.push({ file, name: entry.name, proof });
  }
  const byTarget = new Map(
    proofs.map((entry) => [`${entry.proof.target.platform}-${entry.proof.target.arch}`, entry]),
  );
  return HOSTED_TARGETS.map((target) => {
    const entry = byTarget.get(`${target.platform}-${target.arch}`);
    if (!entry) fail(`${gate} proof directory is missing ${target.platform}-${target.arch}`);
    return {
      platform: target.platform,
      arch: target.arch,
      runner: target.runner,
      job: entry.proof.job,
      artifacts: structuredClone(entry.proof.artifacts),
      proof: {
        name: entry.name,
        sha256: sha256(readFileSync(entry.file)),
        payload: entry.proof,
      },
    };
  });
}

export function promoteHostedMvpEvidence({
  input,
  output,
  revision,
  ref,
  runId,
  runUrl,
  jobs,
  proofDirectories,
  capturedAt = new Date().toISOString(),
} = {}) {
  requireString(input, "input");
  requireString(output, "output");
  requireRevision(revision);
  requireRef(ref);
  requireString(runId, "runId");
  requireString(runUrl, "runUrl");
  if (!/^[1-9][0-9]*$/u.test(runId)) fail("runId must be a positive integer");
  if (runUrl !== hostedRunUrl(runId)) fail("runUrl does not match runId");
  let local;
  try {
    local = JSON.parse(readFileSync(input, "utf8"));
  } catch (error) {
    fail(`cannot read local evidence: ${error.message}`);
  }
  validateMvpEvidence(local, { revision });
  if (local.sourceDirty || local.ref !== ref || !REF_PATTERN.test(ref ?? "")) {
    fail("hosted promotion requires clean tag evidence");
  }
  if (
    local.gates !== null ||
    local.cases.slice(LOCAL_CASES.length).some(({ status }) => status !== "blocked")
  ) {
    fail("hosted promotion requires unpromoted local evidence");
  }
  if (local.cases.slice(0, LOCAL_CASES.length).some(({ status }) => status !== "passed")) {
    fail("hosted promotion requires every local case to pass");
  }
  exactKeys(jobs, MVP_GATE_IDS, "jobs");
  for (const { id } of MVP_GATES) {
    if (jobs[id] !== "success") fail(`hosted promotion requires ${id} to succeed`);
  }
  exactKeys(proofDirectories, ["clean-package-launch", "native-accessibility"], "proofDirectories");
  const platformProofs = Object.fromEntries(
    BLOCKED_CASES.map((definition) => [
      definition.hostedJob,
      loadHostedProofDirectory({
        directory: proofDirectories[definition.hostedJob],
        gate: definition.hostedJob,
        revision,
        ref,
        runId,
        runUrl,
      }),
    ]),
  );
  const promoted = structuredClone(local);
  promoted.capturedAt = capturedAt;
  promoted.gates = {
    workflow: HOSTED_WORKFLOW,
    runId,
    runUrl,
    revision,
    ref,
    results: MVP_GATES.map(({ id, producerWorkflow }) => ({
      id,
      producerWorkflow,
      conclusion: jobs[id],
    })),
  };
  promoted.cases = [
    ...promoted.cases.slice(0, LOCAL_CASES.length),
    ...BLOCKED_CASES.map((definition) => ({
      id: definition.id,
      title: definition.title,
      status: "passed",
      command: null,
      evidence: definition.hostedEvidence,
      reason: null,
      execution: null,
      hosted: {
        workflow: HOSTED_WORKFLOW,
        producerWorkflow: HOSTED_PRODUCER_WORKFLOWS[definition.hostedJob],
        job: definition.hostedJob,
        runId,
        runUrl,
        revision,
        platforms: platformProofs[definition.hostedJob],
      },
    })),
  ];
  validateMvpEvidence(promoted, { revision });
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(promoted, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return promoted;
}

export function verifyMvpEvidence(file, { revision = git(["rev-parse", "HEAD"]) } = {}) {
  requireString(file, "file");
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read evidence: ${error.message}`);
  }
  return validateMvpEvidence(record, { revision });
}

function parseCliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) fail("CLI options must be --name value pairs");
    if (Object.hasOwn(options, flag)) fail(`duplicate CLI option ${flag}`);
    options[flag] = value;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = "collect", ...arguments_] = process.argv.slice(2);
  try {
    if (command === "collect") {
      const file = arguments_[0] ?? "release/mvp-evidence.json";
      collectMvpEvidence({ output: path.resolve(ROOT, file) });
      console.log(`MVP evidence collected at ${file}`);
    } else if (command === "verify") {
      const file = arguments_[0] ?? "release/mvp-evidence.json";
      verifyMvpEvidence(path.resolve(ROOT, file));
      console.log(`MVP evidence verified at ${file}`);
    } else if (command === "collect-hosted") {
      const options = parseCliOptions(arguments_);
      const artifacts = options["--artifacts"]?.split(",").filter(Boolean);
      collectHostedMvpProof({
        output: path.resolve(options["--output"]),
        gate: options["--gate"],
        runner: options["--runner"],
        artifacts,
        runtimeProof: options["--runtime-proof"],
      });
      console.log(`Hosted MVP proof collected at ${options["--output"]}`);
    } else if (command === "promote-hosted") {
      const options = parseCliOptions(arguments_);
      promoteHostedMvpEvidence({
        input: path.resolve(options["--input"]),
        output: path.resolve(options["--output"]),
        revision: options["--revision"],
        ref: options["--ref"],
        runId: options["--run-id"],
        runUrl: options["--run-url"],
        jobs: {
          typescript: options["--typescript-result"],
          rust: options["--rust-result"],
          ffi: options["--ffi-result"],
          "perry-frameworks": options["--perry-result"],
          docs: options["--docs-result"],
          "native-accessibility": options["--native-result"],
          "clean-package-launch": options["--package-result"],
        },
        proofDirectories: {
          "native-accessibility": path.resolve(options["--native-proofs"]),
          "clean-package-launch": path.resolve(options["--package-proofs"]),
        },
      });
      console.log(`Hosted MVP evidence promoted at ${options["--output"]}`);
    } else {
      throw new Error(
        "usage: node tools/mvp-evidence.mjs collect|verify [FILE] | collect-hosted --gate GATE --runner RUNNER --artifacts FILE[,FILE...] [--runtime-proof FILE] --output FILE | promote-hosted --input FILE --output FILE --revision SHA --ref TAG --run-id ID --run-url URL --typescript-result RESULT --rust-result RESULT --ffi-result RESULT --perry-result RESULT --docs-result RESULT --native-result RESULT --package-result RESULT --native-proofs DIR --package-proofs DIR",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

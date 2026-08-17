import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const REF_PATTERN = /^refs\/tags\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const PRODUCER_WORKFLOW = ".github/workflows/reference-notes-package.yml";
const TARGETS = Object.freeze([
  {
    platform: "darwin",
    arch: "arm64",
    runner: "macos-15",
    runnerOs: "macOS",
    runnerArch: "ARM64",
    suffix: "",
  },
  {
    platform: "win32",
    arch: "x64",
    runner: "windows-2022",
    runnerOs: "Windows",
    runnerArch: "X64",
    suffix: ".exe",
  },
]);
const PROBE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "filesystem",
    command: "pnpm --filter @nexa/example-reference-notes smoke:fs",
    gate: "MVP",
    cases: Object.freeze(["N-05", "N-06"]),
    journey: Object.freeze(["invalid-utf8", "save"]),
    assertions: Object.freeze([
      "native-system-host-task-promise",
      "invalid-utf8-preserves-controller-state",
      "saved-bytes-match-and-state-clean",
    ]),
    binary: "reference-notes-fs-runtime-smoke",
  }),
  Object.freeze({
    id: "real-picker",
    command: "pnpm --filter @nexa/example-reference-notes smoke:picker",
    gate: "G5-04P",
    cases: Object.freeze(["N-04"]),
    journey: Object.freeze(["save", "open", "cancel"]),
    assertions: Object.freeze([
      "fixture-free-compiled-binary",
      "native-dialog-task-promise",
      "save-open-cancel-controller-and-disk-journey",
    ]),
    binary: "reference-notes-dialog-picker-smoke",
  }),
]);

function fail(message) {
  throw new Error(`Reference Notes native runtime proof: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireRevision(value, label = "revision") {
  if (!REVISION_PATTERN.test(value ?? "")) fail(`${label} must be a full commit SHA`);
  return value;
}

function requireRef(value, label = "ref") {
  if (!REF_PATTERN.test(value ?? "")) fail(`${label} must be a release tag ref`);
  return value;
}

function requireRunId(value, label = "runId") {
  const normalized = String(value ?? "");
  if (!RUN_ID_PATTERN.test(normalized)) fail(`${label} must be a positive integer`);
  return normalized;
}

function regularFile(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch {
    fail(`${label} is missing: ${file}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  return metadata;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function targetFromEnvironment(environment) {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_REPOSITORY !== "baicie/nexa-ui" ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted"
  ) {
    fail("collection requires baicie/nexa-ui GitHub Actions hosted custody");
  }
  if (environment.GITHUB_JOB !== "package") fail("collection must run in the package job");
  const target = TARGETS.find(
    ({ runnerOs, runnerArch }) =>
      runnerOs === environment.RUNNER_OS && runnerArch === environment.RUNNER_ARCH,
  );
  if (!target) fail("runner OS and architecture are not an approved runtime proof target");
  return target;
}

function normalizedTarget(target) {
  exactKeys(target, ["platform", "arch", "runner"], "target");
  const approved = TARGETS.find(
    ({ platform, arch, runner }) =>
      platform === target.platform && arch === target.arch && runner === target.runner,
  );
  if (!approved) fail("target is not an approved runtime proof target");
  return approved;
}

function executableProof(file, expectedName, label) {
  const metadata = regularFile(file, label);
  if (path.basename(file) !== expectedName) fail(`${label} must be named ${expectedName}`);
  const bytes = readFileSync(file);
  if (bytes.length === 0) fail(`${label} must not be empty`);
  return { name: expectedName, size: metadata.size, sha256: sha256(bytes) };
}

function expectedProbe(definition, executable) {
  return {
    id: definition.id,
    command: definition.command,
    gate: definition.gate,
    cases: [...definition.cases],
    journey: [...definition.journey],
    assertions: [...definition.assertions],
    executable,
  };
}

function validateExecutable(executable, expectedName, label) {
  exactKeys(executable, ["name", "size", "sha256"], `${label} executable`);
  if (executable.name !== expectedName) fail(`${label} executable name must be ${expectedName}`);
  if (!Number.isSafeInteger(executable.size) || executable.size <= 0) {
    fail(`${label} executable size must be a positive safe integer`);
  }
  if (!SHA256_PATTERN.test(executable.sha256 ?? "")) {
    fail(`${label} executable digest must be SHA-256`);
  }
}

export function validateReferenceNotesNativeRuntimeProof(
  proof,
  { revision, ref, runId, target, expectedExecutables } = {},
) {
  exactKeys(
    proof,
    [
      "schemaVersion",
      "outcome",
      "revision",
      "ref",
      "producerWorkflow",
      "runId",
      "runUrl",
      "job",
      "target",
      "probes",
    ],
    "proof",
  );
  if (proof.schemaVersion !== 1 || proof.outcome !== "passed") {
    fail("proof schema or outcome is invalid");
  }
  requireRevision(proof.revision);
  requireRef(proof.ref);
  const normalizedRunId = requireRunId(proof.runId);
  const expectedRunUrl = `https://github.com/baicie/nexa-ui/actions/runs/${normalizedRunId}`;
  if (proof.runUrl !== expectedRunUrl) fail("proof run identity is invalid");
  if (proof.producerWorkflow !== PRODUCER_WORKFLOW || proof.job !== "package") {
    fail("proof producer workflow or job is invalid");
  }
  const approvedTarget = normalizedTarget(proof.target);
  if (revision !== undefined && proof.revision !== revision) fail("proof revision does not match");
  if (ref !== undefined && proof.ref !== ref) fail("proof ref does not match");
  if (runId !== undefined && proof.runId !== String(runId))
    fail("proof run identity does not match");
  if (
    target !== undefined &&
    (proof.target.platform !== target.platform ||
      proof.target.arch !== target.arch ||
      proof.target.runner !== target.runner)
  ) {
    fail("proof target does not match");
  }
  if (!Array.isArray(proof.probes) || proof.probes.length !== PROBE_DEFINITIONS.length) {
    fail("proof must contain filesystem and real-picker probes");
  }
  for (const [index, definition] of PROBE_DEFINITIONS.entries()) {
    const probe = proof.probes[index];
    exactKeys(
      probe,
      ["id", "command", "gate", "cases", "journey", "assertions", "executable"],
      `probes[${index}]`,
    );
    const expectedName = `${definition.binary}${approvedTarget.suffix}`;
    validateExecutable(probe.executable, expectedName, definition.id);
    const expected = expectedProbe(definition, probe.executable);
    if (JSON.stringify(probe) !== JSON.stringify(expected)) {
      if (definition.id === "filesystem") {
        fail("filesystem probe must cover N-05 and N-06 with the native invalid-UTF8/save journey");
      }
      fail("real-picker probe must cover G5-04P save/open/cancel with N-04 cancellation");
    }
    const expectedFile = expectedExecutables?.[definition.id];
    if (expectedFile !== undefined) {
      const actual = executableProof(expectedFile, expectedName, `${definition.id} binary`);
      if (actual.size !== probe.executable.size || actual.sha256 !== probe.executable.sha256) {
        fail(`${definition.id} executable digest or size does not match the proof`);
      }
    }
  }
  return proof;
}

export function collectReferenceNotesNativeRuntimeProof({
  output,
  filesystemBinary,
  pickerBinary,
  environment = process.env,
}) {
  requireString(output, "output");
  if (existsSync(output)) fail(`output already exists: ${output}`);
  const target = targetFromEnvironment(environment);
  const revision = requireRevision(environment.GITHUB_SHA, "GITHUB_SHA");
  const ref = requireRef(environment.GITHUB_REF, "GITHUB_REF");
  const runId = requireRunId(environment.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const proof = {
    schemaVersion: 1,
    outcome: "passed",
    revision,
    ref,
    producerWorkflow: PRODUCER_WORKFLOW,
    runId,
    runUrl: `https://github.com/baicie/nexa-ui/actions/runs/${runId}`,
    job: "package",
    target: { platform: target.platform, arch: target.arch, runner: target.runner },
    probes: [
      expectedProbe(
        PROBE_DEFINITIONS[0],
        executableProof(
          filesystemBinary,
          `${PROBE_DEFINITIONS[0].binary}${target.suffix}`,
          "filesystem binary",
        ),
      ),
      expectedProbe(
        PROBE_DEFINITIONS[1],
        executableProof(
          pickerBinary,
          `${PROBE_DEFINITIONS[1].binary}${target.suffix}`,
          "real-picker binary",
        ),
      ),
    ],
  };
  validateReferenceNotesNativeRuntimeProof(proof, {
    revision,
    ref,
    runId,
    target: proof.target,
    expectedExecutables: {
      filesystem: filesystemBinary,
      "real-picker": pickerBinary,
    },
  });
  writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
  return proof;
}

export function verifyReferenceNotesNativeRuntimeProof(file, expected = {}) {
  regularFile(file, "runtime proof");
  const bytes = readFileSync(file, "utf8");
  let proof;
  try {
    proof = JSON.parse(bytes);
  } catch (error) {
    fail(`runtime proof is invalid JSON: ${error.message}`);
  }
  if (bytes !== `${JSON.stringify(proof, null, 2)}\n`) fail("runtime proof is not canonical JSON");
  return validateReferenceNotesNativeRuntimeProof(proof, expected);
}

function parseOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      fail("arguments must be --name value pairs");
    }
    if (Object.hasOwn(options, name)) fail(`duplicate option: ${name}`);
    options[name] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseOptions(arguments_);
  if (command === "collect") {
    const result = collectReferenceNotesNativeRuntimeProof({
      output: path.resolve(required(options, "--output")),
      filesystemBinary: path.resolve(required(options, "--filesystem")),
      pickerBinary: path.resolve(required(options, "--picker")),
    });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "verify") {
    const result = verifyReferenceNotesNativeRuntimeProof(
      path.resolve(required(options, "--input")),
      {
        revision: options["--revision"],
        ref: options["--ref"],
        runId: options["--run-id"],
      },
    );
    console.log(JSON.stringify(result));
    return;
  }
  fail("usage: reference-notes-native-runtime-proof.mjs collect|verify --name value ...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

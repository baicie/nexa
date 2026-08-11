import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEvidenceRecord,
  evaluateReleaseReadiness,
  releaseReadinessPhase,
  validateReleaseReadinessPolicy,
} from "./release-readiness.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULT_POLICY = path.join(ROOT, "release", "readiness-policy.json");
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const REF_PATTERN = /^refs\/tags\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const PORTABLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const READINESS_GATE_WORKFLOWS = Object.freeze({
  mvp: ".github/workflows/mvp-evidence.yml",
  contracts: ".github/workflows/release-rehearsal.yml",
  security: ".github/workflows/release-rehearsal.yml",
  performance: ".github/workflows/release-rehearsal.yml",
  consumer: ".github/workflows/release-rehearsal.yml",
  signing: ".github/workflows/signing.yml",
  rehearsal: ".github/workflows/release-rehearsal.yml",
  registry: ".github/workflows/registry-evidence.yml",
});

const GATE_EVENTS = Object.freeze({
  mvp: new Set(["workflow_dispatch"]),
  contracts: new Set(["workflow_dispatch", "push"]),
  security: new Set(["workflow_dispatch", "push"]),
  performance: new Set(["workflow_dispatch", "push"]),
  consumer: new Set(["workflow_dispatch", "push"]),
  signing: new Set(["workflow_dispatch"]),
  rehearsal: new Set(["workflow_dispatch", "push"]),
  registry: new Set(["workflow_dispatch"]),
});

function fail(message) {
  throw new Error(`Release readiness bundle contract: ${message}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function regularFile(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    fail(`${label} does not exist: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file`);
  return file;
}

function resolveRelativeFile(root, relative, label) {
  requireString(relative, label);
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a root-relative portable path`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail(`${label} escapes its root`);
  return regularFile(resolved, label);
}

function directoriesOverlap(left, right) {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  if (relative === "") return true;
  if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    return true;
  }
  const reverse = path.relative(path.resolve(right), path.resolve(left));
  return !reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse);
}

export function validateGitHubRun({ run, label = "GitHub run", revision, workflow, events }) {
  if (!run || typeof run !== "object" || Array.isArray(run)) fail(`${label} must be an object`);
  if (!REVISION_PATTERN.test(revision ?? "")) fail("revision must be a full lowercase commit SHA");
  requireString(workflow, `${label} expected workflow`);
  if (
    !Array.isArray(events) ||
    events.length === 0 ||
    events.some((event) => !GATE_EVENTS.rehearsal.has(event))
  ) {
    fail(`${label} expected events are invalid`);
  }
  if (run.path !== workflow) {
    fail(`${label} workflow path must be ${workflow}`);
  }
  if (run.head_sha !== revision) fail(`${label} head SHA must be ${revision}`);
  if (run.conclusion !== "success") fail(`${label} conclusion must be success`);
  if (!events.includes(run.event)) fail(`${label} event is not allowed`);
  if (!Number.isSafeInteger(Number(run.id)) || Number(run.id) <= 0) {
    fail(`${label} id must be a positive integer`);
  }
  requireString(run.html_url, `${label} html_url`);
  if (!run.html_url.startsWith("https://")) fail(`${label} html_url must use HTTPS`);
  return run;
}

function validateRun(run, gate, revision) {
  return validateGitHubRun({
    run,
    label: `${gate} run`,
    revision,
    workflow: READINESS_GATE_WORKFLOWS[gate],
    events: [...GATE_EVENTS[gate]],
  });
}

export function createRunEvidenceRecord({
  gate,
  revision,
  ref,
  proofFile,
  proofArtifact,
  runJob,
  run,
  capturedAt,
}) {
  if (!Object.hasOwn(READINESS_GATE_WORKFLOWS, gate)) fail(`unknown gate ${String(gate)}`);
  if (!REVISION_PATTERN.test(revision ?? "")) fail("revision must be a full lowercase commit SHA");
  if (!REF_PATTERN.test(ref ?? "")) fail("ref must be a version tag ref");
  regularFile(path.resolve(requireString(proofFile, "proofFile")), `${gate} proof file`);
  requireString(proofArtifact, `${gate} proofArtifact`);
  validateRun(run, gate, revision);
  return createEvidenceRecord({
    gate,
    revision,
    ref,
    sourceKind: "github-actions",
    sourceUrl: run.html_url,
    artifact: proofArtifact,
    artifactSha256: sha256(path.resolve(proofFile)),
    runId: String(run.id),
    runJob,
    runUrl: run.html_url,
    runWorkflow: run.path,
    runEvent: run.event,
    runConclusion: run.conclusion,
    capturedAt,
  });
}

export function assembleReadinessBundle({
  sourceDirectory,
  outputDirectory,
  revision,
  ref,
  phase = "final",
  policyPath = DEFAULT_POLICY,
}) {
  if (!REVISION_PATTERN.test(revision ?? "")) fail("revision must be a full lowercase commit SHA");
  if (!REF_PATTERN.test(ref ?? "")) fail("ref must be a version tag ref");
  const source = path.resolve(requireString(sourceDirectory, "sourceDirectory"));
  const output = path.resolve(requireString(outputDirectory, "outputDirectory"));
  const sourceMetadata = lstatSync(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    fail("sourceDirectory must be a regular directory");
  }
  if (existsSync(output)) fail("outputDirectory already exists");
  if (directoriesOverlap(source, output))
    fail("sourceDirectory and outputDirectory must not overlap");

  const policy = structuredClone(
    validateReleaseReadinessPolicy(readJson(path.resolve(policyPath), "base readiness policy")),
  );
  const phasePolicy = releaseReadinessPhase(policy, phase);
  if (policy.execution.state !== "disabled") fail("base readiness policy must remain disabled");
  if (policy.execution.phase !== "none") fail("base readiness policy phase must remain none");
  if (policy.source.requiredRef !== ref)
    fail(`base readiness policy requires ${policy.source.requiredRef}`);
  for (const gate of Object.keys(READINESS_GATE_WORKFLOWS)) {
    if (policy.evidence[gate].status !== "pending") {
      fail(`base readiness policy ${gate} evidence must remain pending`);
    }
  }

  const parent = path.dirname(output);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, ".nexa-readiness-"));
  try {
    mkdirSync(path.join(staging, "records"));
    mkdirSync(path.join(staging, "proof"));
    for (const gate of phasePolicy.requiredGates) {
      const sourceRecord = resolveRelativeFile(source, `${gate}.json`, `${gate} record`);
      const record = readJson(sourceRecord, `${gate} record`);
      const sourceProof = resolveRelativeFile(
        source,
        record?.proof?.artifact,
        `${gate} proof artifact`,
      );
      if (sourceProof === sourceRecord) fail(`${gate} proof artifact must not be the gate record`);
      if (sha256(sourceProof) !== record?.proof?.sha256) {
        fail(`${gate} proof artifact digest does not match`);
      }
      const proofName = path.basename(sourceProof);
      if (!PORTABLE_NAME_PATTERN.test(proofName))
        fail(`${gate} proof artifact name is not portable`);
      const proofRelative = `proof/${gate}-${proofName}`;
      copyFileSync(sourceProof, path.join(staging, proofRelative), fsConstants.COPYFILE_EXCL);

      const copiedRecord = structuredClone(record);
      copiedRecord.proof.artifact = proofRelative;
      const recordRelative = `records/${gate}.json`;
      const recordBytes = `${JSON.stringify(copiedRecord, null, 2)}\n`;
      writeFileSync(path.join(staging, recordRelative), recordBytes, {
        encoding: "utf8",
        flag: "wx",
      });
      policy.evidence[gate] = {
        status: "passed",
        record: recordRelative,
        sha256: createHash("sha256").update(recordBytes).digest("hex"),
      };
    }
    policy.execution = {
      ...policy.execution,
      state: "enabled",
      phase,
      reason: `Protected external evidence bundle contains every ${phase} release gate`,
    };
    const result = evaluateReleaseReadiness(policy, { root: staging, revision, ref, phase });
    if (!result.ready) fail(`assembled policy is not ready: ${result.blockers.join("; ")}`);
    writeFileSync(
      path.join(staging, "readiness-policy.json"),
      `${JSON.stringify(policy, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    renameSync(staging, output);
    return result;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) fail("arguments must be --name value pairs");
    if (Object.hasOwn(options, flag)) fail(`duplicate argument ${flag}`);
    options[flag] = value;
  }
  return options;
}

function main() {
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  if (command === "record") {
    const output = path.resolve(requireString(options["--output"], "--output"));
    const record = createRunEvidenceRecord({
      gate: options["--gate"],
      revision: options["--revision"],
      ref: options["--ref"],
      proofFile: options["--proof"],
      proofArtifact: options["--artifact"],
      runJob: options["--job"],
      run: readJson(path.resolve(options["--run"]), "GitHub run metadata"),
    });
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    console.log(`created ${record.gate} readiness record at ${output}`);
    return;
  }
  if (command === "assemble") {
    const result = assembleReadinessBundle({
      sourceDirectory: options["--source"],
      outputDirectory: options["--output"],
      revision: options["--revision"],
      ref: options["--ref"],
      phase: options["--phase"] ?? "final",
      policyPath: options["--policy"] ?? DEFAULT_POLICY,
    });
    console.log(`assembled readiness evidence for ${result.ref} at ${result.revision}`);
    return;
  }
  if (command === "validate-run") {
    validateGitHubRun({
      run: readJson(path.resolve(options["--run"]), "GitHub run metadata"),
      label: options["--label"] ?? "GitHub run",
      revision: options["--revision"],
      workflow: options["--workflow"],
      events: requireString(options["--events"], "--events").split(","),
    });
    console.log(`validated ${options["--label"] ?? "GitHub run"}`);
    return;
  }
  fail("usage: release-readiness-bundle.mjs record|assemble --name value ...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

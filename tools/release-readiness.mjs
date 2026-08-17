import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const POLICY_PATH = path.join(ROOT, "release/readiness-policy.json");
const GATES = Object.freeze([
  "mvp",
  "contracts",
  "security",
  "performance",
  "consumer",
  "signing",
  "rehearsal",
  "registry",
]);
const CRITERIA = Object.freeze(Array.from({ length: 12 }, (_, index) => index + 1));
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REF_PATTERN = /^refs\/tags\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T/u;
const WORKFLOW_PATTERN = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u;
const RUN_EVENTS = new Set(["workflow_dispatch", "workflow_call", "push", "schedule"]);
const PHASES = Object.freeze(["bootstrap", "final"]);

function fail(message) {
  throw new Error(`Release readiness contract: ${message}`);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  return value;
}

function hashFile(filePath) {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    fail(`evidence is not a regular file: ${filePath}`);
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function resolveEvidenceFile(root, relativePath, label) {
  requireString(relativePath, label);
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be an evidence-root-relative path`);
  }
  const resolved = path.resolve(root, relativePath);
  const rootPath = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(rootPath)) fail(`${label} escapes the evidence root`);
  try {
    const metadata = lstatSync(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file`);
  } catch (error) {
    if (error?.message?.startsWith("Release readiness contract:")) throw error;
    fail(`${label} does not exist: ${error.message}`);
  }
  return resolved;
}

function validateRecord(record, gate, { revision, ref }) {
  requireObject(record, `${gate} evidence record`);
  exactKeys(
    record,
    ["schemaVersion", "gate", "conclusion", "revision", "ref", "capturedAt", "source", "proof"],
    `${gate} evidence record`,
  );
  if (record.schemaVersion !== 1) fail(`${gate} evidence schemaVersion must be 1`);
  if (record.gate !== gate) fail(`${gate} evidence record gate does not match`);
  if (record.conclusion !== "success") fail(`${gate} evidence conclusion must be success`);
  if (!REVISION_PATTERN.test(record.revision))
    fail(`${gate} evidence revision must be a full commit SHA`);
  if (record.revision !== revision) fail(`${gate} evidence revision does not match ${revision}`);
  if (record.ref !== ref) fail(`${gate} evidence ref does not match ${ref}`);
  requireString(record.capturedAt, `${gate} evidence capturedAt`);
  if (!ISO_PATTERN.test(record.capturedAt) || Number.isNaN(Date.parse(record.capturedAt))) {
    fail(`${gate} evidence capturedAt must be an ISO timestamp`);
  }
  const source = requireObject(record.source, `${gate} evidence source`);
  exactKeys(source, ["kind", "url"], `${gate} evidence source`);
  requireString(source.kind, `${gate} evidence source.kind`);
  requireString(source.url, `${gate} evidence source.url`);
  if (!source.url.startsWith("https://")) fail(`${gate} evidence source.url must use HTTPS`);
  const proof = requireObject(record.proof, `${gate} evidence proof`);
  exactKeys(proof, ["artifact", "sha256", "run"], `${gate} evidence proof`);
  requireString(proof.artifact, `${gate} evidence proof.artifact`);
  if (!SHA256_PATTERN.test(proof.sha256)) fail(`${gate} evidence proof.sha256 must be SHA-256`);
  const run = requireObject(proof.run, `${gate} evidence proof.run`);
  exactKeys(
    run,
    ["id", "job", "url", "workflow", "event", "headSha", "conclusion"],
    `${gate} evidence proof.run`,
  );
  requireString(run.id, `${gate} evidence proof.run.id`);
  requireString(run.job, `${gate} evidence proof.run.job`);
  requireString(run.url, `${gate} evidence proof.run.url`);
  if (!run.url.startsWith("https://")) fail(`${gate} evidence proof.run.url must use HTTPS`);
  if (!WORKFLOW_PATTERN.test(run.workflow)) {
    fail(`${gate} evidence run.workflow must be a repository workflow path`);
  }
  if (!RUN_EVENTS.has(run.event)) fail(`${gate} evidence run.event is not allowed`);
  if (run.headSha !== revision) fail(`${gate} evidence run.headSha does not match ${revision}`);
  if (run.conclusion !== "success") fail(`${gate} evidence run.conclusion must be success`);
}

export function validateReleaseReadinessPolicy(policy) {
  requireObject(policy, "policy");
  exactKeys(
    policy,
    [
      "schemaVersion",
      "channel",
      "version",
      "execution",
      "source",
      "requiredGates",
      "evidence",
      "successCriteria",
      "publication",
    ],
    "policy",
  );
  if (policy.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (policy.channel !== "technical-preview") fail("channel must be technical-preview");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(policy.version)) {
    fail("version must be a SemVer core version");
  }

  const execution = requireObject(policy.execution, "execution");
  exactKeys(
    execution,
    ["state", "phase", "environment", "allowedOperations", "reason"],
    "execution",
  );
  if (execution.state !== "disabled" && execution.state !== "enabled") {
    fail("execution.state must be disabled or enabled");
  }
  if (!["none", ...PHASES].includes(execution.phase)) {
    fail("execution.phase must be none, bootstrap, or final");
  }
  if (
    (execution.state === "disabled" && execution.phase !== "none") ||
    (execution.state === "enabled" && execution.phase === "none")
  ) {
    fail("execution.phase must be none only while execution is disabled");
  }
  requireString(execution.environment, "execution.environment");
  if (
    !Array.isArray(execution.allowedOperations) ||
    JSON.stringify(execution.allowedOperations) !==
      JSON.stringify(["validate", "bootstrap-publication", "request-publication"])
  ) {
    fail(
      "execution.allowedOperations must be validate, bootstrap-publication, request-publication",
    );
  }
  requireString(execution.reason, "execution.reason");

  const source = requireObject(policy.source, "source");
  exactKeys(source, ["requiredRef", "requireClean"], "source");
  if (!REF_PATTERN.test(source.requiredRef)) fail("source.requiredRef must be a version tag ref");
  if (source.requireClean !== true) fail("source.requireClean must be true");

  if (JSON.stringify(policy.requiredGates) !== JSON.stringify(GATES)) {
    fail(`requiredGates must be ${GATES.join(", ")}`);
  }
  const evidence = requireObject(policy.evidence, "evidence");
  exactKeys(evidence, GATES, "evidence");
  for (const gate of GATES) {
    const entry = requireObject(evidence[gate], `evidence.${gate}`);
    if (entry.status === "pending") {
      exactKeys(entry, ["status", "reason"], `evidence.${gate}`);
      requireString(entry.reason, `evidence.${gate}.reason`);
    } else if (entry.status === "passed") {
      exactKeys(entry, ["status", "record", "sha256"], `evidence.${gate}`);
      requireString(entry.record, `evidence.${gate}.record`);
      if (!SHA256_PATTERN.test(entry.sha256)) fail(`evidence.${gate}.sha256 must be SHA-256`);
    } else {
      fail(`evidence.${gate}.status must be pending or passed`);
    }
  }

  if (!Array.isArray(policy.successCriteria) || policy.successCriteria.length !== CRITERIA.length) {
    fail("successCriteria must contain exactly twelve entries");
  }
  for (const [index, criterion] of policy.successCriteria.entries()) {
    requireObject(criterion, `successCriteria[${index}]`);
    exactKeys(criterion, ["id", "gates"], `successCriteria[${index}]`);
    if (criterion.id !== CRITERIA[index])
      fail(`successCriteria[${index}].id is not ${CRITERIA[index]}`);
    if (!Array.isArray(criterion.gates) || criterion.gates.length === 0) {
      fail(`successCriteria[${index}].gates must be non-empty`);
    }
    for (const gate of criterion.gates)
      if (!GATES.includes(gate)) fail(`successCriteria[${index}] references unknown gate ${gate}`);
  }

  const publication = requireObject(policy.publication, "publication");
  exactKeys(
    publication,
    [
      "npmRegistry",
      "packageManifest",
      "provenance",
      "signedArtifactsOnly",
      "requireBothPlatforms",
      "allowOverwrite",
      "allowPartial",
      "allowUnsignedFallback",
      "phases",
    ],
    "publication",
  );
  if (!requireString(publication.npmRegistry, "publication.npmRegistry").startsWith("https://")) {
    fail("publication.npmRegistry must use HTTPS");
  }
  requireString(publication.packageManifest, "publication.packageManifest");
  for (const key of ["provenance", "signedArtifactsOnly", "requireBothPlatforms"]) {
    if (publication[key] !== true) fail(`publication.${key} must be true`);
  }
  for (const key of ["allowOverwrite", "allowPartial", "allowUnsignedFallback"]) {
    if (publication[key] !== false) fail(`publication.${key} must be false`);
  }
  const phases = requireObject(publication.phases, "publication.phases");
  exactKeys(phases, PHASES, "publication.phases");
  const bootstrap = requireObject(phases.bootstrap, "publication.phases.bootstrap");
  exactKeys(
    bootstrap,
    ["oneTimeVersion", "requiredGates", "tagStrategy", "promoteChannel"],
    "publication.phases.bootstrap",
  );
  if (bootstrap.oneTimeVersion !== "0.1.0") {
    fail("publication.phases.bootstrap.oneTimeVersion must be 0.1.0");
  }
  const bootstrapGates = GATES.filter((gate) => gate !== "registry");
  if (JSON.stringify(bootstrap.requiredGates) !== JSON.stringify(bootstrapGates)) {
    fail("publication.phases.bootstrap.requiredGates may omit only registry");
  }
  if (bootstrap.tagStrategy !== "revision-staging" || bootstrap.promoteChannel !== false) {
    fail("publication.phases.bootstrap must use revision-staging without channel promotion");
  }
  const final = requireObject(phases.final, "publication.phases.final");
  exactKeys(final, ["requiredGates", "tagStrategy", "promoteChannel"], "publication.phases.final");
  if (JSON.stringify(final.requiredGates) !== JSON.stringify(GATES)) {
    fail("publication.phases.final.requiredGates must contain every release gate");
  }
  if (final.tagStrategy !== "channel" || final.promoteChannel !== true) {
    fail("publication.phases.final must promote the release channel");
  }
  return policy;
}

export function releaseReadinessPhase(policy, phase = "final") {
  validateReleaseReadinessPolicy(policy);
  if (!PHASES.includes(phase)) fail("phase must be bootstrap or final");
  const configured = policy.publication.phases[phase];
  if (phase === "bootstrap" && policy.version !== configured.oneTimeVersion) {
    fail(`bootstrap publication is limited to ${configured.oneTimeVersion}`);
  }
  return configured;
}

export function evaluateReleaseReadiness(
  policy,
  { root = ROOT, revision, ref, phase = "final" } = {},
) {
  const phasePolicy = releaseReadinessPhase(policy, phase);
  if (!REVISION_PATTERN.test(revision ?? "")) fail("revision must be a full commit SHA");
  if (ref !== policy.source.requiredRef) fail(`ref must be ${policy.source.requiredRef}`);
  const blockers = [];
  if (policy.execution.state !== "enabled") blockers.push("release execution is disabled");
  if (policy.execution.state === "enabled" && policy.execution.phase !== phase) {
    blockers.push(`release evidence is prepared for ${policy.execution.phase}, not ${phase}`);
  }
  const requiredGates = new Set(phasePolicy.requiredGates);

  for (const gate of GATES) {
    const entry = policy.evidence[gate];
    if (entry.status === "pending") {
      if (requiredGates.has(gate)) blockers.push(`${gate} evidence is pending: ${entry.reason}`);
      continue;
    }
    const recordPath = resolveEvidenceFile(root, entry.record, `${gate} evidence.record`);
    const actualDigest = hashFile(recordPath);
    if (actualDigest !== entry.sha256) fail(`${gate} evidence digest does not match`);
    const record = readJson(recordPath, `${gate} evidence record`);
    validateRecord(record, gate, { revision, ref });
    const proofPath = resolveEvidenceFile(root, record.proof.artifact, `${gate} proof artifact`);
    if (proofPath === recordPath) fail(`${gate} proof artifact must not be the gate record`);
    if (hashFile(proofPath) !== record.proof.sha256) {
      fail(`${gate} proof artifact digest does not match`);
    }
  }

  for (const criterion of policy.successCriteria) {
    const missing = criterion.gates.filter(
      (gate) => requiredGates.has(gate) && policy.evidence[gate].status !== "passed",
    );
    if (missing.length > 0)
      blockers.push(
        `success criterion N-${String(criterion.id).padStart(2, "0")} lacks ${missing.join(", ")} evidence`,
      );
  }
  return {
    ready: blockers.length === 0,
    blockers,
    phase,
    version: policy.version,
    revision,
    ref,
  };
}

export function createEvidenceRecord({
  gate,
  revision,
  ref,
  sourceKind,
  sourceUrl,
  artifact,
  artifactSha256,
  runId,
  runJob,
  runUrl,
  runWorkflow,
  runEvent,
  runConclusion = "success",
  capturedAt = new Date().toISOString(),
}) {
  if (!GATES.includes(gate)) fail(`unknown evidence gate ${gate}`);
  if (!REVISION_PATTERN.test(revision ?? "")) fail("record revision must be a full commit SHA");
  if (!REF_PATTERN.test(ref ?? "")) fail("record ref must be a version tag ref");
  requireString(sourceKind, "record sourceKind");
  requireString(sourceUrl, "record sourceUrl");
  requireString(artifact, "record artifact");
  if (!SHA256_PATTERN.test(artifactSha256 ?? "")) fail("record artifactSha256 must be SHA-256");
  requireString(runId, "record runId");
  requireString(runJob, "record runJob");
  requireString(runUrl, "record runUrl");
  if (!runUrl.startsWith("https://")) fail("record runUrl must use HTTPS");
  const record = {
    schemaVersion: 1,
    gate,
    conclusion: "success",
    revision,
    ref,
    capturedAt,
    source: { kind: sourceKind, url: sourceUrl },
    proof: {
      artifact,
      sha256: artifactSha256,
      run: {
        id: runId,
        job: runJob,
        url: runUrl,
        workflow: runWorkflow,
        event: runEvent,
        headSha: revision,
        conclusion: runConclusion,
      },
    },
  };
  validateRecord(record, gate, { revision, ref });
  return record;
}

function gitValue(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail(`unknown argument ${arg}`);
    const name = arg.slice(2);
    if (name === "json") options.json = true;
    else {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) fail(`missing value for --${name}`);
      options[name] = value;
    }
  }
  return options;
}

function main() {
  const command = process.argv[2] ?? "validate";
  const options = parseOptions(process.argv.slice(3));
  const policy = readJson(options.policy ? path.resolve(options.policy) : POLICY_PATH, "policy");
  if (command === "validate") {
    validateReleaseReadinessPolicy(policy);
    console.log("release readiness policy ok");
    return;
  }
  if (command !== "readiness") {
    console.error(
      "Usage: node tools/release-readiness.mjs validate|readiness [--policy FILE] [--root DIR] [--revision SHA] [--ref TAG] [--phase bootstrap|final] [--json]",
    );
    process.exitCode = 2;
    return;
  }
  const revision = options.revision ?? gitValue(["rev-parse", "HEAD"]);
  const ref = options.ref ?? process.env.GITHUB_REF ?? "";
  const result = evaluateReleaseReadiness(policy, {
    root: options.root ? path.resolve(options.root) : ROOT,
    revision,
    ref,
    phase: options.phase ?? "final",
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  } else if (result.ready)
    console.log(`release readiness passed for ${result.ref} at ${result.revision}`);
  else {
    for (const blocker of result.blockers) console.error(`BLOCKED: ${blocker}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const defaultPolicyPath = path.join(workspaceRoot, "release", "signing-policy.json");
const PLATFORM_KEYS = ["darwin", "win32"];
const ARTIFACT_CLASSES = ["quarantine", "signed", "unsigned"];
const REFERENCE_PATTERN = /^[A-Z][A-Z0-9_]+$/u;
const OPERATIONS = ["request-release-sign", "request-staging-sign", "validate"];
const EXECUTOR_VERSION = "1.2.0";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVIEWED_EXECUTOR_FILES = [
  "release/artifact-integrity.json",
  "tools/archive-utils.mjs",
  "tools/pnpm-launcher.mjs",
  "tools/release-dependency-graph.mjs",
  "tools/release-evidence.mjs",
  "tools/signing-credentials.mjs",
  "tools/signing-executor.mjs",
  "tools/signing-policy.mjs",
];
const EXECUTOR_COMMANDS = {
  darwin: [
    ["codesign", "/usr/bin/codesign"],
    ["ditto", "/usr/bin/ditto"],
    ["notarytool", "/usr/bin/xcrun"],
    ["stapler", "/usr/bin/xcrun"],
    ["spctl", "/usr/sbin/spctl"],
  ],
  win32: [
    ["signtool", "C:/Program Files (x86)/Windows Kits/10/bin/x64/signtool.exe"],
    ["powershell", "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"],
  ],
};
const STAGING_CHECKS = [
  "checksum-and-provenance",
  "fresh-download",
  "native-launch",
  "notarization-or-authenticode",
  "platform-signature",
];
const CREDENTIAL_CONTRACTS = {
  darwin: {
    environment: "technical-preview-signing-macos",
    ownerPlaceholder: "UNASSIGNED_MACOS_SIGNING_OWNER",
    secretReferences: [
      "NEXA_APPLE_NOTARY_KEY_P8",
      "NEXA_MACOS_CERTIFICATE_P12",
      "NEXA_MACOS_CERTIFICATE_PASSWORD",
    ],
    variableReferences: [
      "NEXA_APPLE_NOTARY_ISSUER_ID",
      "NEXA_APPLE_NOTARY_KEY_ID",
      "NEXA_APPLE_TEAM_ID",
      "NEXA_MACOS_SIGNING_IDENTITY",
    ],
  },
  win32: {
    environment: "technical-preview-signing-windows",
    ownerPlaceholder: "UNASSIGNED_WINDOWS_SIGNING_OWNER",
    secretReferences: ["NEXA_WINDOWS_CERTIFICATE_PASSWORD", "NEXA_WINDOWS_CERTIFICATE_PFX"],
    variableReferences: [
      "NEXA_WINDOWS_CERTIFICATE_THUMBPRINT",
      "NEXA_WINDOWS_RFC3161_TIMESTAMP_URL",
    ],
  },
};
const PLATFORM_EVIDENCE = {
  darwin: [
    "SHA256SUMS",
    "codesign-details.txt",
    "notarytool-log.json",
    "notarytool-submission.json",
    "provenance.intoto.jsonl",
    "sbom.cdx.json",
    "spctl-assessment.txt",
    "stapler-validate.txt",
  ],
  win32: [
    "SHA256SUMS",
    "authenticode-status.json",
    "certificate-chain.txt",
    "provenance.intoto.jsonl",
    "sbom.cdx.json",
    "signtool-verify.txt",
  ],
};

export class SigningPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SigningPolicyError";
  }
}

function fail(message) {
  throw new SigningPolicyError(message);
}

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) fail(`${name} must be a non-empty array`);
  for (const [index, entry] of value.entries()) requireString(entry, `${name}[${index}]`);
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
  return value;
}

function requireExactStringSet(value, expected, name) {
  const actual = [...requireStringArray(value, name)].sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((entry, index) => entry !== required[index])
  ) {
    fail(`${name} entries must be exactly: ${required.join(", ")}`);
  }
  return value;
}

function requireExactKeys(value, keys, name) {
  const actual = Object.keys(requireObject(value, name)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${name} keys must be exactly: ${expected.join(", ")}`);
  }
  return value;
}

function requireReferenceArray(value, name) {
  for (const reference of requireStringArray(value, name)) {
    if (!REFERENCE_PATTERN.test(reference))
      fail(`${name} contains an invalid reference: ${reference}`);
  }
}

function requireSafeRelativeRoot(value, name) {
  requireString(value, name);
  const segments = value.split("/");
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(value) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    fail(`${name} must be a portable workspace-relative path`);
  }
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateOwner(ownerValue, name, placeholder) {
  const owner = requireExactKeys(ownerValue, ["status", "principal"], name);
  if (!["unassigned", "assigned"].includes(owner.status)) {
    fail(`${name}.status must be unassigned or assigned`);
  }
  requireString(owner.principal, `${name}.principal`);
  if (owner.status === "unassigned" && owner.principal !== placeholder) {
    fail(`${name}.principal must be ${placeholder} while unassigned`);
  }
  if (owner.status === "assigned" && owner.principal.startsWith("UNASSIGNED_")) {
    fail(`${name}.principal must identify the assigned owner`);
  }
  return owner;
}

function validateRelease(release) {
  requireExactKeys(
    release,
    ["channel", "publishableArtifactClass", "requiresBothPlatforms", "stagingEvidence"],
    "release",
  );
  if (release.channel !== "technical-preview") fail("release.channel must be technical-preview");
  if (release.publishableArtifactClass !== "signed") {
    fail("release.publishableArtifactClass must be signed");
  }
  if (release.requiresBothPlatforms !== true) fail("release.requiresBothPlatforms must be true");

  const evidence = requireExactKeys(
    release.stagingEvidence,
    ["status", "record", "requiredChecks"],
    "release.stagingEvidence",
  );
  if (!["pending", "passed"].includes(evidence.status)) {
    fail("release.stagingEvidence.status must be pending or passed");
  }
  if (evidence.status === "pending" && evidence.record !== null) {
    fail("pending staging evidence must not claim a record");
  }
  if (evidence.status === "passed")
    requireString(evidence.record, "release.stagingEvidence.record");
  requireExactStringSet(
    evidence.requiredChecks,
    STAGING_CHECKS,
    "release.stagingEvidence.requiredChecks",
  );
}

function executorFileDigest(entrypoint) {
  const file = path.resolve(workspaceRoot, entrypoint);
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch (error) {
    fail(
      `cannot read reviewed signing executor: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function executorClosureDigest(files) {
  const hash = createHash("sha256");
  for (const relative of files) {
    const file = path.resolve(workspaceRoot, relative);
    try {
      hash.update(relative, "utf8");
      hash.update("\0", "utf8");
      hash.update(readFileSync(file));
      hash.update("\0", "utf8");
    } catch (error) {
      fail(
        `cannot read reviewed signing closure file ${relative}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return hash.digest("hex");
}

function validateReviewedExecutor(executor) {
  requireExactKeys(
    executor,
    ["entrypoint", "version", "sha256", "closure", "platforms"],
    "execution.reviewedExecutor",
  );
  if (executor.entrypoint !== "tools/signing-executor.mjs") {
    fail("execution.reviewedExecutor.entrypoint must be tools/signing-executor.mjs");
  }
  if (executor.version !== EXECUTOR_VERSION) {
    fail(`execution.reviewedExecutor.version must be ${EXECUTOR_VERSION}`);
  }
  if (!SHA256_PATTERN.test(executor.sha256)) {
    fail("execution.reviewedExecutor.sha256 must be a SHA-256 digest");
  }
  if (executorFileDigest(executor.entrypoint) !== executor.sha256) {
    fail("execution.reviewedExecutor.sha256 does not match the reviewed executor bytes");
  }
  const closure = requireExactKeys(
    executor.closure,
    ["files", "sha256"],
    "execution.reviewedExecutor.closure",
  );
  if (JSON.stringify(closure.files) !== JSON.stringify(REVIEWED_EXECUTOR_FILES)) {
    fail(`execution.reviewedExecutor.closure.files must be ${REVIEWED_EXECUTOR_FILES.join(", ")}`);
  }
  if (!SHA256_PATTERN.test(closure.sha256)) {
    fail("execution.reviewedExecutor.closure.sha256 must be a SHA-256 digest");
  }
  if (executorClosureDigest(closure.files) !== closure.sha256) {
    fail("execution.reviewedExecutor.closure.sha256 does not match the reviewed closure bytes");
  }
  requireExactKeys(executor.platforms, PLATFORM_KEYS, "execution.reviewedExecutor.platforms");
  for (const platform of PLATFORM_KEYS) {
    const configured = requireExactKeys(
      executor.platforms[platform],
      ["runner", "commands"],
      `execution.reviewedExecutor.platforms.${platform}`,
    );
    if (configured.runner !== (platform === "darwin" ? "macos-15" : "windows-2022")) {
      fail(
        `execution.reviewedExecutor.platforms.${platform}.runner must match the platform runner`,
      );
    }
    const expected = EXECUTOR_COMMANDS[platform];
    if (!Array.isArray(configured.commands) || configured.commands.length !== expected.length) {
      fail(
        `execution.reviewedExecutor.platforms.${platform}.commands must bind every reviewed tool`,
      );
    }
    for (const [index, [name, toolPath]] of expected.entries()) {
      const command = requireExactKeys(
        configured.commands[index],
        ["name", "path"],
        `execution.reviewedExecutor.platforms.${platform}.commands[${index}]`,
      );
      if (command.name !== name || command.path !== toolPath) {
        fail(
          `execution.reviewedExecutor.platforms.${platform}.commands must use reviewed paths and order`,
        );
      }
    }
  }
}

function validateExecution(execution) {
  requireExactKeys(
    execution,
    [
      "state",
      "implementation",
      "credentialActivation",
      "workflow",
      "allowedOperations",
      "reason",
      "reviewedExecutor",
    ],
    "execution",
  );
  if (!["disabled", "active"].includes(execution.state)) {
    fail("execution.state must be disabled or active");
  }
  if (execution.workflow !== ".github/workflows/signing.yml") {
    fail("execution.workflow must identify the isolated signing workflow");
  }
  if (execution.implementation !== "reviewed-executor-installed") {
    fail("execution.implementation must be reviewed-executor-installed");
  }
  if (!["disabled", "active"].includes(execution.credentialActivation)) {
    fail("execution.credentialActivation must be disabled or active");
  }
  if (execution.state === "disabled" && execution.credentialActivation !== "disabled") {
    fail("disabled execution must keep credential activation disabled");
  }
  if (execution.state === "active" && execution.credentialActivation !== "active") {
    fail("active execution requires active credential activation");
  }
  const expectedOperations = execution.state === "active" ? OPERATIONS : ["validate"];
  requireExactStringSet(
    execution.allowedOperations,
    expectedOperations,
    "execution.allowedOperations",
  );
  requireString(execution.reason, "execution.reason");
  validateReviewedExecutor(execution.reviewedExecutor);
}

function validateCredentials(credentials) {
  requireExactKeys(credentials, PLATFORM_KEYS, "credentials");
  for (const platform of PLATFORM_KEYS) {
    const name = `credentials.${platform}`;
    const contract = CREDENTIAL_CONTRACTS[platform];
    const credential = requireExactKeys(
      credentials[platform],
      [
        "environment",
        "owner",
        "requiredReviewers",
        "secretReferences",
        "variableReferences",
        "materialPolicy",
      ],
      name,
    );
    if (credential.environment !== contract.environment) {
      fail(`${name}.environment must be ${contract.environment}`);
    }
    validateOwner(credential.owner, `${name}.owner`, contract.ownerPlaceholder);
    if (credential.requiredReviewers !== true) fail(`${name}.requiredReviewers must be true`);
    requireReferenceArray(credential.secretReferences, `${name}.secretReferences`);
    requireExactStringSet(
      credential.secretReferences,
      contract.secretReferences,
      `${name}.secretReferences`,
    );
    requireReferenceArray(credential.variableReferences, `${name}.variableReferences`);
    requireExactStringSet(
      credential.variableReferences,
      contract.variableReferences,
      `${name}.variableReferences`,
    );
    const references = [...credential.secretReferences, ...credential.variableReferences];
    if (new Set(references).size !== references.length) {
      fail(`${name} secret and variable references must be disjoint`);
    }

    const material = requireExactKeys(
      credential.materialPolicy,
      [
        "ephemeralImport",
        "hostedEphemeralRunner",
        "printSecretValues",
        "removeOnEveryExit",
        "cleanupCondition",
        "persistentExport",
      ],
      `${name}.materialPolicy`,
    );
    if (
      material.ephemeralImport !== true ||
      material.hostedEphemeralRunner !== true ||
      material.printSecretValues !== false ||
      material.removeOnEveryExit !== true ||
      material.cleanupCondition !== "always()" ||
      material.persistentExport !== false
    ) {
      fail(
        `${name}.materialPolicy must require hosted, ephemeral, non-exported, always-cleaned material`,
      );
    }
  }
}

function validateArtifacts(artifacts) {
  requireExactKeys(artifacts, [...ARTIFACT_CLASSES, "naming", "rules"], "artifacts");
  const roots = [];
  for (const artifactClass of ARTIFACT_CLASSES) {
    const name = `artifacts.${artifactClass}`;
    const expectedKeys = ["root", "suffix", "publishable", "immutable"];
    if (artifactClass === "signed") expectedKeys.push("derivedFrom");
    const artifact = requireExactKeys(artifacts[artifactClass], expectedKeys, name);
    requireSafeRelativeRoot(artifact.root, `${name}.root`);
    roots.push(artifact.root);
    if (artifact.suffix !== `-${artifactClass}`) fail(`${name}.suffix must identify its class`);
    if (artifact.immutable !== true) fail(`${name}.immutable must be true`);
    if (artifact.publishable !== (artifactClass === "signed")) {
      fail("only artifacts.signed may be publishable");
    }
  }
  for (const [index, root] of roots.entries()) {
    for (const candidate of roots.slice(index + 1)) {
      if (pathsOverlap(root, candidate)) {
        fail("artifact class roots must be disjoint and non-overlapping");
      }
    }
  }
  if (artifacts.signed.derivedFrom !== "unsigned") {
    fail("artifacts.signed.derivedFrom must be unsigned");
  }

  const naming = requireExactKeys(artifacts.naming, PLATFORM_KEYS, "artifacts.naming");
  const expectedNames = {
    darwin: "{app}-{version}-macos-{arch}-{class}.tar.gz",
    win32: "{app}-{version}-windows-{arch}-{class}.zip",
  };
  for (const platform of PLATFORM_KEYS) {
    if (naming[platform] !== expectedNames[platform]) {
      fail(`artifacts.naming.${platform} must be ${expectedNames[platform]}`);
    }
  }

  const rules = requireExactKeys(
    artifacts.rules,
    [
      "copyUnsignedBeforeMutation",
      "allowInPlaceMutation",
      "allowCrossClassOverwrite",
      "regenerateIntegrityEvidence",
    ],
    "artifacts.rules",
  );
  if (
    rules.copyUnsignedBeforeMutation !== true ||
    rules.allowInPlaceMutation !== false ||
    rules.allowCrossClassOverwrite !== false ||
    rules.regenerateIntegrityEvidence !== true
  ) {
    fail("artifacts.rules must isolate immutable unsigned and signed outputs");
  }
}

function validatePlatforms(platforms) {
  requireExactKeys(platforms, PLATFORM_KEYS, "platforms");
  const darwin = requireExactKeys(
    platforms.darwin,
    ["runner", "signature", "notarization", "evidence"],
    "platforms.darwin",
  );
  if (darwin.runner !== "macos-15") fail("platforms.darwin.runner must be macos-15");
  const macSignature = requireExactKeys(
    darwin.signature,
    ["identityClass", "hardenedRuntime", "secureTimestamp", "componentOrder", "verification"],
    "platforms.darwin.signature",
  );
  if (
    macSignature.identityClass !== "Developer ID Application" ||
    macSignature.hardenedRuntime !== true ||
    macSignature.secureTimestamp !== "required" ||
    macSignature.componentOrder !== "inside-out"
  ) {
    fail(
      "macOS signing must use Developer ID, hardened runtime, timestamping, and inside-out order",
    );
  }
  requireExactStringSet(
    macSignature.verification,
    ["codesign-strict"],
    "platforms.darwin.signature.verification",
  );
  const notarization = requireExactKeys(
    darwin.notarization,
    ["tool", "waitForCompletion", "acceptedStatus", "staple", "verification"],
    "platforms.darwin.notarization",
  );
  if (
    notarization.tool !== "notarytool" ||
    notarization.waitForCompletion !== true ||
    notarization.acceptedStatus !== "Accepted" ||
    notarization.staple !== true
  ) {
    fail("macOS notarization must wait for acceptance and staple the ticket");
  }
  requireExactStringSet(
    notarization.verification,
    ["gatekeeper-assessment", "stapler-validate"],
    "platforms.darwin.notarization.verification",
  );
  requireExactStringSet(darwin.evidence, PLATFORM_EVIDENCE.darwin, "platforms.darwin.evidence");

  const win32 = requireExactKeys(
    platforms.win32,
    ["runner", "signature", "evidence"],
    "platforms.win32",
  );
  if (win32.runner !== "windows-2022") fail("platforms.win32.runner must be windows-2022");
  const windowsSignature = requireExactKeys(
    win32.signature,
    ["format", "fileDigest", "timestampProtocol", "timestampDigest", "verification"],
    "platforms.win32.signature",
  );
  if (
    windowsSignature.format !== "Authenticode" ||
    windowsSignature.fileDigest !== "SHA256" ||
    windowsSignature.timestampProtocol !== "RFC3161" ||
    windowsSignature.timestampDigest !== "SHA256"
  ) {
    fail("Windows signing must use SHA-256 Authenticode with an RFC3161 timestamp");
  }
  requireExactStringSet(
    windowsSignature.verification,
    ["authenticode-status-valid", "signtool-default-policy-all", "timestamp-present"],
    "platforms.win32.signature.verification",
  );
  requireExactStringSet(win32.evidence, PLATFORM_EVIDENCE.win32, "platforms.win32.evidence");
}

function validateFailureAndRollback(failurePolicy, rollback) {
  requireExactKeys(
    failurePolicy,
    [
      "failClosed",
      "allowUnsignedFallback",
      "publishOnPartialSuccess",
      "quarantineOnFailure",
      "retainUnsignedInput",
      "removeCredentialMaterialOnEveryExit",
    ],
    "failurePolicy",
  );
  if (
    failurePolicy.failClosed !== true ||
    failurePolicy.allowUnsignedFallback !== false ||
    failurePolicy.publishOnPartialSuccess !== false ||
    failurePolicy.quarantineOnFailure !== true ||
    failurePolicy.retainUnsignedInput !== true ||
    failurePolicy.removeCredentialMaterialOnEveryExit !== true
  ) {
    fail("failurePolicy must fail closed without an unsigned or partial-release fallback");
  }

  requireExactKeys(
    rollback,
    [
      "strategy",
      "quarantineBeforePublication",
      "allowOverwritePublishedVersion",
      "keepLastKnownGoodCurrent",
      "requireNewVersionAfterPublication",
      "revokeOnlyOnCompromise",
      "incidentOwner",
    ],
    "rollback",
  );
  if (
    rollback.strategy !== "withdraw-and-rebuild" ||
    rollback.quarantineBeforePublication !== true ||
    rollback.allowOverwritePublishedVersion !== false ||
    rollback.keepLastKnownGoodCurrent !== true ||
    rollback.requireNewVersionAfterPublication !== true ||
    rollback.revokeOnlyOnCompromise !== true
  ) {
    fail(
      "rollback must quarantine or withdraw, keep the last known-good version current, and rebuild a new version",
    );
  }
  validateOwner(
    rollback.incidentOwner,
    "rollback.incidentOwner",
    "UNASSIGNED_RELEASE_INCIDENT_OWNER",
  );
}

export function validateSigningPolicy(policy) {
  requireExactKeys(
    policy,
    [
      "schemaVersion",
      "release",
      "execution",
      "credentials",
      "artifacts",
      "platforms",
      "failurePolicy",
      "rollback",
    ],
    "policy",
  );
  if (policy.schemaVersion !== 2) fail("policy.schemaVersion must be 2");
  validateRelease(policy.release);
  validateExecution(policy.execution);
  validateCredentials(policy.credentials);
  validateArtifacts(policy.artifacts);
  validatePlatforms(policy.platforms);
  validateFailureAndRollback(policy.failurePolicy, policy.rollback);
  return policy;
}

export function loadSigningPolicy(policyPath = defaultPolicyPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    fail(`cannot read signing policy: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateSigningPolicy(parsed);
}

export function assessSigningReadiness(policy, phase = "staging") {
  validateSigningPolicy(policy);
  if (!["staging", "release"].includes(phase)) fail("phase must be staging or release");
  const blockers = [];
  const requiredOperation = phase === "release" ? "request-release-sign" : "request-staging-sign";
  if (policy.execution.state !== "active") blockers.push("signing executor is disabled");
  if (policy.execution.credentialActivation !== "active") {
    blockers.push("credential activation is disabled");
  }
  if (!policy.execution.allowedOperations.includes(requiredOperation)) {
    blockers.push(`${requiredOperation} is not allowed`);
  }
  for (const platform of PLATFORM_KEYS) {
    const owner = policy.credentials[platform].owner;
    if (owner.status !== "assigned") blockers.push(`${platform} credential owner is unassigned`);
  }
  if (policy.rollback.incidentOwner.status !== "assigned") {
    blockers.push("release incident owner is unassigned");
  }
  if (phase === "release" && policy.release.stagingEvidence.status !== "passed") {
    blockers.push("staging signed-release evidence is pending");
  }
  return { schemaVersion: 1, phase, ready: blockers.length === 0, blockers };
}

function parsePhase(arguments_) {
  if (arguments_.length === 0) return "staging";
  if (arguments_.length !== 2 || arguments_[0] !== "--phase") {
    fail("usage: node tools/signing-policy.mjs readiness [--phase staging|release]");
  }
  return arguments_[1];
}

function run(arguments_) {
  const [command = "validate", ...rest] = arguments_;
  if (command === "validate") {
    if (rest.length !== 0) fail("validate does not accept arguments");
    const policy = loadSigningPolicy();
    console.log(`Signing policy ok (execution ${policy.execution.state})`);
    return 0;
  }
  if (command === "readiness") {
    const result = assessSigningReadiness(loadSigningPolicy(), parsePhase(rest));
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (result.ready) {
      process.stdout.write(output);
      return 0;
    }
    process.stderr.write(output);
    return 1;
  }
  fail("usage: node tools/signing-policy.mjs validate|readiness [--phase staging|release]");
}

const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

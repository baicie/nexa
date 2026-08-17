import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessSigningReadiness,
  loadSigningPolicy,
  validateSigningPolicy,
} from "./signing-policy.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const script = path.join(root, "tools", "signing-policy.mjs");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function policyCopy() {
  return structuredClone(loadSigningPolicy());
}

function expectRejected(mutate, pattern) {
  const policy = policyCopy();
  mutate(policy);
  assert.throws(() => validateSigningPolicy(policy), pattern);
}

test("signing policy isolates immutable unsigned, signed, and quarantine artifacts", () => {
  const policy = loadSigningPolicy();
  assert.equal(validateSigningPolicy(policy), policy);
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.execution.implementation, "reviewed-executor-installed");
  assert.equal(policy.execution.credentialActivation, "disabled");
  assert.equal(policy.execution.reviewedExecutor.entrypoint, "tools/signing-executor.mjs");
  assert.equal(policy.execution.reviewedExecutor.version, "1.2.0");
  assert.match(policy.execution.reviewedExecutor.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(policy.execution.reviewedExecutor.closure.files, [
    "release/artifact-integrity.json",
    "tools/archive-utils.mjs",
    "tools/pnpm-launcher.mjs",
    "tools/release-dependency-graph.mjs",
    "tools/release-evidence.mjs",
    "tools/signing-credentials.mjs",
    "tools/signing-executor.mjs",
    "tools/signing-policy.mjs",
  ]);
  assert.match(policy.execution.reviewedExecutor.closure.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(policy.release.publishableArtifactClass, "signed");
  assert.deepEqual(
    [policy.artifacts.unsigned, policy.artifacts.signed, policy.artifacts.quarantine].map(
      ({ root, publishable, immutable }) => ({ root, publishable, immutable }),
    ),
    [
      { root: "release-work/unsigned", publishable: false, immutable: true },
      { root: "release-work/signed", publishable: true, immutable: true },
      { root: "release-work/quarantine", publishable: false, immutable: true },
    ],
  );
  assert.equal(policy.artifacts.rules.copyUnsignedBeforeMutation, true);
  assert.equal(policy.artifacts.rules.allowInPlaceMutation, false);
  assert.equal(policy.artifacts.rules.allowCrossClassOverwrite, false);
  assert.equal(policy.failurePolicy.allowUnsignedFallback, false);
  assert.equal(policy.failurePolicy.publishOnPartialSuccess, false);
});

test("unassigned credential and incident owners make staging and release fail closed", () => {
  const policy = loadSigningPolicy();
  const staging = assessSigningReadiness(policy, "staging");
  const release = assessSigningReadiness(policy, "release");

  assert.equal(staging.ready, false);
  assert.match(staging.blockers.join("\n"), /signing executor is disabled/u);
  assert.match(staging.blockers.join("\n"), /darwin credential owner is unassigned/u);
  assert.match(staging.blockers.join("\n"), /win32 credential owner is unassigned/u);
  assert.match(staging.blockers.join("\n"), /release incident owner is unassigned/u);
  assert.match(release.blockers.join("\n"), /staging signed-release evidence is pending/u);
});

test("release readiness additionally requires a successful two-platform staging record", () => {
  const policy = policyCopy();
  policy.execution = {
    ...policy.execution,
    state: "active",
    credentialActivation: "active",
    allowedOperations: ["validate", "request-staging-sign", "request-release-sign"],
    reason: "Reviewed executor installed for contract test",
  };
  policy.credentials.darwin.owner = { status: "assigned", principal: "@nexa/macos-signing" };
  policy.credentials.win32.owner = { status: "assigned", principal: "@nexa/windows-signing" };
  policy.rollback.incidentOwner = { status: "assigned", principal: "@nexa/release-incident" };

  assert.equal(assessSigningReadiness(policy, "staging").ready, true);
  assert.equal(assessSigningReadiness(policy, "release").ready, false);

  policy.release.stagingEvidence = {
    ...policy.release.stagingEvidence,
    status: "passed",
    record: "https://github.com/baicie/nexa-ui/actions/runs/123456789",
  };
  assert.deepEqual(assessSigningReadiness(policy, "release"), {
    schemaVersion: 1,
    phase: "release",
    ready: true,
    blockers: [],
  });
});

test("platform policy requires Developer ID notarization and SHA-256 Authenticode", () => {
  const policy = loadSigningPolicy();
  assert.equal(policy.platforms.darwin.signature.identityClass, "Developer ID Application");
  assert.equal(policy.platforms.darwin.signature.hardenedRuntime, true);
  assert.deepEqual(policy.platforms.darwin.signature.verification, ["codesign-strict"]);
  assert.equal(policy.platforms.darwin.notarization.tool, "notarytool");
  assert.equal(policy.platforms.darwin.notarization.acceptedStatus, "Accepted");
  assert.equal(policy.platforms.darwin.notarization.staple, true);
  assert.deepEqual(policy.platforms.darwin.notarization.verification, [
    "stapler-validate",
    "gatekeeper-assessment",
  ]);
  assert.equal(policy.platforms.win32.signature.format, "Authenticode");
  assert.equal(policy.platforms.win32.signature.fileDigest, "SHA256");
  assert.equal(policy.platforms.win32.signature.timestampProtocol, "RFC3161");
  assert.equal(policy.platforms.win32.signature.timestampDigest, "SHA256");
});

test("validator rejects weakened execution, credentials, cleanup, and rollback", () => {
  expectRejected(
    (policy) => policy.execution.allowedOperations.push("request-staging-sign"),
    /execution\.allowedOperations entries must be exactly/u,
  );
  expectRejected(
    (policy) => (policy.execution.credentialActivation = "active"),
    /disabled execution must keep credential activation disabled/u,
  );
  expectRejected(
    (policy) => (policy.execution.reviewedExecutor.sha256 = "0".repeat(64)),
    /does not match the reviewed executor bytes/u,
  );
  expectRejected(
    (policy) => (policy.execution.reviewedExecutor.closure.sha256 = "0".repeat(64)),
    /does not match the reviewed closure bytes/u,
  );
  expectRejected(
    (policy) =>
      (policy.execution.reviewedExecutor.platforms.win32.commands[0].path = "signtool.exe"),
    /reviewed paths and order/u,
  );
  expectRejected(
    (policy) => policy.credentials.darwin.secretReferences.pop(),
    /credentials\.darwin\.secretReferences entries must be exactly/u,
  );
  expectRejected(
    (policy) => (policy.credentials.win32.materialPolicy.cleanupCondition = "success()"),
    /always-cleaned material/u,
  );
  expectRejected(
    (policy) => (policy.failurePolicy.allowUnsignedFallback = true),
    /without an unsigned or partial-release fallback/u,
  );
  expectRejected(
    (policy) => (policy.rollback.requireNewVersionAfterPublication = false),
    /keep the last known-good version current/u,
  );
  expectRejected(
    (policy) => (policy.rollback.incidentOwner.principal = "UNASSIGNED_OTHER_OWNER"),
    /must be UNASSIGNED_RELEASE_INCIDENT_OWNER/u,
  );
});

test("validator rejects unsafe or overlapping artifact custody", () => {
  expectRejected(
    (policy) => (policy.artifacts.signed.root = "release-work/unsigned/signed"),
    /disjoint and non-overlapping/u,
  );
  expectRejected(
    (policy) => (policy.artifacts.quarantine.root = "../quarantine"),
    /portable workspace-relative path/u,
  );
  expectRejected(
    (policy) => (policy.artifacts.naming.win32 = "{app}-{version}-{arch}-{class}.zip"),
    /must be \{app\}-\{version\}-windows/u,
  );
});

test("validator rejects platform verification downgrades and incomplete evidence", () => {
  expectRejected(
    (policy) => (policy.platforms.darwin.signature.identityClass = "Apple Development"),
    /must use Developer ID/u,
  );
  expectRejected(
    (policy) => policy.platforms.darwin.signature.verification.push("gatekeeper-assessment"),
    /platforms\.darwin\.signature\.verification entries must be exactly/u,
  );
  expectRejected(
    (policy) => (policy.platforms.darwin.notarization.staple = false),
    /must wait for acceptance and staple/u,
  );
  expectRejected(
    (policy) => (policy.platforms.win32.signature.fileDigest = "SHA1"),
    /SHA-256 Authenticode/u,
  );
  expectRejected(
    (policy) => policy.platforms.win32.evidence.pop(),
    /platforms\.win32\.evidence entries must be exactly/u,
  );
});

test("credential policy requires protected owners and unconditional ephemeral cleanup", () => {
  const policy = loadSigningPolicy();
  for (const platform of ["darwin", "win32"]) {
    const credential = policy.credentials[platform];
    assert.equal(credential.owner.status, "unassigned");
    assert.equal(credential.requiredReviewers, true);
    assert.deepEqual(credential.materialPolicy, {
      ephemeralImport: true,
      hostedEphemeralRunner: true,
      printSecretValues: false,
      removeOnEveryExit: true,
      cleanupCondition: "always()",
      persistentExport: false,
    });
  }
});

test("guarded workflow has protected platform executors but cannot activate credentials", () => {
  const workflow = read(".github/workflows/signing.yml");
  const triggerBlock = workflow.slice(
    workflow.indexOf("on:\n"),
    workflow.indexOf("\npermissions:"),
  );
  const triggers = [...triggerBlock.matchAll(/^  ([a-z_]+):/gmu)].map(([, trigger]) => trigger);
  assert.deepEqual(triggers, ["workflow_call", "workflow_dispatch"]);
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /runs-on: macos-15/u);
  assert.match(workflow, /runs-on: windows-2022/u);
  assert.match(workflow, /default: validate/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /node tools\/signing-policy\.mjs validate/u);
  assert.match(workflow, /node tools\/signing-policy\.mjs readiness --phase staging/u);
  assert.match(workflow, /node tools\/signing-policy\.mjs readiness --phase release/u);
  assert.match(workflow, /node tools\/signing-executor\.mjs validate/u);
  assert.match(workflow, /OPERATION: \$\{\{ inputs\.operation \}\}/u);
  assert.match(workflow, /printf 'Unknown signing operation: %s\\n' "\$OPERATION"/u);
  assert.doesNotMatch(workflow, /Unknown signing operation: \$\{\{/u);
  for (const reference of [
    "NEXA_MACOS_CERTIFICATE_P12",
    "NEXA_APPLE_NOTARY_KEY_P8",
    "NEXA_WINDOWS_CERTIFICATE_PFX",
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${reference}`, "u"));
  }
  assert.match(workflow, /name: technical-preview-signing-macos/u);
  assert.match(workflow, /name: technical-preview-signing-windows/u);
  assert.equal((workflow.match(/if: \$\{\{ false \}\}/gu) ?? []).length, 2);
  assert.equal((workflow.match(/if: always\(\)/gu) ?? []).length, 3);
  assert.match(workflow, /Remove run-scoped macOS signing material/u);
  assert.match(workflow, /Remove run-scoped Windows signing material/u);

  const actionReferences = [...workflow.matchAll(/^\s+- uses: [^@\s]+@([^\s#]+)/gmu)].map(
    ([, reference]) => reference,
  );
  assert.ok(actionReferences.length >= 2);
  for (const reference of actionReferences) assert.match(reference, /^[0-9a-f]{40}$/u);
});

test("signing runbook defines ownership, failure handling, verification, cleanup, and rollback", () => {
  const runbook = read("docs/SIGNING.md");
  for (const marker of [
    "UNASSIGNED_MACOS_SIGNING_OWNER",
    "UNASSIGNED_WINDOWS_SIGNING_OWNER",
    "unsigned",
    "signed",
    "quarantine",
    "codesign --verify",
    "notarytool submit",
    "stapler validate",
    "signtool sign",
    "signtool verify /pa /all /v",
    "Get-AuthenticodeSignature",
    "if: always()",
    "reviewed executor",
    "credential activation",
    "SHA-256",
    "Rollback",
    "must not fall back",
    "new higher version",
  ]) {
    assert.match(runbook, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("CLI validates policy but rejects both signing readiness phases", () => {
  const validate = spawnSync(process.execPath, [script, "validate"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /execution disabled/u);

  for (const phase of ["staging", "release"]) {
    const readiness = spawnSync(process.execPath, [script, "readiness", "--phase", phase], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(readiness.status, 1, readiness.stdout);
    const report = JSON.parse(readiness.stderr);
    assert.equal(report.phase, phase);
    assert.equal(report.ready, false);
    assert.ok(report.blockers.length >= 6);
  }
});

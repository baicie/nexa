import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  buildSignedReleaseArtifactManifest,
  collectPublishArtifacts,
  evaluatePublicationRegistry,
  evaluateRegistryTrain,
  resolvePublicationPhase,
  runPublicationCommand,
  verifySignedReleaseArtifacts,
  writeArtifactManifest,
} from "./publish-release.mjs";

const release = JSON.parse(
  readFileSync(new URL("../release/packages.json", import.meta.url), "utf8"),
);
const signingPolicy = JSON.parse(
  readFileSync(new URL("../release/signing-policy.json", import.meta.url), "utf8"),
);
const revision = "a".repeat(40);

const signedEvidence = {
  darwin: [
    "codesign-details.txt",
    "notarytool-submission.json",
    "notarytool-log.json",
    "stapler-validate.txt",
    "spctl-assessment.txt",
    "fresh-codesign-verify.txt",
    "fresh-stapler-validate.txt",
    "fresh-spctl-assessment.txt",
    "fresh-launch.txt",
    "SHA256SUMS",
    "sbom.cdx.json",
    "provenance.intoto.jsonl",
    "g6-05-descriptor.json",
    "g6-05-SHA256SUMS",
    "g6-05-sbom.cdx.json",
    "g6-05-provenance.intoto.jsonl",
  ],
  win32: [
    "signtool-verify.txt",
    "authenticode-status.json",
    "certificate-chain.txt",
    "fresh-signtool-verify.txt",
    "fresh-authenticode-status.json",
    "fresh-launch.txt",
    "SHA256SUMS",
    "sbom.cdx.json",
    "provenance.intoto.jsonl",
    "g6-05-descriptor.json",
    "g6-05-SHA256SUMS",
    "g6-05-sbom.cdx.json",
    "g6-05-provenance.intoto.jsonl",
  ],
};

test("an inherited-stdio command can complete without captured stdout", () => {
  assert.equal(runPublicationCommand(process.execPath, ["--eval", ""], { inherit: true }), "");
});

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function signingInputEvidence({ artifactCount = 2, descriptorSeed = "descriptor" } = {}) {
  const descriptorName = `g6-05-${descriptorSeed}.json`;
  const descriptor = {
    name: descriptorName,
    sha256: createHash("sha256").update(`${descriptorName}\n`).digest("hex"),
  };
  const outputs = ["SHA256SUMS", "provenance.intoto.jsonl", "sbom.cdx.json"].map((name) => ({
    name,
    sha256: createHash("sha256").update(`${name}\n`).digest("hex"),
  }));
  const hash = createHash("sha256");
  hash.update("artifact-count\0", "utf8");
  hash.update(`${artifactCount}\0`, "utf8");
  for (const entry of [descriptor, ...outputs]) {
    hash.update(entry.name, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.sha256, "utf8");
    hash.update("\0", "utf8");
  }
  return {
    schemaVersion: 1,
    artifactCount,
    descriptor,
    outputs,
    bundleSha256: hash.digest("hex"),
  };
}

function signingInputSidecars(inputEvidence) {
  return {
    "g6-05-descriptor.json": `${inputEvidence.descriptor.name}\n`,
    "g6-05-SHA256SUMS": "SHA256SUMS\n",
    "g6-05-provenance.intoto.jsonl": "provenance.intoto.jsonl\n",
    "g6-05-sbom.cdx.json": "sbom.cdx.json\n",
  };
}

function createTransportFixture(
  root,
  {
    withCustody = true,
    artifactVersion = "0.1.0",
    inputEvidenceForPlatform = () => signingInputEvidence(),
  } = {},
) {
  const npm = path.join(root, "npm");
  const signed = path.join(root, "signed");
  mkdirSync(npm, { recursive: true });
  mkdirSync(signed);
  for (const entry of release.npm.public) {
    const name = `${entry.name.replace(/^@nexa\//u, "nexa-")}-0.1.0.tgz`;
    writeFileSync(path.join(npm, name), `${entry.name}\n`);
  }
  for (const name of [
    `nexa-notes-${artifactVersion}-macos-arm64-signed.tar.gz`,
    `nexa-notes-${artifactVersion}-windows-x64-signed.zip`,
  ]) {
    writeFileSync(path.join(signed, name), `${name}\n`);
  }
  if (withCustody) {
    for (const name of [
      `nexa-notes-${artifactVersion}-macos-arm64-signed.tar.gz`,
      `nexa-notes-${artifactVersion}-windows-x64-signed.zip`,
    ]) {
      const platform = name.endsWith(".tar.gz") ? "darwin" : "win32";
      const evidence = signedEvidence[platform];
      const inputEvidence = inputEvidenceForPlatform(platform);
      const inputSidecars = signingInputSidecars(inputEvidence);
      const record = {
        schemaVersion: 3,
        outcome: "signed",
        platform,
        source: {
          name: name.replace(
            platform === "darwin" ? "-signed.tar.gz" : "-signed.zip",
            platform === "darwin" ? "-unsigned.tar.gz" : "-unsigned.zip",
          ),
          sha256: "b".repeat(64),
          revision,
        },
        inputEvidence,
        derived: {
          name,
          sha256: createHash("sha256")
            .update(readFileSync(path.join(signed, name)))
            .digest("hex"),
        },
        archive: {
          format: platform === "darwin" ? "tar.gz" : "zip",
          binaries: [
            {
              relative: platform === "darwin" ? "Nexa.app/Contents/MacOS/Nexa" : "Nexa/Nexa.exe",
              depth: 4,
            },
          ],
          freshVerification: true,
          launchObservationMs: 5000,
        },
        evidence,
        executor: {
          version: signingPolicy.execution.reviewedExecutor.version,
          sha256: signingPolicy.execution.reviewedExecutor.sha256,
          closureSha256: signingPolicy.execution.reviewedExecutor.closure.sha256,
        },
      };
      writeFileSync(
        path.join(signed, `${name}.custody.json`),
        `${JSON.stringify(record, null, 2)}\n`,
      );
      for (const evidenceName of evidence) {
        let content = `${evidenceName} verified\n`;
        if (Object.hasOwn(inputSidecars, evidenceName)) content = inputSidecars[evidenceName];
        if (evidenceName === "SHA256SUMS") content = `${record.derived.sha256}  ${name}\n`;
        if (evidenceName === "sbom.cdx.json") {
          content = `${JSON.stringify({
            bomFormat: "CycloneDX",
            specVersion: "1.6",
            version: 1,
            metadata: {
              component: {
                type: "application",
                name,
                version: artifactVersion,
                hashes: [{ alg: "SHA-256", content: record.derived.sha256 }],
              },
            },
          })}\n`;
        }
        if (evidenceName === "provenance.intoto.jsonl") {
          content = `${JSON.stringify({
            _type: "https://in-toto.io/Statement/v1",
            subject: [{ name, digest: { sha256: record.derived.sha256 } }],
            predicateType: "https://slsa.dev/provenance/v1",
            predicate: {
              buildDefinition: {
                buildType: "https://nexa-ui.dev/build-types/signing/v1",
                externalParameters: {
                  platform,
                  revision,
                  source: record.source,
                  inputEvidence,
                  executor: record.executor,
                },
                resolvedDependencies: [
                  { uri: record.source.name, digest: { sha256: record.source.sha256 } },
                  {
                    uri: `g6-05/${inputEvidence.descriptor.name}`,
                    digest: { sha256: inputEvidence.descriptor.sha256 },
                  },
                  ...inputEvidence.outputs.map(({ name: inputName, sha256 }) => ({
                    uri: `g6-05/${inputName}`,
                    digest: { sha256 },
                  })),
                ],
              },
              runDetails: { builder: { id: ".github/workflows/signing.yml" } },
            },
          })}\n`;
        }
        writeFileSync(path.join(signed, `${name}.${evidenceName}`), content);
      }
    }
  }
  writeArtifactManifest({
    directory: npm,
    artifactClass: "npm-publish-train",
    revision,
    version: "0.1.0",
    producer: {
      workflow: ".github/workflows/release.yml",
      runId: "101",
    },
  });
  writeArtifactManifest({
    directory: signed,
    artifactClass: "signed-release-artifacts",
    revision,
    version: "0.1.0",
    producer: {
      workflow: ".github/workflows/signing.yml",
      runId: "202",
    },
  });
  return { npm, signed };
}

test("publication consumes the revision-bound npm train and both signed platform archives", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { npm, signed } = createTransportFixture(root);

  const plan = collectPublishArtifacts({
    artifactsDirectory: npm,
    signedArtifactsDirectory: signed,
    revision,
    npmRunId: "101",
    signedRunId: "202",
  });
  assert.equal(plan.tarballs.length, release.npm.public.length);
  assert.deepEqual(plan.signedArtifacts.map(({ name }) => name).sort(), [
    "nexa-notes-0.1.0-macos-arm64-signed.tar.gz",
    "nexa-notes-0.1.0-windows-x64-signed.zip",
  ]);
});

test("signed transport can be independently verified before readiness evidence is recorded", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-signed-verifier-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { signed } = createTransportFixture(root);

  assert.equal(
    verifySignedReleaseArtifacts({
      signedArtifactsDirectory: signed,
      revision,
      signedRunId: "202",
    }).length,
    2,
  );

  const result = spawnSync(
    process.execPath,
    [
      new URL("./publish-release.mjs", import.meta.url).pathname,
      "verify-signed",
      "--signed-artifacts",
      signed,
      "--revision",
      revision,
      "--signed-run-id",
      "202",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verified.length, 2);
});

test("signing producer builds the publisher manifest through API and CLI", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-signed-producer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { signed } = createTransportFixture(root);
  rmSync(path.join(signed, "signed-release-artifacts.manifest.json"));

  const manifest = buildSignedReleaseArtifactManifest({
    signedArtifactsDirectory: signed,
    revision,
    runId: "202",
  });
  assert.equal(manifest.artifactClass, "signed-release-artifacts");
  assert.equal(manifest.producer.workflow, ".github/workflows/signing.yml");
  assert.equal(manifest.producer.runId, "202");
  assert.equal(
    verifySignedReleaseArtifacts({
      signedArtifactsDirectory: signed,
      revision,
      signedRunId: "202",
    }).length,
    2,
  );

  rmSync(path.join(signed, "signed-release-artifacts.manifest.json"));
  const result = spawnSync(
    process.execPath,
    [
      new URL("./publish-release.mjs", import.meta.url).pathname,
      "build-signed-manifest",
      "--signed-artifacts",
      signed,
      "--revision",
      revision,
      "--run-id",
      "202",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(readFileSync(path.join(signed, "signed-release-artifacts.manifest.json"), "utf8"))
      .producer.runId,
    "202",
  );
});

test("signed transport rejects archives from a version other than the manifest train", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-version-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { signed } = createTransportFixture(root, { artifactVersion: "0.2.0" });
  assert.throws(
    () =>
      verifySignedReleaseArtifacts({
        signedArtifactsDirectory: signed,
        revision,
        signedRunId: "202",
      }),
    /version/u,
  );
});

test("transport verification rejects changed bytes and an artifact from another run", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { npm, signed } = createTransportFixture(root);

  writeFileSync(path.join(npm, "nexa-cli-0.1.0.tgz"), "tampered!\n");
  assert.throws(
    () =>
      collectPublishArtifacts({
        artifactsDirectory: npm,
        signedArtifactsDirectory: signed,
        revision,
        npmRunId: "101",
        signedRunId: "202",
      }),
    /digest mismatch/u,
  );

  rmSync(npm, { recursive: true, force: true });
  const fixture = createTransportFixture(path.join(root, "second"));
  assert.throws(
    () =>
      collectPublishArtifacts({
        artifactsDirectory: fixture.npm,
        signedArtifactsDirectory: fixture.signed,
        revision,
        npmRunId: "101",
        signedRunId: "wrong-run",
      }),
    /producer runId/u,
  );
});

test("signed publication rejects archives that have no executor custody proof", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createTransportFixture(root, { withCustody: false });
  assert.throws(
    () =>
      collectPublishArtifacts({
        artifactsDirectory: fixture.npm,
        signedArtifactsDirectory: fixture.signed,
        revision,
        npmRunId: "101",
        signedRunId: "202",
      }),
    /custody record/u,
  );
});

test("signed publication verifies regenerated integrity evidence semantically", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createTransportFixture(root);
  const archive = "nexa-notes-0.1.0-macos-arm64-signed.tar.gz";
  writeFileSync(
    path.join(fixture.signed, `${archive}.SHA256SUMS`),
    `${"0".repeat(64)}  ${archive}\n`,
  );
  rmSync(path.join(fixture.signed, "signed-release-artifacts.manifest.json"));
  writeArtifactManifest({
    directory: fixture.signed,
    artifactClass: "signed-release-artifacts",
    revision,
    version: "0.1.0",
    producer: { workflow: ".github/workflows/signing.yml", runId: "202" },
  });
  assert.throws(
    () =>
      collectPublishArtifacts({
        artifactsDirectory: fixture.npm,
        signedArtifactsDirectory: fixture.signed,
        revision,
        npmRunId: "101",
        signedRunId: "202",
      }),
    /SHA256SUMS does not match/u,
  );
});

test("signed publication verifies the self-contained G6-05 evidence bytes", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-input-bytes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createTransportFixture(root);
  const archive = "nexa-notes-0.1.0-macos-arm64-signed.tar.gz";
  writeFileSync(path.join(fixture.signed, `${archive}.g6-05-sbom.cdx.json`), "substituted\n");
  rmSync(path.join(fixture.signed, "signed-release-artifacts.manifest.json"));
  writeArtifactManifest({
    directory: fixture.signed,
    artifactClass: "signed-release-artifacts",
    revision,
    version: "0.1.0",
    producer: { workflow: ".github/workflows/signing.yml", runId: "202" },
  });

  assert.throws(
    () =>
      verifySignedReleaseArtifacts({
        signedArtifactsDirectory: fixture.signed,
        revision,
        signedRunId: "202",
      }),
    /G6-05 sbom\.cdx\.json digest/u,
  );
});

test("signed publication rejects a custody record with substituted G6-05 input evidence", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-input-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createTransportFixture(root);
  const archive = "nexa-notes-0.1.0-macos-arm64-signed.tar.gz";
  const custodyFile = path.join(fixture.signed, `${archive}.custody.json`);
  const custody = JSON.parse(readFileSync(custodyFile, "utf8"));
  custody.inputEvidence.bundleSha256 = "0".repeat(64);
  writeFileSync(custodyFile, `${JSON.stringify(custody, null, 2)}\n`);
  rmSync(path.join(fixture.signed, "signed-release-artifacts.manifest.json"));
  writeArtifactManifest({
    directory: fixture.signed,
    artifactClass: "signed-release-artifacts",
    revision,
    version: "0.1.0",
    producer: { workflow: ".github/workflows/signing.yml", runId: "202" },
  });

  assert.throws(
    () =>
      verifySignedReleaseArtifacts({
        signedArtifactsDirectory: fixture.signed,
        revision,
        signedRunId: "202",
      }),
    /inputEvidence bundle digest/u,
  );
});

test("signed publication requires exactly two G6-05 input artifacts", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-input-count-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createTransportFixture(root, {
    inputEvidenceForPlatform: () => signingInputEvidence({ artifactCount: 1 }),
  });

  assert.throws(
    () =>
      verifySignedReleaseArtifacts({
        signedArtifactsDirectory: fixture.signed,
        revision,
        signedRunId: "202",
      }),
    /exactly two G6-05 artifacts/u,
  );
});

test("signed publication requires both platforms to bind the same G6-05 input bundle", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-publish-cross-platform-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createTransportFixture(root, {
    inputEvidenceForPlatform: (platform) => signingInputEvidence({ descriptorSeed: platform }),
  });

  assert.throws(
    () =>
      verifySignedReleaseArtifacts({
        signedArtifactsDirectory: fixture.signed,
        revision,
        signedRunId: "202",
      }),
    /same G6-05 descriptor, outputs, and bundle/u,
  );
});

test("registry train can resume only a digest-matching dependency prefix", () => {
  const packages = ["protocol", "system-host", "nui-host"].map((name) => ({
    name: `@nexa/${name}`,
    version: "0.1.0",
    integrity: sha512Integrity(name),
  }));
  const observed = packages.map((entry, index) => ({
    name: entry.name,
    version: entry.version,
    integrity: index === 0 ? entry.integrity : null,
    channelVersion: null,
  }));

  assert.throws(() => evaluateRegistryTrain({ packages, observed, resume: false }), /--resume/u);
  assert.deepEqual(evaluateRegistryTrain({ packages, observed, resume: true }), {
    state: "resume",
    published: ["@nexa/protocol"],
    remaining: ["@nexa/system-host", "@nexa/nui-host"],
    promotions: ["@nexa/protocol", "@nexa/system-host", "@nexa/nui-host"],
  });

  const gap = structuredClone(observed);
  gap[0].integrity = null;
  gap[1].integrity = packages[1].integrity;
  assert.throws(
    () => evaluateRegistryTrain({ packages, observed: gap, resume: true }),
    /non-prefix/u,
  );

  const substituted = structuredClone(observed);
  substituted[0].integrity = sha512Integrity("different bytes");
  assert.throws(
    () => evaluateRegistryTrain({ packages, observed: substituted, resume: true }),
    /integrity mismatch/u,
  );
});

test("publication phases separate one-time staging from final channel promotion", () => {
  assert.deepEqual(resolvePublicationPhase({ phase: "bootstrap", version: "0.1.0", revision }), {
    phase: "bootstrap",
    targetTag: `technical-preview-staging-${revision.slice(0, 12)}`,
    publishMissing: true,
    promoteChannel: false,
  });
  assert.deepEqual(resolvePublicationPhase({ phase: "final", version: "0.1.0", revision }), {
    phase: "final",
    targetTag: "technical-preview",
    publishMissing: false,
    promoteChannel: true,
  });
  assert.throws(
    () => resolvePublicationPhase({ phase: "bootstrap", version: "0.1.1", revision }),
    /limited to 0\.1\.0/u,
  );
  assert.throws(
    () => resolvePublicationPhase({ phase: "candidate", version: "0.1.0", revision }),
    /phase must be bootstrap or final/u,
  );
});

test("final publication cannot create versions that bootstrap has not staged", () => {
  const packages = ["protocol", "ui"].map((name) => ({
    name: `@nexa/${name}`,
    version: "0.1.0",
    integrity: sha512Integrity(name),
  }));
  const missing = packages.map((entry) => ({
    ...entry,
    integrity: null,
    channelVersion: null,
  }));
  assert.equal(
    evaluatePublicationRegistry({
      phase: "bootstrap",
      packages,
      observed: missing,
    }).state,
    "new",
  );
  assert.throws(
    () =>
      evaluatePublicationRegistry({
        phase: "final",
        packages,
        observed: missing,
      }),
    /final publication cannot create registry versions/u,
  );
  const partial = packages.map((entry, index) => ({
    ...entry,
    integrity: index === 0 ? entry.integrity : null,
    channelVersion: null,
  }));
  assert.throws(
    () =>
      evaluatePublicationRegistry({
        phase: "final",
        packages,
        observed: partial,
      }),
    /final publication cannot create registry versions/u,
  );
  assert.throws(
    () =>
      evaluatePublicationRegistry({
        phase: "final",
        packages,
        observed: packages.map((entry) => ({ ...entry, channelVersion: null })),
        resume: true,
      }),
    /--resume is bootstrap-only/u,
  );
});

test("a complete train resumes channel promotion without republishing versions", () => {
  const packages = ["protocol", "system-host"].map((name) => ({
    name: `@nexa/${name}`,
    version: "0.1.0",
    integrity: sha512Integrity(name),
  }));
  const observed = packages.map((entry, index) => ({
    name: entry.name,
    version: entry.version,
    integrity: entry.integrity,
    channelVersion: index === 0 ? "0.1.0" : "0.0.9",
  }));
  assert.deepEqual(evaluateRegistryTrain({ packages, observed, resume: true }), {
    state: "complete",
    published: ["@nexa/protocol", "@nexa/system-host"],
    remaining: [],
    promotions: ["@nexa/system-host"],
  });
});

test("protected release consumes external evidence and signed artifacts without rebuilding", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  );
  assert.equal(workflow.on.workflow_dispatch.inputs.evidence_run_id.required, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.signing_run_id.required, false);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, [
    "validate",
    "bootstrap-publication",
    "request-publication",
  ]);
  assert.equal(workflow.jobs.publish.environment, "technical-preview-release");
  assert.equal(workflow.jobs.publish.permissions.actions, "read");

  const buildCommands = workflow.jobs["build-train"].steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(buildCommands, /pnpm release:build/u);
  assert.match(buildCommands, /build-artifacts[\s\S]*--revision/u);

  const publishDownloads = workflow.jobs.publish.steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  const signedDownload = publishDownloads.find(
    (step) => step.with?.name === "signed-release-artifacts",
  );
  const evidenceDownload = publishDownloads.find(
    (step) => step.with?.name === "release-readiness-evidence-${{ env.PUBLICATION_PHASE }}",
  );
  assert.equal(signedDownload.with["run-id"], "${{ inputs.signing_run_id }}");
  assert.equal(evidenceDownload.with["run-id"], "${{ inputs.evidence_run_id }}");
  assert.equal(signedDownload.with["github-token"], "${{ github.token }}");

  const readinessCommands = workflow.jobs.readiness.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(readinessCommands, /release-readiness-bundle\.mjs validate-run/u);
  assert.match(readinessCommands, /\.github\/workflows\/release-evidence\.yml/u);
  assert.match(readinessCommands, /\.github\/workflows\/signing\.yml/u);
  assert.match(readinessCommands, /--events workflow_dispatch/u);

  const publishCommands = workflow.jobs.publish.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(publishCommands, /release-readiness\.mjs readiness[\s\S]*--root/u);
  assert.match(
    publishCommands,
    /release-readiness\.mjs readiness[\s\S]*--phase "\$PUBLICATION_PHASE"/u,
  );
  assert.match(
    publishCommands,
    /publish-release\.mjs publish --execute[\s\S]*--phase "\$PUBLICATION_PHASE"/u,
  );
  assert.doesNotMatch(publishCommands, /pnpm release:build/u);
});

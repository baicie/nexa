import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { releaseReadinessPhase, validateReleaseReadinessPolicy } from "./release-readiness.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MANIFEST_NAMES = Object.freeze({
  "npm-publish-train": "npm-publish-train.manifest.json",
  "signed-release-artifacts": "signed-release-artifacts.manifest.json",
});
const PRODUCER_WORKFLOWS = Object.freeze({
  "npm-publish-train": ".github/workflows/release.yml",
  "signed-release-artifacts": ".github/workflows/signing.yml",
});
const RELEASE_CHANNEL = "technical-preview";
const SIGNED_EVIDENCE = Object.freeze({
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
});
const G6_05_OUTPUTS = Object.freeze(["SHA256SUMS", "provenance.intoto.jsonl", "sbom.cdx.json"]);

function fail(message) {
  throw new Error(`Release publication contract: ${message}`);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  return value;
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

function sha512Integrity(file) {
  return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

function evidenceBundleDigest(artifactCount, descriptor, outputs) {
  const hash = createHash("sha256");
  hash.update(`artifact-count\0${artifactCount}\0`, "utf8");
  for (const entry of [descriptor, ...outputs]) {
    hash.update(entry.name, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.sha256, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function runPublicationCommand(command, args, { cwd = ROOT, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function runResult(command, args, { cwd = ROOT } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function packageEntries() {
  const release = readJson("release/packages.json");
  if (!Array.isArray(release.npm?.public) || release.npm.public.length === 0) {
    fail("release/packages.json has no public npm packages");
  }
  return release.npm.public.map((entry) => {
    const manifestPath = path.join(ROOT, entry.path, "package.json");
    if (!existsSync(manifestPath)) fail(`${entry.name} manifest is missing`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== entry.name) fail(`${entry.name} manifest name drift`);
    if (manifest.private === true) fail(`${entry.name} is still private`);
    if (manifest.publishConfig?.access !== "public") fail(`${entry.name} must publish publicly`);
    return { ...entry, manifest };
  });
}

function publicationEntries() {
  const entries = packageEntries();
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(entry) {
    if (visited.has(entry.name)) return;
    if (visiting.has(entry.name)) fail(`public package dependency cycle at ${entry.name}`);
    visiting.add(entry.name);
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {}).sort()) {
      const dependencyEntry = byName.get(dependency);
      if (dependencyEntry) visit(dependencyEntry);
    }
    visiting.delete(entry.name);
    visited.add(entry.name);
    ordered.push(entry);
  }

  for (const entry of entries) visit(entry);
  return ordered;
}

function assertTag(version, ref = process.env.GITHUB_REF) {
  if (ref !== `refs/tags/v${version}`)
    fail(`publication requires refs/tags/v${version}, got ${ref || "unset"}`);
}

function assertCleanSource() {
  const status = runPublicationCommand("git", ["status", "--porcelain"]);
  if (status !== "") fail("publication requires a clean source checkout");
}

function expectedTarballName(entry) {
  return `${entry.name.replace(/^@nexa\//u, "nexa-")}-${entry.manifest.version}.tgz`;
}

function requireRevision(revision, label = "revision") {
  if (!REVISION_PATTERN.test(revision ?? "")) fail(`${label} must be a full commit SHA`);
  return revision;
}

function requireArtifactName(name, label) {
  requireString(name, label);
  if (
    path.basename(name) !== name ||
    name.includes("\\") ||
    /[\0\r\n]/u.test(name) ||
    name === "." ||
    name === ".."
  ) {
    fail(`${label} must be a portable file name`);
  }
  return name;
}

function listTransportFiles(directory, manifestName) {
  if (!directory || !existsSync(directory)) {
    fail(`artifact directory is missing: ${directory || "unset"}`);
  }
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    fail(`artifact directory must be a regular directory: ${directory}`);
  }
  return readdirSync(directory)
    .filter((name) => name !== manifestName)
    .sort()
    .map((name) => {
      requireArtifactName(name, "artifact name");
      const file = path.join(directory, name);
      const metadata = lstatSync(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        fail(`artifact is not a regular file: ${name}`);
      }
      return { name, file, size: metadata.size, sha256: sha256(file) };
    });
}

function validateProducer(producer, artifactClass, expectedRunId) {
  exactKeys(producer, ["workflow", "runId"], "artifact manifest producer");
  if (producer.workflow !== PRODUCER_WORKFLOWS[artifactClass]) {
    fail(`artifact manifest producer workflow must be ${PRODUCER_WORKFLOWS[artifactClass]}`);
  }
  requireString(producer.runId, "artifact manifest producer runId");
  if (expectedRunId !== undefined && producer.runId !== String(expectedRunId)) {
    fail(`artifact manifest producer runId does not match ${expectedRunId}`);
  }
}

export function writeArtifactManifest({ directory, artifactClass, revision, version, producer }) {
  const manifestName = MANIFEST_NAMES[artifactClass];
  if (!manifestName) fail(`unknown artifact class: ${artifactClass}`);
  requireRevision(revision);
  requireString(version, "artifact manifest version");
  validateProducer(producer, artifactClass);
  const files = listTransportFiles(directory, manifestName).map(
    ({ name, size, sha256: digest }) => ({
      name,
      size,
      sha256: digest,
    }),
  );
  if (files.length === 0) fail("artifact manifest cannot describe an empty transport");
  const manifest = {
    schemaVersion: 1,
    artifactClass,
    version,
    revision,
    producer,
    files,
  };
  writeFileSync(path.join(directory, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return manifest;
}

function verifyArtifactManifest({ directory, artifactClass, revision, version, runId }) {
  const manifestName = MANIFEST_NAMES[artifactClass];
  if (!manifestName) fail(`unknown artifact class: ${artifactClass}`);
  const manifestPath = path.join(directory, manifestName);
  let manifest;
  try {
    const metadata = lstatSync(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail("artifact manifest must be regular");
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${manifestName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  exactKeys(
    manifest,
    ["schemaVersion", "artifactClass", "version", "revision", "producer", "files"],
    "artifact manifest",
  );
  if (manifest.schemaVersion !== 1) fail("artifact manifest schemaVersion must be 1");
  if (manifest.artifactClass !== artifactClass) fail("artifact manifest class does not match");
  if (manifest.version !== version) fail(`artifact manifest version does not match ${version}`);
  if (manifest.revision !== revision) fail(`artifact manifest revision does not match ${revision}`);
  validateProducer(manifest.producer, artifactClass, runId);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail("artifact manifest files must be a non-empty array");
  }
  const expected = manifest.files.map((entry, index) => {
    exactKeys(entry, ["name", "size", "sha256"], `artifact manifest files[${index}]`);
    requireArtifactName(entry.name, `artifact manifest files[${index}].name`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      fail(`artifact manifest files[${index}].size must be a non-negative safe integer`);
    }
    if (!SHA256_PATTERN.test(entry.sha256)) {
      fail(`artifact manifest files[${index}].sha256 must be SHA-256`);
    }
    return entry;
  });
  const expectedNames = expected.map(({ name }) => name);
  if (new Set(expectedNames).size !== expectedNames.length) {
    fail("artifact manifest contains duplicate file names");
  }
  const sortedNames = [...expectedNames].sort();
  if (expectedNames.some((name, index) => name !== sortedNames[index])) {
    fail("artifact manifest files must be sorted by name");
  }
  const actual = listTransportFiles(directory, manifestName);
  if (
    actual.length !== expected.length ||
    actual.some(({ name }, index) => name !== expected[index].name)
  ) {
    fail("artifact directory does not exactly match its manifest");
  }
  for (const [index, file] of actual.entries()) {
    if (file.size !== expected[index].size) fail(`artifact size mismatch: ${file.name}`);
    if (file.sha256 !== expected[index].sha256) fail(`artifact digest mismatch: ${file.name}`);
  }
  return actual;
}

function signedSidecar(byName, archiveName, evidenceName) {
  const transportName = `${archiveName}.${evidenceName}`;
  const evidence = byName.get(transportName);
  if (!evidence) fail(`signed archive is missing evidence sidecar: ${transportName}`);
  return evidence;
}

function parseSignedJson(byName, archiveName, evidenceName) {
  const evidence = signedSidecar(byName, archiveName, evidenceName);
  try {
    return JSON.parse(readFileSync(evidence.file, "utf8"));
  } catch (error) {
    fail(`${archiveName} ${evidenceName} is invalid JSON: ${error.message}`);
  }
}

function validateInputEvidence(inputEvidence, label) {
  exactKeys(
    inputEvidence,
    ["schemaVersion", "artifactCount", "descriptor", "outputs", "bundleSha256"],
    label,
  );
  if (inputEvidence.schemaVersion !== 1) fail(`${label} schemaVersion must be 1`);
  if (!Number.isSafeInteger(inputEvidence.artifactCount) || inputEvidence.artifactCount !== 2) {
    fail(`${label} must identify exactly two G6-05 artifacts`);
  }
  exactKeys(inputEvidence.descriptor, ["name", "sha256"], `${label} descriptor`);
  requireArtifactName(inputEvidence.descriptor.name, `${label} descriptor name`);
  if (!SHA256_PATTERN.test(inputEvidence.descriptor.sha256)) {
    fail(`${label} descriptor digest must be SHA-256`);
  }
  if (
    !Array.isArray(inputEvidence.outputs) ||
    inputEvidence.outputs.length !== G6_05_OUTPUTS.length
  ) {
    fail(`${label} outputs must contain the complete G6-05 evidence set`);
  }
  for (const [index, expectedName] of G6_05_OUTPUTS.entries()) {
    const output = inputEvidence.outputs[index];
    exactKeys(output, ["name", "sha256"], `${label} outputs[${index}]`);
    if (output.name !== expectedName || !SHA256_PATTERN.test(output.sha256)) {
      fail(`${label} outputs must contain the ordered G6-05 evidence set`);
    }
  }
  if (
    !SHA256_PATTERN.test(inputEvidence.bundleSha256) ||
    inputEvidence.bundleSha256 !==
      evidenceBundleDigest(
        inputEvidence.artifactCount,
        inputEvidence.descriptor,
        inputEvidence.outputs,
      )
  ) {
    fail(`${label} bundle digest does not match its descriptor and outputs`);
  }
  return inputEvidence;
}

function validateSignedIntegrityEvidence(byName, archive, record) {
  const inputEvidenceFiles = [
    ["g6-05-descriptor.json", record.inputEvidence.descriptor],
    ...record.inputEvidence.outputs.map((entry) => [`g6-05-${entry.name}`, entry]),
  ];
  for (const [evidenceName, binding] of inputEvidenceFiles) {
    const evidence = signedSidecar(byName, archive.name, evidenceName);
    if (evidence.sha256 !== binding.sha256) {
      fail(`${archive.name} G6-05 ${binding.name} digest does not match custody`);
    }
  }

  const sums = readFileSync(signedSidecar(byName, archive.name, "SHA256SUMS").file, "utf8");
  if (sums !== `${archive.sha256}  ${archive.name}\n`) {
    fail(`${archive.name} SHA256SUMS does not match the signed archive`);
  }

  const sbom = parseSignedJson(byName, archive.name, "sbom.cdx.json");
  const component = sbom?.metadata?.component;
  const versionPattern =
    record.platform === "darwin"
      ? /^.+-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-macos-(?:arm64|x64)-unsigned\.tar\.gz$/u
      : /^.+-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-windows-x64-unsigned\.zip$/u;
  const sourceVersion = record.source.name.match(versionPattern)?.[1];
  const componentHash = Array.isArray(component?.hashes)
    ? component.hashes.find(({ alg }) => alg === "SHA-256")
    : undefined;
  if (
    sbom?.bomFormat !== "CycloneDX" ||
    sbom?.specVersion !== "1.6" ||
    sbom?.version !== 1 ||
    component?.type !== "application" ||
    component?.name !== archive.name ||
    component?.version !== sourceVersion ||
    componentHash?.content !== archive.sha256
  ) {
    fail(`${archive.name} SBOM does not identify the signed archive`);
  }

  const statement = parseSignedJson(byName, archive.name, "provenance.intoto.jsonl");
  const subject = statement?.subject;
  const definition = statement?.predicate?.buildDefinition;
  const parameters = definition?.externalParameters;
  const dependency = definition?.resolvedDependencies;
  const expectedDependencies = [
    { uri: record.source.name, digest: { sha256: record.source.sha256 } },
    {
      uri: `g6-05/${record.inputEvidence.descriptor.name}`,
      digest: { sha256: record.inputEvidence.descriptor.sha256 },
    },
    ...record.inputEvidence.outputs.map(({ name, sha256: digest }) => ({
      uri: `g6-05/${name}`,
      digest: { sha256: digest },
    })),
  ];
  if (
    statement?._type !== "https://in-toto.io/Statement/v1" ||
    statement?.predicateType !== "https://slsa.dev/provenance/v1" ||
    !Array.isArray(subject) ||
    subject.length !== 1 ||
    subject[0]?.name !== archive.name ||
    subject[0]?.digest?.sha256 !== archive.sha256 ||
    definition?.buildType !== "https://nexa-ui.dev/build-types/signing/v1" ||
    parameters?.platform !== record.platform ||
    parameters?.revision !== record.source.revision ||
    parameters?.source?.name !== record.source.name ||
    parameters?.source?.sha256 !== record.source.sha256 ||
    parameters?.source?.revision !== record.source.revision ||
    JSON.stringify(parameters?.inputEvidence) !== JSON.stringify(record.inputEvidence) ||
    parameters?.executor?.version !== record.executor.version ||
    parameters?.executor?.sha256 !== record.executor.sha256 ||
    parameters?.executor?.closureSha256 !== record.executor.closureSha256 ||
    JSON.stringify(dependency) !== JSON.stringify(expectedDependencies) ||
    statement?.predicate?.runDetails?.builder?.id !== ".github/workflows/signing.yml"
  ) {
    fail(`${archive.name} provenance does not bind the signed archive and unsigned source`);
  }
}

function validateSignedCustody(transport, revision) {
  const signingPolicy = readJson("release/signing-policy.json");
  const releaseVersion = readJson("release/version.json").npmTrain;
  const byName = new Map(transport.map((entry) => [entry.name, entry]));
  const archives = transport.filter(
    ({ name }) => name.endsWith("-signed.tar.gz") || name.endsWith("-signed.zip"),
  );
  const consumed = new Set(archives.map(({ name }) => name));
  let sharedInputEvidenceBinding;
  for (const archive of archives) {
    const platform = archive.name.endsWith(".tar.gz") ? "darwin" : "win32";
    const expectedArchiveName =
      platform === "darwin"
        ? `nexa-notes-${releaseVersion}-macos-arm64-signed.tar.gz`
        : `nexa-notes-${releaseVersion}-windows-x64-signed.zip`;
    if (archive.name !== expectedArchiveName) {
      fail(`signed archive name or version does not match the release train: ${archive.name}`);
    }
    const custodyName = `${archive.name}.custody.json`;
    const custodyFile = byName.get(custodyName);
    if (!custodyFile) fail(`signed archive is missing custody record: ${custodyName}`);
    consumed.add(custodyName);
    let record;
    try {
      record = JSON.parse(readFileSync(custodyFile.file, "utf8"));
    } catch (error) {
      fail(`signed custody record is invalid JSON: ${error.message}`);
    }
    exactKeys(
      record,
      [
        "schemaVersion",
        "outcome",
        "platform",
        "source",
        "inputEvidence",
        "derived",
        "archive",
        "evidence",
        "executor",
      ],
      `custody record ${custodyName}`,
    );
    if (record.schemaVersion !== 3 || record.outcome !== "signed" || record.platform !== platform) {
      fail(`custody record does not prove a signed ${platform} outcome: ${custodyName}`);
    }
    exactKeys(record.source, ["name", "sha256", "revision"], `${custodyName} source`);
    if (record.source.revision !== revision || !SHA256_PATTERN.test(record.source.sha256)) {
      fail(`custody record source is not bound to revision ${revision}: ${custodyName}`);
    }
    const unsignedSuffix = platform === "darwin" ? "-unsigned.tar.gz" : "-unsigned.zip";
    const signedSuffix = platform === "darwin" ? "-signed.tar.gz" : "-signed.zip";
    if (record.source.name !== archive.name.replace(signedSuffix, unsignedSuffix)) {
      fail(`custody record source name does not match ${archive.name}`);
    }
    validateInputEvidence(record.inputEvidence, `${custodyName} inputEvidence`);
    const inputEvidenceBinding = JSON.stringify([
      record.inputEvidence.descriptor.name,
      record.inputEvidence.descriptor.sha256,
      record.inputEvidence.outputs.map(({ name, sha256: digest }) => [name, digest]),
      record.inputEvidence.bundleSha256,
    ]);
    if (sharedInputEvidenceBinding === undefined) sharedInputEvidenceBinding = inputEvidenceBinding;
    else if (inputEvidenceBinding !== sharedInputEvidenceBinding) {
      fail(
        "both platform custody records must bind the same G6-05 descriptor, outputs, and bundle",
      );
    }
    exactKeys(record.derived, ["name", "sha256"], `${custodyName} derived`);
    if (record.derived.name !== archive.name || record.derived.sha256 !== archive.sha256) {
      fail(`custody record digest does not match signed archive: ${archive.name}`);
    }
    exactKeys(
      record.archive,
      ["format", "binaries", "freshVerification", "launchObservationMs"],
      `${custodyName} archive`,
    );
    if (
      record.archive.format !== (platform === "darwin" ? "tar.gz" : "zip") ||
      record.archive.freshVerification !== true ||
      !Number.isSafeInteger(record.archive.launchObservationMs) ||
      record.archive.launchObservationMs < 5_000 ||
      !Array.isArray(record.archive.binaries) ||
      record.archive.binaries.length !== 1
    ) {
      fail(`custody record lacks fresh verification and launch proof: ${archive.name}`);
    }
    exactKeys(record.executor, ["version", "sha256", "closureSha256"], `${custodyName} executor`);
    if (
      record.executor.version !== signingPolicy.execution.reviewedExecutor.version ||
      record.executor.sha256 !== signingPolicy.execution.reviewedExecutor.sha256 ||
      record.executor.closureSha256 !== signingPolicy.execution.reviewedExecutor.closure.sha256
    ) {
      fail(`custody record is not bound to the reviewed signing closure: ${archive.name}`);
    }
    if (
      !Array.isArray(record.evidence) ||
      new Set(record.evidence).size !== record.evidence.length
    ) {
      fail(`custody record evidence must be a unique array: ${archive.name}`);
    }
    for (const required of SIGNED_EVIDENCE[platform]) {
      if (!record.evidence.includes(required)) {
        fail(`custody record is missing ${platform} evidence ${required}`);
      }
    }
    for (const evidenceName of record.evidence) {
      requireArtifactName(evidenceName, `${custodyName} evidence name`);
      const transportName = `${archive.name}.${evidenceName}`;
      const evidence = byName.get(transportName);
      if (!evidence) fail(`signed archive is missing evidence sidecar: ${transportName}`);
      consumed.add(transportName);
    }
    validateSignedIntegrityEvidence(byName, archive, record);
  }
  if (transport.some(({ name }) => !consumed.has(name))) {
    fail("signed artifact transport contains files not referenced by custody records");
  }
  return archives;
}

function assertPackageBuilt(entry) {
  const required =
    entry.name === "@nexa/cli"
      ? path.join(ROOT, entry.path, "dist", "bin.mjs")
      : path.join(ROOT, entry.path, "dist", "index.js");
  if (!existsSync(required)) fail(`${entry.name} release dist is missing; run pnpm release:build`);
  const metadata = lstatSync(required);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${entry.name} release entry must be a regular file`);
  }
}

export function buildImmutablePublishArtifacts({
  outputDirectory,
  revision = process.env.GITHUB_SHA,
  runId = process.env.GITHUB_RUN_ID,
}) {
  if (!outputDirectory) fail("outputDirectory is required");
  requireRevision(revision);
  requireString(runId, "producer runId");
  mkdirSync(outputDirectory, { recursive: false });
  for (const entry of publicationEntries()) {
    assertPackageBuilt(entry);
    const output = runPublicationCommand("pnpm", ["pack", "--pack-destination", outputDirectory], {
      cwd: path.join(ROOT, entry.path),
    });
    const expected = expectedTarballName(entry);
    if (!output.includes(expected) || !existsSync(path.join(outputDirectory, expected))) {
      fail(`${entry.name} did not produce the expected immutable tarball ${expected}`);
    }
  }
  writeArtifactManifest({
    directory: outputDirectory,
    artifactClass: "npm-publish-train",
    revision,
    version: readJson("release/version.json").npmTrain,
    producer: { workflow: PRODUCER_WORKFLOWS["npm-publish-train"], runId: String(runId) },
  });
  return outputDirectory;
}

export function collectPublishArtifacts({
  artifactsDirectory,
  signedArtifactsDirectory,
  revision,
  npmRunId,
  signedRunId,
}) {
  requireRevision(revision);
  const version = readJson("release/version.json").npmTrain;
  const entries = publicationEntries();
  const npmArtifacts = verifyArtifactManifest({
    directory: artifactsDirectory,
    artifactClass: "npm-publish-train",
    revision,
    version,
    runId: npmRunId,
  });
  if (npmArtifacts.some(({ name }) => !name.endsWith(".tgz"))) {
    fail("npm artifact manifest may contain only package tarballs");
  }
  const byName = new Map(npmArtifacts.map((artifact) => [artifact.name, artifact]));
  const tarballs = entries.map((entry) => {
    const name = expectedTarballName(entry);
    const artifact = byName.get(name);
    if (!artifact) fail(`missing immutable tarball for ${entry.name}: ${name}`);
    return { ...entry, tarball: artifact.file };
  });
  if (byName.size !== tarballs.length) fail("npm artifact directory contains unexpected tarballs");
  const signed = verifySignedReleaseArtifacts({
    signedArtifactsDirectory,
    revision,
    signedRunId,
  });
  return { tarballs, signedArtifacts: signed };
}

export function buildSignedReleaseArtifactManifest({
  signedArtifactsDirectory,
  revision,
  runId = process.env.GITHUB_RUN_ID,
}) {
  requireRevision(revision);
  requireString(runId, "producer runId");
  const manifestName = MANIFEST_NAMES["signed-release-artifacts"];
  const transport = listTransportFiles(signedArtifactsDirectory, manifestName);
  const signed = validateSignedCustody(transport, revision);
  if (signed.filter(({ name }) => name.endsWith("-signed.tar.gz")).length !== 1) {
    fail("signed artifact directory is missing a macOS signed archive");
  }
  if (signed.filter(({ name }) => name.endsWith("-signed.zip")).length !== 1) {
    fail("signed artifact directory is missing a Windows signed archive");
  }
  return writeArtifactManifest({
    directory: signedArtifactsDirectory,
    artifactClass: "signed-release-artifacts",
    revision,
    version: readJson("release/version.json").npmTrain,
    producer: { workflow: PRODUCER_WORKFLOWS["signed-release-artifacts"], runId: String(runId) },
  });
}

export function verifySignedReleaseArtifacts({ signedArtifactsDirectory, revision, signedRunId }) {
  requireRevision(revision);
  const version = readJson("release/version.json").npmTrain;
  const signedTransport = verifyArtifactManifest({
    directory: signedArtifactsDirectory,
    artifactClass: "signed-release-artifacts",
    revision,
    version,
    runId: signedRunId,
  });
  if (signedTransport.some(({ name }) => /-(?:unsigned|quarantine)(?:\.|-)/u.test(name))) {
    fail("signed artifact transport contains an unsigned or quarantine class");
  }
  const signed = validateSignedCustody(signedTransport, revision);
  const signedNames = signed.map(({ name }) => name);
  if (signedNames.filter((name) => name.endsWith("-signed.tar.gz")).length !== 1) {
    fail("signed artifact directory is missing a macOS signed archive");
  }
  if (signedNames.filter((name) => name.endsWith("-signed.zip")).length !== 1) {
    fail("signed artifact directory is missing a Windows signed archive");
  }
  return signed;
}

export function evaluateRegistryTrain({ packages, observed, resume = false }) {
  if (!Array.isArray(packages) || packages.length === 0) fail("registry train is empty");
  if (!Array.isArray(observed) || observed.length !== packages.length) {
    fail("registry observations must match the package train");
  }
  const published = [];
  const remaining = [];
  const promotions = [];
  let missingSeen = false;
  for (const [index, entry] of packages.entries()) {
    const state = observed[index];
    if (state?.name !== entry.name || state?.version !== entry.version) {
      fail(`registry observation does not match ${entry.name}@${entry.version}`);
    }
    if (state.integrity === null) {
      missingSeen = true;
      remaining.push(entry.name);
    } else {
      if (missingSeen) fail("registry contains a non-prefix partial publication");
      if (state.integrity !== entry.integrity) {
        fail(`registry integrity mismatch for ${entry.name}@${entry.version}`);
      }
      published.push(entry.name);
    }
    if (state.channelVersion !== entry.version) promotions.push(entry.name);
  }
  if (published.length > 0 && remaining.length > 0 && !resume) {
    fail("registry train is partial; inspect it and rerun with --resume");
  }
  return {
    state: remaining.length === 0 ? "complete" : published.length === 0 ? "new" : "resume",
    published,
    remaining,
    promotions,
  };
}

export function evaluatePublicationRegistry({ phase, packages, observed, resume = false }) {
  if (phase !== "bootstrap" && phase !== "final") {
    fail("phase must be bootstrap or final");
  }
  if (phase === "final" && resume) fail("--resume is bootstrap-only");
  const registry = evaluateRegistryTrain({
    packages,
    observed,
    resume: phase === "final" ? true : resume,
  });
  if (phase === "final" && registry.remaining.length > 0) {
    fail("final publication cannot create registry versions; run the controlled bootstrap first");
  }
  return registry;
}

function parseRegistryJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(
      `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function registryNotFound(result) {
  return /(?:ERR_PNPM_FETCH_404|E404|404 Not Found)/iu.test(`${result.stderr}\n${result.stdout}`);
}

function registryObservation(entry, channel) {
  const version = `${entry.name}@${entry.manifest.version}`;
  const integrityResult = runResult("pnpm", ["view", version, "dist.integrity", "--json"]);
  let integrity = null;
  if (integrityResult.status === 0) {
    integrity = parseRegistryJson(integrityResult.stdout, `${version} integrity`);
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      fail(`${version} registry integrity is missing or unsupported`);
    }
  } else if (!registryNotFound(integrityResult)) {
    fail(`${version} registry lookup failed: ${integrityResult.stderr || integrityResult.stdout}`);
  }

  const tagsResult = runResult("pnpm", ["view", entry.name, "dist-tags", "--json"]);
  let channelVersion = null;
  if (tagsResult.status === 0) {
    const tags = parseRegistryJson(tagsResult.stdout, `${entry.name} dist-tags`);
    if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
      fail(`${entry.name} dist-tags must be an object`);
    }
    if (tags[channel] !== undefined) {
      channelVersion = requireString(tags[channel], `${entry.name} ${channel} channel`);
    }
  } else if (!registryNotFound(tagsResult)) {
    fail(`${entry.name} dist-tag lookup failed: ${tagsResult.stderr || tagsResult.stdout}`);
  }
  return { name: entry.name, version: entry.manifest.version, integrity, channelVersion };
}

export function resolvePublicationPhase({ phase = "final", version, revision }) {
  requireRevision(revision);
  const policy = validateReleaseReadinessPolicy(readJson("release/readiness-policy.json"));
  const configured = releaseReadinessPhase(policy, phase);
  if (phase === "bootstrap" && version !== configured.oneTimeVersion) {
    fail(`bootstrap publication is limited to ${configured.oneTimeVersion}`);
  }
  if (version !== policy.version) fail(`publication version must be ${policy.version}`);
  return {
    phase,
    targetTag:
      configured.tagStrategy === "revision-staging"
        ? `${policy.channel}-staging-${revision.slice(0, 12)}`
        : policy.channel,
    publishMissing: phase === "bootstrap",
    promoteChannel: configured.promoteChannel,
  };
}

export function publicationPlan({ version = readJson("release/version.json").npmTrain, ref } = {}) {
  const entries = packageEntries();
  assertTag(version, ref ?? process.env.GITHUB_REF);
  return {
    version,
    ref: ref ?? process.env.GITHUB_REF,
    packages: entries.map(({ name, path: packagePath, manifest }) => ({
      name,
      path: packagePath,
      version: manifest.version,
      access: manifest.publishConfig.access,
    })),
  };
}

export function publishRelease({
  execute = false,
  resume = false,
  phase = "final",
  revision = process.env.GITHUB_SHA,
  ref = process.env.GITHUB_REF,
  artifactsDirectory = process.env.NEXA_RELEASE_ARTIFACTS,
  signedArtifactsDirectory = process.env.NEXA_SIGNED_ARTIFACTS,
  npmRunId = process.env.GITHUB_RUN_ID,
  signedRunId = process.env.NEXA_SIGNING_RUN_ID,
} = {}) {
  const versionPolicy = readJson("release/version.json");
  assertTag(versionPolicy.npmTrain, ref);
  if (!/^[0-9a-f]{40}$/u.test(revision ?? "")) fail("revision must be a full commit SHA");
  const publicationPhase = resolvePublicationPhase({
    phase,
    version: versionPolicy.npmTrain,
    revision,
  });
  if (phase === "final" && resume) fail("--resume is bootstrap-only");
  assertCleanSource();
  const authorization = process.env.NEXA_RELEASE_AUTHORIZATION;
  if (execute && authorization !== revision) {
    fail("NEXA_RELEASE_AUTHORIZATION must equal the checked-out revision");
  }
  if (!artifactsDirectory || !signedArtifactsDirectory) {
    fail("publication requires downloaded immutable npm and signed artifact directories");
  }
  const { tarballs, signedArtifacts } = collectPublishArtifacts({
    artifactsDirectory,
    signedArtifactsDirectory,
    revision,
    npmRunId,
    signedRunId,
  });
  const plan = {
    version: versionPolicy.npmTrain,
    revision,
    ref,
    phase: publicationPhase.phase,
    packages: tarballs.map(({ name, manifest, tarball }) => ({
      name,
      version: manifest.version,
      tarball,
      integrity: sha512Integrity(tarball),
    })),
    signedArtifacts: signedArtifacts.map(({ name }) => name),
    channel: RELEASE_CHANNEL,
    targetTag: publicationPhase.targetTag,
    promotesPublicChannel: publicationPhase.promoteChannel,
    resume,
    executed: execute,
  };
  if (!execute) return plan;

  // npm has no multi-package transaction. Every tarball is validated before the
  // first mutation, and an interrupted dependency-ordered staging train can only
  // continue through an explicit digest-matching --resume operation.
  for (const { tarball } of tarballs) {
    runPublicationCommand("pnpm", [
      "publish",
      tarball,
      "--access",
      "public",
      "--provenance",
      "--no-git-checks",
      "--tag",
      publicationPhase.targetTag,
      "--dry-run",
    ]);
  }
  const packages = plan.packages.map(({ name, version, integrity }) => ({
    name,
    version,
    integrity,
  }));
  let registryPlan = evaluatePublicationRegistry({
    phase,
    packages,
    observed: tarballs.map((entry) => registryObservation(entry, publicationPhase.targetTag)),
    resume,
  });
  if (publicationPhase.publishMissing) {
    try {
      for (const entry of tarballs.filter(({ name }) => registryPlan.remaining.includes(name))) {
        runPublicationCommand(
          "pnpm",
          [
            "publish",
            entry.tarball,
            "--access",
            "public",
            "--provenance",
            "--no-git-checks",
            "--tag",
            publicationPhase.targetTag,
          ],
          { inherit: true },
        );
      }
    } catch (error) {
      fail(
        `registry staging train may be partial; stop, inspect digests, then rerun with --resume: ${error.message}`,
      );
    }
  }
  registryPlan = evaluatePublicationRegistry({
    phase,
    packages,
    observed: tarballs.map((entry) => registryObservation(entry, publicationPhase.targetTag)),
    resume: phase === "bootstrap",
  });
  if (registryPlan.remaining.length !== 0) fail("registry staging train did not converge");
  try {
    for (const entry of tarballs.filter(({ name }) => registryPlan.promotions.includes(name))) {
      runPublicationCommand("pnpm", [
        "dist-tag",
        "add",
        `${entry.name}@${entry.manifest.version}`,
        publicationPhase.targetTag,
      ]);
    }
  } catch (error) {
    fail(
      `${publicationPhase.targetTag} promotion may be partial; inspect the immutable train and rerun the same phase: ${error.message}`,
    );
  }
  const convergedRegistry = evaluatePublicationRegistry({
    phase,
    packages,
    observed: tarballs.map((entry) => registryObservation(entry, publicationPhase.targetTag)),
    resume: phase === "bootstrap",
  });
  if (convergedRegistry.promotions.length !== 0) {
    fail(`${publicationPhase.targetTag} channel promotion did not converge`);
  }
  return { ...plan, registry: convergedRegistry };
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail(`missing value for ${arg}`);
      options[key] = value;
    } else fail(`unknown argument ${arg}`);
  }
  return options;
}

function main() {
  const command = process.argv[2] ?? "plan";
  const options = parseOptions(process.argv.slice(3));
  if (command === "plan") {
    const plan = publicationPlan({
      version: options.version,
      ref: options.ref ?? process.env.GITHUB_REF,
    });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (command === "publish") {
    const plan = publishRelease({
      execute: options.execute === true,
      resume: options.resume === true,
      phase: options.phase ?? "final",
      revision: options.revision ?? process.env.GITHUB_SHA,
      ref: options.ref ?? process.env.GITHUB_REF,
      artifactsDirectory: options.artifacts,
      signedArtifactsDirectory: options["signed-artifacts"],
      npmRunId: options["npm-run-id"] ?? process.env.GITHUB_RUN_ID,
      signedRunId: options["signed-run-id"] ?? process.env.NEXA_SIGNING_RUN_ID,
    });
    const output = `${JSON.stringify(plan, null, 2)}\n`;
    if (options.output) {
      const outputFile = path.resolve(options.output);
      mkdirSync(path.dirname(outputFile), { recursive: true });
      writeFileSync(outputFile, output, { flag: "wx" });
    } else {
      process.stdout.write(output);
    }
    return;
  }
  if (command === "build-artifacts") {
    buildImmutablePublishArtifacts({
      outputDirectory: path.resolve(options.output),
      revision: options.revision ?? process.env.GITHUB_SHA,
      runId: options["run-id"] ?? process.env.GITHUB_RUN_ID,
    });
    console.log(`immutable publish artifacts built at ${options.output}`);
    return;
  }
  if (command === "build-signed-manifest") {
    const manifest = buildSignedReleaseArtifactManifest({
      signedArtifactsDirectory: options["signed-artifacts"],
      revision: options.revision ?? process.env.GITHUB_SHA,
      runId: options["run-id"] ?? process.env.GITHUB_RUN_ID,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (command === "verify-signed") {
    const signed = verifySignedReleaseArtifacts({
      signedArtifactsDirectory: options["signed-artifacts"],
      revision: options.revision ?? process.env.GITHUB_SHA,
      signedRunId: options["signed-run-id"] ?? process.env.NEXA_SIGNING_RUN_ID,
    });
    console.log(
      JSON.stringify(
        { verified: signed.map(({ name, sha256: digest }) => ({ name, sha256: digest })) },
        null,
        2,
      ),
    );
    return;
  }
  console.error(
    "Usage: node tools/publish-release.mjs plan|build-artifacts|build-signed-manifest|verify-signed|publish [--execute] [--resume] [--phase bootstrap|final] [--version V] [--revision SHA] [--ref TAG] [--run-id ID] [--npm-run-id ID] [--signed-run-id ID] [--output FILE_OR_DIR] [--artifacts DIR] [--signed-artifacts DIR] [--json]",
  );
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

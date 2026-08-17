import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { verifySignedReleaseArtifacts } from "./publish-release.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const SIGNING_WORKFLOW = ".github/workflows/signing.yml";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const RELEASE_CHANNEL = "technical-preview";
const STATIC_ASSET_NAMES = Object.freeze([
  "SHA256SUMS",
  "provenance.intoto.jsonl",
  "release-manifest.json",
  "sbom.cdx.json",
  "signing-custody.json",
]);
const PUBLIC_PACKAGES = Object.freeze(
  JSON.parse(readFileSync(path.join(ROOT, "release", "packages.json"), "utf8")).npm.public.map(
    ({ name }) => name,
  ),
);

function fail(message) {
  throw new Error(`GitHub release contract: ${message}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} must be non-empty text`);
  }
  return value;
}

function requireRevision(value, label = "revision") {
  if (!REVISION_PATTERN.test(value ?? "")) fail(`${label} must be a full commit SHA`);
  return value;
}

function requireRunId(value, label) {
  const normalized = String(value ?? "");
  if (!RUN_ID_PATTERN.test(normalized)) fail(`${label} must be a positive GitHub Actions run ID`);
  return normalized;
}

function requireSha256(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) fail(`${label} must be SHA-256`);
  return value;
}

function requireVersion(value) {
  requireString(value, "version");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    fail("version must be SemVer");
  }
  return value;
}

function requireRepository(value) {
  requireString(value, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    fail("repository must be an owner/name slug");
  }
  return value;
}

function requireFileName(value, label = "file name") {
  requireString(value, label);
  if (
    path.basename(value) !== value ||
    value.includes("\\") ||
    /[\0\r\n]/u.test(value) ||
    value === "." ||
    value === ".."
  ) {
    fail(`${label} must be a portable file name`);
  }
  return value;
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
  return value;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

function regularFile(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch {
    fail(`${label} is missing: ${file}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular file: ${file}`);
  }
  return metadata;
}

function regularDirectory(directory, label) {
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch {
    fail(`${label} is missing: ${directory}`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular directory: ${directory}`);
  }
}

function fileEntry(directory, name) {
  requireFileName(name);
  const file = path.join(directory, name);
  const metadata = regularFile(file, name);
  return { name, file, size: metadata.size, sha256: sha256File(file) };
}

function writeNewFile(file, bytes) {
  writeFileSync(file, bytes, { flag: "wx" });
}

function writeCanonicalJson(file, value) {
  writeNewFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readCanonicalJson(file, label) {
  regularFile(file, label);
  const bytes = readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
  if (bytes !== `${JSON.stringify(parsed, null, 2)}\n`) fail(`${label} is not canonical JSON`);
  return parsed;
}

function readCanonicalJsonLine(file, label) {
  regularFile(file, label);
  const bytes = readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
  if (bytes !== `${JSON.stringify(parsed)}\n`) fail(`${label} is not canonical JSONL`);
  return parsed;
}

function releaseIdentity({ version, revision, ref }) {
  requireVersion(version);
  requireRevision(revision);
  const tag = `v${version}`;
  if (ref !== `refs/tags/${tag}`) {
    fail(`release requires refs/tags/${tag}, got ${ref || "unset"}`);
  }
  return { name: "nexa-ui", version, tag, revision };
}

function releaseName(version) {
  return `Nexa UI v${version} Technical Preview`;
}

function archiveAssetNames(version) {
  requireVersion(version);
  return [
    `nexa-notes-${version}-macos-arm64-signed.tar.gz`,
    `nexa-notes-${version}-windows-x64-signed.zip`,
  ];
}

export function expectedGithubReleaseAssetNames(version) {
  return [...STATIC_ASSET_NAMES, ...archiveAssetNames(version)].sort(compareStrings);
}

function payloadAssetNames(version) {
  return [
    ...archiveAssetNames(version),
    "provenance.intoto.jsonl",
    "sbom.cdx.json",
    "signing-custody.json",
  ].sort(compareStrings);
}

function expectedSbom(release, archives) {
  const releaseReference = `pkg:generic/nexa-ui@${release.version}`;
  const references = archives.map(({ sha256 }) => `urn:nexa:release-asset:sha256:${sha256}`);
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": releaseReference,
        name: release.name,
        version: release.version,
        properties: [
          { name: "nexa:source:revision", value: release.revision },
          { name: "nexa:release:tag", value: release.tag },
        ],
      },
    },
    components: archives.map(({ name, size, sha256 }) => ({
      type: "file",
      "bom-ref": `urn:nexa:release-asset:sha256:${sha256}`,
      name,
      hashes: [{ alg: "SHA-256", content: sha256 }],
      properties: [{ name: "nexa:artifact:size", value: String(size) }],
    })),
    dependencies: [
      { ref: releaseReference, dependsOn: references },
      ...references.map((ref) => ({ ref, dependsOn: [] })),
    ],
  };
}

function expectedProvenance(release, archives, repository, transportManifestSha256) {
  const repositoryUrl = `https://github.com/${repository}`;
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: archives.map(({ name, sha256 }) => ({ name, digest: { sha256 } })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://nexa-ui.dev/build-types/github-release/v1",
        externalParameters: { release },
        resolvedDependencies: [
          {
            uri: `git+${repositoryUrl}@${release.revision}`,
            digest: { gitCommit: release.revision },
          },
          {
            uri: "signed-transport/signed-release-artifacts.manifest.json",
            digest: { sha256: transportManifestSha256 },
          },
        ],
      },
      runDetails: {
        builder: { id: `${repositoryUrl}/${RELEASE_WORKFLOW}@${release.revision}` },
      },
    },
  };
}

function validateAssetEntries(entries, expectedNames, label) {
  if (!Array.isArray(entries) || entries.length !== expectedNames.length) {
    fail(`${label} must contain the exact release asset set`);
  }
  const normalized = entries.map((entry, index) => {
    exactKeys(entry, ["name", "size", "sha256"], `${label}[${index}]`);
    requireFileName(entry.name, `${label}[${index}].name`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      fail(`${label}[${index}].size must be a non-negative safe integer`);
    }
    requireSha256(entry.sha256, `${label}[${index}].sha256`);
    return { name: entry.name, size: entry.size, sha256: entry.sha256 };
  });
  const names = normalized.map(({ name }) => name);
  if (new Set(names).size !== names.length) fail(`${label} contains duplicate names`);
  if (names.some((name, index) => name !== expectedNames[index])) {
    fail(`${label} must be sorted and contain the exact release asset set`);
  }
  return normalized;
}

function validateCustody(custody, release, archives, signingRunId) {
  exactKeys(custody, ["schemaVersion", "release", "signing", "platforms"], "release custody");
  if (custody.schemaVersion !== 1) fail("release custody schemaVersion must be 1");
  if (JSON.stringify(custody.release) !== JSON.stringify(release)) {
    fail("release custody identity does not match");
  }
  exactKeys(custody.signing, ["workflow", "runId", "transportManifest"], "release custody signing");
  if (custody.signing.workflow !== SIGNING_WORKFLOW || custody.signing.runId !== signingRunId) {
    fail("release custody signing producer does not match");
  }
  exactKeys(custody.signing.transportManifest, ["name", "sha256"], "transport manifest binding");
  if (custody.signing.transportManifest.name !== "signed-release-artifacts.manifest.json") {
    fail("release custody must bind the signed transport manifest");
  }
  requireSha256(custody.signing.transportManifest.sha256, "transport manifest digest");
  if (!Array.isArray(custody.platforms) || custody.platforms.length !== 2) {
    fail("release custody must contain both platform records");
  }
  const expectedPlatforms = ["darwin", "win32"];
  let inputEvidenceBundle;
  for (const [index, platform] of custody.platforms.entries()) {
    exactKeys(
      platform,
      ["platform", "archive", "custody", "inputEvidenceBundleSha256", "executor"],
      `release custody platforms[${index}]`,
    );
    if (platform.platform !== expectedPlatforms[index]) {
      fail("release custody platforms must be ordered darwin, win32");
    }
    exactKeys(platform.archive, ["name", "size", "sha256"], "release custody archive");
    const expectedArchive = {
      name: archives[index].name,
      size: archives[index].size,
      sha256: archives[index].sha256,
    };
    if (JSON.stringify(platform.archive) !== JSON.stringify(expectedArchive)) {
      fail(`release custody archive does not match ${expectedArchive.name}`);
    }
    exactKeys(platform.custody, ["name", "sha256"], "source custody binding");
    if (platform.custody.name !== `${expectedArchive.name}.custody.json`) {
      fail("source custody file does not match its archive");
    }
    requireSha256(platform.custody.sha256, "source custody digest");
    requireSha256(platform.inputEvidenceBundleSha256, "input evidence bundle digest");
    if (inputEvidenceBundle === undefined) inputEvidenceBundle = platform.inputEvidenceBundleSha256;
    else if (inputEvidenceBundle !== platform.inputEvidenceBundleSha256) {
      fail("both platforms must bind the same G6-05 input evidence bundle");
    }
    exactKeys(platform.executor, ["version", "sha256", "closureSha256"], "signing executor");
    requireString(platform.executor.version, "signing executor version");
    requireSha256(platform.executor.sha256, "signing executor digest");
    requireSha256(platform.executor.closureSha256, "signing executor closure digest");
  }
  return custody.signing.transportManifest.sha256;
}

function assertExactDirectory(directory, expectedNames) {
  regularDirectory(directory, "release asset directory");
  const actual = readdirSync(directory).sort(compareStrings);
  if (
    actual.length !== expectedNames.length ||
    actual.some((name, index) => name !== expectedNames[index])
  ) {
    fail(`release asset directory must contain exactly: ${expectedNames.join(", ")}`);
  }
  return actual.map((name) => fileEntry(directory, name));
}

export function verifyGithubReleaseAssets({
  assetsDirectory,
  version,
  revision,
  ref,
  signingRunId,
  notesName,
  notesSha256,
  repository,
}) {
  const release = releaseIdentity({ version, revision, ref });
  const normalizedSigningRunId = requireRunId(signingRunId, "signing run ID");
  requireRepository(repository);
  if (notesName !== `v${version}.md`) fail(`release notes must be v${version}.md`);
  requireSha256(notesSha256, "release notes digest");
  const expectedNames = expectedGithubReleaseAssetNames(version);
  const allAssets = assertExactDirectory(assetsDirectory, expectedNames);
  const byName = new Map(allAssets.map((entry) => [entry.name, entry]));
  const archives = archiveAssetNames(version).map((name, index) => {
    const { size, sha256 } = byName.get(name);
    return { name, size, sha256, platform: index === 0 ? "darwin" : "win32" };
  });

  const checksumNames = expectedNames.filter((name) => name !== "SHA256SUMS");
  const expectedChecksums = checksumNames
    .map((name) => `${byName.get(name).sha256}  ${name}\n`)
    .join("");
  if (readFileSync(path.join(assetsDirectory, "SHA256SUMS"), "utf8") !== expectedChecksums) {
    fail("SHA256SUMS does not match the exact release asset bytes");
  }

  const custody = readCanonicalJson(
    path.join(assetsDirectory, "signing-custody.json"),
    "release custody",
  );
  const transportManifestSha256 = validateCustody(
    custody,
    release,
    archives,
    normalizedSigningRunId,
  );

  const sbom = readCanonicalJson(path.join(assetsDirectory, "sbom.cdx.json"), "release SBOM");
  if (JSON.stringify(sbom) !== JSON.stringify(expectedSbom(release, archives))) {
    fail("release SBOM does not bind the signed archives and release identity");
  }

  const provenance = readCanonicalJsonLine(
    path.join(assetsDirectory, "provenance.intoto.jsonl"),
    "release provenance",
  );
  if (
    JSON.stringify(provenance) !==
    JSON.stringify(expectedProvenance(release, archives, repository, transportManifestSha256))
  ) {
    fail("release provenance does not bind the signed archives, source, and signed transport");
  }

  const payloadNames = payloadAssetNames(version);
  const payload = payloadNames.map((name) => {
    const { size, sha256 } = byName.get(name);
    return { name, size, sha256 };
  });
  const expectedManifest = {
    schemaVersion: 1,
    release: { ...release, draft: true, prerelease: true },
    signing: { workflow: SIGNING_WORKFLOW, runId: normalizedSigningRunId },
    notes: { name: notesName, sha256: notesSha256 },
    assets: payload,
  };
  const manifest = readCanonicalJson(
    path.join(assetsDirectory, "release-manifest.json"),
    "release manifest",
  );
  if (JSON.stringify(manifest.release) !== JSON.stringify(expectedManifest.release)) {
    fail("manifest release identity does not match");
  }
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    fail("release manifest does not bind the exact payload, notes, and signing run");
  }
  return {
    release,
    assets: allAssets.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    archives,
  };
}

function readSignedCustody(signedArtifactsDirectory, archive) {
  const file = path.join(signedArtifactsDirectory, `${archive.name}.custody.json`);
  regularFile(file, `${archive.name} custody`);
  let custody;
  try {
    custody = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${archive.name} custody is invalid JSON: ${error.message}`);
  }
  if (
    custody.platform !== archive.platform ||
    custody.derived?.name !== archive.name ||
    custody.derived?.sha256 !== archive.sha256
  ) {
    fail(`${archive.name} custody identity drifted after signed transport verification`);
  }
  requireSha256(custody.inputEvidence?.bundleSha256, `${archive.name} input evidence digest`);
  exactKeys(custody.executor, ["version", "sha256", "closureSha256"], `${archive.name} executor`);
  return {
    custody: { name: path.basename(file), sha256: sha256File(file) },
    inputEvidenceBundleSha256: custody.inputEvidence.bundleSha256,
    executor: custody.executor,
  };
}

export function prepareGithubReleaseAssets({
  signedArtifactsDirectory,
  outputDirectory,
  version,
  revision,
  ref,
  signedRunId,
  notesFile,
  repository,
}) {
  const release = releaseIdentity({ version, revision, ref });
  const signingRunId = requireRunId(signedRunId, "signing run ID");
  requireRepository(repository);
  regularFile(notesFile, "version-bound release notes");
  const notesName = path.basename(notesFile);
  if (notesName !== `v${version}.md`) fail(`release notes must be named v${version}.md`);
  const notesSha256 = sha256File(notesFile);
  if (existsSync(outputDirectory)) fail(`release asset output already exists: ${outputDirectory}`);
  mkdirSync(path.dirname(path.resolve(outputDirectory)), { recursive: true });
  mkdirSync(outputDirectory);
  try {
    const verifiedSigned = verifySignedReleaseArtifacts({
      signedArtifactsDirectory,
      revision,
      signedRunId: signingRunId,
    });
    const byName = new Map(verifiedSigned.map((entry) => [entry.name, entry]));
    const archives = archiveAssetNames(version).map((name, index) => {
      const source = byName.get(name);
      if (!source) fail(`signed transport is missing ${name}`);
      copyFileSync(source.file, path.join(outputDirectory, name), fsConstants.COPYFILE_EXCL);
      const copied = fileEntry(outputDirectory, name);
      if (copied.sha256 !== source.sha256 || copied.size !== source.size) {
        fail(`${name} changed while preparing GitHub Release assets`);
      }
      return {
        name,
        size: copied.size,
        sha256: copied.sha256,
        platform: index === 0 ? "darwin" : "win32",
      };
    });
    const transportManifest = path.join(
      signedArtifactsDirectory,
      "signed-release-artifacts.manifest.json",
    );
    regularFile(transportManifest, "signed transport manifest");
    const platforms = archives.map((archive) => ({
      platform: archive.platform,
      archive: { name: archive.name, size: archive.size, sha256: archive.sha256 },
      ...readSignedCustody(signedArtifactsDirectory, archive),
    }));
    const custody = {
      schemaVersion: 1,
      release,
      signing: {
        workflow: SIGNING_WORKFLOW,
        runId: signingRunId,
        transportManifest: {
          name: path.basename(transportManifest),
          sha256: sha256File(transportManifest),
        },
      },
      platforms,
    };
    writeCanonicalJson(path.join(outputDirectory, "signing-custody.json"), custody);
    writeCanonicalJson(
      path.join(outputDirectory, "sbom.cdx.json"),
      expectedSbom(release, archives),
    );
    writeNewFile(
      path.join(outputDirectory, "provenance.intoto.jsonl"),
      `${JSON.stringify(
        expectedProvenance(release, archives, repository, custody.signing.transportManifest.sha256),
      )}\n`,
    );
    const payload = payloadAssetNames(version).map((name) => {
      const { size, sha256 } = fileEntry(outputDirectory, name);
      return { name, size, sha256 };
    });
    writeCanonicalJson(path.join(outputDirectory, "release-manifest.json"), {
      schemaVersion: 1,
      release: { ...release, draft: true, prerelease: true },
      signing: { workflow: SIGNING_WORKFLOW, runId: signingRunId },
      notes: { name: notesName, sha256: notesSha256 },
      assets: payload,
    });
    const checksumNames = expectedGithubReleaseAssetNames(version).filter(
      (name) => name !== "SHA256SUMS",
    );
    writeNewFile(
      path.join(outputDirectory, "SHA256SUMS"),
      checksumNames
        .map((name) => `${sha256File(path.join(outputDirectory, name))}  ${name}\n`)
        .join(""),
    );
    return verifyGithubReleaseAssets({
      assetsDirectory: outputDirectory,
      version,
      revision,
      ref,
      signingRunId,
      notesName,
      notesSha256,
      repository,
    });
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

function normalizeReleaseAssets(entries, version, label) {
  const expectedNames = expectedGithubReleaseAssetNames(version);
  const sorted = [...entries].sort((left, right) => compareStrings(left.name, right.name));
  return validateAssetEntries(sorted, expectedNames, label);
}

function validateReleaseMetadata(release, { version, revision, notes, allowDraft = true }) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    fail("GitHub Release metadata must be an object");
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0) fail("GitHub Release ID is invalid");
  if (release.tag_name !== `v${version}`) fail("GitHub Release tag does not match");
  if (release.target_commitish !== revision) fail("GitHub Release target commit does not match");
  if (release.name !== releaseName(version)) fail("GitHub Release name does not match");
  if (release.body !== notes) fail("GitHub Release notes do not match the version-bound notes");
  if (release.prerelease !== true) fail("Technical Preview GitHub Release must be a prerelease");
  if (typeof release.draft !== "boolean" || (!allowDraft && release.draft)) {
    fail(allowDraft ? "GitHub Release draft state is invalid" : "GitHub Release is still draft");
  }
  return release;
}

export function evaluateReleaseReconciliation({
  release,
  version,
  revision,
  notes,
  localAssets,
  observedAssets,
}) {
  requireVersion(version);
  requireRevision(revision);
  requireText(notes, "release notes");
  validateReleaseMetadata(release, { version, revision, notes });
  const expectedNames = expectedGithubReleaseAssetNames(version);
  const local = validateAssetEntries(
    [...localAssets].sort((left, right) => compareStrings(left.name, right.name)),
    expectedNames,
    "local release assets",
  );
  if (!Array.isArray(observedAssets)) fail("observed release assets must be an array");
  const localByName = new Map(local.map((entry) => [entry.name, entry]));
  const observedByName = new Map();
  for (const [index, observed] of observedAssets.entries()) {
    if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
      fail(`observed release assets[${index}] must be an object`);
    }
    requireFileName(observed.name, `observed release assets[${index}].name`);
    if (observedByName.has(observed.name)) fail(`duplicate release asset: ${observed.name}`);
    const expected = localByName.get(observed.name);
    if (!expected) fail(`unexpected release asset: ${observed.name}`);
    if (!Number.isSafeInteger(observed.size) || observed.size < 0) {
      fail(`observed release asset size is invalid: ${observed.name}`);
    }
    requireSha256(observed.sha256, `observed ${observed.name} digest`);
    if (observed.size !== expected.size) fail(`release asset size mismatch: ${observed.name}`);
    if (observed.sha256 !== expected.sha256) {
      fail(`release asset digest mismatch: ${observed.name}`);
    }
    observedByName.set(observed.name, observed);
  }
  const missing = expectedNames.filter((name) => !observedByName.has(name));
  if (release.draft === false && missing.length > 0) {
    fail("published GitHub Release is missing required assets");
  }
  return { missing, existing: expectedNames.filter((name) => observedByName.has(name)) };
}

function sameNames(actual, expected) {
  const normalized = [...actual].sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  return (
    normalized.length === wanted.length && normalized.every((name, index) => name === wanted[index])
  );
}

export function assertFinalNpmPublication(publication) {
  if (!publication || typeof publication !== "object" || Array.isArray(publication)) {
    fail("final npm publication record must be an object");
  }
  requireVersion(publication.version);
  requireRevision(publication.revision, "npm publication revision");
  if (publication.ref !== `refs/tags/v${publication.version}`) {
    fail("final npm publication ref does not match its version");
  }
  if (
    publication.phase !== "final" ||
    publication.executed !== true ||
    publication.resume !== false ||
    publication.channel !== RELEASE_CHANNEL ||
    publication.targetTag !== RELEASE_CHANNEL ||
    publication.promotesPublicChannel !== true
  ) {
    fail("final npm publication did not execute the public Technical Preview promotion");
  }
  if (!Array.isArray(publication.packages)) fail("final npm publication packages are missing");
  const packageNames = publication.packages.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      entry.version !== publication.version ||
      typeof entry.integrity !== "string" ||
      !entry.integrity.startsWith("sha512-")
    ) {
      fail(`final npm publication package ${index} is invalid`);
    }
    return requireString(entry.name, `final npm publication package ${index} name`);
  });
  if (!sameNames(packageNames, PUBLIC_PACKAGES)) {
    fail("final npm publication does not contain the complete public package train");
  }
  if (!sameNames(publication.signedArtifacts ?? [], archiveAssetNames(publication.version))) {
    fail("final npm publication does not bind both signed desktop archives");
  }
  const registry = publication.registry;
  if (
    !registry ||
    registry.state !== "complete" ||
    !Array.isArray(registry.remaining) ||
    registry.remaining.length !== 0 ||
    !Array.isArray(registry.promotions) ||
    registry.promotions.length !== 0
  ) {
    fail("final npm channel did not converge");
  }
  if (!sameNames(registry.published ?? [], PUBLIC_PACKAGES)) {
    fail("final npm registry observation does not contain the complete public package train");
  }
  return {
    version: publication.version,
    revision: publication.revision,
    ref: publication.ref,
    channel: publication.channel,
    packages: publication.packages
      .map(({ name, version: packageVersion, integrity }) => ({
        name,
        version: packageVersion,
        integrity,
      }))
      .sort((left, right) => compareStrings(left.name, right.name)),
  };
}

export function buildPublicationRecord({
  release,
  repository,
  releaseRunId,
  signingRunId,
  assets,
  npmPublication,
}) {
  requireRepository(repository);
  const publicationRunId = requireRunId(releaseRunId, "release run ID");
  const normalizedSigningRunId = requireRunId(signingRunId, "signing run ID");
  const npm = assertFinalNpmPublication(npmPublication);
  if (
    !release ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== `v${npm.version}` ||
    release.target_commitish !== npm.revision ||
    release.draft !== false ||
    release.prerelease !== true
  ) {
    fail("published GitHub Release identity does not match the npm publication");
  }
  requireString(release.html_url, "GitHub Release URL");
  if (release.html_url !== `https://github.com/${repository}/releases/tag/${release.tag_name}`) {
    fail("GitHub Release URL does not match the repository and tag");
  }
  requireString(release.published_at, "GitHub Release published_at");
  const normalizedAssets = normalizeReleaseAssets(assets, npm.version, "published release assets");
  return {
    schemaVersion: 1,
    outcome: "published",
    release: {
      id: release.id,
      url: release.html_url,
      tag: release.tag_name,
      targetCommitish: release.target_commitish,
      prerelease: true,
      publishedAt: release.published_at,
    },
    source: { repository, revision: npm.revision },
    signing: { workflow: SIGNING_WORKFLOW, runId: normalizedSigningRunId },
    publication: { workflow: RELEASE_WORKFLOW, runId: publicationRunId },
    assets: normalizedAssets,
    npm,
  };
}

function runGh(arguments_, { outputFile } = {}) {
  let descriptor;
  try {
    if (outputFile) descriptor = openSync(outputFile, "wx");
    const result = spawnSync("gh", arguments_, {
      cwd: ROOT,
      encoding: outputFile ? undefined : "utf8",
      stdio: outputFile ? ["ignore", descriptor, "pipe"] : ["ignore", "pipe", "pipe"],
    });
    if (result.error) fail(`gh failed to start: ${result.error.message}`);
    return {
      status: result.status ?? 1,
      stdout: outputFile ? "" : (result.stdout ?? ""),
      stderr: outputFile
        ? Buffer.isBuffer(result.stderr)
          ? result.stderr.toString("utf8")
          : String(result.stderr ?? "")
        : (result.stderr ?? ""),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireGhSuccess(arguments_, options) {
  const result = runGh(arguments_, options);
  if (result.status !== 0) {
    fail(`gh ${arguments_.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseGhJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`);
  }
}

function getGithubRelease(repository, tag) {
  const result = runGh(["api", `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`]);
  if (result.status === 0) return parseGhJson(result.stdout, "GitHub Release lookup");
  if (/\b404\b|not found/iu.test(`${result.stderr}\n${result.stdout}`)) return null;
  fail(`GitHub Release lookup failed (${result.status}): ${result.stderr || result.stdout}`);
}

function createDraftGithubRelease({ repository, version, revision, notes }) {
  return parseGhJson(
    requireGhSuccess([
      "api",
      "--method",
      "POST",
      `repos/${repository}/releases`,
      "-f",
      `tag_name=v${version}`,
      "-f",
      `target_commitish=${revision}`,
      "-f",
      `name=${releaseName(version)}`,
      "-f",
      `body=${notes}`,
      "-F",
      "draft=true",
      "-F",
      "prerelease=true",
    ]),
    "GitHub Release creation",
  );
}

function publishDraftGithubRelease({ repository, releaseId }) {
  return parseGhJson(
    requireGhSuccess([
      "api",
      "--method",
      "PATCH",
      `repos/${repository}/releases/${releaseId}`,
      "-F",
      "draft=false",
      "-F",
      "prerelease=true",
    ]),
    "GitHub Release publication",
  );
}

function remoteAssetMetadata(release, version) {
  if (!Array.isArray(release.assets)) fail("GitHub Release assets metadata is missing");
  const expected = new Set(expectedGithubReleaseAssetNames(version));
  const seen = new Set();
  return release.assets.map((asset, index) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      fail(`GitHub Release asset ${index} is invalid`);
    }
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0) {
      fail(`GitHub Release asset ${index} has an invalid ID`);
    }
    requireFileName(asset.name, `GitHub Release asset ${index} name`);
    if (!expected.has(asset.name)) fail(`unexpected release asset: ${asset.name}`);
    if (seen.has(asset.name)) fail(`duplicate release asset: ${asset.name}`);
    seen.add(asset.name);
    return { id: asset.id, name: asset.name };
  });
}

function downloadRemoteAssets({ repository, release, version, directory }) {
  if (existsSync(directory)) fail(`fresh download directory already exists: ${directory}`);
  mkdirSync(directory);
  try {
    const observed = [];
    for (const asset of remoteAssetMetadata(release, version)) {
      const file = path.join(directory, asset.name);
      const result = runGh(
        [
          "api",
          "--method",
          "GET",
          "-H",
          "Accept: application/octet-stream",
          `repos/${repository}/releases/assets/${asset.id}`,
        ],
        { outputFile: file },
      );
      if (result.status !== 0) {
        fail(`cannot freshly download ${asset.name}: ${result.stderr}`);
      }
      const entry = fileEntry(directory, asset.name);
      observed.push({ id: asset.id, name: entry.name, size: entry.size, sha256: entry.sha256 });
    }
    return observed;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function releaseNotes(notesFile, version) {
  regularFile(notesFile, "version-bound release notes");
  const name = path.basename(notesFile);
  if (name !== `v${version}.md`) fail(`release notes must be named v${version}.md`);
  const body = readFileSync(notesFile, "utf8");
  requireText(body, "release notes");
  return { name, body, sha256: sha256Bytes(body) };
}

function requireGithubAuthorization(revision) {
  if (process.env.NEXA_GITHUB_RELEASE_AUTHORIZATION !== revision) {
    fail("NEXA_GITHUB_RELEASE_AUTHORIZATION must equal the checked-out revision");
  }
}

function verifyLocalReleaseAssets({
  assetsDirectory,
  version,
  revision,
  ref,
  signingRunId,
  notes,
  repository,
}) {
  return verifyGithubReleaseAssets({
    assetsDirectory,
    version,
    revision,
    ref,
    signingRunId,
    notesName: notes.name,
    notesSha256: notes.sha256,
    repository,
  });
}

function freshlyVerifyRemoteRelease({
  repository,
  release,
  version,
  revision,
  ref,
  signingRunId,
  notes,
  localAssets,
}) {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-github-release-download-"));
  const download = path.join(root, "assets");
  try {
    const observedAssets = downloadRemoteAssets({
      repository,
      release,
      version,
      directory: download,
    });
    const reconciliation = evaluateReleaseReconciliation({
      release,
      version,
      revision,
      notes: notes.body,
      localAssets,
      observedAssets,
    });
    if (reconciliation.missing.length !== 0) {
      fail(`GitHub Release is missing assets: ${reconciliation.missing.join(", ")}`);
    }
    const verified = verifyGithubReleaseAssets({
      assetsDirectory: download,
      version,
      revision,
      ref,
      signingRunId,
      notesName: notes.name,
      notesSha256: notes.sha256,
      repository,
    });
    return { release, assets: verified.assets };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function reconcileGithubRelease({
  execute = false,
  assetsDirectory,
  notesFile,
  version,
  revision,
  ref,
  signingRunId,
  repository,
}) {
  const release = releaseIdentity({ version, revision, ref });
  requireRepository(repository);
  const notes = releaseNotes(notesFile, version);
  const verified = verifyLocalReleaseAssets({
    assetsDirectory,
    version,
    revision,
    ref,
    signingRunId,
    notes,
    repository,
  });
  if (!execute) {
    return {
      executed: false,
      release: { tag: release.tag, targetCommitish: revision, draft: true, prerelease: true },
      assets: verified.assets,
    };
  }
  requireGithubAuthorization(revision);
  let githubRelease = getGithubRelease(repository, release.tag);
  if (!githubRelease) {
    githubRelease = createDraftGithubRelease({ repository, version, revision, notes: notes.body });
  }
  validateReleaseMetadata(githubRelease, { version, revision, notes: notes.body });

  const firstDownloadRoot = mkdtempSync(path.join(tmpdir(), "nexa-github-release-existing-"));
  const firstDownload = path.join(firstDownloadRoot, "assets");
  let reconciliation;
  try {
    const observedAssets = downloadRemoteAssets({
      repository,
      release: githubRelease,
      version,
      directory: firstDownload,
    });
    reconciliation = evaluateReleaseReconciliation({
      release: githubRelease,
      version,
      revision,
      notes: notes.body,
      localAssets: verified.assets,
      observedAssets,
    });
  } finally {
    rmSync(firstDownloadRoot, { recursive: true, force: true });
  }
  if (githubRelease.draft === false && reconciliation.missing.length !== 0) {
    fail("published GitHub Release cannot be repaired in place");
  }
  for (const name of reconciliation.missing) {
    requireGhSuccess([
      "release",
      "upload",
      release.tag,
      path.join(assetsDirectory, name),
      "--repo",
      repository,
    ]);
  }
  githubRelease = getGithubRelease(repository, release.tag);
  if (!githubRelease) fail("GitHub Release disappeared after asset reconciliation");
  validateReleaseMetadata(githubRelease, { version, revision, notes: notes.body });
  const fresh = freshlyVerifyRemoteRelease({
    repository,
    release: githubRelease,
    version,
    revision,
    ref,
    signingRunId,
    notes,
    localAssets: verified.assets,
  });
  return {
    executed: true,
    release: {
      id: githubRelease.id,
      url: githubRelease.html_url,
      tag: githubRelease.tag_name,
      targetCommitish: githubRelease.target_commitish,
      draft: githubRelease.draft,
      prerelease: githubRelease.prerelease,
    },
    assets: fresh.assets,
  };
}

export function finalizeGithubRelease({
  execute = false,
  assetsDirectory,
  notesFile,
  npmPublicationFile,
  outputFile,
  version,
  revision,
  ref,
  signingRunId,
  releaseRunId,
  repository,
}) {
  releaseIdentity({ version, revision, ref });
  requireRepository(repository);
  const notes = releaseNotes(notesFile, version);
  const verified = verifyLocalReleaseAssets({
    assetsDirectory,
    version,
    revision,
    ref,
    signingRunId,
    notes,
    repository,
  });
  let npmPublication;
  try {
    npmPublication = JSON.parse(readFileSync(npmPublicationFile, "utf8"));
  } catch (error) {
    fail(`cannot read final npm publication result: ${error.message}`);
  }
  const npm = assertFinalNpmPublication(npmPublication);
  if (npm.version !== version || npm.revision !== revision || npm.ref !== ref) {
    fail("final npm publication identity does not match the GitHub Release request");
  }
  if (!execute) {
    return {
      executed: false,
      release: { tag: `v${version}`, revision },
      assets: verified.assets,
      npm,
    };
  }
  requireGithubAuthorization(revision);
  let githubRelease = getGithubRelease(repository, `v${version}`);
  if (!githubRelease) fail("draft GitHub Release does not exist");
  validateReleaseMetadata(githubRelease, { version, revision, notes: notes.body });
  const fresh = freshlyVerifyRemoteRelease({
    repository,
    release: githubRelease,
    version,
    revision,
    ref,
    signingRunId,
    notes,
    localAssets: verified.assets,
  });
  if (githubRelease.draft) {
    githubRelease = publishDraftGithubRelease({ repository, releaseId: githubRelease.id });
  }
  validateReleaseMetadata(githubRelease, {
    version,
    revision,
    notes: notes.body,
    allowDraft: false,
  });
  const record = buildPublicationRecord({
    release: githubRelease,
    repository,
    releaseRunId,
    signingRunId,
    assets: fresh.assets,
    npmPublication,
  });
  mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
  writeCanonicalJson(outputFile, record);
  return record;
}

function parseOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--execute") {
      if (options.execute) fail("duplicate argument: --execute");
      options.execute = true;
      continue;
    }
    if (!argument.startsWith("--")) fail(`unknown argument: ${argument}`);
    if (Object.hasOwn(options, argument)) fail(`duplicate argument: ${argument}`);
    const value = arguments_[++index];
    if (!value || value.startsWith("--")) fail(`missing value for ${argument}`);
    options[argument] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function assertAllowedOptions(command, options, allowed) {
  const permitted = new Set(allowed);
  for (const option of Object.keys(options)) {
    if (!permitted.has(option)) fail(`unknown ${command} option: ${option}`);
  }
}

function releaseVersion() {
  return JSON.parse(readFileSync(path.join(ROOT, "release", "version.json"), "utf8")).npmTrain;
}

function cliIdentity(options) {
  return {
    version: options["--version"] ?? releaseVersion(),
    revision: required(options, "--revision"),
    ref: required(options, "--ref"),
    signingRunId: required(options, "--signed-run-id"),
    repository: required(options, "--repository"),
  };
}

function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseOptions(arguments_);
  const common = ["--version", "--revision", "--ref", "--signed-run-id", "--repository"];
  const commandOptions = {
    prepare: [...common, "--signed-artifacts", "--output", "--notes"],
    verify: [...common, "--assets", "--notes"],
    reconcile: [...common, "--assets", "--notes", "execute"],
    finalize: [
      ...common,
      "--assets",
      "--notes",
      "--npm-publication",
      "--output",
      "--release-run-id",
      "execute",
    ],
  };
  if (!Object.hasOwn(commandOptions, command)) {
    fail(
      "usage: github-release.mjs prepare|verify|reconcile|finalize --revision SHA --ref TAG --signed-run-id ID --repository OWNER/REPO ...",
    );
  }
  assertAllowedOptions(command, options, commandOptions[command]);
  const identity = cliIdentity(options);
  if (command === "prepare") {
    const result = prepareGithubReleaseAssets({
      ...identity,
      signedRunId: identity.signingRunId,
      signedArtifactsDirectory: path.resolve(required(options, "--signed-artifacts")),
      outputDirectory: path.resolve(required(options, "--output")),
      notesFile: path.resolve(required(options, "--notes")),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "verify") {
    const notes = releaseNotes(path.resolve(required(options, "--notes")), identity.version);
    const result = verifyGithubReleaseAssets({
      ...identity,
      assetsDirectory: path.resolve(required(options, "--assets")),
      notesName: notes.name,
      notesSha256: notes.sha256,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "reconcile") {
    const result = reconcileGithubRelease({
      ...identity,
      execute: options.execute === true,
      assetsDirectory: path.resolve(required(options, "--assets")),
      notesFile: path.resolve(required(options, "--notes")),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "finalize") {
    const result = finalizeGithubRelease({
      ...identity,
      execute: options.execute === true,
      assetsDirectory: path.resolve(required(options, "--assets")),
      notesFile: path.resolve(required(options, "--notes")),
      npmPublicationFile: path.resolve(required(options, "--npm-publication")),
      outputFile: path.resolve(required(options, "--output")),
      releaseRunId: required(options, "--release-run-id"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

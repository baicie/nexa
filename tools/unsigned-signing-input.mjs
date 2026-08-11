import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createArchive, extractArchive, inventoryBinaries } from "./archive-utils.mjs";
import { collectDependencyGraph, validateDependencyGraph } from "./release-dependency-graph.mjs";
import { generateEvidence, verifyEvidence } from "./release-evidence.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const releaseVersion = readJson(path.join(root, "release", "version.json"), "release version");
const repository = "https://github.com/baicie/nexa-ui";
const builderId = `${repository}/.github/workflows/reference-notes-package.yml`;
const buildType = "https://nexa-ui.dev/build-types/unsigned-signing-input/v1";
const manifestName = "unsigned-signing-input.manifest.json";
const descriptorRelative = "g6-05/descriptor.json";
const evidenceRelative = "g6-05/evidence";
const unsignedRelative = "release-work/unsigned";
const evidenceNames = ["SHA256SUMS", "sbom.cdx.json", "provenance.intoto.jsonl"];
const targets = Object.freeze({
  darwin: Object.freeze({ arch: "arm64", label: "macos", extension: ".tar.gz" }),
  win32: Object.freeze({ arch: "x64", label: "windows", extension: ".zip" }),
});

export class UnsignedSigningInputError extends Error {
  constructor(message) {
    super(`[unsigned-signing-input] ${message}`);
    this.name = "UnsignedSigningInputError";
  }
}

function fail(message) {
  throw new UnsignedSigningInputError(message);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function regularFile(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    fail(`${label} is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  return metadata;
}

function directory(directoryPath, label) {
  let metadata;
  try {
    metadata = lstatSync(directoryPath);
  } catch (error) {
    fail(`${label} is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a non-symlink directory`);
  }
  return metadata;
}

function portable(relative) {
  return relative.split(path.sep).join("/");
}

function walkFiles(directoryPath, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const absolute = path.join(directoryPath, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) fail(`package contains a symlink: ${relative}`);
    if (metadata.isDirectory()) files.push(...walkFiles(absolute, relative));
    else if (metadata.isFile()) files.push(relative);
    else fail(`package contains a special file: ${relative}`);
  }
  return files;
}

function requireExactFiles(sourceDirectory, expected) {
  const actual = walkFiles(sourceDirectory).sort(compareStrings);
  const expected_ = [...expected].sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(expected_)) {
    fail(`package inventory does not match the Notes signing allowlist: ${actual.join(", ")}`);
  }
}

function target(platform, arch) {
  const current = targets[platform];
  if (!current) fail("platform must be darwin or win32");
  if (arch !== current.arch) {
    fail(`${platform} Technical Preview signing input requires ${current.arch}`);
  }
  return current;
}

function archiveName(platform, arch) {
  const current = target(platform, arch);
  return `nexa-notes-${releaseVersion.npmTrain}-${current.label}-${arch}-unsigned${current.extension}`;
}

function validateNotesPackage(sourceDirectory, platform, arch) {
  directory(sourceDirectory, "Notes package source");
  target(platform, arch);
  const expected =
    platform === "darwin"
      ? [
          "Nexa Notes.app/Contents/Info.plist",
          "Nexa Notes.app/Contents/MacOS/NexaNotes",
          "Nexa Notes.app/Contents/Resources/app.manifest.json",
          "Nexa Notes.app/Contents/Resources/nexa-build.json",
        ]
      : ["NexaNotes.exe", "app.manifest.json", "nexa-build.json"];
  requireExactFiles(sourceDirectory, expected);

  const executableRelative =
    platform === "darwin" ? "Nexa Notes.app/Contents/MacOS/NexaNotes" : "NexaNotes.exe";
  const metadataRelative =
    platform === "darwin" ? "Nexa Notes.app/Contents/Resources/nexa-build.json" : "nexa-build.json";
  const manifestRelative =
    platform === "darwin"
      ? "Nexa Notes.app/Contents/Resources/app.manifest.json"
      : "app.manifest.json";
  const executable = path.join(sourceDirectory, ...executableRelative.split("/"));
  regularFile(executable, "Notes executable");
  if (platform === "darwin" && (statSync(executable).mode & 0o111) === 0) {
    fail("macOS Notes executable must be marked executable");
  }
  const binaries = inventoryBinaries(sourceDirectory, platform).map(({ relative }) =>
    portable(relative),
  );
  if (JSON.stringify(binaries) !== JSON.stringify([executableRelative])) {
    fail(`package must contain exactly one expected ${platform} executable`);
  }

  const metadata = readJson(
    path.join(sourceDirectory, ...metadataRelative.split("/")),
    "nexa-build metadata",
  );
  const manifest = readJson(
    path.join(sourceDirectory, ...manifestRelative.split("/")),
    "Notes application manifest",
  );
  if (
    metadata?.schemaVersion !== 1 ||
    metadata.app?.id !== "dev.nexa.notes" ||
    metadata.app?.name !== "Nexa Notes" ||
    metadata.app?.version !== releaseVersion.npmTrain ||
    metadata.target?.platform !== platform ||
    metadata.target?.arch !== arch
  ) {
    fail("nexa-build metadata does not match the release application target");
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.id !== metadata.app.id ||
    manifest.name !== metadata.app.name ||
    manifest.version !== metadata.app.version
  ) {
    fail("Notes application manifest does not match nexa-build metadata");
  }
  return { metadata, manifest };
}

function createNewDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath);
  if (existsSync(resolved)) fail(`${label} already exists: ${resolved}`);
  mkdirSync(resolved);
  directory(resolved, label);
  return resolved;
}

export function createUnsignedPlatformArchive({
  sourceDirectory,
  outputDirectory,
  platform,
  arch,
}) {
  if (typeof sourceDirectory !== "string" || typeof outputDirectory !== "string") {
    fail("sourceDirectory and outputDirectory are required");
  }
  const source = path.resolve(sourceDirectory);
  validateNotesPackage(source, platform, arch);
  const output = createNewDirectory(outputDirectory, "platform archive output");
  const name = archiveName(platform, arch);
  const artifact = path.join(output, name);
  const verificationRoot = mkdtempSync(path.join(tmpdir(), "nexa-unsigned-archive-"));
  try {
    createArchive(source, artifact, platform);
    regularFile(artifact, "unsigned platform archive");
    const extracted = path.join(verificationRoot, "extracted");
    extractArchive(artifact, extracted, platform);
    validateNotesPackage(extracted, platform, arch);
    const metadata = statSync(artifact);
    return {
      artifact,
      name,
      platform,
      arch,
      version: releaseVersion.npmTrain,
      size: metadata.size,
      sha256: sha256(artifact),
    };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(verificationRoot, { recursive: true, force: true });
  }
}

function requireSourceIdentity(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("source identity is required");
  }
  if (typeof source.revision !== "string" || !/^[0-9a-f]{40}$/u.test(source.revision)) {
    fail("source revision must be a full lowercase commit SHA");
  }
  if (source.dirty !== false) fail("unsigned signing input requires a clean source");
  if (!Number.isSafeInteger(source.sourceDateEpoch) || source.sourceDateEpoch < 0) {
    fail("sourceDateEpoch must be a non-negative integer");
  }
  return {
    revision: source.revision,
    dirty: false,
    sourceDateEpoch: source.sourceDateEpoch,
  };
}

function expectedArtifacts() {
  return [
    { platform: "darwin", arch: targets.darwin.arch },
    { platform: "win32", arch: targets.win32.arch },
  ].map(({ platform, arch }) => ({ platform, arch, name: archiveName(platform, arch) }));
}

function validateArchiveFile(file, platform, arch) {
  regularFile(file, `${platform} unsigned archive`);
  const verificationRoot = mkdtempSync(path.join(tmpdir(), "nexa-unsigned-input-verify-"));
  try {
    const extracted = path.join(verificationRoot, "extracted");
    extractArchive(file, extracted, platform);
    validateNotesPackage(extracted, platform, arch);
  } finally {
    rmSync(verificationRoot, { recursive: true, force: true });
  }
}

function fileRecord(file, name = path.basename(file)) {
  const metadata = regularFile(file, name);
  return { name, size: metadata.size, sha256: sha256(file) };
}

function writeJsonExclusive(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function descriptorFor(source, dependencyGraph) {
  return {
    schemaVersion: 1,
    release: { name: "nexa-ui", version: releaseVersion.npmTrain },
    source: { repository, revision: source.revision, dirty: false },
    build: { builderId, buildType, sourceDateEpoch: source.sourceDateEpoch },
    materials: dependencyGraph.sources.map(({ lockfile, digest }) => ({
      uri: `${repository}/blob/${source.revision}/${lockfile}`,
      digest,
    })),
    dependencyGraph,
  };
}

function manifestFor(bundleDirectory, revision) {
  const unsignedRoot = path.join(bundleDirectory, ...unsignedRelative.split("/"));
  const descriptorPath = path.join(bundleDirectory, ...descriptorRelative.split("/"));
  const evidenceRoot = path.join(bundleDirectory, ...evidenceRelative.split("/"));
  return {
    schemaVersion: 1,
    release: { name: "nexa-ui", version: releaseVersion.npmTrain },
    source: { repository, revision },
    custody: {
      unsignedRoot: unsignedRelative,
      descriptor: descriptorRelative,
      evidenceRoot: evidenceRelative,
    },
    artifacts: expectedArtifacts().map(({ platform, arch, name }) => ({
      platform,
      arch,
      ...fileRecord(path.join(unsignedRoot, name), name),
    })),
    evidence: {
      descriptor: {
        path: descriptorRelative,
        ...fileRecord(descriptorPath, path.basename(descriptorRelative)),
      },
      outputs: evidenceNames.map((name) => ({
        path: `${evidenceRelative}/${name}`,
        ...fileRecord(path.join(evidenceRoot, name), name),
      })),
    },
  };
}

function expectedBundleFiles() {
  return [
    manifestName,
    descriptorRelative,
    ...evidenceNames.map((name) => `${evidenceRelative}/${name}`),
    ...expectedArtifacts().map(({ name }) => `${unsignedRelative}/${name}`),
  ].sort(compareStrings);
}

function assertBundleInventory(bundleDirectory) {
  directory(bundleDirectory, "unsigned signing input bundle");
  const actual = walkFiles(bundleDirectory).sort(compareStrings);
  const expected = expectedBundleFiles();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`unsigned bundle inventory does not match the canonical contract: ${actual.join(", ")}`);
  }
}

function verificationResult(revision) {
  return {
    schemaVersion: 1,
    artifactCount: 2,
    revision,
    manifest: manifestName,
    outputs: [...evidenceNames],
  };
}

export function assembleUnsignedSigningInput({
  inputDirectory,
  outputDirectory,
  source,
  dependencyGraph,
}) {
  if (typeof inputDirectory !== "string" || typeof outputDirectory !== "string") {
    fail("inputDirectory and outputDirectory are required");
  }
  const source_ = requireSourceIdentity(source);
  let dependencyGraph_;
  try {
    dependencyGraph_ = validateDependencyGraph(dependencyGraph);
  } catch (error) {
    fail(`dependency graph is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const input = path.resolve(inputDirectory);
  directory(input, "platform archive input");
  const inputFiles = walkFiles(input).sort(compareStrings);
  const expectedNames = expectedArtifacts()
    .map(({ name }) => name)
    .sort(compareStrings);
  if (JSON.stringify(inputFiles) !== JSON.stringify(expectedNames)) {
    fail("platform archive inventory must contain exactly one macOS and one Windows input");
  }
  for (const { platform, arch, name } of expectedArtifacts()) {
    validateArchiveFile(path.join(input, name), platform, arch);
  }

  const output = createNewDirectory(outputDirectory, "unsigned signing input output");
  try {
    const unsignedRoot = path.join(output, ...unsignedRelative.split("/"));
    const evidenceRoot = path.join(output, ...evidenceRelative.split("/"));
    const descriptorPath = path.join(output, ...descriptorRelative.split("/"));
    mkdirSync(unsignedRoot, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    for (const { name } of expectedArtifacts()) {
      copyFileSync(
        path.join(input, name),
        path.join(unsignedRoot, name),
        fsConstants.COPYFILE_EXCL,
      );
    }
    writeJsonExclusive(descriptorPath, descriptorFor(source_, dependencyGraph_));
    const generated = generateEvidence({
      artifactsDir: unsignedRoot,
      evidenceDir: evidenceRoot,
      descriptorPath,
    });
    if (
      generated.artifactCount !== 2 ||
      JSON.stringify(generated.outputs) !== JSON.stringify(evidenceNames)
    ) {
      fail("G6-05 generator did not emit the required dual-platform evidence");
    }
    writeJsonExclusive(path.join(output, manifestName), manifestFor(output, source_.revision));
    return verifyUnsignedSigningInput({ bundleDirectory: output, revision: source_.revision });
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

export function verifyUnsignedSigningInput({ bundleDirectory, revision }) {
  if (typeof bundleDirectory !== "string") fail("bundleDirectory is required");
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision)) {
    fail("revision must be a full lowercase commit SHA");
  }
  const bundle = path.resolve(bundleDirectory);
  assertBundleInventory(bundle);
  const unsignedRoot = path.join(bundle, ...unsignedRelative.split("/"));
  const descriptorPath = path.join(bundle, ...descriptorRelative.split("/"));
  const evidenceRoot = path.join(bundle, ...evidenceRelative.split("/"));
  const descriptor = readJson(descriptorPath, "G6-05 descriptor");
  if (
    descriptor?.schemaVersion !== 1 ||
    descriptor.release?.name !== "nexa-ui" ||
    descriptor.release?.version !== releaseVersion.npmTrain ||
    descriptor.source?.repository !== repository ||
    descriptor.source?.revision !== revision ||
    descriptor.source?.dirty !== false ||
    descriptor.build?.builderId !== builderId ||
    descriptor.build?.buildType !== buildType
  ) {
    fail("G6-05 descriptor identity does not match the unsigned signing input");
  }
  let verified;
  try {
    verified = verifyEvidence({
      artifactsDir: unsignedRoot,
      evidenceDir: evidenceRoot,
      descriptorPath,
    });
  } catch (error) {
    fail(
      `G6-05 evidence verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    verified.artifactCount !== 2 ||
    JSON.stringify(verified.outputs) !== JSON.stringify(evidenceNames)
  ) {
    fail("G6-05 verifier did not validate the complete dual-platform input");
  }
  for (const { platform, arch, name } of expectedArtifacts()) {
    validateArchiveFile(path.join(unsignedRoot, name), platform, arch);
  }

  const expectedManifest = manifestFor(bundle, revision);
  const manifestPath = path.join(bundle, manifestName);
  const actualManifest = readJson(manifestPath, "unsigned signing input manifest");
  if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
    fail("unsigned signing input manifest does not match the custody bytes");
  }
  if (readFileSync(manifestPath, "utf8") !== `${JSON.stringify(expectedManifest, null, 2)}\n`) {
    fail("unsigned signing input manifest is not canonical JSON");
  }
  return verificationResult(revision);
}

function usage() {
  return (
    "Usage:\n" +
    "  node tools/unsigned-signing-input.mjs archive --source DIR --output DIR --platform darwin|win32 --arch arm64|x64\n" +
    "  node tools/unsigned-signing-input.mjs assemble --input DIR --output DIR --revision SHA\n" +
    "  node tools/unsigned-signing-input.mjs verify --bundle DIR --revision SHA"
  );
}

function parseOptions(arguments_, names) {
  if (arguments_.length !== names.length * 2) fail(usage());
  const allowed = new Set(names.map((name) => `--${name}`));
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(flag) || typeof value !== "string" || value.length === 0) fail(usage());
    const name = flag.slice(2);
    if (options[name] !== undefined) fail(usage());
    options[name] = value;
  }
  if (names.some((name) => options[name] === undefined)) fail(usage());
  return options;
}

function runGit(arguments_) {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    fail(
      `git ${arguments_.join(" ")} failed: ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }
  return result.stdout.trim();
}

function gitSourceIdentity(revision) {
  if (!/^[0-9a-f]{40}$/u.test(revision)) fail("revision must be a full lowercase commit SHA");
  const head = runGit(["rev-parse", "HEAD"]);
  if (head !== revision) fail("requested revision does not match the checked-out commit");
  const dirty = runGit(["status", "--porcelain", "--untracked-files=all"]).length > 0;
  const sourceDateEpoch = Number(runGit(["show", "-s", "--format=%ct", revision]));
  return requireSourceIdentity({ revision, dirty, sourceDateEpoch });
}

function main(arguments_) {
  const [command, ...rest] = arguments_;
  if (command === "archive") {
    const options = parseOptions(rest, ["source", "output", "platform", "arch"]);
    const result = createUnsignedPlatformArchive({
      sourceDirectory: options.source,
      outputDirectory: options.output,
      platform: options.platform,
      arch: options.arch,
    });
    console.log(`created ${result.name} (${result.size} bytes, sha256 ${result.sha256})`);
    return;
  }
  if (command === "assemble") {
    const options = parseOptions(rest, ["input", "output", "revision"]);
    const result = assembleUnsignedSigningInput({
      inputDirectory: options.input,
      outputDirectory: options.output,
      source: gitSourceIdentity(options.revision),
      dependencyGraph: collectDependencyGraph({ rootDirectory: root }),
    });
    console.log(
      `assembled ${result.artifactCount} unsigned artifacts for ${result.revision} at ${path.resolve(options.output)}`,
    );
    return;
  }
  if (command === "verify") {
    const options = parseOptions(rest, ["bundle", "revision"]);
    const result = verifyUnsignedSigningInput({
      bundleDirectory: options.bundle,
      revision: options.revision,
    });
    console.log(`verified ${result.artifactCount} unsigned artifacts for ${result.revision}`);
    return;
  }
  fail(usage());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = message.includes("Usage:") ? 64 : 1;
  }
}

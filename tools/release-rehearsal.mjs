import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateEvidence, verifyEvidence } from "./release-evidence.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const defaultPolicyPath = path.join(root, "release", "rehearsal-policy.json");
const releasePackages = readJson(path.join(root, "release", "packages.json"), "release packages");
const releaseVersion = readJson(path.join(root, "release", "version.json"), "release version");
const publicPackageNames = releasePackages.npm.public.map(({ name }) => name);
const hashBuffer = Buffer.allocUnsafe(1024 * 1024);

function fail(message) {
  throw new Error(`[release-rehearsal] ${message}`);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function readJson(file, name) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isFullRevision(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function assertPortableRelative(value, name) {
  requireString(value, name);
  if (
    value.includes("\\") ||
    /[\0\r\n]/u.test(value) ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    fail(`${name} must be a portable relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`${name} must not contain empty, current, or parent path segments`);
  }
  return value;
}

function assertWithin(parent, child, name) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${name} must be a descendant of ${parent}`);
  }
}

function assertRegularFile(file, name = file) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    fail(`${name} is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${name} must be a regular file`);
  return metadata;
}

function assertDirectory(directory, name = directory) {
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch (error) {
    fail(`${name} is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`${name} must be a directory`);
  return metadata;
}

function createOwnedDirectory(directory, name) {
  const absolute = path.resolve(directory);
  if (existsSync(absolute)) fail(`${name} already exists: ${absolute}`);
  mkdirSync(path.dirname(absolute), { recursive: true });
  mkdirSync(absolute);
  assertDirectory(absolute, name);
  return absolute;
}

function hashFile(file) {
  const hash = createHash("sha256");
  const handle = openSync(file, "r");
  let size = 0;
  try {
    for (;;) {
      const bytesRead = readSync(handle, hashBuffer, 0, hashBuffer.length, null);
      if (bytesRead === 0) break;
      hash.update(hashBuffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally {
    closeSync(handle);
  }
  return { size, sha256: hash.digest("hex") };
}

function walkRegularFiles(
  directory,
  {
    exclude = new Set(),
    maxFileCount = Number.MAX_SAFE_INTEGER,
    maxTotalBytes = Number.MAX_SAFE_INTEGER,
  } = {},
) {
  assertDirectory(directory);
  const files = [];
  let totalBytes = 0;

  function visit(current, relativeDirectory) {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      compareStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertPortableRelative(relativePath, "candidate path");
      if (exclude.has(relativePath)) continue;
      const absolute = path.join(current, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail(`candidate contains a symlink: ${relativePath}`);
      if (metadata.isDirectory()) {
        visit(absolute, relativePath);
      } else if (metadata.isFile()) {
        const digest = hashFile(absolute);
        files.push({ path: relativePath, ...digest });
        totalBytes += digest.size;
        if (files.length > maxFileCount) fail(`candidate exceeds ${maxFileCount} files`);
        if (totalBytes > maxTotalBytes) fail(`candidate exceeds ${maxTotalBytes} bytes`);
      } else {
        fail(`candidate contains a special file: ${relativePath}`);
      }
    }
  }

  visit(path.resolve(directory), "");
  return files.sort((left, right) => compareStrings(left.path, right.path));
}

function copyRegularTree(source, destination) {
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink()) fail(`cannot copy symlink into candidate: ${source}`);
  if (metadata.isFile()) {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
    return;
  }
  if (!metadata.isDirectory()) fail(`cannot copy special file into candidate: ${source}`);
  mkdirSync(destination);
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    assertPortableRelative(entry.name, "copied entry name");
    copyRegularTree(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

function expectedTarget(platform) {
  const targets = {
    "darwin-arm64": { platform: "darwin", arch: "arm64" },
    "darwin-x64": { platform: "darwin", arch: "x64" },
    "win32-x64": { platform: "win32", arch: "x64" },
  };
  const target = targets[platform];
  if (!target) fail(`unsupported rehearsal platform: ${platform}`);
  return target;
}

export function validateRehearsalPolicy(policy) {
  assertObject(policy, "policy");
  if (policy.schemaVersion !== 1) fail("policy schemaVersion must be 1");

  assertObject(policy.execution, "execution");
  for (const boundary of ["publishes", "signs", "notarizes", "dispatchesRemoteWorkflows"]) {
    if (policy.execution[boundary] !== false) fail(`execution.${boundary} must be false`);
  }

  assertObject(policy.modes, "modes");
  for (const [mode, clean, tag, promotion] of [
    ["candidate", false, false, "candidate-only"],
    ["publishable", true, true, "owner-review-required"],
    ["tag", true, true, "owner-review-required"],
  ]) {
    assertObject(policy.modes[mode], `modes.${mode}`);
    if (policy.modes[mode].requireCleanSource !== clean) {
      fail(`modes.${mode}.requireCleanSource must be ${clean}`);
    }
    if (policy.modes[mode].requireVersionTag !== tag) {
      fail(`modes.${mode}.requireVersionTag must be ${tag}`);
    }
    if (policy.modes[mode].promotion !== promotion) {
      fail(`modes.${mode}.promotion must be ${promotion}`);
    }
  }

  const requiredGates = [
    "source",
    "contracts",
    "security",
    "performance",
    "consumer",
    "freshVerification",
    "launch",
    "rollback",
  ];
  if (JSON.stringify(policy.requiredGates) !== JSON.stringify(requiredGates)) {
    fail(`requiredGates must be ${requiredGates.join(", ")}`);
  }

  assertObject(policy.verification, "verification");
  if (policy.verification.producerJob !== "consumer") {
    fail("verification.producerJob must be consumer");
  }
  if (policy.verification.consumerJob !== "fresh-verify") {
    fail("verification.consumerJob must be fresh-verify");
  }
  for (const boundary of ["freshDownloadRequired", "independentJobRequired"]) {
    if (policy.verification[boundary] !== true) fail(`verification.${boundary} must be true`);
  }

  assertObject(policy.transport, "transport");
  for (const [name, expected] of [
    ["manifest", "rehearsal-manifest.json"],
    ["descriptor", "descriptor.json"],
    ["consumerResult", "consumer-result.json"],
    ["launchDescriptor", "launch.json"],
    ["artifactsDirectory", "artifacts"],
    ["evidenceDirectory", "evidence"],
  ]) {
    if (policy.transport[name] !== expected) fail(`transport.${name} must be ${expected}`);
  }
  for (const name of ["maxFileCount", "maxTotalBytes"]) {
    if (!Number.isSafeInteger(policy.transport[name]) || policy.transport[name] <= 0) {
      fail(`transport.${name} must be a positive safe integer`);
    }
  }

  assertObject(policy.launch, "launch");
  if (policy.launch.integrityVerificationRequired !== true) {
    fail("launch.integrityVerificationRequired must be true");
  }
  for (const name of [
    "observationMs",
    "terminationGraceMs",
    "maxOutputBytes",
    "candidateProbeMinObservationMs",
  ]) {
    if (!Number.isSafeInteger(policy.launch[name]) || policy.launch[name] <= 0) {
      fail(`launch.${name} must be a positive safe integer`);
    }
  }
  if (policy.launch.observationMs < 5_000) fail("launch.observationMs must be at least 5000");
  const allowedPlatforms = ["darwin-arm64", "darwin-x64", "win32-x64"];
  if (JSON.stringify(policy.launch.allowedPlatforms) !== JSON.stringify(allowedPlatforms)) {
    fail(`launch.allowedPlatforms must be ${allowedPlatforms.join(", ")}`);
  }

  assertObject(policy.rollback, "rollback");
  if (policy.rollback.state !== "quarantined") fail("rollback.state must be quarantined");
  for (const action of [
    "stop-promotion",
    "retain-candidate-and-evidence",
    "keep-last-known-good-current",
    "open-corrective-change",
    "use-new-version-for-next-candidate",
  ]) {
    if (!policy.rollback.actions?.includes(action)) fail(`rollback.actions must include ${action}`);
  }
  for (const action of [
    "publish",
    "sign",
    "notarize",
    "overwrite-version",
    "unpublish-version",
    "dispatch-remote-workflow",
  ]) {
    if (!policy.rollback.forbiddenActions?.includes(action)) {
      fail(`rollback.forbiddenActions must include ${action}`);
    }
  }
  return policy;
}

export function validateSourceState({
  mode,
  policy,
  version,
  refType,
  refName,
  revision,
  head,
  status,
}) {
  validateRehearsalPolicy(policy);
  const modePolicy = policy.modes[mode];
  if (!modePolicy) fail(`unknown rehearsal mode: ${mode}`);
  if (!isFullRevision(revision) || head !== revision) {
    fail(`checked-out revision ${head} does not match requested revision ${revision}`);
  }
  if (modePolicy.requireCleanSource && status.trim() !== "") {
    fail(`${mode} rehearsal requires clean source`);
  }
  if (modePolicy.requireVersionTag && (refType !== "tag" || refName !== `v${version}`)) {
    fail(`${mode} rehearsal requires version tag v${version}`);
  }
  return true;
}

export function createRehearsalDecision({ policy, mode, ref, revision, gates }) {
  validateRehearsalPolicy(policy);
  if (!policy.modes[mode]) fail(`unknown rehearsal mode: ${mode}`);
  requireString(ref, "decision ref");
  if (!isFullRevision(revision)) fail("decision revision must be a full Git SHA");
  assertObject(gates, "gates");

  const failedGates = [];
  for (const gate of policy.requiredGates) {
    if (typeof gates[gate] !== "string" || gates[gate].length === 0) {
      fail(`missing result for required gate ${gate}`);
    }
    if (gates[gate] !== "success") failedGates.push({ name: gate, status: gates[gate] });
  }
  const passed = failedGates.length === 0;
  return {
    schemaVersion: 1,
    mode,
    ref,
    revision,
    gates: Object.fromEntries(policy.requiredGates.map((gate) => [gate, gates[gate]])),
    outcome: passed ? "passed" : "rollback-required",
    promotion: passed ? policy.modes[mode].promotion : "blocked",
    failedGates,
    rollback: passed
      ? null
      : {
          state: policy.rollback.state,
          actions: [...policy.rollback.actions],
          forbiddenActions: [...policy.rollback.forbiddenActions],
        },
  };
}

export function releaseWorkflowPlan(policy = loadRehearsalPolicy()) {
  validateRehearsalPolicy(policy);
  return {
    schemaVersion: 1,
    stages: [
      "validate-tag-source",
      "run-required-gates",
      "build-unsigned-artifacts",
      "upload-candidate",
      "fresh-download",
      "verify-integrity",
      "launch-downloaded-application",
      "rehearse-quarantine-rollback",
      "record-promotion-decision",
    ],
    forbiddenOperations: ["publish", "sign", "notarize", "dispatch-remote-workflow"],
  };
}

function git(args, cwd = root) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    fail(
      `git ${args.join(" ")} failed: ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }
  return result.stdout.trim();
}

export function loadRehearsalPolicy(policyPath = defaultPolicyPath) {
  return validateRehearsalPolicy(readJson(policyPath, "rehearsal policy"));
}

function parseRef(ref) {
  requireString(ref, "source ref");
  for (const [prefix, refType] of [
    ["refs/tags/", "tag"],
    ["refs/heads/", "branch"],
    ["refs/pull/", "pull"],
  ]) {
    if (ref.startsWith(prefix) && ref.length > prefix.length) {
      return { refType, refName: ref.slice(prefix.length) };
    }
  }
  fail(`unsupported source ref: ${ref}`);
}

export function assertRepositorySource({ mode, ref, revision, cwd = root }) {
  const policy = loadRehearsalPolicy();
  const { refType, refName } = parseRef(ref);
  validateSourceState({
    mode,
    policy,
    version: releaseVersion.npmTrain,
    refType,
    refName,
    revision,
    head: git(["rev-parse", "HEAD"], cwd),
    status: git(["status", "--porcelain", "--untracked-files=all"], cwd),
  });
  if (policy.modes[mode].requireVersionTag) {
    const tagCommit = git(["rev-parse", `${refName}^{commit}`], cwd);
    if (tagCommit !== revision)
      fail(`tag ${refName} does not resolve to requested revision ${revision}`);
  }
  return true;
}

function findNamedFiles(directory, expectedName) {
  const matches = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      compareStrings(left.name, right.name),
    )) {
      const absolute = path.join(current, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail(`packaged application contains a symlink: ${absolute}`);
      if (metadata.isDirectory()) visit(absolute);
      else if (metadata.isFile() && entry.name === expectedName) matches.push(absolute);
      else if (!metadata.isFile())
        fail(`packaged application contains a special file: ${absolute}`);
    }
  }
  visit(directory);
  return matches;
}

function discoverApplication(releaseOutputDirectory, platform) {
  const dist = path.join(releaseOutputDirectory, "consumer", "dist");
  assertDirectory(dist, "consumer dist");
  const target = expectedTarget(platform);
  const matches = findNamedFiles(dist, "nexa-build.json").filter((file) => {
    const metadata = readJson(file, "packaged application metadata");
    return metadata.target?.platform === target.platform && metadata.target?.arch === target.arch;
  });
  if (matches.length !== 1) {
    fail(`expected one packaged application for ${platform}, found ${matches.length}`);
  }
  const metadataPath = matches[0];
  if (target.platform === "darwin") {
    const applicationDirectory = path.resolve(path.dirname(metadataPath), "..", "..");
    if (!applicationDirectory.endsWith(".app")) fail("macOS metadata is not inside an app bundle");
    assertWithin(dist, applicationDirectory, "macOS application");
    const binaryName = path.basename(applicationDirectory, ".app");
    return {
      applicationDirectory,
      executableRelativePath: `Contents/MacOS/${binaryName}`,
    };
  }
  const applicationDirectory = path.dirname(metadataPath);
  assertWithin(dist, applicationDirectory, "Windows application");
  const executables = readdirSync(applicationDirectory)
    .filter((name) => name.endsWith(".exe"))
    .filter((name) => lstatSync(path.join(applicationDirectory, name)).isFile());
  if (executables.length !== 1)
    fail(`expected one packaged Windows executable, found ${executables.length}`);
  return { applicationDirectory, executableRelativePath: executables[0] };
}

function runTar(args) {
  const command = process.platform === "win32" ? "tar.exe" : "tar";
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }
  return result.stdout;
}

function validateConsumerResult(result) {
  assertObject(result, "consumer result");
  if (result.schemaVersion !== 1 || result.native !== true) {
    fail("consumer result must record a successful native rehearsal");
  }
  if (JSON.stringify(result.packages) !== JSON.stringify(publicPackageNames)) {
    fail("consumer result does not cover the complete public package set");
  }
  return { schemaVersion: 1, native: true, packages: [...publicPackageNames] };
}

function validateBundleIdentity({ mode, ref, revision, platform, descriptor, policy }) {
  if (!policy.modes[mode]) fail(`unknown rehearsal mode: ${mode}`);
  requireString(ref, "rehearsal ref");
  if (!isFullRevision(revision)) fail("rehearsal revision must be a full Git SHA");
  expectedTarget(platform);
  if (policy.modes[mode].requireVersionTag && ref !== `refs/tags/v${releaseVersion.npmTrain}`) {
    fail(`${mode} rehearsal requires ref refs/tags/v${releaseVersion.npmTrain}`);
  }
  if (descriptor.schemaVersion !== 1 || descriptor.source?.revision !== revision) {
    fail("release descriptor revision does not match the rehearsal revision");
  }
  if (
    descriptor.release?.name !== "nexa-ui" ||
    descriptor.release?.version !== releaseVersion.npmTrain
  ) {
    fail("release descriptor identity does not match the release train");
  }
  if (policy.modes[mode].requireCleanSource && descriptor.source?.dirty !== false) {
    fail(`${mode} rehearsal requires a clean release descriptor`);
  }
}

function validateLaunchDescriptor(launch, { mode, platform, policy }) {
  assertObject(launch, "launch descriptor");
  if (launch.schemaVersion !== 1 || launch.platform !== platform) {
    fail("launch descriptor platform does not match the candidate");
  }
  if (launch.kind !== "native" && launch.kind !== "node-probe") {
    fail(`unsupported launch kind: ${launch.kind}`);
  }
  if (launch.kind === "node-probe" && mode !== "candidate") {
    fail("node-probe launch is allowed only for local candidate rehearsals");
  }
  assertPortableRelative(launch.archive, "launch archive");
  if (!launch.archive.startsWith(`${policy.transport.artifactsDirectory}/application/`)) {
    fail("launch archive must be inside the application artifact directory");
  }
  assertPortableRelative(launch.archiveRoot, "launch archive root");
  if (launch.archiveRoot.includes("/")) fail("launch archive root must be one directory name");
  assertPortableRelative(launch.executable, "launch executable");
  if (
    !Array.isArray(launch.arguments) ||
    launch.arguments.some((argument) => typeof argument !== "string")
  ) {
    fail("launch arguments must be an array of strings");
  }
  const minimum =
    launch.kind === "native"
      ? policy.launch.observationMs
      : policy.launch.candidateProbeMinObservationMs;
  if (!Number.isSafeInteger(launch.observationMs) || launch.observationMs < minimum) {
    fail(`launch observation must be at least ${minimum}ms`);
  }
  if (launch.kind === "native" && launch.observationMs !== policy.launch.observationMs) {
    fail(`native launch observation must be ${policy.launch.observationMs}ms`);
  }
  return launch;
}

export function prepareCandidateBundle({
  releaseOutputDirectory,
  bundleDirectory,
  mode,
  ref,
  revision,
  platform,
  applicationDirectory,
  executableRelativePath,
  launchKind = "native",
  observationMs,
  policyPath = defaultPolicyPath,
}) {
  const policy = loadRehearsalPolicy(policyPath);
  const producer = path.resolve(releaseOutputDirectory);
  assertDirectory(producer, "release consumer output");
  const producerArtifacts = path.join(producer, "artifacts");
  const producerEvidence = path.join(producer, "evidence");
  const producerDescriptor = path.join(producer, "descriptor.json");
  const descriptor = readJson(producerDescriptor, "release descriptor");
  validateBundleIdentity({ mode, ref, revision, platform, descriptor, policy });
  const consumer = validateConsumerResult(
    readJson(path.join(producer, "result.json"), "consumer result"),
  );
  verifyEvidence({
    artifactsDir: producerArtifacts,
    evidenceDir: producerEvidence,
    descriptorPath: producerDescriptor,
  });

  let application;
  if (applicationDirectory !== undefined || executableRelativePath !== undefined) {
    if (!applicationDirectory || !executableRelativePath) {
      fail("applicationDirectory and executableRelativePath must be provided together");
    }
    application = {
      applicationDirectory: path.resolve(applicationDirectory),
      executableRelativePath,
    };
  } else {
    application = discoverApplication(producer, platform);
  }
  assertDirectory(application.applicationDirectory, "packaged application");
  assertPortableRelative(application.executableRelativePath, "application executable");
  const executable = path.join(
    application.applicationDirectory,
    ...application.executableRelativePath.split("/"),
  );
  assertWithin(application.applicationDirectory, executable, "application executable");
  assertRegularFile(executable, "application executable");
  walkRegularFiles(application.applicationDirectory, {
    maxFileCount: policy.transport.maxFileCount,
    maxTotalBytes: policy.transport.maxTotalBytes,
  });

  const output = createOwnedDirectory(bundleDirectory, "candidate bundle");
  try {
    const artifactsDirectory = path.join(output, policy.transport.artifactsDirectory);
    const npmDirectory = path.join(artifactsDirectory, "npm");
    const applicationArtifacts = path.join(artifactsDirectory, "application");
    mkdirSync(artifactsDirectory);
    copyRegularTree(producerArtifacts, npmDirectory);
    mkdirSync(applicationArtifacts);

    const archiveName = `nexa-application-${platform}.tar.gz`;
    const archivePath = path.join(applicationArtifacts, archiveName);
    const archiveRoot = path.basename(application.applicationDirectory);
    assertPortableRelative(archiveRoot, "application archive root");
    runTar([
      "-czf",
      archivePath,
      "-C",
      path.dirname(application.applicationDirectory),
      archiveRoot,
    ]);
    assertRegularFile(archivePath, "application archive");

    copyFileSync(
      producerDescriptor,
      path.join(output, policy.transport.descriptor),
      fsConstants.COPYFILE_EXCL,
    );
    writeJson(path.join(output, policy.transport.consumerResult), consumer);
    const launch = {
      schemaVersion: 1,
      kind: launchKind,
      platform,
      archive: `${policy.transport.artifactsDirectory}/application/${archiveName}`,
      archiveRoot,
      executable: application.executableRelativePath,
      arguments: [],
      observationMs: observationMs ?? policy.launch.observationMs,
    };
    validateLaunchDescriptor(launch, { mode, platform, policy });
    writeJson(path.join(output, policy.transport.launchDescriptor), launch);

    const evidenceDirectory = path.join(output, policy.transport.evidenceDirectory);
    generateEvidence({
      artifactsDir: artifactsDirectory,
      evidenceDir: evidenceDirectory,
      descriptorPath: path.join(output, policy.transport.descriptor),
    });
    const files = walkRegularFiles(output, {
      maxFileCount: policy.transport.maxFileCount,
      maxTotalBytes: policy.transport.maxTotalBytes,
    });
    const manifest = {
      schemaVersion: 1,
      mode,
      source: { ref, revision },
      release: { name: "nexa-ui", version: releaseVersion.npmTrain },
      platform,
      integrity: { algorithm: "sha256", files },
      descriptor: policy.transport.descriptor,
      consumerResult: policy.transport.consumerResult,
      launchDescriptor: policy.transport.launchDescriptor,
      evidenceDirectory: policy.transport.evidenceDirectory,
    };
    writeJson(path.join(output, policy.transport.manifest), manifest);
    return { bundleDirectory: output, manifest };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function compareInventory(expected, actual) {
  const expectedByPath = new Map();
  for (const entry of expected) {
    assertObject(entry, "integrity entry");
    assertPortableRelative(entry.path, "integrity path");
    if (expectedByPath.has(entry.path)) fail(`duplicate integrity path: ${entry.path}`);
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) {
      fail(`invalid integrity metadata for ${entry.path}`);
    }
    expectedByPath.set(entry.path, entry);
  }
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  for (const [relativePath, entry] of expectedByPath) {
    const observed = actualByPath.get(relativePath);
    if (!observed || observed.size !== entry.size || observed.sha256 !== entry.sha256) {
      fail(`integrity mismatch for ${relativePath}`);
    }
  }
  for (const relativePath of actualByPath.keys()) {
    if (!expectedByPath.has(relativePath))
      fail(`integrity inventory has unexpected file ${relativePath}`);
  }
  if (expectedByPath.size !== actualByPath.size) fail("integrity inventory file count changed");
}

export function verifyDownloadedBundle({
  bundleDirectory,
  mode,
  ref,
  revision,
  platform,
  policyPath = defaultPolicyPath,
}) {
  const policy = loadRehearsalPolicy(policyPath);
  const bundle = path.resolve(bundleDirectory);
  assertDirectory(bundle, "downloaded candidate bundle");
  const manifestPath = path.join(bundle, policy.transport.manifest);
  assertRegularFile(manifestPath, "rehearsal manifest");
  const manifest = readJson(manifestPath, "rehearsal manifest");
  assertObject(manifest, "rehearsal manifest");
  if (manifest.schemaVersion !== 1 || manifest.mode !== mode) fail("manifest mode does not match");
  if (manifest.source?.ref !== ref) fail("manifest ref does not match the requested ref");
  if (manifest.source?.revision !== revision)
    fail("manifest revision does not match the requested revision");
  if (manifest.platform !== platform) fail("manifest platform does not match");
  if (
    manifest.release?.name !== "nexa-ui" ||
    manifest.release?.version !== releaseVersion.npmTrain
  ) {
    fail("manifest release identity does not match the release train");
  }
  if (manifest.integrity?.algorithm !== "sha256" || !Array.isArray(manifest.integrity?.files)) {
    fail("manifest integrity inventory must use sha256");
  }
  for (const [name, expected] of [
    ["descriptor", policy.transport.descriptor],
    ["consumerResult", policy.transport.consumerResult],
    ["launchDescriptor", policy.transport.launchDescriptor],
    ["evidenceDirectory", policy.transport.evidenceDirectory],
  ]) {
    if (manifest[name] !== expected) fail(`manifest ${name} does not match policy`);
  }

  const actualFiles = walkRegularFiles(bundle, {
    exclude: new Set([policy.transport.manifest]),
    maxFileCount: policy.transport.maxFileCount,
    maxTotalBytes: policy.transport.maxTotalBytes,
  });
  compareInventory(manifest.integrity.files, actualFiles);

  const descriptorPath = path.join(bundle, policy.transport.descriptor);
  const descriptor = readJson(descriptorPath, "downloaded release descriptor");
  validateBundleIdentity({ mode, ref, revision, platform, descriptor, policy });
  const consumer = validateConsumerResult(
    readJson(path.join(bundle, policy.transport.consumerResult), "downloaded consumer result"),
  );
  const evidence = verifyEvidence({
    artifactsDir: path.join(bundle, policy.transport.artifactsDirectory),
    evidenceDir: path.join(bundle, policy.transport.evidenceDirectory),
    descriptorPath,
  });
  const launch = validateLaunchDescriptor(
    readJson(path.join(bundle, policy.transport.launchDescriptor), "launch descriptor"),
    { mode, platform, policy },
  );
  if (!manifest.integrity.files.some(({ path: relativePath }) => relativePath === launch.archive)) {
    fail("launch archive is not covered by the transport integrity inventory");
  }
  return { bundleDirectory: bundle, manifest, descriptor, consumer, evidence, launch };
}

function validateArchiveListing(archive, archiveRoot) {
  const output = runTar(["-tzf", archive]);
  const entries = output.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) fail("application archive is empty");
  for (const rawEntry of entries) {
    const entry = rawEntry.endsWith("/") ? rawEntry.slice(0, -1) : rawEntry;
    assertPortableRelative(entry, "application archive entry");
    if (entry !== archiveRoot && !entry.startsWith(`${archiveRoot}/`)) {
      fail(`application archive entry escapes its root: ${entry}`);
    }
  }
}

function sanitizedLaunchEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      /(?:FIXTURE|BYPASS)/iu.test(name) ||
      name === "NEXA_APP_MANIFEST_PATH" ||
      name === "PERRY_SKIP_CODEGEN"
    ) {
      delete environment[name];
    }
  }
  return environment;
}

function observeProcess({ command, arguments: arguments_, cwd, observationMs, policy }) {
  return new Promise((resolve, reject) => {
    let observed = false;
    let settled = false;
    let outputBytes = 0;
    let stdout = "";
    let stderr = "";
    let forceTimer;
    let confirmationTimer;
    const child = spawn(command, arguments_, {
      cwd,
      env: sanitizedLaunchEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });

    function capture(kind, chunk) {
      if (outputBytes >= policy.launch.maxOutputBytes) return;
      const available = policy.launch.maxOutputBytes - outputBytes;
      const slice = chunk.subarray(0, available);
      outputBytes += slice.length;
      if (kind === "stdout") stdout += slice.toString("utf8");
      else stderr += slice.toString("utf8");
    }

    function finish(error, report) {
      if (settled) return;
      settled = true;
      clearTimeout(observationTimer);
      clearTimeout(forceTimer);
      clearTimeout(confirmationTimer);
      if (error) reject(error);
      else resolve(report);
    }

    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.once("error", (error) => {
      finish(new Error(`[release-rehearsal] application could not start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (!observed) {
        finish(
          new Error(
            `[release-rehearsal] application exited before the observation boundary (code=${code}, signal=${signal})\n${stderr || stdout}`,
          ),
        );
        return;
      }
      finish(undefined, {
        survivedObservation: true,
        terminated: true,
        exitCode: code,
        signal,
        stdout,
        stderr,
      });
    });

    const observationTimer = setTimeout(() => {
      observed = true;
      child.kill();
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        confirmationTimer = setTimeout(() => {
          finish(new Error("[release-rehearsal] application termination could not be confirmed"));
        }, policy.launch.terminationGraceMs);
      }, policy.launch.terminationGraceMs);
    }, observationMs);
  });
}

export async function launchDownloadedCandidate({
  bundleDirectory,
  extractDirectory,
  mode,
  ref,
  revision,
  platform,
  policyPath = defaultPolicyPath,
}) {
  const policy = loadRehearsalPolicy(policyPath);
  const verified = verifyDownloadedBundle({
    bundleDirectory,
    mode,
    ref,
    revision,
    platform,
    policyPath,
  });
  const archive = path.join(verified.bundleDirectory, ...verified.launch.archive.split("/"));
  assertRegularFile(archive, "verified launch archive");
  validateArchiveListing(archive, verified.launch.archiveRoot);
  const extraction = createOwnedDirectory(extractDirectory, "launch extraction directory");
  runTar(["-xzf", archive, "-C", extraction]);
  const extractionEntries = readdirSync(extraction);
  if (extractionEntries.length !== 1 || extractionEntries[0] !== verified.launch.archiveRoot) {
    fail("extracted application must contain exactly its declared archive root");
  }
  const applicationRoot = path.join(extraction, verified.launch.archiveRoot);
  assertDirectory(applicationRoot, "extracted application root");
  walkRegularFiles(applicationRoot, {
    maxFileCount: policy.transport.maxFileCount,
    maxTotalBytes: policy.transport.maxTotalBytes,
  });
  const executable = path.join(applicationRoot, ...verified.launch.executable.split("/"));
  assertWithin(applicationRoot, executable, "extracted executable");
  assertRegularFile(executable, "extracted executable");
  if (verified.launch.kind === "native" && process.platform !== "win32") {
    try {
      const metadata = lstatSync(executable);
      if ((metadata.mode & 0o111) === 0) fail("extracted native application is not executable");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("[release-rehearsal]")) throw error;
      fail(
        `cannot inspect extracted executable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const command = verified.launch.kind === "node-probe" ? process.execPath : executable;
  const arguments_ =
    verified.launch.kind === "node-probe"
      ? [executable, ...verified.launch.arguments]
      : verified.launch.arguments;
  const report = await observeProcess({
    command,
    arguments: arguments_,
    cwd: applicationRoot,
    observationMs: verified.launch.observationMs,
    policy,
  });
  return { schemaVersion: 1, verified: true, platform, kind: verified.launch.kind, ...report };
}

function directoriesOverlap(left, right) {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function rehearseRollback({
  bundleDirectory,
  outputDirectory,
  mode,
  ref,
  revision,
  platform,
  lastKnownGood,
  policyPath = defaultPolicyPath,
}) {
  const policy = loadRehearsalPolicy(policyPath);
  requireString(lastKnownGood, "last known good");
  const verified = verifyDownloadedBundle({
    bundleDirectory,
    mode,
    ref,
    revision,
    platform,
    policyPath,
  });
  if (
    directoriesOverlap(verified.bundleDirectory, outputDirectory) ||
    directoriesOverlap(outputDirectory, verified.bundleDirectory)
  ) {
    fail("rollback output and candidate bundle must be separate directories");
  }
  const output = createOwnedDirectory(outputDirectory, "rollback rehearsal output");
  const quarantine = path.join(output, "quarantine");
  copyRegularTree(verified.bundleDirectory, quarantine);
  const npmArtifacts = walkRegularFiles(
    path.join(quarantine, policy.transport.artifactsDirectory, "npm"),
  );
  const target = npmArtifacts.find(({ path: relativePath }) => relativePath.endsWith(".tgz"));
  if (!target) fail("rollback rehearsal needs an npm tarball tamper target");
  appendFileSync(
    path.join(quarantine, policy.transport.artifactsDirectory, "npm", ...target.path.split("/")),
    "\nNEXA_ROLLBACK_REHEARSAL_TAMPER\n",
  );

  let verificationFailure;
  try {
    verifyDownloadedBundle({
      bundleDirectory: quarantine,
      mode,
      ref,
      revision,
      platform,
      policyPath,
    });
  } catch (error) {
    verificationFailure = error instanceof Error ? error.message : String(error);
  }
  if (!verificationFailure || !verificationFailure.includes("integrity mismatch")) {
    fail("rollback rehearsal did not detect the quarantined artifact change");
  }

  const gates = Object.fromEntries(policy.requiredGates.map((gate) => [gate, "success"]));
  gates.freshVerification = "failure";
  gates.launch = "skipped";
  const decision = {
    ...createRehearsalDecision({ policy, mode, ref, revision, gates }),
    exercise: {
      schemaVersion: 1,
      detectedTampering: true,
      trigger: verificationFailure,
      tamperedCopy: `${policy.transport.artifactsDirectory}/npm/${target.path}`,
      candidatePreserved: true,
      lastKnownGood,
    },
  };
  writeJson(path.join(output, "rollback-decision.json"), decision);
  return decision;
}

function usage() {
  return [
    "Usage:",
    "  node tools/release-rehearsal.mjs validate-policy",
    "  node tools/release-rehearsal.mjs plan",
    "  node tools/release-rehearsal.mjs source --mode MODE --ref REF --revision SHA",
    "  node tools/release-rehearsal.mjs prepare --mode MODE --ref REF --revision SHA --platform PLATFORM --release-output DIR --bundle NEW_DIR [--report FILE]",
    "  node tools/release-rehearsal.mjs verify --mode MODE --ref REF --revision SHA --platform PLATFORM --bundle DIR [--report FILE]",
    "  node tools/release-rehearsal.mjs launch --mode MODE --ref REF --revision SHA --platform PLATFORM --bundle DIR --extract NEW_DIR [--report FILE]",
    "  node tools/release-rehearsal.mjs rollback --mode MODE --ref REF --revision SHA --platform PLATFORM --bundle DIR --output NEW_DIR --last-known-good VERSION [--report FILE]",
    "  node tools/release-rehearsal.mjs decision --mode MODE --ref REF --revision SHA --output FILE --gate-<name> STATUS ...",
    "  node tools/release-rehearsal.mjs enforce --decision FILE",
  ].join("\n");
}

function parseOptions(arguments_, allowed, required = allowed) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.includes(flag) || value === undefined) throw new Error(usage());
    if (values[flag] !== undefined) fail(`duplicate argument: ${flag}`);
    values[flag] = value;
  }
  for (const flag of required) {
    if (values[flag] === undefined) throw new Error(usage());
  }
  return values;
}

function identityOptions(values) {
  return {
    mode: values["--mode"],
    ref: values["--ref"],
    revision: values["--revision"],
    ...(values["--platform"] ? { platform: values["--platform"] } : {}),
  };
}

function writeOptionalReport(reportPath, value) {
  if (reportPath) writeJson(path.resolve(reportPath), value);
}

function gateFlag(gate) {
  return `--gate-${gate.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "validate-policy") {
    loadRehearsalPolicy();
    console.log("release rehearsal policy ok");
    return;
  }
  if (command === "plan") {
    console.log(JSON.stringify(releaseWorkflowPlan()));
    return;
  }
  if (command === "source") {
    const values = parseOptions(arguments_, ["--mode", "--ref", "--revision"]);
    assertRepositorySource(identityOptions(values));
    console.log(JSON.stringify({ schemaVersion: 1, ...identityOptions(values), valid: true }));
    return;
  }
  if (command === "prepare") {
    const allowed = [
      "--mode",
      "--ref",
      "--revision",
      "--platform",
      "--release-output",
      "--bundle",
      "--report",
    ];
    const values = parseOptions(
      arguments_,
      allowed,
      allowed.filter((flag) => flag !== "--report"),
    );
    assertRepositorySource(identityOptions(values));
    const result = prepareCandidateBundle({
      ...identityOptions(values),
      releaseOutputDirectory: values["--release-output"],
      bundleDirectory: values["--bundle"],
    });
    const report = {
      schemaVersion: 1,
      bundleDirectory: result.bundleDirectory,
      manifest: result.manifest,
    };
    writeOptionalReport(values["--report"], report);
    console.log(JSON.stringify(report));
    return;
  }
  if (command === "verify") {
    const allowed = ["--mode", "--ref", "--revision", "--platform", "--bundle", "--report"];
    const values = parseOptions(
      arguments_,
      allowed,
      allowed.filter((flag) => flag !== "--report"),
    );
    const result = verifyDownloadedBundle({
      ...identityOptions(values),
      bundleDirectory: values["--bundle"],
    });
    const report = {
      schemaVersion: 1,
      verified: true,
      platform: values["--platform"],
      revision: values["--revision"],
      artifactCount: result.evidence.artifactCount,
      inventoryFileCount: result.manifest.integrity.files.length,
    };
    writeOptionalReport(values["--report"], report);
    console.log(JSON.stringify(report));
    return;
  }
  if (command === "launch") {
    const allowed = [
      "--mode",
      "--ref",
      "--revision",
      "--platform",
      "--bundle",
      "--extract",
      "--report",
    ];
    const values = parseOptions(
      arguments_,
      allowed,
      allowed.filter((flag) => flag !== "--report"),
    );
    const report = await launchDownloadedCandidate({
      ...identityOptions(values),
      bundleDirectory: values["--bundle"],
      extractDirectory: values["--extract"],
    });
    writeOptionalReport(values["--report"], report);
    console.log(JSON.stringify(report));
    return;
  }
  if (command === "rollback") {
    const allowed = [
      "--mode",
      "--ref",
      "--revision",
      "--platform",
      "--bundle",
      "--output",
      "--last-known-good",
      "--report",
    ];
    const values = parseOptions(
      arguments_,
      allowed,
      allowed.filter((flag) => flag !== "--report"),
    );
    const report = rehearseRollback({
      ...identityOptions(values),
      bundleDirectory: values["--bundle"],
      outputDirectory: values["--output"],
      lastKnownGood: values["--last-known-good"],
    });
    writeOptionalReport(values["--report"], report);
    console.log(JSON.stringify(report));
    return;
  }
  if (command === "decision") {
    const policy = loadRehearsalPolicy();
    const gateFlags = policy.requiredGates.map(gateFlag);
    const allowed = ["--mode", "--ref", "--revision", "--output", ...gateFlags];
    const values = parseOptions(arguments_, allowed);
    const gates = Object.fromEntries(
      policy.requiredGates.map((gate) => [gate, values[gateFlag(gate)]]),
    );
    const decision = createRehearsalDecision({ policy, ...identityOptions(values), gates });
    writeJson(path.resolve(values["--output"]), decision);
    console.log(JSON.stringify(decision));
    return;
  }
  if (command === "enforce") {
    const values = parseOptions(arguments_, ["--decision"]);
    const decision = readJson(path.resolve(values["--decision"]), "rehearsal decision");
    if (decision.outcome !== "passed" || decision.failedGates?.length !== 0) {
      fail(`promotion is blocked by rehearsal outcome ${decision.outcome ?? "unknown"}`);
    }
    console.log("release rehearsal decision passed; owner review is still required");
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

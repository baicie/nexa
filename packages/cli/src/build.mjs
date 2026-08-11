import { spawnSync } from "node:child_process";
import * as nodeFilesystem from "node:fs";
import path from "node:path";

import {
  APP_MANIFEST_MAX_BYTES,
  APP_MANIFEST_PERMISSIONS,
  APP_MANIFEST_PROTOCOL,
  APP_MANIFEST_SCHEMA,
  COMPATIBILITY,
} from "./constants.mjs";
import { resolveInstalledPackage, resolveInstalledPackageBin } from "./doctor.mjs";

const supportedTargets = new Set(["darwin/arm64", "darwin/x64", "win32/x64"]);
const manifestKeys = [
  "$schema",
  "id",
  "name",
  "permissions",
  "requiredProtocol",
  "schemaVersion",
  "version",
];
const permissionSet = new Set(APP_MANIFEST_PERMISSIONS);
const appIdPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;
const binaryNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const scopePattern = /^@[a-z0-9][a-z0-9._-]*$/u;
const windowsReservedNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const semverPattern =
  /^(0|[1-9]\d{0,17})\.(0|[1-9]\d{0,17})\.(0|[1-9]\d{0,17})(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const dialogFixtureCanaries = ["nexa-ui-dialog-open.txt", "nexa-ui-dialog-save.txt"];
const identityStatOptions = Object.freeze({ bigint: true });

function defaultRunner(command, args, options) {
  return spawnSync(command, args, options);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function fileIdentity(metadata) {
  return {
    ctime: metadata.ctimeNs ?? metadata.ctimeMs,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    mtime: metadata.mtimeNs ?? metadata.mtimeMs,
    size: metadata.size,
  };
}

function identitiesMatch(left, right) {
  const leftIdentity = fileIdentity(left);
  const rightIdentity = fileIdentity(right);
  return Object.keys(leftIdentity).every((key) => leftIdentity[key] === rightIdentity[key]);
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function exceedsByteLimit(size, maximumBytes) {
  return typeof size === "bigint" ? size > BigInt(maximumBytes) : size > maximumBytes;
}

function byteLengthMatches(length, size) {
  return typeof size === "bigint" ? BigInt(length) === size : length === size;
}

export function readStableRegularFile(filesystem, filePath, label, maximumBytes, expectedMetadata) {
  let pathMetadata;
  try {
    pathMetadata = filesystem.lstatSync(filePath, identityStatOptions);
  } catch (error) {
    throw new Error(`${label} does not exist: ${filePath}`, { cause: error });
  }
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new Error(`${label} must be a non-symbolic-link regular file: ${filePath}`);
  }
  if (expectedMetadata && !identitiesMatch(expectedMetadata, pathMetadata)) {
    throw new Error(`${label} changed before it could be read: ${filePath}`);
  }
  if (maximumBytes !== undefined && exceedsByteLimit(pathMetadata.size, maximumBytes)) {
    throw new Error(`${label} exceeds the ${maximumBytes} byte limit`);
  }

  const noFollow = process.platform === "win32" ? 0 : nodeFilesystem.constants.O_NOFOLLOW;
  let descriptor;
  try {
    descriptor = filesystem.openSync(filePath, nodeFilesystem.constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error(`${label} changed or could not be opened safely: ${filePath}`, {
      cause: error,
    });
  }

  let bytes;
  let readError;
  try {
    const openedMetadata = filesystem.fstatSync(descriptor, identityStatOptions);
    if (!openedMetadata.isFile() || !identitiesMatch(pathMetadata, openedMetadata)) {
      throw new Error(`${label} changed before it could be read: ${filePath}`);
    }
    bytes = filesystem.readFileSync(descriptor);
    const finalDescriptorMetadata = filesystem.fstatSync(descriptor, identityStatOptions);
    let finalPathMetadata;
    try {
      finalPathMetadata = filesystem.lstatSync(filePath, identityStatOptions);
    } catch (error) {
      throw new Error(`${label} changed while reading: ${filePath}`, { cause: error });
    }
    if (
      finalPathMetadata.isSymbolicLink() ||
      !finalPathMetadata.isFile() ||
      !identitiesMatch(openedMetadata, finalDescriptorMetadata) ||
      !identitiesMatch(openedMetadata, finalPathMetadata) ||
      !byteLengthMatches(bytes.length, openedMetadata.size)
    ) {
      throw new Error(`${label} changed while reading: ${filePath}`);
    }
    if (maximumBytes !== undefined && bytes.length > maximumBytes) {
      throw new Error(`${label} changed while reading and exceeds the ${maximumBytes} byte limit`);
    }
  } catch (error) {
    readError = error;
  }

  try {
    filesystem.closeSync(descriptor);
  } catch (closeError) {
    if (readError) {
      throw new Error(
        `${failureMessage(readError)}; additionally failed to close ${label}: ${failureMessage(closeError)}`,
        { cause: new AggregateError([readError, closeError]) },
      );
    }
    throw new Error(`Could not close ${label}: ${filePath}`, { cause: closeError });
  }
  if (readError) throw readError;
  return bytes;
}

function parseJsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function isValidAppName(name) {
  if (typeof name !== "string" || [...name].length < 1 || [...name].length > 80) return false;
  if (name.trim().length === 0) return false;
  return ![...name].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    );
  });
}

function validateAppManifest(manifest) {
  assertExactKeys(manifest, manifestKeys, "app manifest");
  if (manifest.$schema !== APP_MANIFEST_SCHEMA) {
    throw new Error(`app manifest schema must be ${APP_MANIFEST_SCHEMA}`);
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error("app manifest schemaVersion must be 1");
  }
  if (
    typeof manifest.id !== "string" ||
    manifest.id.length < 3 ||
    manifest.id.length > 255 ||
    !appIdPattern.test(manifest.id)
  ) {
    throw new Error("app manifest id must be a valid reverse-DNS identifier");
  }
  if (!isValidAppName(manifest.name)) {
    throw new Error("app manifest name must contain 1-80 visible characters");
  }
  if (
    typeof manifest.version !== "string" ||
    manifest.version.length > 128 ||
    !semverPattern.test(manifest.version)
  ) {
    throw new Error("app manifest version must be canonical SemVer");
  }

  const protocol = manifest.requiredProtocol;
  if (!protocol || typeof protocol !== "object" || Array.isArray(protocol)) {
    throw new Error("app manifest requiredProtocol must be an object");
  }
  assertExactKeys(protocol, ["major", "minor"], "app manifest requiredProtocol");
  if (
    protocol.major !== APP_MANIFEST_PROTOCOL.major ||
    protocol.minor > APP_MANIFEST_PROTOCOL.minor ||
    !Number.isInteger(protocol.minor) ||
    protocol.minor < 0
  ) {
    throw new Error(
      `app manifest requires incompatible Protocol ${String(protocol.major)}.${String(protocol.minor)}`,
    );
  }

  if (!Array.isArray(manifest.permissions) || manifest.permissions.length > 64) {
    throw new Error("app manifest permissions must be an array with at most 64 entries");
  }
  const seen = new Set();
  for (const permission of manifest.permissions) {
    if (typeof permission !== "string" || !permissionSet.has(permission)) {
      throw new Error(`app manifest contains unknown permission ${JSON.stringify(permission)}`);
    }
    if (seen.has(permission)) {
      throw new Error(`app manifest contains duplicate permission ${JSON.stringify(permission)}`);
    }
    seen.add(permission);
  }
  return manifest;
}

function binaryNameFromPackageManifest(manifest) {
  if (typeof manifest.name !== "string") {
    throw new Error("package.json name must be a string");
  }
  const segments = manifest.name.split("/");
  if (
    segments.length > 2 ||
    (segments.length === 2 && (!scopePattern.test(segments[0]) || !segments[1]))
  ) {
    throw new Error("package.json name must be an unscoped name or one npm scope and name");
  }
  const binaryName = segments.at(-1);
  if (
    typeof binaryName !== "string" ||
    binaryName.length > 63 ||
    !binaryNamePattern.test(binaryName) ||
    windowsReservedNames.test(binaryName)
  ) {
    throw new Error("package.json name must end in a safe lowercase/hyphen binary name");
  }
  return binaryName;
}

export function readProject(filesystem, cwd) {
  const projectDirectory = path.resolve(cwd);
  const packagePath = path.join(projectDirectory, "package.json");
  const entryRelative = path.join("src", "main.tsx");
  const entryPath = path.join(projectDirectory, entryRelative);
  const manifestPath = path.join(projectDirectory, "app.manifest.json");
  const packageManifest = parseJsonObject(
    readStableRegularFile(filesystem, packagePath, "package.json"),
    "package.json",
  );
  const binaryName = binaryNameFromPackageManifest(packageManifest);
  readStableRegularFile(filesystem, entryPath, "Minimal TSX entry");
  const manifestSource = readStableRegularFile(
    filesystem,
    manifestPath,
    "app manifest",
    APP_MANIFEST_MAX_BYTES,
  );
  const manifest = validateAppManifest(parseJsonObject(manifestSource, "app manifest"));
  return {
    binaryName,
    entryRelative,
    manifest,
    manifestPath,
    manifestSource,
    projectDirectory,
  };
}

function resolvePerry(cwd) {
  const resolved = resolveInstalledPackage("@perryts/perry", cwd);
  if (resolved.manifest.version !== COMPATIBILITY.perry) {
    throw new Error(
      `Perry package version ${String(resolved.manifest.version)} does not match required ${COMPATIBILITY.perry}`,
    );
  }
  return resolveInstalledPackageBin("@perryts/perry", "perry", cwd);
}

export function assertSupportedTarget(runtime) {
  const target = `${runtime.platform}/${runtime.arch}`;
  if (!supportedTargets.has(target)) {
    throw new Error(`Unsupported Technical Preview target ${target}`);
  }
}

function ensureDirectory(filesystem, root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const metadata = lstatIfPresent(filesystem, current);
    if (metadata) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Build directory must not be a symbolic link or file: ${current}`);
      }
    } else {
      filesystem.mkdirSync(current);
    }
  }
  return current;
}

function lstatIfPresent(filesystem, candidate) {
  try {
    return filesystem.lstatSync(candidate);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw new Error(`Could not inspect build path ${candidate}`, { cause: error });
  }
}

function sanitizedEnvironment(environment, manifestPath) {
  const blocked = new Set([
    "NEXA_APP_MANIFEST_PATH",
    "NEXA_DIALOG_TEST_FIXTURE_PATH",
    "PERRY_SKIP_CODEGEN",
  ]);
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!blocked.has(key.toUpperCase())) result[key] = value;
  }
  result.NEXA_APP_MANIFEST_PATH = manifestPath;
  return result;
}

function assertProcessSucceeded(result, stage) {
  if (result?.error) {
    throw new Error(`${stage} could not start: ${result.error.message}`, { cause: result.error });
  }
  if (result?.status !== 0) {
    const suffix = result?.signal
      ? ` after signal ${result.signal}`
      : ` with exit code ${result?.status ?? "no status"}`;
    throw new Error(`${stage} failed${suffix}`);
  }
}

function assertOwnedBinaryPath(filesystem, binaryPath, remove) {
  const metadata = lstatIfPresent(filesystem, binaryPath);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Build binary path must be a regular file: ${binaryPath}`);
  }
  if (remove) filesystem.unlinkSync(binaryPath);
}

export function verifyBuiltBinary(filesystem, binaryPath, manifestSource) {
  const binary = readStableRegularFile(filesystem, binaryPath, "Compiled binary");
  if (!binary.includes(manifestSource)) {
    throw new Error("Compiled binary embedded manifest bytes do not match app.manifest.json");
  }
  for (const canary of dialogFixtureCanaries) {
    if (binary.includes(Buffer.from(canary))) {
      throw new Error(`Compiled binary contains Dialog test fixture marker ${canary}`);
    }
  }
  return binary;
}

function portablePath(value) {
  return value.split(path.sep).join("/");
}

export function runProjectBuild({
  cwd = process.cwd(),
  environment = process.env,
  filesystem = nodeFilesystem,
  runner = defaultRunner,
  runtime = { arch: process.arch, platform: process.platform },
} = {}) {
  assertSupportedTarget(runtime);
  const project = readProject(filesystem, cwd);
  const perryBin = resolvePerry(project.projectDirectory);
  ensureDirectory(filesystem, project.projectDirectory, ["dist"]);
  const outputRelative = path.join("dist", project.binaryName);
  const binaryRelative = runtime.platform === "win32" ? `${outputRelative}.exe` : outputRelative;
  const binaryPath = path.join(project.projectDirectory, binaryRelative);
  assertOwnedBinaryPath(filesystem, binaryPath, true);

  const args = [perryBin, "compile", project.entryRelative, "-o", outputRelative];
  if (runtime.platform === "win32") args.push("--windows-subsystem", "windows");
  const result = runner(process.execPath, args, {
    cwd: project.projectDirectory,
    env: sanitizedEnvironment(environment, project.manifestPath),
    stdio: "inherit",
  });
  assertProcessSucceeded(result, "Perry compile");
  verifyBuiltBinary(filesystem, binaryPath, project.manifestSource);

  return {
    binaryPath,
    binaryRelative: portablePath(binaryRelative),
    id: project.manifest.id,
    version: project.manifest.version,
  };
}

export function runProjectDev({
  cwd = process.cwd(),
  environment = process.env,
  filesystem = nodeFilesystem,
  onStart = () => {},
  runner = defaultRunner,
  runtime = { arch: process.arch, platform: process.platform },
} = {}) {
  assertSupportedTarget(runtime);
  const project = readProject(filesystem, cwd);
  const perryBin = resolvePerry(project.projectDirectory);
  ensureDirectory(filesystem, project.projectDirectory, [".nexa", "dev"]);
  const outputRelative = path.join(".nexa", "dev", project.binaryName);
  const binaryRelative = runtime.platform === "win32" ? `${outputRelative}.exe` : outputRelative;
  assertOwnedBinaryPath(filesystem, path.join(project.projectDirectory, binaryRelative), false);
  onStart({
    entryRelative: portablePath(project.entryRelative),
    id: project.manifest.id,
  });
  const result = runner(
    process.execPath,
    [perryBin, "dev", project.entryRelative, "-o", outputRelative],
    {
      cwd: project.projectDirectory,
      env: sanitizedEnvironment(environment, project.manifestPath),
      stdio: "inherit",
    },
  );
  assertProcessSucceeded(result, "Perry dev");
}

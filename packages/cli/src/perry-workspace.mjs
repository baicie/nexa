import { spawnSync } from "node:child_process";
import * as nodeFilesystem from "node:fs";
import path from "node:path";

import { resolveInstalledPackage } from "./doctor.mjs";
import {
  COMPATIBILITY,
  PERRY_SOURCE_REPOSITORY,
  PERRY_SOURCE_REVISION,
} from "./constants.mjs";

const metadataBufferLimit = 16 * 1024 * 1024;
const requiredPerryCrates = [
  "perry-ffi",
  "perry-runtime",
  "perry-stdlib",
  "perry-ui-geisterhand",
];

function defaultRunner(command, args, options) {
  return spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: metadataBufferLimit,
  });
}

function resultOutput(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertCommandSucceeded(result, command, args) {
  if (result?.error) {
    throw new Error(`${command} could not start: ${result.error.message}`, { cause: result.error });
  }
  if (result?.status !== 0) {
    const detail = resultOutput(result?.stderr).trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result?.status ?? "no status"}${detail ? `: ${detail}` : ""}`,
    );
  }
}

function regularFile(filesystem, filePath, label) {
  let metadata;
  try {
    metadata = filesystem.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} does not exist: ${filePath}`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a non-symbolic-link regular file: ${filePath}`);
  }
  return filePath;
}

function regularDirectory(filesystem, directory, label) {
  let metadata;
  try {
    metadata = filesystem.lstatSync(directory);
  } catch (error) {
    throw new Error(`${label} does not exist: ${directory}`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a non-symbolic-link directory: ${directory}`);
  }
  return directory;
}

function canonicalRegularFile(filesystem, filePath, label) {
  regularFile(filesystem, filePath, label);
  try {
    return filesystem.realpathSync(filePath);
  } catch (error) {
    throw new Error(`${label} could not be canonicalized: ${filePath}`, { cause: error });
  }
}

function canonicalWorkspaceRoot(filesystem, perryFfiManifest) {
  const manifest = canonicalRegularFile(filesystem, perryFfiManifest, "Perry perry-ffi manifest");
  const rootCandidate = path.resolve(manifest, "..", "..", "..");
  regularDirectory(filesystem, rootCandidate, "Perry workspace root");
  let root;
  try {
    root = filesystem.realpathSync(rootCandidate);
  } catch (error) {
    throw new Error(`Perry workspace root could not be canonicalized: ${rootCandidate}`, {
      cause: error,
    });
  }
  const expectedManifest = path.join(root, "crates", "perry-ffi", "Cargo.toml");
  if (manifest !== expectedManifest) {
    throw new Error(`Perry perry-ffi manifest is not at crates/perry-ffi/Cargo.toml: ${manifest}`);
  }
  regularFile(filesystem, path.join(root, "Cargo.toml"), "Perry workspace manifest");
  for (const crate of requiredPerryCrates) {
    regularFile(
      filesystem,
      path.join(root, "crates", crate, "Cargo.toml"),
      `Perry workspace is missing required crate ${crate}`,
    );
  }
  return root;
}

function parseCargoMetadata(stdout) {
  let metadata;
  try {
    metadata = JSON.parse(resultOutput(stdout));
  } catch (error) {
    throw new Error(`cargo metadata returned invalid JSON: ${errorMessage(error)}`, { cause: error });
  }
  if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.packages)) {
    throw new Error("cargo metadata must contain a packages array");
  }
  return metadata;
}

function resolveHostManifest({
  filesystem,
  projectDirectory,
  hostManifestPath,
  resolvePackage,
}) {
  if (hostManifestPath !== undefined) {
    return canonicalRegularFile(filesystem, path.resolve(hostManifestPath), "NUI Host Cargo manifest");
  }
  if (typeof projectDirectory !== "string" || projectDirectory.length === 0) {
    throw new Error("Perry workspace resolution requires projectDirectory or hostManifestPath");
  }
  const resolved = resolvePackage("@nexa/nui-host", projectDirectory);
  if (resolved?.manifest?.version !== COMPATIBILITY.hostRuntime) {
    throw new Error(
      `NUI Host package version ${String(resolved?.manifest?.version)} does not match required ${COMPATIBILITY.hostRuntime}`,
    );
  }
  const packageManifest = canonicalRegularFile(
    filesystem,
    resolved.filePath,
    "NUI Host package manifest",
  );
  const targets = resolved.manifest?.perry?.nativeLibrary?.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    throw new Error("NUI Host package has no native library targets");
  }
  const crateValues = Object.values(targets).map((target) => target?.crate);
  if (
    crateValues.length === 0 ||
    crateValues.some((crate) => typeof crate !== "string" || crate.length === 0)
  ) {
    throw new Error("NUI Host native library targets must declare crate paths");
  }
  if (new Set(crateValues).size !== 1) {
    throw new Error("NUI Host native library targets must use one vendored crate");
  }
  const packageDirectory = path.dirname(packageManifest);
  const crateDirectory = path.resolve(packageDirectory, crateValues[0]);
  const relative = path.relative(packageDirectory, crateDirectory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("NUI Host native crate must stay inside the installed package");
  }
  regularDirectory(filesystem, crateDirectory, "NUI Host native crate");
  return canonicalRegularFile(
    filesystem,
    path.join(crateDirectory, "Cargo.toml"),
    "NUI Host native Cargo manifest",
  );
}

function parsePerrySource(source) {
  const expectedPrefix = `git+${PERRY_SOURCE_REPOSITORY}?rev=`;
  if (typeof source !== "string" || !source.startsWith(expectedPrefix)) {
    throw new Error(`Perry source must be ${expectedPrefix}<revision>#<revision>`);
  }
  const revision = source.slice(expectedPrefix.length).split("#");
  if (
    revision.length !== 2 ||
    revision[0] !== revision[1] ||
    !/^[0-9a-f]{40}$/u.test(revision[0])
  ) {
    throw new Error(`Perry source has an invalid revision: ${source}`);
  }
  if (revision[0] !== PERRY_SOURCE_REVISION) {
    throw new Error(
      `Perry source revision ${revision[0]} does not match required ${PERRY_SOURCE_REVISION}`,
    );
  }
}

export function resolvePerryWorkspace({
  filesystem = nodeFilesystem,
  hostManifestPath,
  projectDirectory,
  resolvePackage = resolveInstalledPackage,
  runner = defaultRunner,
} = {}) {
  const manifestPath = resolveHostManifest({
    filesystem,
    hostManifestPath,
    projectDirectory,
    resolvePackage,
  });
  const metadataArgs = [
    "metadata",
    "--manifest-path",
    manifestPath,
    "--locked",
    "--format-version",
    "1",
  ];
  const metadataResult = runner("cargo", metadataArgs, {
    cwd: path.dirname(manifestPath),
    encoding: "utf8",
    maxBuffer: metadataBufferLimit,
  });
  assertCommandSucceeded(metadataResult, "cargo metadata", metadataArgs);
  const metadata = parseCargoMetadata(metadataResult.stdout);
  const perryPackages = metadata.packages.filter((package_) => package_.name === "perry-ffi");
  if (perryPackages.length !== 1) {
    throw new Error("Cargo metadata must contain exactly one perry-ffi package");
  }
  const perry = perryPackages[0];
  if (perry.version !== COMPATIBILITY.perry) {
    throw new Error(
      `Perry source version ${String(perry.version)} does not match required ${COMPATIBILITY.perry}`,
    );
  }
  parsePerrySource(perry.source);
  const workspace = canonicalWorkspaceRoot(filesystem, perry.manifest_path);

  const headArgs = ["-C", workspace, "rev-parse", "HEAD"];
  const headResult = runner("git", headArgs, { cwd: workspace, encoding: "utf8" });
  assertCommandSucceeded(headResult, "git rev-parse", headArgs);
  const head = resultOutput(headResult.stdout).trim();
  if (head !== PERRY_SOURCE_REVISION) {
    throw new Error(`Perry checkout HEAD ${head} does not match required ${PERRY_SOURCE_REVISION}`);
  }

  const statusArgs = ["-C", workspace, "status", "--short", "--untracked-files=no"];
  const statusResult = runner("git", statusArgs, { cwd: workspace, encoding: "utf8" });
  assertCommandSucceeded(statusResult, "git status", statusArgs);
  if (resultOutput(statusResult.stdout).trim().length > 0) {
    throw new Error("Perry source checkout has tracked changes");
  }
  return workspace;
}

export function createPerryWorkspaceEnvironment(environment, workspace) {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("Perry workspace root must be a non-empty path");
  }
  const result = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (key.toUpperCase() !== "PERRY_WORKSPACE_ROOT") result[key] = value;
  }
  result.PERRY_WORKSPACE_ROOT = workspace;
  return result;
}

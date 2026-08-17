import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMPATIBILITY, PERRY_SOURCE_REPOSITORY, PERRY_SOURCE_REVISION } from "./constants.mjs";
import { resolveInstalledPackage } from "./doctor.mjs";

const NUI_HOST = "@nexa/nui-host";
const SYSTEM_HOST = "@nexa/system-host";
const HOST_NAMES = new Set(["nui-host", "system-host"]);
const WINDOWS_SKIA_LIBRARIES = ["skia.lib", "skia-bindings.lib"];
const CARGO_METADATA_BUFFER_LIMIT = 16 * 1024 * 1024;
const PERRY_WINDOWS_LONGJMP_UPSTREAM_COMMIT = "4f397c7ae0b9349d3eddf32b873c5a753cffa3fd";
const PERRY_WINDOWS_LONGJMP_TARGET = "crates/perry-runtime/src/exception.rs";
const PERRY_WINDOWS_LONGJMP_BEFORE_SHA256 =
  "10073a4f45bb1db32d989be5f9d31405fb8d2798ef42315b67e7ea5bd75b1b05";
const PERRY_WINDOWS_LONGJMP_AFTER_SHA256 =
  "0a7b0a0f676748a1dd1a166aed57d6e08f1e8b3016d9c51495062cbe48cdae43";
const PERRY_WINDOWS_LONGJMP_ANCHOR = "    unsafe { longjmp(jb_ptr, 1) }\n";
const PERRY_WINDOWS_LONGJMP_REPLACEMENT = `    #[cfg(windows)]
    unsafe {
        (jb_ptr as *mut u64).write(0);
    }
${PERRY_WINDOWS_LONGJMP_ANCHOR}`;
const FORBIDDEN_SEGMENTS = new Set(["target", "node_modules", ".git"]);
const PACKAGED_TEMPLATE_ROOT = path.resolve(
  fileURLToPath(new URL("./windows-static-closure/", import.meta.url)),
);
const TEMPLATE_ROOT = PACKAGED_TEMPLATE_ROOT;
const identityOptions = Object.freeze({ bigint: true });

export const WINDOWS_CLOSURE_RUST_TOOLCHAIN = "1.95.0";
export const WINDOWS_CLOSURE_RUST_TARGET = "x86_64-pc-windows-msvc";

function fail(message) {
  throw new Error(`Windows Perry runtime closure: ${message}`);
}

function lstatRegular(filePath, label) {
  let stat;
  try {
    stat = lstatSync(filePath, identityOptions);
  } catch {
    fail(`${label} does not exist: ${filePath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file: ${filePath}`);
  return stat;
}

function lstatDirectory(directory, label) {
  let stat;
  try {
    stat = lstatSync(directory, identityOptions);
  } catch {
    fail(`${label} does not exist: ${directory}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    fail(`${label} must be a directory: ${directory}`);
  return stat;
}

function regularFile(filePath, label) {
  lstatRegular(filePath, label);
  return filePath;
}

function regularDirectory(directory, label) {
  lstatDirectory(directory, label);
  return directory;
}

function nonEmptyRegularFile(filePath, label) {
  const stat = lstatRegular(filePath, label);
  if (stat.size === 0n) fail(`${label} must not be empty: ${filePath}`);
  return filePath;
}

function canonicalFile(filePath, label) {
  regularFile(filePath, label);
  try {
    return realpathSync.native(filePath);
  } catch {
    fail(`${label} could not be canonicalized: ${filePath}`);
  }
}

function canonicalDirectory(directory, label) {
  regularDirectory(directory, label);
  try {
    return realpathSync.native(directory);
  } catch {
    fail(`${label} could not be canonicalized: ${directory}`);
  }
}

function assertInside(parent, child, label) {
  const relative = path.relative(parent, child);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label} escapes its package: ${child}`);
  }
}

function assertDirectoryPathHasNoLinks(parent, child, label) {
  assertInside(parent, child, label);
  let current = parent;
  for (const segment of path.relative(parent, child).split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current, identityOptions);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`${label} contains a symbolic link: ${current}`);
    if (!stat.isDirectory()) fail(`${label} contains a non-directory path: ${current}`);
  }
}

function replaceCaseInsensitive(environment, values) {
  const names = new Set(Object.keys(values).map((name) => name.toUpperCase()));
  const result = Object.fromEntries(
    Object.entries(environment ?? {}).filter(([name]) => !names.has(name.toUpperCase())),
  );
  return { ...result, ...values };
}

function closureEnvironment(environment, values) {
  return replaceCaseInsensitive(environment, {
    NEXA_APP_MANIFEST_PATH: undefined,
    NEXA_DIALOG_TEST_FIXTURE_PATH: undefined,
    ...values,
  });
}

function hostSource(name, projectDirectory, resolvePackage, environment) {
  const resolved = resolvePackage(name, projectDirectory);
  const manifest = resolved?.manifest;
  if (manifest?.version !== COMPATIBILITY.hostRuntime) {
    fail(
      `${name} version ${String(manifest?.version)} does not match ${COMPATIBILITY.hostRuntime}`,
    );
  }
  if (manifest?.perry?.nativeLibrary?.abiVersion !== COMPATIBILITY.hostAbi) {
    fail(`${name} native ABI does not match ${COMPATIBILITY.hostAbi}`);
  }
  const packageManifest = canonicalFile(resolved.filePath, `${name} package manifest`);
  const packageDirectory = path.dirname(packageManifest);
  const requireInstalled = Object.entries(environment ?? {}).some(
    ([key, value]) => key.toUpperCase() === "NEXA_REQUIRE_INSTALLED_HOSTS" && value === "1",
  );
  if (requireInstalled) {
    const projectRoot = canonicalDirectory(projectDirectory, "clean consumer project");
    assertInside(projectRoot, packageDirectory, `${name} installed package`);
    const relative = path.relative(projectRoot, packageDirectory);
    if (!relative.split(path.sep).includes("node_modules")) {
      fail(`${name} must resolve from the clean consumer node_modules tree`);
    }
  }
  const targets = manifest.perry.nativeLibrary.targets;
  const expectedCrate = `dist/native/repo/packages/${name.slice("@nexa/".length)}`;
  const crates = Object.values(targets ?? {}).map((target) => target?.crate);
  if (crates.length === 0 || crates.some((crate) => crate !== expectedCrate)) {
    fail(`${name} must use the published vendored native source closure`);
  }
  const nativeRoot = path.resolve(packageDirectory, "dist/native/repo");
  assertDirectoryPathHasNoLinks(packageDirectory, nativeRoot, `${name} native closure`);
  regularDirectory(nativeRoot, `${name} native closure`);
  const markerPath = regularFile(
    path.join(nativeRoot, "RELEASE-CLOSURE.json"),
    `${name} closure marker`,
  );
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    fail(`${name} closure marker must be valid JSON`);
  }
  if (
    marker?.schemaVersion !== 1 ||
    marker?.host !== name ||
    marker?.layout !== "repository-relative" ||
    marker?.source !== "vendored" ||
    Object.keys(marker).sort().join("\0") !== "host\0layout\0schemaVersion\0source"
  ) {
    fail(`${name} closure marker does not match the published vendored-source contract`);
  }
  const packageRoot = path.join(nativeRoot, "packages");
  regularDirectory(packageRoot, `${name} closure packages directory`);
  const packageEntries = readdirSync(packageRoot);
  const expectedName = name.slice("@nexa/".length);
  if (packageEntries.some((entry) => entry !== expectedName && HOST_NAMES.has(entry))) {
    fail(`${name} closure contains another Host package`);
  }
  const windowsTarget = targets.windows;
  let windowsLibDirectories = [];
  if (windowsTarget?.libDirs !== undefined) {
    if (
      !Array.isArray(windowsTarget.libDirs) ||
      windowsTarget.libDirs.some((directory) => typeof directory !== "string" || !directory)
    ) {
      fail(`${name} Windows native libDirs must be an array of non-empty paths`);
    }
    windowsLibDirectories = windowsTarget.libDirs.map((directory) => {
      const absolute = path.resolve(packageDirectory, directory);
      assertDirectoryPathHasNoLinks(
        packageDirectory,
        absolute,
        `${name} Windows native library directory`,
      );
      return absolute;
    });
  }
  return { packageDirectory, nativeRoot, expectedName, windowsLibDirectories };
}

function isPerryGeneratedHostTarget(relative, stat) {
  const segments = relative.split(path.sep);
  return (
    stat.isDirectory() &&
    segments.length === 3 &&
    segments[0] === "packages" &&
    HOST_NAMES.has(segments[1]) &&
    segments[2] === "target"
  );
}

function relativeFiles(root, current = root, output = []) {
  for (const name of readdirSync(current).sort()) {
    const source = path.join(current, name);
    const relative = path.relative(root, source);
    const stat = lstatSync(source, identityOptions);
    // Perry builds each declared nativeLibrary in place after the unified closure
    // is prepared. Keep that Cargo cache installed, but never trust or merge it.
    if (isPerryGeneratedHostTarget(relative, stat)) continue;
    const segments = relative.split(path.sep);
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      fail(`native closure contains forbidden build output: ${relative}`);
    }
    if (stat.isSymbolicLink()) fail(`native closure contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) relativeFiles(root, source, output);
    else if (stat.isFile()) output.push(relative);
    else fail(`native closure contains a special file: ${relative}`);
  }
  return output;
}

function commonFiles(root) {
  return relativeFiles(root).filter((relative) => {
    const first = relative.split(path.sep)[0];
    return first !== "packages" && relative !== "RELEASE-CLOSURE.json";
  });
}

function treeDigest(root) {
  const hash = createHash("sha256");
  for (const relative of relativeFiles(root)) {
    hash.update(Buffer.from(relative.split(path.sep).join("/"), "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(readFileSync(path.join(root, relative)));
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function commonDirectories(root) {
  const output = [];
  function visit(current) {
    for (const name of readdirSync(current).sort()) {
      const source = path.join(current, name);
      const relative = path.relative(root, source);
      const stat = lstatSync(source, identityOptions);
      if (isPerryGeneratedHostTarget(relative, stat)) continue;
      const segments = relative.split(path.sep);
      if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
        fail(`native closure contains forbidden build output: ${relative}`);
      }
      if (stat.isSymbolicLink()) fail(`native closure contains a symbolic link: ${relative}`);
      if (!stat.isDirectory()) continue;
      if (segments[0] !== "packages") output.push(relative);
      visit(source);
    }
  }
  visit(root);
  return output;
}

function assertSharedClosure(nuiRoot, systemRoot) {
  const nuiFiles = commonFiles(nuiRoot);
  const systemFiles = commonFiles(systemRoot);
  if (
    nuiFiles.length !== systemFiles.length ||
    nuiFiles.some((file) => !systemFiles.includes(file))
  ) {
    fail("installed Host native closures do not share the same common workspace files");
  }
  for (const relative of nuiFiles) {
    const left = readFileSync(path.join(nuiRoot, relative));
    const right = readFileSync(path.join(systemRoot, relative));
    if (!left.equals(right)) fail(`installed Host native closures drift at ${relative}`);
  }
}

function copyTree(source, destination, root) {
  const stat = lstatSync(source, identityOptions);
  const relative = path.relative(root, source);
  if (isPerryGeneratedHostTarget(relative, stat)) return;
  if (relative.split(path.sep).some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    fail(`native closure contains forbidden build output: ${relative}`);
  }
  if (stat.isSymbolicLink()) fail(`native closure contains a symbolic link: ${relative}`);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source).sort())
      copyTree(path.join(source, name), path.join(destination, name), root);
    return;
  }
  if (!stat.isFile()) fail(`native closure contains a special file: ${relative}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { dereference: false, force: true });
}

function mergeInstalledSources(nui, system, destination) {
  assertSharedClosure(nui.nativeRoot, system.nativeRoot);
  const merged = path.join(destination, "source", "repo");
  mkdirSync(merged, { recursive: true });
  for (const relative of commonDirectories(nui.nativeRoot)) {
    mkdirSync(path.join(merged, relative), { recursive: true });
  }
  for (const relative of commonFiles(nui.nativeRoot)) {
    copyTree(path.join(nui.nativeRoot, relative), path.join(merged, relative), nui.nativeRoot);
  }
  copyTree(
    path.join(nui.nativeRoot, "packages", nui.expectedName),
    path.join(merged, "packages", nui.expectedName),
    nui.nativeRoot,
  );
  copyTree(
    path.join(system.nativeRoot, "packages", system.expectedName),
    path.join(merged, "packages", system.expectedName),
    system.nativeRoot,
  );
  return merged;
}

function copyClosureTemplate(merged, templateRoot = TEMPLATE_ROOT) {
  const runtimePatch = "patches/perry-runtime-windows-longjmp.json";
  for (const file of ["Cargo.toml", "Cargo.lock", "src/lib.rs", runtimePatch]) {
    regularFile(path.join(templateRoot, file), `reviewed closure template ${file}`);
  }
  const destination = path.join(merged, "packages/cli/src/windows-static-closure");
  mkdirSync(path.join(destination, "src"), { recursive: true });
  for (const file of ["Cargo.toml", "Cargo.lock"]) {
    cpSync(path.join(templateRoot, file), path.join(destination, file));
  }
  cpSync(path.join(templateRoot, "src/lib.rs"), path.join(destination, "src/lib.rs"));
  mkdirSync(path.join(destination, "patches"), { recursive: true });
  cpSync(path.join(templateRoot, runtimePatch), path.join(destination, runtimePatch));
  return {
    manifestPath: path.join(destination, "Cargo.toml"),
    runtimePatchPath: path.join(destination, runtimePatch),
  };
}

function defaultRunner(command, args, options) {
  return spawnSync(command, args, { stdio: "inherit", ...options });
}

function assertCommandSucceeded(result, stage) {
  if (result?.error) fail(`${stage} could not start: ${result.error.message}`);
  if (result?.status !== 0) fail(`${stage} failed with exit code ${result?.status ?? "unknown"}`);
}

function commandOutput(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readRuntimePatchContract(patchPath) {
  const bytes = readFileSync(canonicalFile(patchPath, "reviewed Perry runtime patch"));
  let contract;
  try {
    contract = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("reviewed Perry runtime patch must be valid JSON");
  }
  const expectedKeys = [
    "afterSha256",
    "anchor",
    "beforeSha256",
    "replacement",
    "schemaVersion",
    "sourceRevision",
    "target",
    "upstreamCommit",
  ];
  const actualKeys =
    contract !== null && typeof contract === "object" && !Array.isArray(contract)
      ? Object.keys(contract).sort()
      : [];
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    contract.schemaVersion !== 1 ||
    contract.sourceRevision !== PERRY_SOURCE_REVISION ||
    contract.upstreamCommit !== PERRY_WINDOWS_LONGJMP_UPSTREAM_COMMIT ||
    contract.target !== PERRY_WINDOWS_LONGJMP_TARGET ||
    contract.beforeSha256 !== PERRY_WINDOWS_LONGJMP_BEFORE_SHA256 ||
    contract.afterSha256 !== PERRY_WINDOWS_LONGJMP_AFTER_SHA256 ||
    contract.anchor !== PERRY_WINDOWS_LONGJMP_ANCHOR ||
    contract.replacement !== PERRY_WINDOWS_LONGJMP_REPLACEMENT
  ) {
    fail("reviewed Perry runtime patch contract is invalid");
  }
  return { contract, contractSha256: sha256(bytes) };
}

function patchPerryRuntime(metadata, cargoHome, patchPath) {
  const runtimes = metadata.packages.filter(({ name }) => name === "perry-runtime");
  if (runtimes.length !== 1) {
    fail("merged closure Cargo graph must resolve exactly one Perry runtime");
  }
  const runtime = runtimes[0];
  const expectedSource = `git+${PERRY_SOURCE_REPOSITORY}?rev=${PERRY_SOURCE_REVISION}#${PERRY_SOURCE_REVISION}`;
  if (runtime.version !== COMPATIBILITY.perry || runtime.source !== expectedSource) {
    fail("merged closure Perry runtime does not match the pinned version and revision");
  }

  const canonicalCargoHome = canonicalDirectory(cargoHome, "controlled Cargo home");
  const runtimeManifest = canonicalFile(runtime.manifest_path, "Perry runtime Cargo manifest");
  assertInside(canonicalCargoHome, runtimeManifest, "Perry runtime Cargo manifest");
  const sourceRoot = canonicalDirectory(
    path.resolve(path.dirname(runtimeManifest), "../.."),
    "Perry source checkout",
  );
  assertInside(canonicalCargoHome, sourceRoot, "Perry source checkout");
  if (
    canonicalFile(
      path.join(sourceRoot, "crates/perry-runtime/Cargo.toml"),
      "Perry runtime Cargo manifest",
    ) !== runtimeManifest
  ) {
    fail("Perry runtime manifest is outside the pinned source layout");
  }

  const { contract, contractSha256 } = readRuntimePatchContract(patchPath);
  const runtimeSource = canonicalFile(
    path.join(sourceRoot, contract.target),
    "Perry runtime exception source",
  );
  assertInside(sourceRoot, runtimeSource, "Perry runtime exception source");
  let bytes = readFileSync(runtimeSource);
  let sourceSha256 = sha256(bytes);
  if (sourceSha256 === contract.beforeSha256) {
    const source = bytes.toString("utf8");
    if (source.split(contract.anchor).length !== 2) {
      fail("Perry runtime patch anchor must occur exactly once");
    }
    bytes = Buffer.from(source.replace(contract.anchor, contract.replacement), "utf8");
    if (sha256(bytes) !== contract.afterSha256) {
      fail("Perry runtime patch output does not match the reviewed hash");
    }
    writeFileSync(runtimeSource, bytes);
    sourceSha256 = sha256(readFileSync(runtimeSource));
  }
  if (sourceSha256 !== contract.afterSha256) {
    fail("Perry runtime source hash does not match the reviewed original or patch");
  }
  return {
    sourceRevision: contract.sourceRevision,
    upstreamCommit: contract.upstreamCommit,
    contractSha256,
    sourceSha256,
  };
}

function validateMergedMetadata(metadataResult, merged, hostManifestPaths) {
  assertCommandSucceeded(metadataResult, "merged closure cargo metadata");
  let metadata;
  try {
    metadata = JSON.parse(commandOutput(metadataResult.stdout));
  } catch {
    fail("merged closure cargo metadata returned invalid JSON");
  }
  if (!metadata || !Array.isArray(metadata.packages)) {
    fail("merged closure cargo metadata has no packages array");
  }
  const actual = metadata.packages
    .filter(({ name }) => name === "perry-ext-nui_host" || name === "perry-ext-nexa_system_host")
    .map(({ manifest_path }) => canonicalFile(manifest_path, "merged Host Cargo manifest"))
    .sort();
  const expected = hostManifestPaths
    .map((manifest) => canonicalFile(manifest, "merged Host Cargo manifest"))
    .sort();
  if (
    actual.length !== expected.length ||
    actual.some((manifest, index) => manifest !== expected[index])
  ) {
    fail("merged closure Cargo graph must resolve both Hosts from the owned merged source root");
  }
  const canonicalMerged = canonicalDirectory(merged, "merged source root");
  for (const manifest of actual)
    assertInside(canonicalMerged, manifest, "merged Host Cargo manifest");
  return metadata;
}

function runtimeRoot(environment) {
  const configured = Object.entries(environment ?? {}).find(
    ([name]) => name.toUpperCase() === "NEXA_WINDOWS_RUNTIME_ROOT",
  )?.[1];
  if (configured !== undefined) {
    if (typeof configured !== "string" || !path.isAbsolute(configured)) {
      fail("NEXA_WINDOWS_RUNTIME_ROOT must be an absolute path");
    }
    if (existsPath(configured)) regularDirectory(configured, "persistent runtime root");
    else mkdirSync(configured, { recursive: true });
    const root = realpathSync.native(configured);
    const lock = acquireBuildLock(root);
    if (lock.stale) {
      return {
        root: mkdtempSync(path.join(root, "recovery-")),
        persistent: false,
        releaseLock: () => {},
      };
    }
    return { root, persistent: true, releaseLock: lock.release };
  }
  const base = environment.NEXA_RUNTIME_TMPDIR || os.tmpdir();
  regularDirectory(base, "runtime temporary directory");
  return {
    root: mkdtempSync(path.join(base, "nexa-windows-runtime-")),
    persistent: false,
    releaseLock: () => {},
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be inspected by this user.
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function readBuildLock(lockPath) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
  if (
    !metadata ||
    metadata.schemaVersion !== 1 ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 0 ||
    typeof metadata.token !== "string" ||
    metadata.token.length === 0
  ) {
    return null;
  }
  return metadata;
}

function acquireBuildLock(root) {
  const lockPath = path.join(root, ".build-lock");
  let handle;
  try {
    handle = openSync(lockPath, "wx");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      const metadata = readBuildLock(lockPath);
      if (metadata && processIsAlive(metadata.pid)) {
        fail(`another build owns the persistent runtime root (pid ${metadata.pid})`);
      }
      // Never conditionally delete a path another process may have replaced. A stale
      // owner falls back to an invocation-local target and leaves the evidence intact.
      return { stale: true };
    }
    throw error;
  }

  const token = randomUUID();
  try {
    writeSync(
      handle,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token })}\n`,
      0,
      "utf8",
    );
  } catch (error) {
    try {
      closeSync(handle);
    } finally {
      rmSync(lockPath, { force: true });
    }
    throw error;
  }

  return {
    stale: false,
    release: () => {
      let ownsLock = false;
      try {
        const metadata = readBuildLock(lockPath);
        ownsLock = metadata?.pid === process.pid && metadata.token === token;
      } catch {
        // The lock was already removed or replaced; never remove an unknown owner.
      }
      try {
        closeSync(handle);
      } finally {
        if (ownsLock) rmSync(lockPath, { force: true });
      }
    },
  };
}

function builtWindowsSkiaDirectory(releaseDirectory) {
  const buildRoot = regularDirectory(
    path.join(releaseDirectory, "build"),
    "Cargo release build directory",
  );
  const candidates = [];
  for (const entry of readdirSync(buildRoot).sort()) {
    if (!entry.startsWith("skia-bindings-")) continue;
    const output = path.join(buildRoot, entry, "out", "skia");
    if (!existsPath(output)) continue;
    regularDirectory(output, "Skia Cargo output directory");
    for (const library of WINDOWS_SKIA_LIBRARIES) {
      nonEmptyRegularFile(path.join(output, library), `Skia link input ${library}`);
    }
    candidates.push(canonicalDirectory(output, "Skia Cargo output directory"));
  }
  if (candidates.length !== 1) {
    fail(
      `Cargo must produce exactly one complete Skia output directory; found ${candidates.length}`,
    );
  }
  return candidates[0];
}

function withWindowsLinkerSearchPath(environment, libraryDirectory) {
  const currentLibraryPath = Object.entries(environment ?? {}).find(
    ([name]) => name.toUpperCase() === "LIB",
  )?.[1];
  if (currentLibraryPath !== undefined && typeof currentLibraryPath !== "string") {
    fail("Windows LIB environment variable must be a string");
  }
  const currentLinkOptions = Object.entries(environment ?? {}).find(
    ([name]) => name.toUpperCase() === "LINK",
  )?.[1];
  if (currentLinkOptions !== undefined && typeof currentLinkOptions !== "string") {
    fail("Windows LINK environment variable must be a string");
  }
  if (/["\r\n]/u.test(libraryDirectory)) {
    fail(`Skia library directory cannot be encoded for the Windows linker: ${libraryDirectory}`);
  }
  const skiaSearchOption = `/LIBPATH:"${libraryDirectory}"`;
  return replaceCaseInsensitive(environment, {
    LIB: currentLibraryPath || undefined,
    LINK: currentLinkOptions ? `${skiaSearchOption} ${currentLinkOptions}` : skiaSearchOption,
  });
}

function existsPath(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function shouldPrepare(environment, runtime, force) {
  if (runtime.platform !== "win32" || runtime.arch !== "x64") return false;
  if (force) return true;
  const keys = new Set(Object.keys(environment ?? {}).map((name) => name.toUpperCase()));
  return ["NEXA_WINDOWS_RUNTIME_ROOT", "PERRY_RUNTIME_DIR", "PERRY_LIB_DIR"].some((name) =>
    keys.has(name),
  );
}

export function preparePerryRuntimeForCompile(options = {}) {
  const environment = options.environment ?? process.env;
  const runtime = options.runtime ?? { platform: process.platform, arch: process.arch };
  if (!shouldPrepare(environment, runtime, options.force === true)) {
    return { environment, cleanup: () => {} };
  }
  return prepareWindowsPerryRuntime({ ...options, environment, runtime });
}

export function prepareWindowsPerryRuntime({
  projectDirectory = process.cwd(),
  manifestPath,
  dialogFixturePath,
  environment = process.env,
  resolvePackage = resolveInstalledPackage,
  runner = defaultRunner,
  runtime = { platform: process.platform, arch: process.arch },
  templateRoot = TEMPLATE_ROOT,
  cleanup = true,
} = {}) {
  if (runtime.platform !== "win32" || runtime.arch !== "x64") {
    return { environment, cleanup: () => {} };
  }
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) {
    fail("application manifest path must be an absolute path");
  }
  regularFile(manifestPath, "application manifest");
  if (dialogFixturePath !== undefined) regularFile(dialogFixturePath, "Dialog test fixture");

  const nui = hostSource(NUI_HOST, projectDirectory, resolvePackage, environment);
  const system = hostSource(SYSTEM_HOST, projectDirectory, resolvePackage, environment);
  const { root, persistent, releaseLock } = runtimeRoot(environment);
  let ownsLock = true;
  let invocation;
  try {
    invocation = mkdtempSync(path.join(root, "invocation-"));
    const merged = mergeInstalledSources(nui, system, invocation);
    const closureTemplate = copyClosureTemplate(merged, templateRoot);
    const closureManifest = closureTemplate.manifestPath;
    const hostManifestPaths = [
      path.join(merged, "packages/nui-host/Cargo.toml"),
      path.join(merged, "packages/system-host/Cargo.toml"),
    ];
    const target = path.join(root, "target");
    const cargoHome = path.join(root, "cargo-home");
    assertDirectoryPathHasNoLinks(root, cargoHome, "controlled Cargo home");
    mkdirSync(cargoHome, { recursive: true });
    canonicalDirectory(cargoHome, "controlled Cargo home");
    const cargoEnvironment = closureEnvironment(environment, {
      NEXA_APP_MANIFEST_PATH: manifestPath,
      ...(dialogFixturePath ? { NEXA_DIALOG_TEST_FIXTURE_PATH: dialogFixturePath } : {}),
      CARGO_PROFILE_RELEASE_PANIC: "unwind",
      CARGO_HOME: cargoHome,
      PERRY_NO_AUTO_OPTIMIZE: "1",
      PERRY_NO_CACHE: "1",
      RUSTUP_TOOLCHAIN: WINDOWS_CLOSURE_RUST_TOOLCHAIN,
      CARGO_BUILD_TARGET: WINDOWS_CLOSURE_RUST_TARGET,
    });
    for (const [name, value] of Object.entries(cargoEnvironment)) {
      if (value === undefined) delete cargoEnvironment[name];
    }
    const metadataResult = runner(
      "cargo",
      [
        `+${WINDOWS_CLOSURE_RUST_TOOLCHAIN}`,
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--manifest-path",
        closureManifest,
      ],
      {
        cwd: merged,
        env: cargoEnvironment,
        encoding: "utf8",
        stdio: "pipe",
        maxBuffer: CARGO_METADATA_BUFFER_LIMIT,
      },
    );
    const metadata = validateMergedMetadata(metadataResult, merged, hostManifestPaths);
    const perryRuntimePatch = patchPerryRuntime(
      metadata,
      cargoHome,
      closureTemplate.runtimePatchPath,
    );
    const result = runner(
      "cargo",
      [
        `+${WINDOWS_CLOSURE_RUST_TOOLCHAIN}`,
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        closureManifest,
        "--target-dir",
        target,
        "--target",
        WINDOWS_CLOSURE_RUST_TARGET,
      ],
      { cwd: merged, env: cargoEnvironment },
    );
    assertCommandSucceeded(result, "unified static closure build");
    const releaseDirectory = path.join(target, WINDOWS_CLOSURE_RUST_TARGET, "release");
    const skiaDirectory = builtWindowsSkiaDirectory(releaseDirectory);
    const closurePath = path.join(releaseDirectory, "nexa_windows_static_closure.lib");
    regularFile(closurePath, "unified static closure");
    const runtimeDirectory = path.join(invocation, "runtime");
    mkdirSync(runtimeDirectory, { recursive: true });
    const runtimePath = path.join(runtimeDirectory, "perry_runtime.lib");
    const stdlibPath = path.join(runtimeDirectory, "perry_stdlib.lib");
    cpSync(closurePath, runtimePath);
    cpSync(closurePath, stdlibPath);
    if (
      !readFileSync(closurePath).equals(readFileSync(runtimePath)) ||
      !readFileSync(runtimePath).equals(readFileSync(stdlibPath))
    ) {
      fail("runtime, stdlib, and unified closure archives must be byte-identical");
    }
    const nextEnvironment = withWindowsLinkerSearchPath(
      closureEnvironment(environment, {
        PERRY_RUNTIME_DIR: runtimeDirectory,
        PERRY_LIB_DIR: runtimeDirectory,
        PERRY_NO_AUTO_OPTIMIZE: "1",
        PERRY_NO_CACHE: "1",
        RUSTUP_TOOLCHAIN: WINDOWS_CLOSURE_RUST_TOOLCHAIN,
        CARGO_BUILD_TARGET: WINDOWS_CLOSURE_RUST_TARGET,
        CARGO_HOME: cargoHome,
        NEXA_APP_MANIFEST_PATH: manifestPath,
        ...(dialogFixturePath ? { NEXA_DIALOG_TEST_FIXTURE_PATH: dialogFixturePath } : {}),
      }),
      skiaDirectory,
    );
    for (const [name, value] of Object.entries(nextEnvironment)) {
      if (value === undefined) delete nextEnvironment[name];
    }
    return {
      environment: nextEnvironment,
      root,
      merged,
      closure: closurePath,
      provenance: {
        closureSha256: createHash("sha256").update(readFileSync(closurePath)).digest("hex"),
        windowsSkia: WINDOWS_SKIA_LIBRARIES.map((library) => ({
          name: library,
          sha256: createHash("sha256")
            .update(readFileSync(path.join(skiaDirectory, library)))
            .digest("hex"),
        })),
        mergedSourceSha256: treeDigest(merged),
        perryRuntimePatch,
        installedHosts: [nui, system].map(({ packageDirectory, nativeRoot }) => ({
          packageDirectory,
          nativeRoot,
          sourceSha256: treeDigest(nativeRoot),
        })),
      },
      cleanup: () => {
        if (!ownsLock) return;
        ownsLock = false;
        try {
          if (cleanup) rmSync(persistent ? invocation : root, { recursive: true, force: true });
        } finally {
          releaseLock();
        }
      },
    };
  } catch (error) {
    try {
      if (persistent) {
        if (invocation) rmSync(invocation, { recursive: true, force: true });
      } else {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      if (ownsLock) {
        ownsLock = false;
        releaseLock();
      }
    }
    throw error;
  }
}

export function resolveWindowsNativeLibraryDirectories({
  projectDirectory = process.cwd(),
  environment = process.env,
  resolvePackage = resolveInstalledPackage,
  runtime = { platform: process.platform, arch: process.arch },
} = {}) {
  if (runtime.platform !== "win32" || runtime.arch !== "x64") return [];
  return hostSource(NUI_HOST, projectDirectory, resolvePackage, environment).windowsLibDirectories;
}

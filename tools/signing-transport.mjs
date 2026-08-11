import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(`[signing-transport] ${message}`);
}

function requireDirectory(directory, label) {
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch {
    fail(`${label} does not exist: ${directory}`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular directory: ${directory}`);
  }
}

function requireNewDirectory(directory, label) {
  const absolute = path.resolve(directory);
  if (existsSync(absolute)) fail(`${label} already exists: ${absolute}`);
  mkdirSync(path.dirname(absolute), { recursive: true });
  mkdirSync(absolute);
  return absolute;
}

function requireFileName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    path.basename(name) !== name ||
    name.includes("\\") ||
    /[\0\r\n]/u.test(name) ||
    name === "." ||
    name === ".."
  ) {
    fail(`unsafe transport file name: ${name}`);
  }
  return name;
}

function flatFiles(directory, label) {
  requireDirectory(directory, label);
  const files = readdirSync(directory).sort();
  if (files.length === 0) fail(`${label} is empty`);
  for (const name of files) {
    requireFileName(name);
    const metadata = lstatSync(path.join(directory, name));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`${label} contains a non-regular file or symlink: ${name}`);
    }
  }
  return files;
}

function signedSuffix(platform) {
  if (platform === "darwin") return "-signed.tar.gz";
  if (platform === "win32") return "-signed.zip";
  fail("platform must be darwin or win32");
}

function copyFlat(source, destination, seen) {
  const files = flatFiles(source, "signed custody transport");
  for (const name of files) {
    if (seen.has(name)) fail(`duplicate signed custody file: ${name}`);
    copyFileSync(
      path.join(source, name),
      path.join(destination, name),
      fsConstants.COPYFILE_EXCL,
    );
    seen.add(name);
  }
  return files;
}

export function exportSignedCustody({ custodyRoot, platform, outputDirectory }) {
  const suffix = signedSuffix(platform);
  const signedRoot = path.resolve(custodyRoot, "release-work", "signed");
  requireDirectory(signedRoot, "signed custody root");
  const entries = readdirSync(signedRoot, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    !entries[0].isDirectory() ||
    entries[0].isSymbolicLink() ||
    !entries[0].name.endsWith(`${suffix}.custody`)
  ) {
    fail(`signed custody root must contain exactly one ${platform} custody directory`);
  }
  const custodyDirectory = path.join(signedRoot, entries[0].name);
  const output = requireNewDirectory(outputDirectory, "signed custody export");
  try {
    const files = copyFlat(custodyDirectory, output, new Set());
    const archives = files.filter((name) => name.endsWith(suffix));
    if (archives.length !== 1) fail(`signed custody must contain exactly one ${platform} archive`);
    if (!files.includes(`${archives[0]}.custody.json`)) {
      fail(`signed custody is missing its custody record: ${archives[0]}`);
    }
    return { artifactName: archives[0], fileCount: files.length };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

export function mergeSignedCustody({
  darwinDirectory,
  windowsDirectory,
  outputDirectory,
}) {
  const output = requireNewDirectory(outputDirectory, "merged signed custody");
  try {
    const seen = new Set();
    copyFlat(path.resolve(darwinDirectory), output, seen);
    copyFlat(path.resolve(windowsDirectory), output, seen);
    if ([...seen].filter((name) => name.endsWith(signedSuffix("darwin"))).length !== 1) {
      fail("merged custody must contain exactly one macOS signed archive");
    }
    if ([...seen].filter((name) => name.endsWith(signedSuffix("win32"))).length !== 1) {
      fail("merged custody must contain exactly one Windows signed archive");
    }
    return { fileCount: seen.size };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function parseOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || !value) fail("arguments must be --name value pairs");
    if (Object.hasOwn(options, flag)) fail(`duplicate argument: ${flag}`);
    options[flag] = value;
  }
  return options;
}

function required(options, flag) {
  const value = options[flag];
  if (!value) fail(`${flag} is required`);
  return value;
}

function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseOptions(arguments_);
  if (command === "export") {
    const result = exportSignedCustody({
      custodyRoot: required(options, "--custody-root"),
      platform: required(options, "--platform"),
      outputDirectory: required(options, "--output"),
    });
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "merge") {
    const result = mergeSignedCustody({
      darwinDirectory: required(options, "--darwin"),
      windowsDirectory: required(options, "--windows"),
      outputDirectory: required(options, "--output"),
    });
    console.log(JSON.stringify(result));
    return;
  }
  fail("usage: signing-transport.mjs export|merge --name value ...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWindowsNativeLibraryDirectories } from "../packages/cli/src/windows-runtime.mjs";

const expectedLibraries = ["skia.lib", "skia-bindings.lib"];

function fail(message) {
  throw new Error(`Windows Skia staging: ${message}`);
}

function regularFile(filePath, label) {
  let metadata;
  try {
    metadata = lstatSync(filePath);
  } catch {
    fail(`${label} does not exist: ${filePath}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
    fail(`${label} must be a non-empty regular file: ${filePath}`);
  }
  return filePath;
}

function defaultExtractArchive(archive, destination) {
  const command = process.platform === "win32" ? "tar.exe" : "tar";
  const result = spawnSync(
    command,
    ["--extract", "--gzip", "--file", archive, "--directory", destination],
    { stdio: "inherit" },
  );
  if (result.error) fail(`could not start archive extraction: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`archive extraction failed with exit code ${result.status ?? "unknown"}`);
  }
}

export function stageWindowsSkia({
  projectDirectory,
  archivePath,
  expectedSha256,
  environment = process.env,
  extractArchive = defaultExtractArchive,
  resolvePackage,
  temporaryDirectory = os.tmpdir(),
} = {}) {
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    fail("expectedSha256 must be a lowercase SHA-256 digest");
  }
  const archive = regularFile(path.resolve(archivePath), "Skia archive");
  const actualSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (actualSha256 !== expectedSha256) {
    fail(`archive digest mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  const resolverOptions = {
    projectDirectory: path.resolve(projectDirectory),
    environment,
    runtime: { platform: "win32", arch: "x64" },
  };
  if (resolvePackage !== undefined) resolverOptions.resolvePackage = resolvePackage;
  const destinations = resolveWindowsNativeLibraryDirectories(resolverOptions);
  if (destinations.length !== 1) fail("NUI Host must declare exactly one Windows libDirs entry");
  const destination = destinations[0];
  const extractionRoot = mkdtempSync(path.join(path.resolve(temporaryDirectory), "nexa-skia-"));
  try {
    extractArchive(archive, extractionRoot);
    const sourceDirectory = path.join(extractionRoot, "skia-binaries");
    const sources = expectedLibraries.map((library) =>
      regularFile(path.join(sourceDirectory, library), library),
    );
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    for (const source of sources) cpSync(source, path.join(destination, path.basename(source)));
    return { destination, sha256: actualSha256 };
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function main() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith("--") || value === undefined)
      fail("arguments must be --name value pairs");
    values.set(name, value);
  }
  const result = stageWindowsSkia({
    projectDirectory: values.get("--project"),
    archivePath: values.get("--archive"),
    expectedSha256: values.get("--sha256"),
    environment: process.env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

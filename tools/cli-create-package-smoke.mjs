import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../packages/cli/src/index.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureCanaries = ["nexa-ui-dialog-open.txt", "nexa-ui-dialog-save.txt"];
const supportedTargets = new Set(["darwin/arm64", "darwin/x64", "win32/x64"]);
const usage = "Usage: node tools/cli-create-package-smoke.mjs [--artifact-output <path>]";

function assertCliSucceeded(exitCode, command) {
  if (exitCode !== 0) throw new Error(`nexa ${command} failed with exit code ${exitCode}`);
}

function linkDirectory(target, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  symlinkSync(realpathSync(target), destination, process.platform === "win32" ? "junction" : "dir");
}

function inspectTree(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = path.join(prefix, entry.name);
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Packaged artifact contains a symbolic link: ${relative}`);
    }
    return metadata.isDirectory()
      ? [{ relative, type: "directory" }, ...inspectTree(absolute, relative)]
      : [{ relative, type: "file" }];
  });
}

function lstatIfPresent(candidate) {
  try {
    return lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertArtifactOutputAvailable(outputDirectory) {
  const parent = path.dirname(outputDirectory);
  const parentMetadata = lstatIfPresent(parent);
  if (!parentMetadata || parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`Artifact output parent must be a non-symbolic-link directory: ${parent}`);
  }
  if (lstatIfPresent(outputDirectory)) {
    throw new Error(`Artifact output destination already exists: ${outputDirectory}`);
  }
  return parent;
}

export function exportVerifiedPackageArtifact({ artifactDirectory, outputDirectory }) {
  const source = path.resolve(artifactDirectory);
  const destination = path.resolve(outputDirectory);
  assertArtifactOutputAvailable(destination);
  const sourceMetadata = lstatIfPresent(source);
  if (!sourceMetadata || sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
    throw new Error(`Verified package artifact must be a non-symbolic-link directory: ${source}`);
  }

  renameSync(source, destination);
  const destinationMetadata = lstatIfPresent(destination);
  if (
    !destinationMetadata ||
    destinationMetadata.isSymbolicLink() ||
    !destinationMetadata.isDirectory() ||
    destinationMetadata.dev !== sourceMetadata.dev ||
    destinationMetadata.ino !== sourceMetadata.ino
  ) {
    throw new Error(`Exported package artifact identity changed: ${destination}`);
  }
  return destination;
}

export function parseCreatePackageSmokeArguments(argv, { cwd = process.cwd() } = {}) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--artifact-output" && argv[1]) {
    return { artifactOutputDirectory: path.resolve(cwd, argv[1]) };
  }
  throw new Error(usage);
}

export function runCreatePackageSmoke({
  artifactOutputDirectory,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!supportedTargets.has(`${process.platform}/${process.arch}`)) {
    throw new Error(`Unsupported CLI package smoke target ${process.platform}/${process.arch}`);
  }

  const resolvedOutput = artifactOutputDirectory
    ? path.resolve(artifactOutputDirectory)
    : undefined;
  const temporaryParent = resolvedOutput ? assertArtifactOutputAvailable(resolvedOutput) : tmpdir();
  const temporaryRoot = mkdtempSync(path.join(temporaryParent, "nexa-cli-create-package-"));
  try {
    assertCliSucceeded(runCli(["new", "smoke-app"], { cwd: temporaryRoot, stdout, stderr }), "new");
    const projectDirectory = path.join(temporaryRoot, "smoke-app");
    linkDirectory(
      path.join(workspaceRoot, "packages", "ui"),
      path.join(projectDirectory, "node_modules", "@nexa", "ui"),
    );
    linkDirectory(
      path.join(workspaceRoot, "node_modules", "@perryts", "perry"),
      path.join(projectDirectory, "node_modules", "@perryts", "perry"),
    );
    const assets = path.join(projectDirectory, "assets");
    mkdirSync(path.join(assets, "nested"), { recursive: true });
    writeFileSync(path.join(assets, "nested", "smoke.txt"), "nexa package asset\n");

    assertCliSucceeded(runCli(["package"], { cwd: projectDirectory, stdout, stderr }), "package");
    const platformLabel = process.platform === "darwin" ? "macos" : "windows";
    const artifactDirectory = path.join(
      projectDirectory,
      "dist",
      `smoke-app-${platformLabel}-${process.arch}`,
    );
    const bundle =
      process.platform === "darwin"
        ? path.join(artifactDirectory, "smoke-app.app")
        : artifactDirectory;
    const executable =
      process.platform === "darwin"
        ? path.join(bundle, "Contents", "MacOS", "smoke-app")
        : path.join(bundle, "smoke-app.exe");
    const resources =
      process.platform === "darwin" ? path.join(bundle, "Contents", "Resources") : bundle;
    const infoPlist =
      process.platform === "darwin" ? path.join(bundle, "Contents", "Info.plist") : undefined;
    const manifestPath = path.join(resources, "app.manifest.json");
    const metadataPath = path.join(resources, "nexa-build.json");
    const packagedAsset = path.join(resources, "assets", "nested", "smoke.txt");

    for (const file of [executable, manifestPath, metadataPath, packagedAsset]) {
      if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
        throw new Error(`nexa package smoke is missing a regular file: ${file}`);
      }
    }
    if (infoPlist) {
      const lint = spawnSync("/usr/bin/plutil", ["-lint", infoPlist], { encoding: "utf8" });
      if (lint.error || lint.status !== 0) {
        throw new Error(
          `Packaged CLI smoke Info.plist is invalid: ${lint.error?.message ?? lint.stderr ?? lint.stdout}`,
        );
      }
    }
    const manifest = readFileSync(manifestPath);
    const binary = readFileSync(executable);
    if (!binary.includes(manifest)) {
      throw new Error("Packaged CLI smoke binary does not contain the exact sidecar manifest");
    }
    for (const canary of fixtureCanaries) {
      if (binary.includes(Buffer.from(canary))) {
        throw new Error(`Packaged CLI smoke binary contains fixture canary ${canary}`);
      }
    }
    if (readFileSync(packagedAsset, "utf8") !== "nexa package asset\n") {
      throw new Error("Packaged CLI smoke asset bytes changed");
    }
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (
      metadata.schemaVersion !== 1 ||
      metadata.app?.id !== "dev.nexa.smoke-app" ||
      metadata.target?.platform !== process.platform ||
      metadata.target?.arch !== process.arch ||
      metadata.assets?.files !== 1
    ) {
      throw new Error(`Packaged CLI smoke metadata is invalid: ${JSON.stringify(metadata)}`);
    }

    const tree = inspectTree(artifactDirectory);
    const forbidden = tree.find(({ relative }) =>
      /(?:^|[\\/])(?:node_modules|target|src|\.nexa)(?:[\\/]|$)/u.test(relative),
    );
    if (forbidden) {
      throw new Error(`Packaged CLI smoke contains a development path: ${forbidden.relative}`);
    }
    if (resolvedOutput) {
      exportVerifiedPackageArtifact({
        artifactDirectory,
        outputDirectory: resolvedOutput,
      });
      stdout.write(`nexa-ui cli package artifact exported: ${resolvedOutput}\n`);
    }
    stdout.write(`nexa-ui cli create-package smoke ok: ${process.platform}/${process.arch}\n`);
    return resolvedOutput;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCreatePackageSmoke(parseCreatePackageSmokeArguments(process.argv.slice(2)));
}

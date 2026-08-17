import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { COMPATIBILITY } from "../packages/cli/src/constants.mjs";
import { stageWindowsSkia } from "./stage-windows-skia.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-stage-skia-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "consumer");
  const packageDirectory = path.join(project, "node_modules/@nexa/nui-host");
  const nativeRoot = path.join(packageDirectory, "dist/native/repo");
  mkdirSync(path.join(nativeRoot, "packages/nui-host"), { recursive: true });
  writeFileSync(path.join(project, "package.json"), "{}\n");
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    `${JSON.stringify({
      name: "@nexa/nui-host",
      version: COMPATIBILITY.hostRuntime,
      perry: {
        nativeLibrary: {
          abiVersion: COMPATIBILITY.hostAbi,
          targets: {
            windows: {
              crate: "dist/native/repo/packages/nui-host",
              libDirs: ["target/perry-native/windows/skia-binaries"],
            },
          },
        },
      },
    })}\n`,
  );
  writeFileSync(
    path.join(nativeRoot, "RELEASE-CLOSURE.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      host: "@nexa/nui-host",
      layout: "repository-relative",
      source: "vendored",
    })}\n`,
  );
  const archive = path.join(root, "skia.tar.gz");
  writeFileSync(archive, "archive bytes\n");
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  return {
    archive,
    root,
    packageDirectory,
    project,
    sha256,
    extractArchive(_archive, destination) {
      const source = path.join(destination, "skia-binaries");
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, "skia.lib"), "skia\n");
      writeFileSync(path.join(source, "skia-bindings.lib"), "bindings\n");
    },
    resolvePackage: () => ({
      filePath: path.join(packageDirectory, "package.json"),
      manifest: JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")),
    }),
  };
}

test("stages verified Skia libraries in the installed NUI Host manifest libDir", (t) => {
  const value = fixture(t);
  const result = stageWindowsSkia({
    projectDirectory: value.project,
    archivePath: value.archive,
    expectedSha256: value.sha256,
    environment: { NEXA_REQUIRE_INSTALLED_HOSTS: "1" },
    extractArchive: value.extractArchive,
    resolvePackage: value.resolvePackage,
    temporaryDirectory: value.project,
  });

  assert.equal(
    result.destination,
    path.join(
      realpathSync.native(value.packageDirectory),
      "target/perry-native/windows/skia-binaries",
    ),
  );
  assert.equal(readFileSync(path.join(result.destination, "skia.lib"), "utf8"), "skia\n");
  assert.equal(
    readFileSync(path.join(result.destination, "skia-bindings.lib"), "utf8"),
    "bindings\n",
  );
});

test("rejects an archive digest mismatch before writing the installed package", (t) => {
  const value = fixture(t);
  assert.throws(
    () =>
      stageWindowsSkia({
        projectDirectory: value.project,
        archivePath: value.archive,
        expectedSha256: "0".repeat(64),
        environment: { NEXA_REQUIRE_INSTALLED_HOSTS: "1" },
        extractArchive() {
          throw new Error("digest mismatch must fail before extraction");
        },
        resolvePackage: value.resolvePackage,
        temporaryDirectory: value.project,
      }),
    /archive digest mismatch/u,
  );
  assert.equal(
    existsSync(path.join(value.packageDirectory, "target/perry-native/windows/skia-binaries")),
    false,
  );
});

test("rejects a package-root libDir before deleting the installed Host package", (t) => {
  const value = fixture(t);
  const packageManifestPath = path.join(value.packageDirectory, "package.json");
  const manifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  manifest.perry.nativeLibrary.targets.windows.libDirs = ["."];
  writeFileSync(packageManifestPath, `${JSON.stringify(manifest)}\n`);

  let extractionAttempted = false;
  let failure;
  try {
    stageWindowsSkia({
      projectDirectory: value.project,
      archivePath: value.archive,
      expectedSha256: value.sha256,
      environment: { NEXA_REQUIRE_INSTALLED_HOSTS: "1" },
      extractArchive(archive, destination) {
        extractionAttempted = true;
        value.extractArchive(archive, destination);
      },
      resolvePackage: value.resolvePackage,
      temporaryDirectory: value.project,
    });
  } catch (error) {
    failure = error;
  }

  assert.deepEqual(
    {
      extractionAttempted,
      packageDirectoryExists: existsSync(value.packageDirectory),
      packageManifestExists: existsSync(packageManifestPath),
    },
    {
      extractionAttempted: false,
      packageDirectoryExists: true,
      packageManifestExists: true,
    },
  );
  assert.match(String(failure), /Windows native library directory/u);
});

test("rejects a symlinked libDir ancestor before extracting or deleting outside the package", (t) => {
  const value = fixture(t);
  const outsideTarget = path.join(value.root, "outside-target");
  const outsideLibraryDirectory = path.join(
    outsideTarget,
    "perry-native/windows/skia-binaries",
  );
  const victim = path.join(outsideLibraryDirectory, "keep.txt");
  mkdirSync(outsideLibraryDirectory, { recursive: true });
  writeFileSync(victim, "keep\n");
  symlinkSync(outsideTarget, path.join(value.packageDirectory, "target"), "dir");

  let extractionAttempted = false;
  assert.throws(
    () =>
      stageWindowsSkia({
        projectDirectory: value.project,
        archivePath: value.archive,
        expectedSha256: value.sha256,
        environment: { NEXA_REQUIRE_INSTALLED_HOSTS: "1" },
        extractArchive(archive, destination) {
          extractionAttempted = true;
          value.extractArchive(archive, destination);
        },
        resolvePackage: value.resolvePackage,
        temporaryDirectory: value.project,
      }),
    /symbolic link/u,
  );

  assert.equal(extractionAttempted, false);
  assert.equal(readFileSync(victim, "utf8"), "keep\n");
});

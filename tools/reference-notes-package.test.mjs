import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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
import test from "node:test";

const { packageReferenceNotes } = await import("./reference-notes-package.mjs");

const manifest = {
  $schema: "https://nexa-ui.dev/schema/app-manifest-v1.json",
  schemaVersion: 1,
  id: "dev.nexa.notes",
  name: "Nexa Notes",
  version: "0.1.0",
  requiredProtocol: { major: 1, minor: 0 },
  permissions: ["system.FsRead", "system.FsWrite", "system.DialogOpen", "system.DialogSave"],
};

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-notes-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "app.manifest.json");
  const binaryPath = path.join(directory, "reference-notes");
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const binary = Buffer.concat([Buffer.from(manifestJson), Buffer.from("\0native-binary")]);
  writeFileSync(manifestPath, manifestJson);
  writeFileSync(binaryPath, binary);
  chmodSync(binaryPath, 0o755);
  return {
    binary,
    binaryPath,
    directory,
    manifestJson,
    manifestPath,
    outputRoot: path.join(directory, "dist"),
  };
}

function filesBelow(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? filesBelow(path.join(directory, entry.name), relative) : relative;
  });
}

test("packages a self-contained macOS app with matching bundle metadata", (t) => {
  const input = fixture(t);

  const artifact = packageReferenceNotes({
    platform: "darwin",
    arch: "arm64",
    binaryPath: input.binaryPath,
    manifestPath: input.manifestPath,
    outputRoot: input.outputRoot,
    build: () => {},
  });

  assert.equal(
    artifact.artifactDirectory,
    path.join(input.outputRoot, "reference-notes-macos-arm64"),
  );
  assert.equal(artifact.bundlePath, path.join(artifact.artifactDirectory, "Nexa Notes.app"));
  assert.deepEqual(filesBelow(artifact.artifactDirectory).sort(), [
    path.join("Nexa Notes.app", "Contents", "Info.plist"),
    path.join("Nexa Notes.app", "Contents", "MacOS", "NexaNotes"),
    path.join("Nexa Notes.app", "Contents", "Resources", "app.manifest.json"),
    path.join("Nexa Notes.app", "Contents", "Resources", "nexa-build.json"),
  ]);

  const executable = path.join(artifact.bundlePath, "Contents", "MacOS", "NexaNotes");
  assert.deepEqual(readFileSync(executable), input.binary);
  assert.notEqual(statSync(executable).mode & 0o111, 0);
  assert.equal(
    readFileSync(
      path.join(artifact.bundlePath, "Contents", "Resources", "app.manifest.json"),
      "utf8",
    ),
    input.manifestJson,
  );
  const plist = readFileSync(path.join(artifact.bundlePath, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.nexa\.notes<\/string>/u);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>0\.1\.0<\/string>/u);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>NexaNotes<\/string>/u);
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        path.join(artifact.bundlePath, "Contents", "Resources", "nexa-build.json"),
        "utf8",
      ),
    ),
    {
      schemaVersion: 1,
      app: { id: "dev.nexa.notes", name: "Nexa Notes", version: "0.1.0" },
      target: { platform: "darwin", arch: "arm64" },
    },
  );
});

test("packages a Windows distribution directory with the embedded-manifest binary", (t) => {
  const input = fixture(t);
  const windowsBinary = path.join(input.directory, "reference-notes.exe");
  writeFileSync(windowsBinary, input.binary);

  const artifact = packageReferenceNotes({
    platform: "win32",
    arch: "x64",
    binaryPath: windowsBinary,
    manifestPath: input.manifestPath,
    outputRoot: input.outputRoot,
    build: () => {},
  });

  assert.equal(
    artifact.artifactDirectory,
    path.join(input.outputRoot, "reference-notes-windows-x64"),
  );
  assert.equal(artifact.bundlePath, artifact.artifactDirectory);
  assert.deepEqual(filesBelow(artifact.artifactDirectory).sort(), [
    "NexaNotes.exe",
    "app.manifest.json",
    "nexa-build.json",
  ]);
  assert.deepEqual(readFileSync(path.join(artifact.bundlePath, "NexaNotes.exe")), input.binary);
  assert.equal(
    readFileSync(path.join(artifact.bundlePath, "app.manifest.json"), "utf8"),
    input.manifestJson,
  );
  assert.deepEqual(JSON.parse(readFileSync(path.join(artifact.bundlePath, "nexa-build.json"))), {
    schemaVersion: 1,
    app: { id: "dev.nexa.notes", name: "Nexa Notes", version: "0.1.0" },
    target: { platform: "win32", arch: "x64" },
  });
});

test("refuses to package a binary containing the embedded Dialog test fixture", (t) => {
  const input = fixture(t);
  writeFileSync(
    input.binaryPath,
    Buffer.concat([input.binary, Buffer.from("\0nexa-ui-dialog-open.txt\0")]),
  );

  assert.throws(
    () =>
      packageReferenceNotes({
        platform: "darwin",
        arch: "arm64",
        binaryPath: input.binaryPath,
        manifestPath: input.manifestPath,
        outputRoot: input.outputRoot,
        build: () => {},
      }),
    /Dialog test fixture/u,
  );
});

test("fails closed for malformed metadata or a binary without every permission marker", (t) => {
  const input = fixture(t);
  writeFileSync(input.binaryPath, Buffer.from(manifest.id));

  assert.throws(
    () =>
      packageReferenceNotes({
        platform: "darwin",
        binaryPath: input.binaryPath,
        manifestPath: input.manifestPath,
        outputRoot: input.outputRoot,
        build: () => {},
      }),
    /system\.FsRead/u,
  );

  writeFileSync(input.manifestPath, JSON.stringify({ ...manifest, version: "not-semver" }));
  assert.throws(
    () =>
      packageReferenceNotes({
        platform: "darwin",
        binaryPath: input.binaryPath,
        manifestPath: input.manifestPath,
        outputRoot: input.outputRoot,
        build: () => {},
      }),
    /version/u,
  );
});

test("rejects a sidecar manifest that differs from the manifest embedded in the binary", (t) => {
  const input = fixture(t);
  writeFileSync(
    input.binaryPath,
    Buffer.concat([Buffer.from(input.manifestJson), Buffer.from("\0native-binary")]),
  );
  writeFileSync(
    input.manifestPath,
    `${JSON.stringify({ ...manifest, version: "0.2.0" }, null, 2)}\n`,
  );

  assert.throws(
    () =>
      packageReferenceNotes({
        platform: "darwin",
        binaryPath: input.binaryPath,
        manifestPath: input.manifestPath,
        outputRoot: input.outputRoot,
        build: () => {},
      }),
    /embedded trusted manifest does not match/u,
  );
});

test("rejects unsupported platforms and never overwrites an existing artifact", (t) => {
  const input = fixture(t);
  assert.throws(
    () =>
      packageReferenceNotes({
        platform: "linux",
        binaryPath: input.binaryPath,
        manifestPath: input.manifestPath,
        outputRoot: input.outputRoot,
        build: () => {},
      }),
    /macOS and Windows/u,
  );

  const destination = path.join(input.outputRoot, "reference-notes-macos-arm64");
  mkdirSync(destination, { recursive: true });
  assert.equal(existsSync(destination), true);
  assert.throws(
    () =>
      packageReferenceNotes({
        platform: "darwin",
        arch: "arm64",
        binaryPath: input.binaryPath,
        manifestPath: input.manifestPath,
        outputRoot: input.outputRoot,
        build: () => {},
      }),
    /already exists/u,
  );
});

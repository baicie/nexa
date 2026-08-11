import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { extractArchive } from "./archive-utils.mjs";
import {
  assembleUnsignedSigningInput,
  createUnsignedPlatformArchive,
  verifyUnsignedSigningInput,
} from "./unsigned-signing-input.mjs";

const revision = "0123456789abcdef0123456789abcdef01234567";
const script = fileURLToPath(new URL("./unsigned-signing-input.mjs", import.meta.url));

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function dependencyGraph() {
  const npmRef = `urn:nexa:dependency:npm:sha256:${"a".repeat(64)}`;
  const cargoRef = `urn:nexa:dependency:cargo:sha256:${"b".repeat(64)}`;
  return {
    schemaVersion: 1,
    sources: [
      {
        ecosystem: "npm",
        lockfile: "pnpm-lock.yaml",
        resolver: "pnpm list --prod --json --depth Infinity",
        digest: { sha256: "c".repeat(64) },
      },
      {
        ecosystem: "cargo",
        lockfile: "packages/nui-host/Cargo.lock",
        manifest: "packages/nui-host/Cargo.toml",
        resolver:
          "cargo metadata --manifest-path packages/nui-host/Cargo.toml --locked --format-version 1",
        digest: { sha256: "d".repeat(64) },
      },
    ],
    roots: { npm: [npmRef], cargo: [cargoRef] },
    components: [
      {
        ref: cargoRef,
        ecosystem: "cargo",
        type: "library",
        name: "nui-host",
        version: "0.1.0",
        source: "path:packages/nui-host/Cargo.toml",
      },
      {
        ref: npmRef,
        ecosystem: "npm",
        type: "library",
        name: "@nexa/ui",
        version: "0.1.0",
        purl: "pkg:npm/%40nexa/ui@0.1.0",
      },
    ],
    dependencies: [
      { ref: cargoRef, dependsOn: [] },
      { ref: npmRef, dependsOn: [] },
    ],
  };
}

function macBinary() {
  const binary = Buffer.alloc(64);
  binary.writeUInt32BE(0xfeedfacf, 0);
  return binary;
}

function windowsBinary() {
  const binary = Buffer.alloc(128);
  binary.write("MZ", 0, "ascii");
  binary.writeUInt32LE(64, 60);
  binary.write("PE\0\0", 64, "ascii");
  return binary;
}

function packageFixture(root, platform) {
  const arch = platform === "darwin" ? "arm64" : "x64";
  const source = path.join(root, `${platform}-package`);
  const manifest = {
    $schema: "https://nexa-ui.dev/schema/app-manifest-v1.json",
    schemaVersion: 1,
    id: "dev.nexa.notes",
    name: "Nexa Notes",
    version: "0.1.0",
    requiredProtocol: { major: 1, minor: 0 },
    permissions: [],
  };
  const metadata = {
    schemaVersion: 1,
    app: { id: "dev.nexa.notes", name: "Nexa Notes", version: "0.1.0" },
    target: { platform, arch },
  };
  if (platform === "darwin") {
    const contents = path.join(source, "Nexa Notes.app", "Contents");
    const executable = path.join(contents, "MacOS", "NexaNotes");
    const resources = path.join(contents, "Resources");
    mkdirSync(path.dirname(executable), { recursive: true });
    mkdirSync(resources, { recursive: true });
    writeFileSync(executable, macBinary());
    chmodSync(executable, 0o755);
    writeFileSync(path.join(contents, "Info.plist"), "<plist/>\n");
    writeFileSync(path.join(resources, "app.manifest.json"), `${JSON.stringify(manifest)}\n`);
    writeFileSync(path.join(resources, "nexa-build.json"), `${JSON.stringify(metadata)}\n`);
  } else {
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "NexaNotes.exe"), windowsBinary());
    writeFileSync(path.join(source, "app.manifest.json"), `${JSON.stringify(manifest)}\n`);
    writeFileSync(path.join(source, "nexa-build.json"), `${JSON.stringify(metadata)}\n`);
  }
  return source;
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-unsigned-signing-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    darwinSource: packageFixture(root, "darwin"),
    windowsSource: packageFixture(root, "win32"),
  };
}

function filesBelow(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesBelow(path.join(directory, entry.name), relative) : relative;
  });
}

function createBothArchives(current) {
  const inputs = path.join(current.root, "platform-archives");
  mkdirSync(inputs);
  const darwin = createUnsignedPlatformArchive({
    sourceDirectory: current.darwinSource,
    outputDirectory: path.join(current.root, "darwin-output"),
    platform: "darwin",
    arch: "arm64",
  });
  const windows = createUnsignedPlatformArchive({
    sourceDirectory: current.windowsSource,
    outputDirectory: path.join(current.root, "windows-output"),
    platform: "win32",
    arch: "x64",
  });
  copyFileSync(darwin.artifact, path.join(inputs, path.basename(darwin.artifact)));
  copyFileSync(windows.artifact, path.join(inputs, path.basename(windows.artifact)));
  return inputs;
}

test("creates deterministic executor-compatible archives with canonical names", (t) => {
  const current = fixture(t);
  const firstMac = createUnsignedPlatformArchive({
    sourceDirectory: current.darwinSource,
    outputDirectory: path.join(current.root, "mac-first"),
    platform: "darwin",
    arch: "arm64",
  });
  const secondMac = createUnsignedPlatformArchive({
    sourceDirectory: current.darwinSource,
    outputDirectory: path.join(current.root, "mac-second"),
    platform: "darwin",
    arch: "arm64",
  });
  const windows = createUnsignedPlatformArchive({
    sourceDirectory: current.windowsSource,
    outputDirectory: path.join(current.root, "windows"),
    platform: "win32",
    arch: "x64",
  });

  assert.equal(path.basename(firstMac.artifact), "nexa-notes-0.1.0-macos-arm64-unsigned.tar.gz");
  assert.equal(path.basename(windows.artifact), "nexa-notes-0.1.0-windows-x64-unsigned.zip");
  assert.equal(sha256(firstMac.artifact), sha256(secondMac.artifact));

  const macExtract = path.join(current.root, "mac-extract");
  const windowsExtract = path.join(current.root, "windows-extract");
  extractArchive(firstMac.artifact, macExtract, "darwin");
  extractArchive(windows.artifact, windowsExtract, "win32");
  assert.deepEqual(readdirSync(macExtract), ["Nexa Notes.app"]);
  assert.deepEqual(filesBelow(windowsExtract).sort(), [
    "NexaNotes.exe",
    "app.manifest.json",
    "nexa-build.json",
  ]);
});

test("refuses metadata drift and symlinked package content", (t) => {
  const current = fixture(t);
  const metadataPath = path.join(current.windowsSource, "nexa-build.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.target.arch = "arm64";
  writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
  assert.throws(
    () =>
      createUnsignedPlatformArchive({
        sourceDirectory: current.windowsSource,
        outputDirectory: path.join(current.root, "wrong-arch"),
        platform: "win32",
        arch: "x64",
      }),
    /metadata.*target/u,
  );

  rmSync(metadataPath);
  symlinkSync(path.join(current.windowsSource, "app.manifest.json"), metadataPath);
  assert.throws(
    () =>
      createUnsignedPlatformArchive({
        sourceDirectory: current.windowsSource,
        outputDirectory: path.join(current.root, "symlink"),
        platform: "win32",
        arch: "x64",
      }),
    /symlink|regular file/u,
  );
});

test("assembles and verifies one revision-bound dual-platform G6-05 custody bundle", (t) => {
  const current = fixture(t);
  const inputs = createBothArchives(current);
  const bundleDirectory = path.join(current.root, "bundle");
  const result = assembleUnsignedSigningInput({
    inputDirectory: inputs,
    outputDirectory: bundleDirectory,
    source: { revision, dirty: false, sourceDateEpoch: 1_786_233_600 },
    dependencyGraph: dependencyGraph(),
  });

  assert.equal(result.artifactCount, 2);
  assert.deepEqual(filesBelow(bundleDirectory).sort(), [
    "g6-05/descriptor.json",
    "g6-05/evidence/SHA256SUMS",
    "g6-05/evidence/provenance.intoto.jsonl",
    "g6-05/evidence/sbom.cdx.json",
    "release-work/unsigned/nexa-notes-0.1.0-macos-arm64-unsigned.tar.gz",
    "release-work/unsigned/nexa-notes-0.1.0-windows-x64-unsigned.zip",
    "unsigned-signing-input.manifest.json",
  ]);
  assert.deepEqual(verifyUnsignedSigningInput({ bundleDirectory, revision }), result);

  const descriptor = JSON.parse(
    readFileSync(path.join(bundleDirectory, "g6-05", "descriptor.json"), "utf8"),
  );
  assert.deepEqual(descriptor.release, { name: "nexa-ui", version: "0.1.0" });
  assert.deepEqual(descriptor.source, {
    repository: "https://github.com/baicie/nexa-ui",
    revision,
    dirty: false,
  });
  assert.equal(
    descriptor.build.builderId,
    "https://github.com/baicie/nexa-ui/.github/workflows/reference-notes-package.yml",
  );

  const manifest = JSON.parse(
    readFileSync(path.join(bundleDirectory, "unsigned-signing-input.manifest.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(
    manifest.artifacts.map(({ name, platform, arch }) => ({ name, platform, arch })),
    [
      {
        name: "nexa-notes-0.1.0-macos-arm64-unsigned.tar.gz",
        platform: "darwin",
        arch: "arm64",
      },
      {
        name: "nexa-notes-0.1.0-windows-x64-unsigned.zip",
        platform: "win32",
        arch: "x64",
      },
    ],
  );
});

test("bundle verification fails closed for tampered and additional unsigned artifacts", (t) => {
  const current = fixture(t);
  const inputs = createBothArchives(current);
  const bundleDirectory = path.join(current.root, "bundle");
  assembleUnsignedSigningInput({
    inputDirectory: inputs,
    outputDirectory: bundleDirectory,
    source: { revision, dirty: false, sourceDateEpoch: 1_786_233_600 },
    dependencyGraph: dependencyGraph(),
  });

  const unsigned = path.join(bundleDirectory, "release-work", "unsigned");
  writeFileSync(path.join(unsigned, "nexa-notes-0.1.0-macos-arm64-unsigned.tar.gz"), "tampered\n");
  assert.throws(
    () => verifyUnsignedSigningInput({ bundleDirectory, revision }),
    /SHA256SUMS|manifest/u,
  );

  copyFileSync(
    path.join(inputs, "nexa-notes-0.1.0-macos-arm64-unsigned.tar.gz"),
    path.join(unsigned, "nexa-notes-0.1.0-macos-arm64-unsigned.tar.gz"),
  );
  writeFileSync(path.join(unsigned, "unexpected-unsigned.zip"), "extra\n");
  assert.throws(
    () => verifyUnsignedSigningInput({ bundleDirectory, revision }),
    /inventory|unexpected|SHA256SUMS/u,
  );
});

test("assembly rejects dirty source identity and incomplete platform input", (t) => {
  const current = fixture(t);
  const inputs = createBothArchives(current);
  rmSync(path.join(inputs, "nexa-notes-0.1.0-windows-x64-unsigned.zip"));

  assert.throws(
    () =>
      assembleUnsignedSigningInput({
        inputDirectory: inputs,
        outputDirectory: path.join(current.root, "dirty"),
        source: { revision, dirty: true, sourceDateEpoch: 1_786_233_600 },
        dependencyGraph: dependencyGraph(),
      }),
    /clean source/u,
  );
  assert.throws(
    () =>
      assembleUnsignedSigningInput({
        inputDirectory: inputs,
        outputDirectory: path.join(current.root, "incomplete"),
        source: { revision, dirty: false, sourceDateEpoch: 1_786_233_600 },
        dependencyGraph: dependencyGraph(),
      }),
    /exactly.*macOS.*Windows|inventory/u,
  );
});

test("CLI archives a platform package and independently verifies an assembled bundle", (t) => {
  const current = fixture(t);
  const archiveOutput = path.join(current.root, "cli-archive");
  const archive = spawnSync(
    process.execPath,
    [
      script,
      "archive",
      "--source",
      current.darwinSource,
      "--output",
      archiveOutput,
      "--platform",
      "darwin",
      "--arch",
      "arm64",
    ],
    { encoding: "utf8" },
  );
  assert.equal(archive.status, 0, archive.stderr || archive.stdout);
  assert.match(archive.stdout, /nexa-notes-0\.1\.0-macos-arm64-unsigned\.tar\.gz/u);

  const inputs = createBothArchives(current);
  const bundleDirectory = path.join(current.root, "cli-bundle");
  assembleUnsignedSigningInput({
    inputDirectory: inputs,
    outputDirectory: bundleDirectory,
    source: { revision, dirty: false, sourceDateEpoch: 1_786_233_600 },
    dependencyGraph: dependencyGraph(),
  });
  const verify = spawnSync(
    process.execPath,
    [script, "verify", "--bundle", bundleDirectory, "--revision", revision],
    { encoding: "utf8" },
  );
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /verified.*2 unsigned artifacts/u);

  const invalid = spawnSync(process.execPath, [script, "publish"], { encoding: "utf8" });
  assert.equal(invalid.status, 64);
  assert.match(invalid.stderr, /Usage:/u);
});

test("Notes package workflow emits and independently finalizes the signing input", () => {
  const workflow = parseYaml(
    readFileSync(
      new URL("../.github/workflows/reference-notes-package.yml", import.meta.url),
      "utf8",
    ),
  );
  const packageCommands = workflow.jobs.package.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(packageCommands, /unsigned-signing-input\.mjs archive/u);
  assert.match(packageCommands, /--platform.*runner\.os/u);
  assert.match(packageCommands, /--arch.*runner\.os/u);

  const signingInput = workflow.jobs.signing_input;
  assert.equal(signingInput.needs, "package");
  assert.equal(signingInput["runs-on"], "ubuntu-24.04");
  const download = signingInput.steps.find(
    (step) => step.uses === "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  );
  assert.equal(download.with.pattern, "nexa-unsigned-signing-*-${{ github.sha }}");
  assert.equal(download.with["merge-multiple"], true);
  const commands = signingInput.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(commands, /unsigned-signing-input\.mjs assemble/u);
  assert.match(commands, /unsigned-signing-input\.mjs verify/u);
  const upload = signingInput.steps.find((step) => step.with?.name === "unsigned-signing-input");
  assert.equal(upload.with.path, "${{ runner.temp }}/nexa-unsigned-signing-input");
  assert.equal(upload.with["compression-level"], 0);
  assert.equal(upload.with["if-no-files-found"], "error");
});

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runReferenceNotesBuild } from "./reference-notes-build.mjs";

const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
const exampleDirectory = path.join(repositoryDirectory, "examples", "reference-notes");
const requiredPermissions = [
  "system.FsRead",
  "system.FsWrite",
  "system.DialogOpen",
  "system.DialogSave",
];
const dialogTestFixtureMarkers = ["nexa-ui-dialog-open.txt", "nexa-ui-dialog-save.txt"];
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function readNotesManifest(manifestPath) {
  let source;
  let manifest;
  try {
    source = readFileSync(manifestPath);
    manifest = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`Notes package manifest is not valid JSON: ${error.message}`, { cause: error });
  }

  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("Notes package manifest must be a JSON object");
  }
  if (
    typeof manifest.id !== "string" ||
    !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/u.test(manifest.id)
  ) {
    throw new Error("Notes package manifest id is invalid");
  }
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    throw new Error("Notes package manifest name is invalid");
  }
  if (typeof manifest.version !== "string" || !semverPattern.test(manifest.version)) {
    throw new Error("Notes package manifest version is invalid");
  }
  if (
    !Array.isArray(manifest.permissions) ||
    manifest.permissions.some((permission) => typeof permission !== "string") ||
    new Set(manifest.permissions).size !== manifest.permissions.length
  ) {
    throw new Error("Notes package manifest permissions are invalid");
  }
  for (const permission of requiredPermissions) {
    if (!manifest.permissions.includes(permission)) {
      throw new Error(`Notes package manifest is missing required permission ${permission}`);
    }
  }
  return { manifest, source };
}

function assertEmbeddedManifest(binary, manifest, manifestSource) {
  for (const marker of [manifest.id, ...manifest.permissions]) {
    if (!binary.includes(Buffer.from(marker))) {
      throw new Error(`Notes package binary does not contain trusted manifest marker ${marker}`);
    }
  }
  if (!binary.includes(manifestSource)) {
    throw new Error("Notes package embedded trusted manifest does not match the sidecar manifest");
  }
  for (const marker of dialogTestFixtureMarkers) {
    if (binary.includes(Buffer.from(marker))) {
      throw new Error(`Notes package binary contains Dialog test fixture marker ${marker}`);
    }
  }
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function macInfoPlist(manifest) {
  const id = escapeXml(manifest.id);
  const name = escapeXml(manifest.name);
  const version = escapeXml(manifest.version);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${name}</string>
  <key>CFBundleExecutable</key>
  <string>NexaNotes</string>
  <key>CFBundleIdentifier</key>
  <string>${id}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function assertSourceBinary(binaryPath) {
  if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
    throw new Error(`Notes package binary does not exist: ${binaryPath}`);
  }
}

export function packageReferenceNotes({
  platform = process.platform,
  arch = process.arch,
  binaryPath = path.join(
    exampleDirectory,
    platform === "win32" ? "reference-notes.exe" : "reference-notes",
  ),
  manifestPath = path.join(exampleDirectory, "app.manifest.json"),
  outputRoot = path.join(repositoryDirectory, "dist"),
  build = runReferenceNotesBuild,
} = {}) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Notes packaging currently supports only macOS and Windows");
  }
  if (typeof arch !== "string" || !/^[A-Za-z0-9_-]+$/u.test(arch)) {
    throw new Error(`Notes package architecture is invalid: ${String(arch)}`);
  }

  build({ platform });
  const { manifest, source: manifestSource } = readNotesManifest(manifestPath);
  assertSourceBinary(binaryPath);
  const binary = readFileSync(binaryPath);
  assertEmbeddedManifest(binary, manifest, manifestSource);

  const platformName = platform === "darwin" ? "macos" : "windows";
  const artifactDirectory = path.resolve(outputRoot, `reference-notes-${platformName}-${arch}`);
  if (existsSync(artifactDirectory)) {
    throw new Error(`Notes package destination already exists: ${artifactDirectory}`);
  }

  const resolvedOutputRoot = path.resolve(outputRoot);
  mkdirSync(resolvedOutputRoot, { recursive: true });
  const stagingDirectory = mkdtempSync(path.join(resolvedOutputRoot, ".reference-notes-"));
  try {
    let bundlePath;
    let executablePath;
    let metadataDirectory;
    if (platform === "darwin") {
      bundlePath = path.join(stagingDirectory, "Nexa Notes.app");
      const contents = path.join(bundlePath, "Contents");
      const macos = path.join(contents, "MacOS");
      const resources = path.join(contents, "Resources");
      mkdirSync(macos, { recursive: true });
      mkdirSync(resources, { recursive: true });
      metadataDirectory = resources;
      executablePath = path.join(macos, "NexaNotes");
      copyFileSync(binaryPath, executablePath);
      chmodSync(executablePath, 0o755);
      copyFileSync(manifestPath, path.join(resources, "app.manifest.json"));
      writeFileSync(path.join(contents, "Info.plist"), macInfoPlist(manifest));
    } else {
      bundlePath = stagingDirectory;
      metadataDirectory = stagingDirectory;
      executablePath = path.join(stagingDirectory, "NexaNotes.exe");
      copyFileSync(binaryPath, executablePath);
      copyFileSync(manifestPath, path.join(stagingDirectory, "app.manifest.json"));
    }
    writeFileSync(
      path.join(metadataDirectory, "nexa-build.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          app: { id: manifest.id, name: manifest.name, version: manifest.version },
          target: { platform, arch },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );

    renameSync(stagingDirectory, artifactDirectory);
    const relativeBundle = path.relative(stagingDirectory, bundlePath);
    const relativeExecutable = path.relative(stagingDirectory, executablePath);
    return {
      artifactDirectory,
      bundlePath: path.join(artifactDirectory, relativeBundle),
      executablePath: path.join(artifactDirectory, relativeExecutable),
      id: manifest.id,
      version: manifest.version,
    };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  let build = runReferenceNotesBuild;
  let outputRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--skip-build") {
      build = () => {};
      continue;
    }
    if (argument === "--output") {
      outputRoot = argv[index + 1];
      if (!outputRoot) throw new Error("--output requires a directory");
      index += 1;
      continue;
    }
    throw new Error(`Unknown Notes package argument: ${argument}`);
  }
  return { build, outputRoot };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const artifact = packageReferenceNotes(options);
  process.stdout.write(`Packaged ${artifact.id}@${artifact.version}: ${artifact.bundlePath}\n`);
}

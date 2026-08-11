import * as nodeFilesystem from "node:fs";
import path from "node:path";

import {
  assertSupportedTarget,
  readProject,
  readStableRegularFile,
  runProjectBuild,
  verifyBuiltBinary,
} from "./build.mjs";
import { COMPATIBILITY } from "./constants.mjs";

const maximumAssetFiles = 4096;
const maximumAssetFileBytes = 64 * 1024 * 1024;
const maximumAssetBytes = 256 * 1024 * 1024;
const identityStatOptions = Object.freeze({ bigint: true });

function lstatIfPresent(filesystem, candidate, label) {
  try {
    return filesystem.lstatSync(candidate, identityStatOptions);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw new Error(`Could not inspect ${label}: ${candidate}`, { cause: error });
  }
}

function assertDestinationAvailable(filesystem, destination) {
  if (lstatIfPresent(filesystem, destination, "package destination")) {
    throw new Error(`Package destination already exists: ${destination}`);
  }
}

function assetIdentity(metadata) {
  return {
    ctime: metadata.ctimeNs ?? metadata.ctimeMs,
    dev: metadata.dev,
    ino: metadata.ino,
    mtime: metadata.mtimeNs ?? metadata.mtimeMs,
    size: metadata.size,
  };
}

function directoryIdentity(metadata) {
  return { dev: metadata.dev, ino: metadata.ino };
}

function identitiesMatch(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function combinedFailure(primary, secondary, action) {
  return new Error(
    `${failureMessage(primary)}; additionally failed to ${action}: ${failureMessage(secondary)}`,
    { cause: new AggregateError([primary, secondary]) },
  );
}

function assertStableDirectory(filesystem, directory, identity, label) {
  const metadata = lstatIfPresent(filesystem, directory, label);
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !identitiesMatch(identity, directoryIdentity(metadata))
  ) {
    throw new Error(`${label} changed during packaging: ${directory}`);
  }
}

function inspectAssets(filesystem, projectDirectory) {
  const root = path.join(projectDirectory, "assets");
  const rootMetadata = lstatIfPresent(filesystem, root, "assets directory");
  if (!rootMetadata) return { bytes: 0, directories: [], files: [], present: false };
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Assets path must be a non-symbolic-link directory: ${root}`);
  }

  const directories = [];
  const files = [];
  let totalBytes = 0;

  function visit(directory, relativeDirectory, expectedIdentity) {
    assertStableDirectory(filesystem, directory, expectedIdentity, "Assets directory");
    let entries;
    try {
      entries = filesystem
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? -1 : 1));
    } catch (error) {
      throw new Error(`Could not read assets directory: ${directory}`, { cause: error });
    }
    assertStableDirectory(filesystem, directory, expectedIdentity, "Assets directory");

    for (const entry of entries) {
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const source = path.join(directory, entry.name);
      const metadata = lstatIfPresent(filesystem, source, "asset");
      if (!metadata) throw new Error(`Asset disappeared while inspecting: ${source}`);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Asset must not be a symbolic link: ${source}`);
      }
      if (metadata.isDirectory()) {
        directories.push(relative);
        visit(source, relative, directoryIdentity(metadata));
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Asset must be a regular file or directory: ${source}`);
      }
      const assetSize = Number(metadata.size);
      if (!Number.isSafeInteger(assetSize) || assetSize > maximumAssetFileBytes) {
        throw new Error(
          `Asset exceeds the ${maximumAssetFileBytes} byte (64 MiB) limit: ${relative}`,
        );
      }
      if (files.length >= maximumAssetFiles) {
        throw new Error(`Assets exceed the ${maximumAssetFiles} file limit`);
      }
      totalBytes += assetSize;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumAssetBytes) {
        throw new Error(`Assets exceed the ${maximumAssetBytes} byte (256 MiB) limit`);
      }
      files.push({ identity: assetIdentity(metadata), metadata, relative, source });
    }
    assertStableDirectory(filesystem, directory, expectedIdentity, "Assets directory");
  }

  visit(root, "", directoryIdentity(rootMetadata));
  return { bytes: totalBytes, directories, files, present: true };
}

function readStableAsset(filesystem, asset) {
  return readStableRegularFile(
    filesystem,
    asset.source,
    `Asset ${asset.relative}`,
    maximumAssetFileBytes,
    asset.metadata,
  );
}

function cleanupOwnedDirectory(filesystem, directory, identity) {
  const metadata = lstatIfPresent(filesystem, directory, "owned package directory");
  if (!metadata) return;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !identitiesMatch(identity, directoryIdentity(metadata))
  ) {
    throw new Error(`Refusing to clean a package directory whose identity changed: ${directory}`);
  }
  filesystem.rmSync(directory, { recursive: true, force: true });
}

function cleanupReservation(filesystem, destination, identity) {
  const metadata = lstatIfPresent(filesystem, destination, "package destination reservation");
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !identitiesMatch(identity, directoryIdentity(metadata)) ||
    filesystem.readdirSync(destination).length > 0
  ) {
    return;
  }
  filesystem.rmdirSync(destination);
}

function reserveDestination(filesystem, destination, distDirectory, distIdentity) {
  assertStableDirectory(filesystem, distDirectory, distIdentity, "Package dist root");
  try {
    filesystem.mkdirSync(destination);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`Package destination already exists: ${destination}`, { cause: error });
    }
    throw new Error(`Could not claim package destination: ${destination}`, { cause: error });
  }

  const metadata = lstatIfPresent(filesystem, destination, "package destination reservation");
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Package destination reservation changed: ${destination}`);
  }
  const reservationIdentity = directoryIdentity(metadata);
  try {
    assertStableDirectory(filesystem, distDirectory, distIdentity, "Package dist root");
  } catch (error) {
    try {
      cleanupReservation(filesystem, destination, reservationIdentity);
    } catch (cleanupError) {
      throw combinedFailure(error, cleanupError, "clean the package destination reservation");
    }
    throw error;
  }
  return reservationIdentity;
}

function assertStagedEntry(filesystem, source, expectedType) {
  const metadata = lstatIfPresent(filesystem, source, "staged package entry");
  if (!metadata) {
    throw new Error(`Required staged package entry disappeared: ${source}`);
  }
  const expectedTypeMatches = expectedType === "file" ? metadata.isFile() : metadata.isDirectory();
  if (metadata.isSymbolicLink() || !expectedTypeMatches) {
    const label = expectedType === "file" ? "regular file" : "directory";
    throw new Error(`Staged package entry must be a non-symbolic-link ${label}: ${source}`);
  }
}

function publishStaging(
  filesystem,
  stagingDirectory,
  artifactDirectory,
  distDirectory,
  distIdentity,
  platform,
  binaryName,
  assetsPresent,
) {
  const reservationIdentity = reserveDestination(
    filesystem,
    artifactDirectory,
    distDirectory,
    distIdentity,
  );
  try {
    assertStableDirectory(filesystem, distDirectory, distIdentity, "Package dist root");
    assertStableDirectory(
      filesystem,
      artifactDirectory,
      reservationIdentity,
      "Package destination reservation",
    );
    if (platform === "darwin") {
      const source = path.join(stagingDirectory, `${binaryName}.app`);
      assertStagedEntry(filesystem, source, "directory");
      filesystem.renameSync(source, path.join(artifactDirectory, `${binaryName}.app`));
    } else {
      const orderedEntries = [
        { expectedType: "file", name: `${binaryName}.exe`, required: true },
        { expectedType: "file", name: "app.manifest.json", required: true },
        { expectedType: "directory", name: "assets", required: assetsPresent },
        { expectedType: "file", name: "nexa-build.json", required: true },
      ];
      for (const entry of orderedEntries) {
        if (!entry.required) continue;
        const source = path.join(stagingDirectory, entry.name);
        assertStagedEntry(filesystem, source, entry.expectedType);
        filesystem.renameSync(source, path.join(artifactDirectory, entry.name));
      }
    }
    filesystem.rmdirSync(stagingDirectory);
  } catch (error) {
    try {
      cleanupOwnedDirectory(filesystem, artifactDirectory, reservationIdentity);
    } catch (cleanupError) {
      throw combinedFailure(error, cleanupError, "clean the package destination reservation");
    }
    throw error;
  }
}

function writeAssets(filesystem, assets, destination) {
  if (!assets.present) return;
  filesystem.mkdirSync(destination);
  for (const relative of assets.directories) {
    filesystem.mkdirSync(path.join(destination, relative));
  }
  for (const asset of assets.files) {
    filesystem.writeFileSync(
      path.join(destination, asset.relative),
      readStableAsset(filesystem, asset),
      {
        flag: "wx",
      },
    );
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

function macInfoPlist(manifest, binaryName) {
  const versionCore = manifest.version.split(/[+-]/u, 1)[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${escapeXml(manifest.name)}</string>
  <key>CFBundleExecutable</key>
  <string>${escapeXml(binaryName)}</string>
  <key>CFBundleIdentifier</key>
  <string>${escapeXml(manifest.id)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${escapeXml(manifest.name)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapeXml(versionCore)}</string>
  <key>CFBundleVersion</key>
  <string>${escapeXml(versionCore)}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function buildMetadata(project, runtime, assets) {
  return {
    schemaVersion: 1,
    app: {
      id: project.manifest.id,
      name: project.manifest.name,
      version: project.manifest.version,
    },
    protocol: { ...project.manifest.requiredProtocol },
    target: { arch: runtime.arch, platform: runtime.platform },
    toolchain: {
      cli: COMPATIBILITY.cli,
      hostAbi: COMPATIBILITY.hostAbi,
      hostRuntime: COMPATIBILITY.hostRuntime,
      perry: COMPATIBILITY.perry,
    },
    assets: { bytes: assets.bytes, files: assets.files.length },
  };
}

function writePackageFile(filesystem, destination, source) {
  filesystem.writeFileSync(destination, source, { flag: "wx" });
}

function portablePath(value) {
  return value.split(path.sep).join("/");
}

function platformLabel(platform) {
  return platform === "darwin" ? "macos" : "windows";
}

export function runProjectPackage({
  build = runProjectBuild,
  cwd = process.cwd(),
  environment = process.env,
  filesystem = nodeFilesystem,
  runner,
  runtime = { arch: process.arch, platform: process.platform },
} = {}) {
  assertSupportedTarget(runtime);
  const preflightProject = readProject(filesystem, cwd);
  inspectAssets(filesystem, preflightProject.projectDirectory);
  const artifactName = `${preflightProject.binaryName}-${platformLabel(runtime.platform)}-${runtime.arch}`;
  const artifactDirectory = path.join(preflightProject.projectDirectory, "dist", artifactName);
  assertDestinationAvailable(filesystem, artifactDirectory);

  const buildOptions = { cwd, environment, filesystem, runtime };
  if (runner !== undefined) buildOptions.runner = runner;
  const built = build(buildOptions);
  const project = readProject(filesystem, cwd);
  const assets = inspectAssets(filesystem, project.projectDirectory);
  if (
    built.id !== project.manifest.id ||
    built.version !== project.manifest.version ||
    project.binaryName !== preflightProject.binaryName ||
    !project.manifestSource.equals(preflightProject.manifestSource)
  ) {
    throw new Error("Project identity or manifest changed during packaging");
  }

  const expectedBinary = path.join(
    project.projectDirectory,
    "dist",
    runtime.platform === "win32" ? `${project.binaryName}.exe` : project.binaryName,
  );
  if (path.resolve(built.binaryPath) !== expectedBinary) {
    throw new Error("Build returned an unexpected binary path");
  }
  const binary = verifyBuiltBinary(filesystem, built.binaryPath, project.manifestSource);

  const distDirectory = path.join(project.projectDirectory, "dist");
  const distMetadata = lstatIfPresent(filesystem, distDirectory, "dist directory");
  if (!distMetadata || distMetadata.isSymbolicLink() || !distMetadata.isDirectory()) {
    throw new Error("Package dist root must be a non-symbolic-link directory");
  }
  const distIdentity = directoryIdentity(distMetadata);
  assertDestinationAvailable(filesystem, artifactDirectory);

  const stagingDirectory = filesystem.mkdtempSync(
    path.join(project.projectDirectory, ".nexa-package-"),
  );
  const stagingMetadata = filesystem.lstatSync(stagingDirectory, identityStatOptions);
  if (stagingMetadata.isSymbolicLink() || !stagingMetadata.isDirectory()) {
    throw new Error(`Package staging path must be an owned directory: ${stagingDirectory}`);
  }
  const stagingIdentity = directoryIdentity(stagingMetadata);
  try {
    const metadataSource = `${JSON.stringify(buildMetadata(project, runtime, assets), null, 2)}\n`;
    let bundleInStaging;
    if (runtime.platform === "darwin") {
      bundleInStaging = path.join(stagingDirectory, `${project.binaryName}.app`);
      const contents = path.join(bundleInStaging, "Contents");
      const macos = path.join(contents, "MacOS");
      const resources = path.join(contents, "Resources");
      filesystem.mkdirSync(macos, { recursive: true });
      filesystem.mkdirSync(resources);
      const executable = path.join(macos, project.binaryName);
      writePackageFile(filesystem, executable, binary);
      filesystem.chmodSync(executable, 0o755);
      writePackageFile(
        filesystem,
        path.join(resources, "app.manifest.json"),
        project.manifestSource,
      );
      writePackageFile(filesystem, path.join(resources, "nexa-build.json"), metadataSource);
      writePackageFile(
        filesystem,
        path.join(contents, "Info.plist"),
        macInfoPlist(project.manifest, project.binaryName),
      );
      writeAssets(filesystem, assets, path.join(resources, "assets"));
    } else {
      bundleInStaging = stagingDirectory;
      writePackageFile(
        filesystem,
        path.join(stagingDirectory, `${project.binaryName}.exe`),
        binary,
      );
      writePackageFile(
        filesystem,
        path.join(stagingDirectory, "app.manifest.json"),
        project.manifestSource,
      );
      writePackageFile(filesystem, path.join(stagingDirectory, "nexa-build.json"), metadataSource);
      writeAssets(filesystem, assets, path.join(stagingDirectory, "assets"));
    }

    const relativeBundle = path.relative(stagingDirectory, bundleInStaging);
    publishStaging(
      filesystem,
      stagingDirectory,
      artifactDirectory,
      distDirectory,
      distIdentity,
      runtime.platform,
      project.binaryName,
      assets.present,
    );
    const bundlePath = path.join(artifactDirectory, relativeBundle);
    return {
      artifactDirectory,
      bundlePath,
      bundleRelative: portablePath(path.relative(project.projectDirectory, bundlePath)),
      id: project.manifest.id,
      version: project.manifest.version,
    };
  } catch (error) {
    try {
      cleanupOwnedDirectory(filesystem, stagingDirectory, stagingIdentity);
    } catch (cleanupError) {
      throw combinedFailure(error, cleanupError, "clean package staging");
    }
    throw error;
  }
}

import * as nodeFilesystem from "node:fs";
import path from "node:path";

export const PERRY_OVERRIDE_ENVIRONMENT = "NEXA_PERRY_BIN";

function overrideEntries(environment) {
  return Object.entries(environment ?? {}).filter(
    ([name]) => name.toUpperCase() === PERRY_OVERRIDE_ENVIRONMENT,
  );
}

function assertUnambiguousOverride(entries) {
  if (entries.length > 1) {
    throw new Error(
      `Multiple case-insensitive ${PERRY_OVERRIDE_ENVIRONMENT} variables are ambiguous`,
    );
  }
}

export function environmentWithoutPerryCompilerOverride(environment = process.env) {
  const entries = overrideEntries(environment);
  assertUnambiguousOverride(entries);
  const names = new Set(entries.map(([name]) => name));
  return Object.fromEntries(Object.entries(environment ?? {}).filter(([name]) => !names.has(name)));
}

function canonicalRegularFile(filesystem, requestedPath) {
  let requestedMetadata;
  try {
    requestedMetadata = filesystem.lstatSync(requestedPath);
  } catch (error) {
    throw new Error(`Perry compiler override does not exist: ${requestedPath}`, { cause: error });
  }
  if (requestedMetadata.isSymbolicLink() || !requestedMetadata.isFile()) {
    throw new Error(
      `Perry compiler override must be a non-symbolic-link regular file: ${requestedPath}`,
    );
  }

  let canonicalPath;
  try {
    const realpath = filesystem.realpathSync.native ?? filesystem.realpathSync;
    canonicalPath = realpath(requestedPath);
  } catch (error) {
    throw new Error(`Perry compiler override could not be canonicalized: ${requestedPath}`, {
      cause: error,
    });
  }

  let canonicalMetadata;
  try {
    canonicalMetadata = filesystem.lstatSync(canonicalPath);
  } catch (error) {
    throw new Error(`Canonical Perry compiler override does not exist: ${canonicalPath}`, {
      cause: error,
    });
  }
  if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isFile()) {
    throw new Error(
      `Canonical Perry compiler override must be a non-symbolic-link regular file: ${canonicalPath}`,
    );
  }
  return canonicalPath;
}

export function resolvePerryCompilerCommand({
  environment = process.env,
  fallbackCommand,
  fallbackPrefixArgs = [],
  fallbackShell = false,
  filesystem = nodeFilesystem,
  platform = process.platform,
}) {
  const entries = overrideEntries(environment);
  assertUnambiguousOverride(entries);
  const childEnvironment = environmentWithoutPerryCompilerOverride(environment);
  if (entries.length === 0) {
    return {
      command: fallbackCommand,
      environment: childEnvironment,
      prefixArgs: [...fallbackPrefixArgs],
      shell: fallbackShell,
    };
  }

  const requestedPath = entries[0][1];
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new Error(`${PERRY_OVERRIDE_ENVIRONMENT} must be a non-empty absolute path`);
  }
  if (requestedPath.includes("\0") || !path.isAbsolute(requestedPath)) {
    throw new Error(`${PERRY_OVERRIDE_ENVIRONMENT} must be an absolute path without NUL bytes`);
  }
  if (platform === "win32" && path.extname(requestedPath).toLowerCase() !== ".exe") {
    throw new Error(`${PERRY_OVERRIDE_ENVIRONMENT} must name a .exe file on Windows`);
  }

  const command = canonicalRegularFile(filesystem, requestedPath);
  if (platform === "win32" && path.extname(command).toLowerCase() !== ".exe") {
    throw new Error(`Canonical ${PERRY_OVERRIDE_ENVIRONMENT} must name a .exe file on Windows`);
  }
  return { command, environment: childEnvironment, prefixArgs: [], shell: false };
}

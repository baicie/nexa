import { lstatSync } from "node:fs";
import path from "node:path";

export function packageManagerCommand({ platform = process.platform } = {}) {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function environmentValue(environment, name) {
  const normalizedName = name.toUpperCase();
  return Object.entries(environment ?? {}).find(
    ([candidate]) => candidate.toUpperCase() === normalizedName,
  )?.[1];
}

function resolvePnpmEntrypoint(environment) {
  const candidates = [];
  const npmExecpath = environmentValue(environment, "npm_execpath");
  if (typeof npmExecpath === "string") candidates.push(npmExecpath);
  const pnpmHome = environmentValue(environment, "PNPM_HOME");
  if (typeof pnpmHome === "string") {
    candidates.push(
      path.join(pnpmHome, "pnpm.cjs"),
      path.resolve(pnpmHome, "..", "pnpm", "bin", "pnpm.cjs"),
    );
  }

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || path.basename(candidate).toLowerCase() !== "pnpm.cjs") {
      continue;
    }
    try {
      const metadata = lstatSync(candidate);
      if (!metadata.isSymbolicLink() && metadata.isFile()) return candidate;
    } catch {
      // Try the next controlled pnpm installation layout.
    }
  }
  throw new Error(
    "Windows process requires npm_execpath or PNPM_HOME to resolve a regular pnpm.cjs entrypoint",
  );
}

export function packageManagerLauncher({
  args = [],
  environment = process.env,
  nodeExecutable = process.execPath,
  platform = process.platform,
} = {}) {
  if (platform === "win32") {
    return {
      command: nodeExecutable,
      args: [resolvePnpmEntrypoint(environment), ...args],
    };
  }
  return {
    command: packageManagerCommand({ platform }),
    args: [...args],
  };
}

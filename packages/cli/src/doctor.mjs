import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { COMPATIBILITY } from "./constants.mjs";

const supportedTargets = new Set(["darwin/arm64", "darwin/x64", "win32/x64"]);
const targetExpectation = [...supportedTargets].join(" | ");

function defaultRunner(command, args, options) {
  return spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    shell: command.toLowerCase().endsWith(".cmd"),
  });
}

function parsePackageJson(filePath) {
  const value = JSON.parse(readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Package manifest is not an object: ${filePath}`);
  }
  return value;
}

function dependencyNames(manifest, includeDevelopmentDependencies) {
  const fields = ["dependencies", "optionalDependencies", "peerDependencies"];
  if (includeDevelopmentDependencies) fields.push("devDependencies");

  const names = new Set();
  for (const field of fields) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  return names;
}

function packageNameSegments(packageName) {
  const segments = packageName.split("/");
  const valid = packageName.startsWith("@") ? segments.length === 2 : segments.length === 1;
  if (!valid || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid package name: ${packageName}`);
  }
  return segments;
}

function packageManifestOnDependencyEdge(ownerManifestPath, packageName) {
  return path.join(
    path.dirname(ownerManifestPath),
    "node_modules",
    ...packageNameSegments(packageName),
    "package.json",
  );
}

export function resolveInstalledPackage(packageName, cwd) {
  const rootManifestPath = path.join(path.resolve(cwd), "package.json");
  if (!existsSync(rootManifestPath)) {
    throw new Error(`Current project has no package.json: ${rootManifestPath}`);
  }

  const rootManifest = parsePackageJson(rootManifestPath);
  const pending = [{ filePath: rootManifestPath, manifest: rootManifest, root: true }];
  const visited = new Set([realpathSync(rootManifestPath)]);
  let targetFailure;

  for (let index = 0; index < pending.length; index += 1) {
    const owner = pending[index];
    for (const dependencyName of dependencyNames(owner.manifest, owner.root)) {
      const candidate = packageManifestOnDependencyEdge(owner.filePath, dependencyName);
      if (!existsSync(candidate)) {
        if (dependencyName === packageName) {
          targetFailure = new Error(
            `${packageName} is declared but not installed on the current project dependency graph`,
          );
        }
        continue;
      }

      let filePath;
      let manifest;
      try {
        filePath = realpathSync(candidate);
        manifest = parsePackageJson(filePath);
        if (manifest.name !== dependencyName) {
          throw new Error(`Dependency edge ${dependencyName} resolved to ${String(manifest.name)}`);
        }
      } catch (error) {
        if (dependencyName === packageName) {
          targetFailure = error instanceof Error ? error : new Error(String(error));
        }
        continue;
      }

      if (dependencyName === packageName) return { filePath, manifest };
      if (!visited.has(filePath)) {
        visited.add(filePath);
        pending.push({ filePath, manifest, root: false });
      }
    }
  }

  if (targetFailure) throw targetFailure;
  throw new Error(`Could not resolve ${packageName} from the current project dependency graph`);
}

export function readInstalledPackageManifest(packageName, cwd) {
  return resolveInstalledPackage(packageName, cwd).manifest;
}

export function resolveInstalledPackageBin(packageName, binName, cwd) {
  const resolved = resolveInstalledPackage(packageName, cwd);
  const bin =
    typeof resolved.manifest.bin === "string"
      ? resolved.manifest.bin
      : resolved.manifest.bin?.[binName];
  if (typeof bin !== "string" || bin.length === 0) {
    throw new Error(`${packageName} does not declare the ${binName} executable`);
  }

  const packageDirectory = path.dirname(resolved.filePath);
  const binPath = path.resolve(packageDirectory, bin);
  const relative = path.relative(packageDirectory, binPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${packageName} declares an executable outside its package directory`);
  }
  if (!existsSync(binPath)) {
    throw new Error(`${packageName} executable is not installed: ${binPath}`);
  }
  return binPath;
}

function check(id, expected, actual, ok, detail) {
  const result = { id, ok, expected, actual };
  if (detail && !ok) result.detail = detail;
  return result;
}

function runVersionCommand(runner, command, args, cwd, parser) {
  try {
    const result = runner(command, args, { cwd });
    if (result?.error || result?.status !== 0) {
      const detail = result?.error?.message || result?.stderr?.trim() || "command failed";
      return { actual: "unavailable", detail };
    }
    const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
    const actual = parser(output);
    return actual ? { actual } : { actual: "unavailable", detail: `Unexpected output: ${output}` };
  } catch (error) {
    return {
      actual: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function packageFacts(readPackageManifest, packageName, cwd) {
  try {
    const manifest = readPackageManifest(packageName, cwd);
    const version = typeof manifest?.version === "string" ? manifest.version : "unavailable";
    const abi = manifest?.perry?.nativeLibrary?.abiVersion;
    return {
      version,
      abi: typeof abi === "string" ? abi : "unavailable",
      detail:
        version === "unavailable" || typeof abi !== "string" ? "Malformed package manifest" : "",
    };
  } catch (error) {
    return {
      version: "unavailable",
      abi: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function packageVersionFact(readPackageManifest, packageName, cwd) {
  try {
    const manifest = readPackageManifest(packageName, cwd);
    if (typeof manifest?.version !== "string") {
      return { version: "unavailable", detail: "Malformed package manifest" };
    }
    return { version: manifest.version, detail: "" };
  } catch (error) {
    return {
      version: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function nodeVersionIsSupported(version, expected = COMPATIBILITY.node) {
  const expectedMatch = /^>=(\d+)$/u.exec(expected);
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  return expectedMatch !== null && match !== null && Number(match[1]) >= Number(expectedMatch[1]);
}

export function createDoctorReport({
  cwd = process.cwd(),
  runner = defaultRunner,
  readPackageManifest = readInstalledPackageManifest,
  resolvePerryBin = (projectDirectory) =>
    resolveInstalledPackageBin("@perryts/perry", "perry", projectDirectory),
  runtime = {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  },
} = {}) {
  const packageManagerCommand = runtime.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const pnpm = runVersionCommand(runner, packageManagerCommand, ["--version"], cwd, (output) =>
    /^\d+\.\d+\.\d+$/u.test(output) ? output : undefined,
  );
  const perryPackage = packageVersionFact(readPackageManifest, "@perryts/perry", cwd);
  let perry = { actual: "unavailable", detail: perryPackage.detail };
  if (perryPackage.version === COMPATIBILITY.perry) {
    try {
      const binPath = resolvePerryBin(cwd);
      perry = runVersionCommand(
        runner,
        process.execPath,
        [binPath, "--version"],
        cwd,
        (output) => /^perry (\d+\.\d+\.\d+)$/u.exec(output)?.[1],
      );
    } catch (error) {
      perry = {
        actual: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const nuiHost = packageFacts(readPackageManifest, "@nexa/nui-host", cwd);
  const systemHost = packageFacts(readPackageManifest, "@nexa/system-host", cwd);
  const target = `${runtime.platform}/${runtime.arch}`;
  const checks = [
    check(
      "node",
      COMPATIBILITY.node,
      runtime.nodeVersion,
      nodeVersionIsSupported(runtime.nodeVersion),
    ),
    check("pnpm", COMPATIBILITY.pnpm, pnpm.actual, pnpm.actual === COMPATIBILITY.pnpm, pnpm.detail),
    check(
      "perry",
      COMPATIBILITY.perry,
      perryPackage.version === COMPATIBILITY.perry ? perry.actual : perryPackage.version,
      perryPackage.version === COMPATIBILITY.perry && perry.actual === COMPATIBILITY.perry,
      perryPackage.version === COMPATIBILITY.perry ? perry.detail : perryPackage.detail,
    ),
    check(
      "nui-host-runtime",
      COMPATIBILITY.hostRuntime,
      nuiHost.version,
      nuiHost.version === COMPATIBILITY.hostRuntime,
      nuiHost.detail,
    ),
    check(
      "nui-host-abi",
      COMPATIBILITY.hostAbi,
      nuiHost.abi,
      nuiHost.abi === COMPATIBILITY.hostAbi,
      nuiHost.detail,
    ),
    check(
      "system-host-runtime",
      COMPATIBILITY.hostRuntime,
      systemHost.version,
      systemHost.version === COMPATIBILITY.hostRuntime,
      systemHost.detail,
    ),
    check(
      "system-host-abi",
      COMPATIBILITY.hostAbi,
      systemHost.abi,
      systemHost.abi === COMPATIBILITY.hostAbi,
      systemHost.detail,
    ),
    check("target", targetExpectation, target, supportedTargets.has(target)),
  ];

  return {
    schemaVersion: 1,
    ok: checks.every((candidate) => candidate.ok),
    compatibility: {
      cli: COMPATIBILITY.cli,
      node: COMPATIBILITY.node,
      pnpm: COMPATIBILITY.pnpm,
      protocol: COMPATIBILITY.protocol,
      perry: COMPATIBILITY.perry,
      typescript: COMPATIBILITY.typescript,
      ui: COMPATIBILITY.ui,
      hostRuntime: COMPATIBILITY.hostRuntime,
      hostAbi: COMPATIBILITY.hostAbi,
    },
    target: { platform: runtime.platform, arch: runtime.arch },
    checks,
  };
}

function writeHumanReport(report, stdout, stderr) {
  stdout.write(
    `Nexa UI doctor (CLI ${report.compatibility.cli}, Protocol ${report.compatibility.protocol})\n`,
  );
  for (const item of report.checks) {
    stdout.write(
      `[${item.ok ? "pass" : "fail"}] ${item.id}: ${item.actual} (expected ${item.expected})\n`,
    );
  }
  if (report.ok) stdout.write("All checks passed.\n");
  else stderr.write(`${report.checks.filter((item) => !item.ok).length} check(s) failed.\n`);
}

export function runDoctor({
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
  ...options
} = {}) {
  const report = createDoctorReport(options);
  if (json) stdout.write(`${JSON.stringify(report)}\n`);
  else writeHumanReport(report, stdout, stderr);
  return report.ok ? 0 : 1;
}

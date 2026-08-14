import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePerryCompilerCommand } from "../packages/cli/src/perry-command.mjs";
import { preparePerryRuntimeForCompile } from "../packages/cli/src/windows-runtime.mjs";

function defaultRunner(command, args, options) {
  return spawnSync(command, args, options);
}

function assertSucceeded(result, label) {
  if (result?.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result?.status !== 0) {
    throw new Error(`${label} failed with exit code ${result?.status ?? "unknown"}`);
  }
}

function compileEnvironment(environment, manifestPath, dialogFixturePath) {
  const blocked = new Set(["NEXA_APP_MANIFEST_PATH", "NEXA_DIALOG_TEST_FIXTURE_PATH"]);
  const result = Object.fromEntries(
    Object.entries(environment ?? {}).filter(([name]) => !blocked.has(name.toUpperCase())),
  );
  result.NEXA_APP_MANIFEST_PATH = manifestPath;
  if (dialogFixturePath) result.NEXA_DIALOG_TEST_FIXTURE_PATH = dialogFixturePath;
  return result;
}

export function runPerryCompile({
  args,
  cwd,
  manifestPath,
  dialogFixturePath,
  environment = process.env,
  forceRuntime = false,
  platform = process.platform,
  arch = process.arch,
  runner = defaultRunner,
  prepare = preparePerryRuntimeForCompile,
  stdio = "inherit",
} = {}) {
  if (!Array.isArray(args) || args.length === 0) throw new Error("Perry compile args are required");
  const projectDirectory = path.resolve(cwd);
  const resolvedManifestPath = path.resolve(manifestPath);
  const resolvedFixturePath = dialogFixturePath && path.resolve(dialogFixturePath);
  const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const perry = resolvePerryCompilerCommand({
    environment,
    fallbackCommand: pnpm,
    fallbackPrefixArgs: ["exec", "perry"],
    fallbackShell: platform === "win32",
    platform,
  });
  const prepared = prepare({
    projectDirectory,
    manifestPath: resolvedManifestPath,
    dialogFixturePath: resolvedFixturePath,
    environment: perry.environment,
    force: forceRuntime,
    runtime: { platform, arch },
  });
  try {
    const result = runner(perry.command, [...perry.prefixArgs, "compile", ...args], {
      cwd: projectDirectory,
      env: compileEnvironment(prepared.environment, resolvedManifestPath, resolvedFixturePath),
      shell: perry.shell,
      stdio,
    });
    assertSucceeded(result, "Perry compile");
    return result;
  } finally {
    prepared.cleanup();
  }
}

export function runPerryCompileCommand({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  environment = process.env,
  compile = runPerryCompile,
} = {}) {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const compileArgs = separator === -1 ? [] : argv.slice(separator + 1);
  if (options.length !== 2 || options[0] !== "--manifest" || compileArgs.length === 0) {
    throw new Error(
      "usage: perry-compile.mjs --manifest <app.manifest.json> -- <perry compile args>",
    );
  }
  compile({
    args: compileArgs,
    cwd,
    manifestPath: path.resolve(cwd, options[1]),
    environment,
    forceRuntime: true,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runPerryCompileCommand();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

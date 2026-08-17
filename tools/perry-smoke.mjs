import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PERRY_SMOKE_MARKER = "nexa-ui perry smoke ok";

const exampleDirectory = fileURLToPath(new URL("../examples/counter/", import.meta.url));

function writeChildOutput(result, stdout, stderr) {
  if (result.stdout) {
    stdout.write(result.stdout);
  }
  if (result.stderr) {
    stderr.write(result.stderr);
  }
}

function assertProcessSucceeded(result, stage) {
  if (result.error) {
    throw new Error(`Perry smoke ${stage} could not start: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`Perry smoke ${stage} failed with exit code ${result.status ?? "no status"}`);
  }
}

export function runPerrySmoke({
  platform = process.platform,
  spawn = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const binaryName = platform === "win32" ? "perry-smoke.exe" : "perry-smoke";
  const binaryPath = path.join(exampleDirectory, binaryName);
  const options = {
    cwd: exampleDirectory,
    encoding: "utf8",
  };
  const compileArgs = ["exec", "perry", "compile", "smoke.tsx", "-o", "perry-smoke", "--no-cache"];
  if (platform === "win32") {
    compileArgs.push("--windows-subsystem", "console");
  }

  const compilation = spawn(pnpm, compileArgs, options);
  writeChildOutput(compilation, stdout, stderr);
  assertProcessSucceeded(compilation, "compilation");

  const execution = spawn(binaryPath, [], {
    ...options,
    timeout: 30_000,
  });
  writeChildOutput(execution, stdout, stderr);
  assertProcessSucceeded(execution, "execution");

  if (!execution.stdout?.includes(PERRY_SMOKE_MARKER)) {
    throw new Error(`Perry smoke execution did not emit the success marker: ${PERRY_SMOKE_MARKER}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runPerrySmoke();
}

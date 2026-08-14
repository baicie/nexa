import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { environmentWithoutPerryCompilerOverride } from "../packages/cli/src/perry-command.mjs";
import { runPerryCompile } from "./perry-compile.mjs";

const exampleDirectory = fileURLToPath(new URL("../examples/reference-notes/", import.meta.url));
const manifestPath = path.join(exampleDirectory, "app.manifest.json");

export const CLIPBOARD_RUNTIME_SMOKE_VALUE = "Nexa UI Clipboard Promise: 你好, مرحبا, 😀";
export const CLIPBOARD_RUNTIME_SMOKE_MARKER = "nexa-ui reference notes clipboard runtime smoke ok";
export const CLIPBOARD_RUNTIME_SMOKE_FAILURE =
  "nexa-ui reference notes clipboard runtime smoke failed";
export const CLIPBOARD_RUNTIME_SMOKE_PROOF_PREFIX =
  "nexa-ui reference notes clipboard round-trip: ";

function assertRoundTripProof(output) {
  const proofLine = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith(CLIPBOARD_RUNTIME_SMOKE_PROOF_PREFIX));
  if (proofLine === undefined) {
    throw new Error("Notes Clipboard runtime smoke emitted no round-trip proof");
  }

  let actual;
  try {
    actual = JSON.parse(proofLine.slice(CLIPBOARD_RUNTIME_SMOKE_PROOF_PREFIX.length));
  } catch (error) {
    throw new Error("Notes Clipboard runtime smoke proof was not valid JSON", { cause: error });
  }

  const base = {
    written: CLIPBOARD_RUNTIME_SMOKE_VALUE,
    read: CLIPBOARD_RUNTIME_SMOKE_VALUE,
  };
  const accepted = [
    { ...base, restoreAttempted: true, restoreVerified: true },
    { ...base, restoreAttempted: false, restoreVerified: false },
  ];
  if (!accepted.some((expected) => isDeepStrictEqual(actual, expected))) {
    throw new Error("Notes Clipboard runtime smoke proof did not match");
  }
}

export function compileReferenceNotesClipboardRuntimeSmoke({
  platform = process.platform,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  existsImpl = existsSync,
} = {}) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Notes Clipboard runtime smoke currently supports only macOS and Windows");
  }
  const binaryName =
    platform === "win32"
      ? "reference-notes-clipboard-runtime-smoke.exe"
      : "reference-notes-clipboard-runtime-smoke";
  const binaryPath = path.join(exampleDirectory, binaryName);
  const args = ["clipboard-runtime-smoke.tsx", "-o", "reference-notes-clipboard-runtime-smoke"];
  if (platform === "win32") {
    args.push("--windows-subsystem", "console");
  }

  runPerryCompile({
    args,
    cwd: exampleDirectory,
    manifestPath,
    environment,
    forceRuntime: spawnSyncImpl === spawnSync,
    platform,
    runner: spawnSyncImpl,
  });
  if (!existsImpl(binaryPath)) {
    throw new Error(`Notes Clipboard runtime smoke compilation produced no binary: ${binaryPath}`);
  }
  return binaryPath;
}

export function runReferenceNotesClipboardRuntimeSmoke({
  platform = process.platform,
  environment = process.env,
  compile = true,
  binaryPath,
  binaryArgs = [],
  workingDirectory = exampleDirectory,
  timeoutMs = 30_000,
  spawnImpl = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const executable =
    binaryPath ??
    (compile ? compileReferenceNotesClipboardRuntimeSmoke({ platform, environment }) : undefined);
  if (!executable) {
    return Promise.reject(new Error("Notes Clipboard runtime smoke requires a binary path"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const child = spawnImpl(executable, binaryArgs, {
      cwd: workingDirectory,
      env: environmentWithoutPerryCompilerOverride(environment),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve();
    };

    const inspectOutput = () => {
      if (output.includes(CLIPBOARD_RUNTIME_SMOKE_FAILURE)) {
        finish(new Error(output.trim()));
        return;
      }
      if (!output.includes(CLIPBOARD_RUNTIME_SMOKE_MARKER)) return;

      try {
        assertRoundTripProof(output);
      } catch (error) {
        finish(error);
        return;
      }
      finish();
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      stdout.write(chunk);
      inspectOutput();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => stderr.write(chunk));
    child.once("error", (error) => {
      finish(
        new Error(`Notes Clipboard runtime smoke execution failed: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            `Notes Clipboard runtime smoke exited before success (code ${String(code)}, signal ${String(signal)})`,
          ),
        );
      }
    });

    const timer = setTimeout(() => {
      finish(new Error(`Notes Clipboard runtime smoke timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runReferenceNotesClipboardRuntimeSmoke();
}

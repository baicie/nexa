import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { environmentWithoutPerryCompilerOverride } from "../packages/cli/src/perry-command.mjs";
import { runPerryCompile } from "./perry-compile.mjs";

const exampleDirectory = fileURLToPath(new URL("../examples/reference-notes/", import.meta.url));
const manifestPath = path.join(exampleDirectory, "app.manifest.json");

export const FS_RUNTIME_SMOKE_FILE = "nexa-ui-fs-runtime-smoke.txt";
export const FS_RUNTIME_SMOKE_INVALID_FILE = "nexa-ui-fs-runtime-invalid.txt";
export const FS_RUNTIME_SMOKE_BODY = "Nexa UI UTF-8 smoke: 你好, مرحبا, 😀\n";
export const FS_RUNTIME_SMOKE_MARKER = "nexa-ui reference notes fs runtime smoke ok";
export const FS_RUNTIME_SMOKE_FAILURE = "nexa-ui reference notes fs runtime smoke failed";
export const FS_RUNTIME_SMOKE_STATE_PREFIX = "nexa-ui reference notes state: ";
export const FS_RUNTIME_SMOKE_INVALID_PREFIX = "nexa-ui reference notes invalid utf-8: ";

const expectedControllerState = Object.freeze({
  path: FS_RUNTIME_SMOKE_FILE,
  title: FS_RUNTIME_SMOKE_FILE,
  body: FS_RUNTIME_SMOKE_BODY,
  revision: 2,
  savedRevision: 2,
  dirty: false,
  status: "已保存",
  busy: false,
  operation: "idle",
  window: "active",
});

const expectedInvalidProof = Object.freeze({
  afterInvalidOpen: {
    ...expectedControllerState,
    status: `打开失败: INVALID_DATA: invalid utf-8 data: ${FS_RUNTIME_SMOKE_INVALID_FILE}`,
  },
  diagnostic: {
    code: 0x0200_000b,
    operation: "readTextFile",
    context: { format: "utf-8", identifier: FS_RUNTIME_SMOKE_INVALID_FILE },
  },
});

function assertControllerStateProof(output) {
  const proofLine = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith(FS_RUNTIME_SMOKE_STATE_PREFIX));
  if (proofLine === undefined) {
    throw new Error("Notes FS runtime smoke emitted no controller state proof");
  }

  let actual;
  try {
    actual = JSON.parse(proofLine.slice(FS_RUNTIME_SMOKE_STATE_PREFIX.length));
  } catch (error) {
    throw new Error("Notes FS runtime smoke controller state proof was not valid JSON", {
      cause: error,
    });
  }

  const expectedKeys = Object.keys(expectedControllerState).sort();
  const actualKeys =
    actual !== null && typeof actual === "object" && !Array.isArray(actual)
      ? Object.keys(actual).sort()
      : [];
  const matches =
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expectedControllerState[key]);
  if (!matches) {
    throw new Error(
      "Notes FS runtime smoke controller state proof did not match saved Notes state",
    );
  }
}

function assertInvalidDataProof(output) {
  const proofLine = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith(FS_RUNTIME_SMOKE_INVALID_PREFIX));
  if (proofLine === undefined) {
    throw new Error("Notes FS runtime smoke emitted no invalid UTF-8 Notes proof");
  }

  let actual;
  try {
    actual = JSON.parse(proofLine.slice(FS_RUNTIME_SMOKE_INVALID_PREFIX.length));
  } catch (error) {
    throw new Error("Notes FS runtime smoke invalid UTF-8 Notes proof was not valid JSON", {
      cause: error,
    });
  }
  if (!isDeepStrictEqual(actual, expectedInvalidProof)) {
    throw new Error("Notes FS runtime smoke invalid UTF-8 Notes proof did not match");
  }
}

export function compileReferenceNotesFsRuntimeSmoke({
  platform = process.platform,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  existsImpl = existsSync,
} = {}) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Notes FS runtime smoke currently supports only macOS and Windows");
  }
  const binaryName =
    platform === "win32"
      ? "reference-notes-fs-runtime-smoke.exe"
      : "reference-notes-fs-runtime-smoke";
  const binaryPath = path.join(exampleDirectory, binaryName);
  const args = ["fs-runtime-smoke.tsx", "-o", "reference-notes-fs-runtime-smoke"];
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
    throw new Error(`Notes FS runtime smoke compilation produced no binary: ${binaryPath}`);
  }
  return binaryPath;
}

export function runReferenceNotesFsRuntimeSmoke({
  platform = process.platform,
  environment = process.env,
  compile = true,
  binaryPath,
  binaryArgs = [],
  workingDirectory,
  timeoutMs = 30_000,
  spawnImpl = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const executable =
    binaryPath ??
    (compile ? compileReferenceNotesFsRuntimeSmoke({ platform, environment }) : undefined);
  if (!executable) {
    return Promise.reject(new Error("Notes FS runtime smoke requires a binary path"));
  }

  const ownsWorkingDirectory = workingDirectory === undefined;
  const cwd = workingDirectory ?? mkdtempSync(path.join(tmpdir(), "nexa-notes-fs-smoke-"));
  writeFileSync(
    path.join(cwd, FS_RUNTIME_SMOKE_INVALID_FILE),
    Uint8Array.from([0x66, 0x6f, 0x80]),
    { flag: "wx" },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let cleanupPending = ownsWorkingDirectory;
    const child = spawnImpl(executable, binaryArgs, {
      cwd,
      env: environmentWithoutPerryCompilerOverride(environment),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const cleanup = () => {
      if (!cleanupPending) return;
      cleanupPending = false;
      rmSync(cwd, { recursive: true, force: true });
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve();
    };

    const inspectOutput = () => {
      if (output.includes(FS_RUNTIME_SMOKE_FAILURE)) {
        finish(new Error(output.trim()));
        return;
      }
      if (!output.includes(FS_RUNTIME_SMOKE_MARKER)) return;

      try {
        assertControllerStateProof(output);
        assertInvalidDataProof(output);
      } catch (error) {
        finish(error);
        return;
      }

      const resultPath = path.join(cwd, FS_RUNTIME_SMOKE_FILE);
      let body;
      try {
        body = readFileSync(resultPath, "utf8");
      } catch (error) {
        finish(new Error(`Notes FS runtime smoke did not write ${resultPath}`, { cause: error }));
        return;
      }
      if (body !== FS_RUNTIME_SMOKE_BODY) {
        finish(new Error("Notes FS runtime smoke disk content did not match the UTF-8 fixture"));
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
    child.stderr?.on("data", (chunk) => {
      stderr.write(chunk);
    });
    child.once("error", (error) => {
      finish(
        new Error(`Notes FS runtime smoke execution failed: ${error.message}`, { cause: error }),
      );
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (!settled) {
        finish(
          new Error(
            `Notes FS runtime smoke exited before success (code ${String(code)}, signal ${String(signal)})`,
          ),
        );
      }
    });

    const timer = setTimeout(() => {
      finish(new Error(`Notes FS runtime smoke timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runReferenceNotesFsRuntimeSmoke();
}

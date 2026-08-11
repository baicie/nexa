import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const exampleDirectory = fileURLToPath(new URL("../examples/reference-notes/", import.meta.url));
const manifestPath = path.join(exampleDirectory, "app.manifest.json");
const dialogFixturePath = path.join(exampleDirectory, "dialog-runtime-smoke.fixture.json");

export const DIALOG_RUNTIME_OPEN_FILE = "nexa-ui-dialog-open.txt";
export const DIALOG_RUNTIME_OPEN_BODY = "Opened through native Dialog: 你好, مرحبا, 😀\n";
export const DIALOG_RUNTIME_SAVE_FILE = "nexa-ui-dialog-save.txt";
export const DIALOG_RUNTIME_SAVE_BODY = "Saved through native Dialog: 会议记录 📝\n";
export const DIALOG_RUNTIME_SMOKE_MARKER = "nexa-ui reference notes dialog runtime smoke ok";
export const DIALOG_RUNTIME_SMOKE_FAILURE = "nexa-ui reference notes dialog runtime smoke failed";
export const DIALOG_RUNTIME_SMOKE_STATE_PREFIX = "nexa-ui reference notes dialog journey: ";

const expectedProof = Object.freeze({
  afterSave: {
    path: DIALOG_RUNTIME_SAVE_FILE,
    title: DIALOG_RUNTIME_SAVE_FILE,
    body: DIALOG_RUNTIME_SAVE_BODY,
    revision: 2,
    savedRevision: 2,
    dirty: false,
    status: "已保存",
    busy: false,
    operation: "idle",
    window: "active",
  },
  afterOpen: {
    path: DIALOG_RUNTIME_OPEN_FILE,
    title: DIALOG_RUNTIME_OPEN_FILE,
    body: DIALOG_RUNTIME_OPEN_BODY,
    revision: 3,
    savedRevision: 3,
    dirty: false,
    status: "已保存",
    busy: false,
    operation: "idle",
    window: "active",
  },
  afterCancel: {
    path: DIALOG_RUNTIME_OPEN_FILE,
    title: DIALOG_RUNTIME_OPEN_FILE,
    body: DIALOG_RUNTIME_OPEN_BODY,
    revision: 3,
    savedRevision: 3,
    dirty: false,
    status: "已保存",
    busy: false,
    operation: "idle",
    window: "active",
  },
});

function assertSucceeded(result, stage) {
  if (result.error) {
    throw new Error(
      `Notes Dialog runtime smoke ${stage} could not start: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Notes Dialog runtime smoke ${stage} failed with exit code ${result.status ?? "no status"}`,
    );
  }
}

function assertJourneyProof(output) {
  const proofLine = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith(DIALOG_RUNTIME_SMOKE_STATE_PREFIX));
  if (proofLine === undefined) {
    throw new Error("Notes Dialog runtime smoke emitted no Notes journey proof");
  }

  let actual;
  try {
    actual = JSON.parse(proofLine.slice(DIALOG_RUNTIME_SMOKE_STATE_PREFIX.length));
  } catch (error) {
    throw new Error("Notes Dialog runtime smoke Notes journey proof was not valid JSON", {
      cause: error,
    });
  }
  if (!isDeepStrictEqual(actual, expectedProof)) {
    throw new Error("Notes Dialog runtime smoke Notes journey proof did not match");
  }
}

export function compileReferenceNotesDialogRuntimeSmoke({
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  existsImpl = existsSync,
} = {}) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Notes Dialog runtime smoke currently supports only macOS and Windows");
  }
  const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const binaryName =
    platform === "win32"
      ? "reference-notes-dialog-runtime-smoke.exe"
      : "reference-notes-dialog-runtime-smoke";
  const binaryPath = path.join(exampleDirectory, binaryName);
  const args = [
    "exec",
    "perry",
    "compile",
    "dialog-runtime-smoke.tsx",
    "-o",
    "reference-notes-dialog-runtime-smoke",
  ];
  if (platform === "win32") args.push("--windows-subsystem", "console");

  const result = spawnSyncImpl(pnpm, args, {
    cwd: exampleDirectory,
    env: {
      ...process.env,
      NEXA_APP_MANIFEST_PATH: manifestPath,
      NEXA_DIALOG_TEST_FIXTURE_PATH: dialogFixturePath,
    },
    stdio: "inherit",
    shell: platform === "win32",
  });
  assertSucceeded(result, "compilation");
  if (!existsImpl(binaryPath)) {
    throw new Error(`Notes Dialog runtime smoke compilation produced no binary: ${binaryPath}`);
  }
  return binaryPath;
}

export function runReferenceNotesDialogRuntimeSmoke({
  platform = process.platform,
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
    binaryPath ?? (compile ? compileReferenceNotesDialogRuntimeSmoke({ platform }) : undefined);
  if (!executable) {
    return Promise.reject(new Error("Notes Dialog runtime smoke requires a binary path"));
  }

  const ownsWorkingDirectory = workingDirectory === undefined;
  const cwd = workingDirectory ?? mkdtempSync(path.join(tmpdir(), "nexa-notes-dialog-smoke-"));
  writeFileSync(path.join(cwd, DIALOG_RUNTIME_OPEN_FILE), DIALOG_RUNTIME_OPEN_BODY);

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let cleanupPending = ownsWorkingDirectory;
    const child = spawnImpl(executable, binaryArgs, {
      cwd,
      env: process.env,
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
      if (output.includes(DIALOG_RUNTIME_SMOKE_FAILURE)) {
        finish(new Error(output.trim()));
        return;
      }
      if (!output.includes(DIALOG_RUNTIME_SMOKE_MARKER)) return;

      try {
        assertJourneyProof(output);
        const saved = readFileSync(path.join(cwd, DIALOG_RUNTIME_SAVE_FILE), "utf8");
        if (saved !== DIALOG_RUNTIME_SAVE_BODY) {
          throw new Error("Notes Dialog runtime smoke saved disk content did not match");
        }
        const opened = readFileSync(path.join(cwd, DIALOG_RUNTIME_OPEN_FILE), "utf8");
        if (opened !== DIALOG_RUNTIME_OPEN_BODY) {
          throw new Error("Notes Dialog runtime smoke changed the opened fixture unexpectedly");
        }
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
        new Error(`Notes Dialog runtime smoke execution failed: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (!settled) {
        finish(
          new Error(
            `Notes Dialog runtime smoke exited before success (code ${String(code)}, signal ${String(signal)})`,
          ),
        );
      }
    });

    const timer = setTimeout(() => {
      finish(new Error(`Notes Dialog runtime smoke timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runReferenceNotesDialogRuntimeSmoke();
}

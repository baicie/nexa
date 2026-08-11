import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const exampleDirectory = fileURLToPath(new URL("../examples/reference-notes/", import.meta.url));
const manifestPath = path.join(exampleDirectory, "app.manifest.json");
const macOSDriverPath = fileURLToPath(
  new URL("./dialog-picker-driver-macos.applescript", import.meta.url),
);
const windowsDriverPath = fileURLToPath(
  new URL("./dialog-picker-driver-windows.ps1", import.meta.url),
);
const windowsSupervisorPath = fileURLToPath(
  new URL("./dialog-picker-probe-supervisor-windows.ps1", import.meta.url),
);
const dialogFixtureEnvironment = "NEXA_DIALOG_TEST_FIXTURE_PATH";
const manifestEnvironment = "NEXA_APP_MANIFEST_PATH";
const deterministicFixtureMarkers = ["nexa-ui-dialog-open.txt", "nexa-ui-dialog-save.txt"];

export const DIALOG_PICKER_OPEN_FILE = "nexa-ui-picker-probe-open.txt";
export const DIALOG_PICKER_OPEN_BODY = "Opened through real OS picker: 你好, مرحبا, 😀\n";
export const DIALOG_PICKER_SAVE_FILE = "nexa-ui-picker-probe-save.txt";
export const DIALOG_PICKER_SAVE_BODY = "Saved through real OS picker: 会议记录 📝\n";
export const DIALOG_PICKER_SAVE_TITLE = "Nexa UI Picker Probe - Save";
export const DIALOG_PICKER_OPEN_TITLE = "Nexa UI Picker Probe - Open";
export const DIALOG_PICKER_CANCEL_TITLE = "Nexa UI Picker Probe - Cancel";
export const DIALOG_PICKER_SMOKE_MARKER = "nexa-ui reference notes real dialog picker smoke ok";
export const DIALOG_PICKER_SMOKE_FAILURE =
  "nexa-ui reference notes real dialog picker smoke failed";
export const DIALOG_PICKER_SMOKE_STATE_PREFIX =
  "nexa-ui reference notes real dialog picker journey: ";
export const DIALOG_PICKER_STAGE_PREFIX = "nexa-ui reference notes picker stage: ";
export const DIALOG_PICKER_PROCESS_PREFIX =
  "nexa-ui reference notes picker probe process id: ";

const stages = Object.freeze([
  Object.freeze({ step: "save", title: DIALOG_PICKER_SAVE_TITLE }),
  Object.freeze({ step: "open", title: DIALOG_PICKER_OPEN_TITLE }),
  Object.freeze({ step: "cancel", title: DIALOG_PICKER_CANCEL_TITLE }),
]);

function assertSupportedPlatform(platform) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Notes real Dialog picker smoke supports only macOS and Windows");
  }
}

function omitEnvironmentKeyCaseInsensitive(environment, forbiddenNames) {
  const forbidden = new Set(forbiddenNames.map((name) => name.toUpperCase()));
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !forbidden.has(name.toUpperCase())),
  );
}

function fixtureFreeEnvironment(environment, { injectManifest = false } = {}) {
  const clean = omitEnvironmentKeyCaseInsensitive(environment, [
    dialogFixtureEnvironment,
    ...(injectManifest ? [manifestEnvironment] : []),
  ]);
  if (injectManifest) clean[manifestEnvironment] = manifestPath;
  return clean;
}

function assertSucceeded(result, stage) {
  if (result.error) {
    throw new Error(
      `Notes real Dialog picker smoke ${stage} could not start: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Notes real Dialog picker smoke ${stage} failed with exit code ${result.status ?? "no status"}`,
    );
  }
}

function expectedProof(workingDirectory) {
  const afterSave = {
    path: path.join(workingDirectory, DIALOG_PICKER_SAVE_FILE),
    title: DIALOG_PICKER_SAVE_FILE,
    body: DIALOG_PICKER_SAVE_BODY,
    revision: 2,
    savedRevision: 2,
    dirty: false,
    status: "已保存",
    busy: false,
    operation: "idle",
    window: "active",
  };
  const afterOpen = {
    path: path.join(workingDirectory, DIALOG_PICKER_OPEN_FILE),
    title: DIALOG_PICKER_OPEN_FILE,
    body: DIALOG_PICKER_OPEN_BODY,
    revision: 3,
    savedRevision: 3,
    dirty: false,
    status: "已保存",
    busy: false,
    operation: "idle",
    window: "active",
  };
  return { version: 1, afterSave, afterOpen, afterCancel: afterOpen };
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function normalizeProofPaths(actual, expected, platform) {
  if (actual === null || typeof actual !== "object") return actual;
  const normalized = structuredClone(actual);
  for (const key of ["afterSave", "afterOpen", "afterCancel"]) {
    const actualPath = normalized[key]?.path;
    const expectedPath = expected[key].path;
    if (typeof actualPath !== "string" || !path.isAbsolute(actualPath)) continue;
    let actualCanonical;
    let expectedCanonical;
    try {
      actualCanonical = canonicalPath(actualPath);
      expectedCanonical = canonicalPath(expectedPath);
    } catch {
      continue;
    }
    if (platform === "win32") {
      actualCanonical = actualCanonical.toLowerCase();
      expectedCanonical = expectedCanonical.toLowerCase();
    }
    if (actualCanonical === expectedCanonical) normalized[key].path = expectedPath;
  }
  return normalized;
}

function assertJourneyProof(output, workingDirectory, platform) {
  const proofLines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(DIALOG_PICKER_SMOKE_STATE_PREFIX));
  if (proofLines.length !== 1) {
    throw new Error(
      `Notes real Dialog picker smoke expected one Notes journey proof, received ${proofLines.length}`,
    );
  }

  let actual;
  try {
    actual = JSON.parse(proofLines[0].slice(DIALOG_PICKER_SMOKE_STATE_PREFIX.length));
  } catch (error) {
    throw new Error("Notes real Dialog picker smoke Notes journey proof was not valid JSON", {
      cause: error,
    });
  }
  const expected = expectedProof(workingDirectory);
  const normalized = normalizeProofPaths(actual, expected, platform);
  if (!isDeepStrictEqual(normalized, expected)) {
    throw new Error("Notes real Dialog picker smoke Notes journey proof did not match");
  }
}

export function compileReferenceNotesDialogPickerSmoke({
  platform = process.platform,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  existsImpl = existsSync,
  readBinaryImpl = readFileSync,
  stdout = process.stdout,
} = {}) {
  assertSupportedPlatform(platform);
  const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const binaryName =
    platform === "win32"
      ? "reference-notes-dialog-picker-smoke.exe"
      : "reference-notes-dialog-picker-smoke";
  const binaryPath = path.join(exampleDirectory, binaryName);
  const args = [
    "exec",
    "perry",
    "compile",
    "dialog-picker-smoke.tsx",
    "-o",
    "reference-notes-dialog-picker-smoke",
  ];
  if (platform === "win32") args.push("--windows-subsystem", "console");

  const result = spawnSyncImpl(pnpm, args, {
    cwd: exampleDirectory,
    env: fixtureFreeEnvironment(environment, { injectManifest: true }),
    stdio: "inherit",
  });
  assertSucceeded(result, "compilation");
  if (!existsImpl(binaryPath)) {
    throw new Error(`Notes real Dialog picker compilation produced no binary: ${binaryPath}`);
  }

  const binary = readBinaryImpl(binaryPath);
  for (const marker of deterministicFixtureMarkers) {
    if (binary.includes(Buffer.from(marker))) {
      throw new Error(
        `Notes real Dialog picker binary contains Dialog test fixture marker ${marker}`,
      );
    }
  }
  stdout.write(
    `nexa-ui reference notes real dialog picker probe sha256: ${createHash("sha256").update(binary).digest("hex")}\n`,
  );
  return binaryPath;
}

export function driveHostedDialog({
  platform = process.platform,
  processId,
  step,
  title,
  selectionPath,
  timeoutMs = 15_000,
  spawnSyncImpl = spawnSync,
} = {}) {
  assertSupportedPlatform(platform);
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("Notes real Dialog picker driver requires a positive process id");
  }
  if (!stages.some((stage) => stage.step === step && stage.title === title)) {
    throw new Error(`Notes real Dialog picker driver received an invalid stage: ${String(step)}`);
  }

  const action = step === "cancel" ? "cancel" : "accept";
  if (action === "accept" && (!selectionPath || selectionPath.includes("\0"))) {
    throw new Error("Notes real Dialog picker accept action requires a selection path");
  }
  let command;
  let args;
  if (platform === "darwin") {
    command = "osascript";
    args = [macOSDriverPath, String(processId), action, title, String(timeoutMs)];
    if (selectionPath !== undefined) args.push(selectionPath);
  } else {
    command = "pwsh";
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windowsDriverPath,
      "-ProcessId",
      String(processId),
      "-Action",
      action,
      "-Title",
      title,
      "-TimeoutMilliseconds",
      String(timeoutMs),
    ];
    if (selectionPath !== undefined) args.push("-SelectionPath", selectionPath);
  }

  const result = spawnSyncImpl(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs + 1_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `Notes real Dialog picker ${platform} driver could not start: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    throw new Error(
      `Notes real Dialog picker ${platform} driver failed with exit code ${result.status ?? "no status"}${detail ? `: ${detail}` : ""}`,
    );
  }
}

export function forceTerminateHostedChild(
  child,
  {
    platform = process.platform,
    signal = "SIGKILL",
    timeoutMs = 5_000,
    spawnSyncImpl = spawnSync,
    killProcessImpl = process.kill,
  } = {},
) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    throw new Error("Notes real Dialog picker hard shutdown requires a positive process id");
  }

  if (platform !== "win32") {
    try {
      killProcessImpl(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw new Error(
        `Notes real Dialog picker could not force-stop process group ${child.pid}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const result = spawnSyncImpl("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `Notes real Dialog picker could not force-stop Windows process tree ${child.pid}: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    throw new Error(
      `Notes real Dialog picker could not force-stop Windows process tree ${child.pid} (exit ${result.status ?? "no status"})${detail ? `: ${detail}` : ""}`,
    );
  }
}

export function runReferenceNotesDialogPickerSmoke({
  platform = process.platform,
  compile = true,
  binaryPath,
  binaryArgs = [],
  workingDirectory,
  environment = process.env,
  timeoutMs = 45_000,
  driverTimeoutMs = 15_000,
  shutdownTimeoutMs = 5_000,
  terminationConfirmationTimeoutMs = 5_000,
  hostPlatform = process.platform,
  spawnImpl = spawn,
  terminateChild = (child, signal) =>
    forceTerminateHostedChild(child, {
      platform: hostPlatform,
      signal,
      timeoutMs: shutdownTimeoutMs,
    }),
  forceTerminateChild = (child, signal) =>
    forceTerminateHostedChild(child, {
      platform: hostPlatform,
      signal,
      timeoutMs: shutdownTimeoutMs,
    }),
  driveDialog = driveHostedDialog,
  stdout = process.stdout,
  stderr = process.stderr,
  createTemporaryDirectory = () => mkdtempSync(path.join(tmpdir(), "nexa-notes-dialog-picker-")),
  removeTemporaryDirectory = rmSync,
} = {}) {
  assertSupportedPlatform(platform);
  const executableInput =
    binaryPath ??
    (compile ? compileReferenceNotesDialogPickerSmoke({ platform, environment }) : undefined);
  if (!executableInput) {
    return Promise.reject(new Error("Notes real Dialog picker smoke requires a binary path"));
  }
  const executable = path.resolve(executableInput);

  const ownsWorkingDirectory = workingDirectory === undefined;
  const message = (error) => (error instanceof Error ? error.message : String(error));
  const combineErrors = (primary, secondary) =>
    new AggregateError([primary, secondary], `${message(primary)}; ${message(secondary)}`);
  let cwd;
  let openPath;
  let savePath;
  try {
    cwd = path.resolve(workingDirectory ?? createTemporaryDirectory());
    openPath = path.join(cwd, DIALOG_PICKER_OPEN_FILE);
    savePath = path.join(cwd, DIALOG_PICKER_SAVE_FILE);
    writeFileSync(openPath, DIALOG_PICKER_OPEN_BODY);
    rmSync(savePath, { force: true });
  } catch (setupError) {
    let finalError = setupError;
    if (ownsWorkingDirectory && cwd !== undefined) {
      try {
        removeTemporaryDirectory(cwd, { recursive: true, force: true });
      } catch (cleanupError) {
        finalError = combineErrors(finalError, cleanupError);
      }
    }
    return Promise.reject(finalError);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let finishRequested = false;
    let requestedError;
    let closeObserved = false;
    let output = "";
    let errorOutput = "";
    let lineBuffer = "";
    let successPending = false;
    let timer;
    let shutdownTimer;
    let terminationConfirmationTimer;
    let child;
    let cleanupSuppressed = false;
    let probeProcessId;
    const receivedStages = [];
    let driverChain = Promise.resolve();
    const deadline = Date.now() + timeoutMs;

    const cleanup = () => {
      if (!ownsWorkingDirectory) return;
      removeTemporaryDirectory(cwd, { recursive: true, force: true });
    };

    const appendError = (error) => {
      requestedError = requestedError ? combineErrors(requestedError, error) : error;
    };

    const settleAfterClose = () => {
      if (settled || !closeObserved || !finishRequested) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(shutdownTimer);
      clearTimeout(terminationConfirmationTimer);
      let finalError = requestedError;
      if (!cleanupSuppressed) {
        try {
          cleanup();
        } catch (cleanupError) {
          finalError = finalError
            ? combineErrors(finalError, cleanupError)
            : new Error(`Notes real Dialog picker smoke cleanup failed: ${message(cleanupError)}`, {
                cause: cleanupError,
              });
        }
      }
      if (finalError) reject(finalError);
      else resolve();
    };

    const settleWithoutTerminationConfirmation = () => {
      if (settled || closeObserved || !finishRequested) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(shutdownTimer);
      clearTimeout(terminationConfirmationTimer);
      cleanupSuppressed = true;
      appendError(
        new Error(
          `Notes real Dialog picker smoke termination was not confirmed within ${terminationConfirmationTimeoutMs} ms after forced shutdown${ownsWorkingDirectory ? `; owned working directory retained at ${cwd}` : ""}`,
        ),
      );
      for (const [resource, detach] of [
        ["stdout", () => child?.stdout?.destroy()],
        ["stderr", () => child?.stderr?.destroy()],
        ["child handle", () => child?.unref?.()],
      ]) {
        try {
          detach();
        } catch (detachError) {
          appendError(
            new Error(
              `Notes real Dialog picker smoke could not detach ${resource} after unconfirmed shutdown: ${message(detachError)}`,
              { cause: detachError },
            ),
          );
        }
      }
      reject(requestedError);
    };

    const finish = (error) => {
      if (finishRequested) return;
      finishRequested = true;
      requestedError = error;
      clearTimeout(timer);
      if (closeObserved) {
        settleAfterClose();
        return;
      }
      try {
        if (child) {
          terminateChild(child, "SIGTERM");
        }
      } catch (killError) {
        appendError(
          new Error(`Notes real Dialog picker smoke could not stop: ${message(killError)}`, {
            cause: killError,
          }),
        );
      }
      if (closeObserved || settled) return;
      shutdownTimer = setTimeout(() => {
        appendError(
          new Error(
            `Notes real Dialog picker smoke child did not close within ${shutdownTimeoutMs} ms; forcing termination`,
          ),
        );
        try {
          forceTerminateChild(child, "SIGKILL");
        } catch (forceError) {
          appendError(
            new Error(
              `Notes real Dialog picker smoke hard shutdown failed: ${message(forceError)}`,
              { cause: forceError },
            ),
          );
        }
        if (closeObserved || settled) return;
        terminationConfirmationTimer = setTimeout(
          settleWithoutTerminationConfirmation,
          terminationConfirmationTimeoutMs,
        );
      }, shutdownTimeoutMs);
    };

    try {
      const useWindowsSupervisor = hostPlatform === "win32";
      const spawnCommand = useWindowsSupervisor ? "pwsh" : executable;
      const spawnArguments = useWindowsSupervisor
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            windowsSupervisorPath,
            "-Executable",
            executable,
            "-WorkingDirectory",
            cwd,
            "-ArgumentsBase64",
            Buffer.from(JSON.stringify(binaryArgs), "utf8").toString("base64"),
          ]
        : binaryArgs;
      child = spawnImpl(spawnCommand, spawnArguments, {
        cwd,
        detached: hostPlatform !== "win32",
        env: fixtureFreeEnvironment(environment),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: useWindowsSupervisor,
      });
    } catch (error) {
      closeObserved = true;
      clearTimeout(shutdownTimer);
      clearTimeout(terminationConfirmationTimer);
      finish(
        new Error(`Notes real Dialog picker smoke execution failed: ${message(error)}`, {
          cause: error,
        }),
      );
      return;
    }

    const verifySuccess = async () => {
      try {
        await driverChain;
        if (
          !isDeepStrictEqual(
            receivedStages,
            stages.map(({ step }) => step),
          )
        ) {
          throw new Error(
            `Notes real Dialog picker smoke stage sequence did not match: ${receivedStages.join(",")}`,
          );
        }
        assertJourneyProof(output, cwd, platform);
        if (readFileSync(savePath, "utf8") !== DIALOG_PICKER_SAVE_BODY) {
          throw new Error("Notes real Dialog picker smoke saved disk content did not match");
        }
        if (readFileSync(openPath, "utf8") !== DIALOG_PICKER_OPEN_BODY) {
          throw new Error("Notes real Dialog picker smoke changed the opened file unexpectedly");
        }
        finish();
      } catch (error) {
        finish(error);
      }
    };

    const inspectOutput = () => {
      if (finishRequested) return;
      if (output.includes(DIALOG_PICKER_SMOKE_FAILURE)) {
        finish(new Error(output.trim()));
        return;
      }
      if (successPending || !output.includes(DIALOG_PICKER_SMOKE_MARKER)) return;
      successPending = true;
      void verifySuccess();
    };

    const handleLine = (line) => {
      if (finishRequested) return;
      if (line.startsWith(DIALOG_PICKER_PROCESS_PREFIX)) {
        if (hostPlatform !== "win32" || probeProcessId !== undefined) {
          finish(new Error("Notes real Dialog picker smoke received an unexpected probe process id"));
          return;
        }
        const parsedProcessId = Number(line.slice(DIALOG_PICKER_PROCESS_PREFIX.length));
        if (!Number.isSafeInteger(parsedProcessId) || parsedProcessId <= 0) {
          finish(new Error("Notes real Dialog picker smoke received an invalid probe process id"));
          return;
        }
        probeProcessId = parsedProcessId;
        return;
      }
      if (!line.startsWith(DIALOG_PICKER_STAGE_PREFIX)) return;
      if (hostPlatform === "win32" && probeProcessId === undefined) {
        finish(
          new Error(
            "Notes real Dialog picker smoke received a stage before the Windows supervisor process id",
          ),
        );
        return;
      }
      const step = line.slice(DIALOG_PICKER_STAGE_PREFIX.length);
      const expected = stages[receivedStages.length];
      if (expected === undefined || step !== expected.step) {
        finish(
          new Error(
            `Notes real Dialog picker smoke stage sequence did not match at ${String(step)}`,
          ),
        );
        return;
      }
      receivedStages.push(step);
      const selectionPath = step === "save" ? savePath : step === "open" ? openPath : undefined;
      driverChain = driverChain.then(() => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`Notes real Dialog picker smoke timed out after ${timeoutMs} ms`);
        }
        return driveDialog({
          platform,
          processId: probeProcessId ?? child.pid,
          step,
          title: expected.title,
          selectionPath,
          timeoutMs: Math.min(driverTimeoutMs, remainingMs),
        });
      });
      driverChain.catch((error) => finish(error));
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      stdout.write(chunk);
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/u);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
      inspectOutput();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      errorOutput += chunk;
      stderr.write(chunk);
    });
    child.once("error", (error) => {
      finish(
        new Error(`Notes real Dialog picker smoke execution failed: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      closeObserved = true;
      clearTimeout(shutdownTimer);
      clearTimeout(terminationConfirmationTimer);
      if (!finishRequested) {
        const detail = errorOutput.trim();
        finishRequested = true;
        requestedError = new Error(
          `Notes real Dialog picker smoke exited before success (code ${String(code)}, signal ${String(signal)})${detail ? `: ${detail}` : ""}`,
        );
        clearTimeout(timer);
      }
      if (hostPlatform !== "win32") {
        try {
          forceTerminateChild(child, "SIGKILL");
        } catch (forceError) {
          cleanupSuppressed = true;
          appendError(
            new Error(
              `Notes real Dialog picker smoke could not confirm process-tree shutdown after child close: ${message(forceError)}`,
              { cause: forceError },
            ),
          );
          if (ownsWorkingDirectory) {
            appendError(
              new Error(
                `Notes real Dialog picker smoke owned working directory retained at ${cwd}`,
              ),
            );
          }
        }
      }
      settleAfterClose();
    });

    timer = setTimeout(() => {
      finish(new Error(`Notes real Dialog picker smoke timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runReferenceNotesDialogPickerSmoke();
}

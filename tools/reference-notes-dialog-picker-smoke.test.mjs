import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  DIALOG_PICKER_CANCEL_TITLE,
  DIALOG_PICKER_OPEN_BODY,
  DIALOG_PICKER_OPEN_FILE,
  DIALOG_PICKER_OPEN_TITLE,
  DIALOG_PICKER_PROCESS_PREFIX,
  DIALOG_PICKER_SAVE_BODY,
  DIALOG_PICKER_SAVE_FILE,
  DIALOG_PICKER_SAVE_TITLE,
  DIALOG_PICKER_SMOKE_MARKER,
  DIALOG_PICKER_SMOKE_STATE_PREFIX,
  DIALOG_PICKER_STAGE_PREFIX,
  compileReferenceNotesDialogPickerSmoke,
  driveHostedDialog,
  forceTerminateHostedChild,
  runReferenceNotesDialogPickerSmoke,
} from "./reference-notes-dialog-picker-smoke.mjs";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-dialog-picker-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function silentWriter() {
  return { write() {} };
}

const perryOverrideEnvironment = "NEXA_PERRY_BIN";

function inertChild({ killResult = false } = {}) {
  const child = new EventEmitter();
  child.pid = 42;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return killResult;
  };
  child.unref = () => {};
  return child;
}

function expectedProof(directory) {
  const afterSave = {
    path: path.join(directory, DIALOG_PICKER_SAVE_FILE),
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
    path: path.join(directory, DIALOG_PICKER_OPEN_FILE),
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

function writeJourneyScript(directory, proof = expectedProof(directory)) {
  const script = path.join(directory, "journey.mjs");
  writeFileSync(
    script,
    [
      `console.log(${JSON.stringify(`${DIALOG_PICKER_STAGE_PREFIX}save`)});`,
      `console.log(${JSON.stringify(`${DIALOG_PICKER_STAGE_PREFIX}open`)});`,
      `console.log(${JSON.stringify(`${DIALOG_PICKER_STAGE_PREFIX}cancel`)});`,
      `console.log(${JSON.stringify(`${DIALOG_PICKER_SMOKE_STATE_PREFIX}${JSON.stringify(proof)}`)});`,
      `console.log(${JSON.stringify(DIALOG_PICKER_SMOKE_MARKER)});`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  return script;
}

test("compiles a fixture-free picker probe with only the trusted manifest injected", () => {
  const calls = [];
  let output = "";
  const environment = {
    PATH: process.env.PATH,
    NEXA_DIALOG_TEST_FIXTURE_PATH: "/tmp/canonical.json",
    nexa_dialog_test_fixture_path: "/tmp/lower.json",
    NeXa_DiAlOg_TeSt_FiXtUrE_PaTh: "/tmp/mixed.json",
  };

  const binary = compileReferenceNotesDialogPickerSmoke({
    platform: "win32",
    environment,
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    existsImpl: () => true,
    readBinaryImpl: () => Buffer.from("fixture-free-picker-binary"),
    stdout: {
      write(chunk) {
        output += chunk;
      },
    },
  });

  assert.match(binary, /reference-notes-dialog-picker-smoke\.exe$/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pnpm.cmd");
  assert.deepEqual(calls[0].args, [
    "exec",
    "perry",
    "compile",
    "dialog-picker-smoke.tsx",
    "-o",
    "reference-notes-dialog-picker-smoke",
    "--windows-subsystem",
    "console",
  ]);
  assert.match(calls[0].options.env.NEXA_APP_MANIFEST_PATH, /app\.manifest\.json$/u);
  assert.equal(
    Object.keys(calls[0].options.env).some(
      (name) => name.toUpperCase() === "NEXA_DIALOG_TEST_FIXTURE_PATH",
    ),
    false,
  );
  assert.match(
    output,
    new RegExp(createHash("sha256").update("fixture-free-picker-binary").digest("hex"), "u"),
  );
});

test("compiles the picker probe with a native Perry override and sanitized environment", (t) => {
  const directory = fixture(t);
  const compiler = path.join(directory, "perry.exe");
  writeFileSync(compiler, "native Perry fixture\n");
  const canonicalCompiler = realpathSync(compiler);
  const calls = [];

  compileReferenceNotesDialogPickerSmoke({
    platform: "win32",
    environment: {
      PATH: process.env.PATH,
      [perryOverrideEnvironment]: compiler,
      NEXA_DIALOG_TEST_FIXTURE_PATH: "/tmp/must-not-leak.json",
    },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    existsImpl: () => true,
    readBinaryImpl: () => Buffer.from("fixture-free-picker-binary"),
    stdout: silentWriter(),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, canonicalCompiler);
  assert.deepEqual(calls[0].args, [
    "compile",
    "dialog-picker-smoke.tsx",
    "-o",
    "reference-notes-dialog-picker-smoke",
    "--windows-subsystem",
    "console",
  ]);
  assert.equal(calls[0].options.shell, false);
  for (const blocked of [perryOverrideEnvironment, "NEXA_DIALOG_TEST_FIXTURE_PATH"]) {
    assert.equal(
      Object.keys(calls[0].options.env).some((name) => name.toUpperCase() === blocked),
      false,
    );
  }
});

test("rejects a compiled picker probe containing deterministic fixture canaries", () => {
  assert.throws(
    () =>
      compileReferenceNotesDialogPickerSmoke({
        platform: "darwin",
        spawnSyncImpl: () => ({ status: 0 }),
        existsImpl: () => true,
        readBinaryImpl: () => Buffer.from("prefix nexa-ui-dialog-open.txt suffix"),
      }),
    /contains Dialog test fixture marker/u,
  );
});

test("rejects unsupported picker platforms before invoking Perry", () => {
  assert.throws(
    () =>
      compileReferenceNotesDialogPickerSmoke({
        platform: "linux",
        spawnSyncImpl() {
          throw new Error("must not spawn");
        },
      }),
    /only macOS and Windows/u,
  );
});

test("dispatches hosted dialog actions to fail-closed macOS and Windows drivers", () => {
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "driver ok\n", stderr: "" };
  };

  driveHostedDialog({
    platform: "darwin",
    processId: 41,
    step: "save",
    title: DIALOG_PICKER_SAVE_TITLE,
    selectionPath: "/tmp/nexa-picker-save.txt",
    timeoutMs: 7_000,
    spawnSyncImpl,
  });
  driveHostedDialog({
    platform: "win32",
    processId: 42,
    step: "cancel",
    title: DIALOG_PICKER_CANCEL_TITLE,
    timeoutMs: 8_000,
    spawnSyncImpl,
  });

  assert.equal(calls[0].command, "osascript");
  assert.match(calls[0].args[0], /dialog-picker-driver-macos\.applescript$/u);
  assert.deepEqual(calls[0].args.slice(1), [
    "41",
    "accept",
    DIALOG_PICKER_SAVE_TITLE,
    "7000",
    "/tmp/nexa-picker-save.txt",
  ]);
  assert.equal(calls[0].options.timeout, 8_000);
  assert.equal(calls[1].command, "pwsh");
  assert.ok(calls[1].args.includes("-NonInteractive"));
  assert.ok(calls[1].args.includes("cancel"));
  assert.ok(calls[1].args.includes(DIALOG_PICKER_CANCEL_TITLE));
  assert.match(
    calls[1].args.find((argument) => argument.endsWith(".ps1")),
    /dialog-picker-driver-windows\.ps1$/u,
  );
  assert.equal(calls[1].options.timeout, 9_000);
  assert.equal(calls[1].options.windowsHide, true);
});

test("dispatches macOS open as an explicit file-selection stage", () => {
  const calls = [];

  driveHostedDialog({
    platform: "darwin",
    processId: 43,
    step: "open",
    title: DIALOG_PICKER_OPEN_TITLE,
    selectionPath: "/tmp/nexa-picker-open.txt",
    timeoutMs: 7_000,
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "driver ok\n", stderr: "" };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "osascript");
  assert.deepEqual(calls[0].args.slice(1), [
    "43",
    "open",
    DIALOG_PICKER_OPEN_TITLE,
    "7000",
    "/tmp/nexa-picker-open.txt",
  ]);
});

test("the macOS driver navigates to the parent before selecting an open filename", () => {
  const source = readFileSync(
    new URL("./dialog-picker-driver-macos.applescript", import.meta.url),
    "utf8",
  );

  assert.match(source, /if actionName is "open" then/u);
  assert.match(source, /on parentPathFor\(inputPath\)/u);
  assert.match(source, /on baseNameFor\(inputPath\)/u);
  assert.match(source, /set navigationTarget to my parentPathFor\(selectionPath\)/u);
  assert.match(source, /set selectionName to my baseNameFor\(selectionPath\)/u);
  assert.match(source, /set selectedBaseName to \(item -1 of components\) as text/u);
  assert.match(source, /on ensureRegularFile\(inputPath\)/u);
  assert.match(source, /if not \(exists disk item inputPath\) then error/u);
  assert.doesNotMatch(source, /disk item fileItem/u);
  assert.match(source, /keystroke navigationTarget/u);
  assert.match(source, /keystroke \(selectionName as text\)/u);
  assert.ok(
    source.indexOf("keystroke navigationTarget") <
      source.indexOf("keystroke (selectionName as text)"),
  );
  assert.match(source, /on focusOwner\(targetPid, timeoutSeconds\)/u);
  assert.match(source, /with timeout of timeoutSeconds seconds/u);
  assert.match(source, /keystroke "a" using \{command down\}/u);
  assert.match(source, /first application process whose unix id is targetPid/u);
  assert.match(source, /set frontmost of targetProcess to true/u);
  assert.match(source, /if not \(exists front window of targetProcess\) then error/u);
  assert.match(source, /front window of targetProcess/u);
  assert.doesNotMatch(source, /frontWindowTitle/u);
  assert.doesNotMatch(source, /front window title did not match/u);
  assert.ok((source.match(/my focusOwner\(targetPid, timeoutSeconds\)/gu) ?? []).length >= 3);
  assert.doesNotMatch(source, /entire contents/u);
  assert.doesNotMatch(source, /windows of targetProcess/u);
  assert.doesNotMatch(source, /sheets of /u);
});

test("the Windows driver budget covers Add-Type startup, discovery, and close", () => {
  const source = readFileSync(
    new URL("./dialog-picker-driver-windows.ps1", import.meta.url),
    "utf8",
  );

  assert.ok(
    source.indexOf("$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()") <
      source.indexOf("Add-Type -TypeDefinition"),
  );
  assert.match(
    source,
    /\$remainingMilliseconds = \$TimeoutMilliseconds - \$stopwatch\.ElapsedMilliseconds/u,
  );
  assert.match(source, /\$closeDeadline = \[Math\]::Min\(\$remainingMilliseconds, 5000\)/u);
  assert.match(source, /GetForegroundWindow\(\)/u);
  assert.match(source, /Add-Type -AssemblyName UIAutomationClient/u);
  assert.match(source, /Add-Type -AssemblyName UIAutomationTypes/u);
  assert.match(source, /Find-FileNameControl \$dialog/u);
  assert.match(source, /@\("ComboBoxEx32", "ComboBox", "Edit"\)/u);
  assert.match(source, /AutomationElement\]::FromHandle\(\$Dialog\)/u);
  assert.match(source, /@\("1148", "1001"\)/u);
  assert.match(source, /ValuePattern\]::Pattern/u);
  assert.match(source, /\.SetValue\(\$SelectionPath\)/u);
  assert.match(source, /InvokePattern\]::Pattern/u);
  assert.match(source, /\.Invoke\(\)/u);
  assert.match(source, /Find-DialogControl \$dialog [12] "Button"/u);
  assert.match(source, /did not retain the requested selection path/u);
  assert.match(source, /file-name control did not accept WM_SETTEXT within the timeout/u);
  assert.match(source, /file-name control did not answer WM_GETTEXT within the timeout/u);
  assert.match(source, /0x000D/u);
  assert.match(source, /StringBuilder parameter/u);
  assert.doesNotMatch(source, /Get-WindowText \$fileNameControl/u);
  assert.doesNotMatch(source, /\n\s+1000,\r?\n\s+\[ref\]/u);
  assert.equal(source.match(/Get-RemainingMessageTimeout/g)?.length, 4);
  assert.match(source, /SendMessageTimeout/u);
});

test("the Windows supervisor assigns a suspended probe to a kill-on-close Job Object", () => {
  const source = readFileSync(
    new URL("./dialog-picker-probe-supervisor-windows.ps1", import.meta.url),
    "utf8",
  );

  assert.match(source, /CREATE_SUSPENDED/u);
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(source, /AssignProcessToJobObject/u);
  assert.match(source, /ResumeThread/u);
  assert.match(source, /SetHandleInformation/u);
  assert.match(source, /TerminateJobObject/u);
  assert.match(source, /QueryInformationJobObject/u);
  assert.match(source, /ActiveProcesses/u);
  assert.ok(
    source.lastIndexOf("AssignProcessToJobObject(job, process.hProcess)") <
      source.indexOf("$supervised.Resume()"),
  );
  assert.match(source, new RegExp(DIALOG_PICKER_PROCESS_PREFIX, "u"));
});

test("hosted driver launch, exit, and unsupported-platform failures block the probe", () => {
  assert.throws(
    () =>
      driveHostedDialog({
        platform: "darwin",
        processId: 1,
        step: "open",
        title: DIALOG_PICKER_OPEN_TITLE,
        selectionPath: "/tmp/open.txt",
        spawnSyncImpl: () => ({ error: new Error("missing osascript") }),
      }),
    /could not start/u,
  );
  assert.throws(
    () =>
      driveHostedDialog({
        platform: "win32",
        processId: 1,
        step: "open",
        title: DIALOG_PICKER_OPEN_TITLE,
        selectionPath: "C:\\Temp\\open.txt",
        spawnSyncImpl: () => ({ status: 9, stdout: "", stderr: "picker not found" }),
      }),
    /picker not found/u,
  );
  assert.throws(
    () =>
      driveHostedDialog({
        platform: "linux",
        processId: 1,
        step: "open",
        title: DIALOG_PICKER_OPEN_TITLE,
      }),
    /only macOS and Windows/u,
  );
});

test("termination targets the POSIX process group and the Windows process tree", () => {
  const processSignals = [];
  forceTerminateHostedChild(
    { pid: 41 },
    {
      platform: "darwin",
      signal: "SIGTERM",
      killProcessImpl(processId, signal) {
        processSignals.push([processId, signal]);
      },
    },
  );
  assert.deepEqual(processSignals, [[-41, "SIGTERM"]]);

  const calls = [];
  forceTerminateHostedChild(
    { pid: 42 },
    {
      platform: "win32",
      timeoutMs: 1_250,
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.deepEqual(calls, [
    {
      command: "taskkill.exe",
      args: ["/PID", "42", "/T", "/F"],
      options: {
        encoding: "utf8",
        timeout: 1_250,
        windowsHide: true,
      },
    },
  ]);
});

test("the Windows supervisor marker supplies the real probe pid to every dialog driver", async (t) => {
  const directory = fixture(t);
  const child = inertChild({ killResult: true });
  const drivenProcessIds = [];
  const proof = expectedProof(directory);
  let spawnCall;

  const result = runReferenceNotesDialogPickerSmoke({
    platform: "win32",
    hostPlatform: "win32",
    compile: false,
    binaryPath: process.execPath,
    workingDirectory: directory,
    timeoutMs: 5_000,
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      queueMicrotask(() => {
        child.stdout.write(
          [
            `${DIALOG_PICKER_PROCESS_PREFIX}4242`,
            `${DIALOG_PICKER_STAGE_PREFIX}save`,
            `${DIALOG_PICKER_STAGE_PREFIX}open`,
            `${DIALOG_PICKER_STAGE_PREFIX}cancel`,
            `${DIALOG_PICKER_SMOKE_STATE_PREFIX}${JSON.stringify(proof)}`,
            DIALOG_PICKER_SMOKE_MARKER,
            "",
          ].join("\n"),
        );
      });
      return child;
    },
    driveDialog({ processId, step }) {
      drivenProcessIds.push(processId);
      if (step === "save") {
        writeFileSync(path.join(directory, DIALOG_PICKER_SAVE_FILE), DIALOG_PICKER_SAVE_BODY);
      }
    },
    terminateChild() {
      queueMicrotask(() => {
        child.signalCode = "SIGKILL";
        child.emit("close", null, "SIGKILL");
      });
    },
    stdout: silentWriter(),
    stderr: silentWriter(),
  });

  await result;
  assert.equal(spawnCall.command, "pwsh");
  assert.match(
    spawnCall.args.find((argument) => argument.endsWith(".ps1")),
    /dialog-picker-probe-supervisor-windows\.ps1$/u,
  );
  assert.equal(spawnCall.options.detached, false);
  assert.equal(spawnCall.options.windowsHide, true);
  assert.deepEqual(drivenProcessIds, [4242, 4242, 4242]);
});

test("accepts only the complete real picker, Promise, controller, and disk journey", async (t) => {
  const directory = fixture(t);
  const script = writeJourneyScript(directory);
  const actions = [];
  const environment = {
    ...process.env,
    NeXa_DiAlOg_TeSt_FiXtUrE_PaTh: "/tmp/must-not-reach-child.json",
  };
  let childEnvironment;

  await runReferenceNotesDialogPickerSmoke({
    platform: "darwin",
    compile: false,
    binaryPath: path.relative(process.cwd(), process.execPath),
    binaryArgs: [script],
    workingDirectory: directory,
    environment,
    timeoutMs: 5_000,
    spawnImpl(command, args, options) {
      childEnvironment = options.env;
      return spawn(command, args, options);
    },
    driveDialog(action) {
      actions.push(action);
      if (action.step === "save") {
        writeFileSync(path.join(directory, DIALOG_PICKER_SAVE_FILE), DIALOG_PICKER_SAVE_BODY);
      }
    },
    stdout: silentWriter(),
    stderr: silentWriter(),
  });

  assert.deepEqual(
    actions.map(({ step, title }) => ({ step, title })),
    [
      { step: "save", title: DIALOG_PICKER_SAVE_TITLE },
      { step: "open", title: DIALOG_PICKER_OPEN_TITLE },
      { step: "cancel", title: DIALOG_PICKER_CANCEL_TITLE },
    ],
  );
  assert.equal(
    Object.keys(childEnvironment).some(
      (name) => name.toUpperCase() === "NEXA_DIALOG_TEST_FIXTURE_PATH",
    ),
    false,
  );
  assert.equal(
    readFileSync(path.join(directory, DIALOG_PICKER_OPEN_FILE), "utf8"),
    DIALOG_PICKER_OPEN_BODY,
  );
});

test("retries each macOS keyboard attempt until probe output confirms stage progress", async (t) => {
  const directory = fixture(t);
  const child = inertChild();
  const attempts = [];
  const proof = expectedProof(directory);

  await runReferenceNotesDialogPickerSmoke({
    platform: "darwin",
    hostPlatform: "darwin",
    compile: false,
    binaryPath: process.execPath,
    workingDirectory: directory,
    timeoutMs: 1_000,
    driverTimeoutMs: 250,
    driverAttemptTimeoutMs: 50,
    driverRetryDelayMs: 5,
    driverMaxAttempts: 3,
    spawnImpl() {
      queueMicrotask(() => {
        child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}save\n`);
      });
      return child;
    },
    driveDialog({ step, timeoutMs }) {
      attempts.push({ step, timeoutMs });
      const count = attempts.filter((attempt) => attempt.step === step).length;
      if (count !== 2) return;
      queueMicrotask(() => {
        if (step === "save") {
          writeFileSync(path.join(directory, DIALOG_PICKER_SAVE_FILE), DIALOG_PICKER_SAVE_BODY);
          child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}open\n`);
        } else if (step === "open") {
          child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}cancel\n`);
        } else {
          child.stdout.write(
            `${DIALOG_PICKER_SMOKE_STATE_PREFIX}${JSON.stringify(proof)}\n${DIALOG_PICKER_SMOKE_MARKER}\n`,
          );
        }
      });
    },
    terminateChild(_target, signal) {
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit("close", null, signal);
      });
    },
    forceTerminateChild() {},
    stdout: silentWriter(),
    stderr: silentWriter(),
  });

  assert.deepEqual(
    attempts.map(({ step }) => step),
    ["save", "save", "open", "open", "cancel", "cancel"],
  );
  assert.ok(attempts.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 50));
});

test("retries a transient macOS driver timeout before accepting stage progress", async (t) => {
  const directory = fixture(t);
  const child = inertChild();
  const attempts = [];
  const proof = expectedProof(directory);

  await runReferenceNotesDialogPickerSmoke({
    platform: "darwin",
    hostPlatform: "darwin",
    compile: false,
    binaryPath: process.execPath,
    workingDirectory: directory,
    timeoutMs: 1_000,
    driverTimeoutMs: 200,
    driverAttemptTimeoutMs: 40,
    driverRetryDelayMs: 1,
    driverMaxAttempts: 2,
    spawnImpl() {
      queueMicrotask(() => child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}save\n`));
      return child;
    },
    driveDialog({ step }) {
      attempts.push(step);
      if (attempts.length === 1) {
        const error = new Error("osascript timed out");
        error.retryable = true;
        throw error;
      }
      writeFileSync(path.join(directory, DIALOG_PICKER_SAVE_FILE), DIALOG_PICKER_SAVE_BODY);
      if (step === "save") {
        queueMicrotask(() => child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}open\n`));
      } else if (step === "open") {
        queueMicrotask(() => child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}cancel\n`));
      } else {
        queueMicrotask(() =>
          child.stdout.write(
            `${DIALOG_PICKER_SMOKE_STATE_PREFIX}${JSON.stringify(proof)}\n${DIALOG_PICKER_SMOKE_MARKER}\n`,
          ),
        );
      }
    },
    terminateChild(_target, signal) {
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit("close", null, signal);
      });
    },
    forceTerminateChild() {},
    stdout: silentWriter(),
    stderr: silentWriter(),
  });

  assert.deepEqual(attempts, ["save", "save", "open", "cancel"]);
});

test("rejects a missing stage even when proof, marker, and disk bytes look valid", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "missing-cancel-stage.mjs");
  const proof = expectedProof(directory);
  writeFileSync(
    script,
    [
      `console.log(${JSON.stringify(`${DIALOG_PICKER_STAGE_PREFIX}save`)});`,
      `console.log(${JSON.stringify(`${DIALOG_PICKER_STAGE_PREFIX}open`)});`,
      `console.log(${JSON.stringify(`${DIALOG_PICKER_SMOKE_STATE_PREFIX}${JSON.stringify(proof)}`)});`,
      `console.log(${JSON.stringify(DIALOG_PICKER_SMOKE_MARKER)});`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );

  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "darwin",
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      driveDialog({ step }) {
        if (step === "save") {
          writeFileSync(path.join(directory, DIALOG_PICKER_SAVE_FILE), DIALOG_PICKER_SAVE_BODY);
        }
      },
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /stage sequence/u,
  );
});

test("rejects a proof whose cancel changed Notes controller state", async (t) => {
  const directory = fixture(t);
  const proof = structuredClone(expectedProof(directory));
  proof.afterCancel = { ...proof.afterCancel, revision: 4, dirty: true };
  const script = writeJourneyScript(directory, proof);

  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "win32",
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      driveDialog({ step }) {
        if (step === "save") {
          writeFileSync(path.join(directory, DIALOG_PICKER_SAVE_FILE), DIALOG_PICKER_SAVE_BODY);
        }
      },
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /journey proof did not match/u,
  );
});

test("rejects marker, stages, and disk bytes without a versioned journey proof", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "missing-proof.mjs");
  writeFileSync(
    script,
    [
      `console.log(${JSON.stringify(`${DIALOG_PICKER_STAGE_PREFIX}save`)});`,
      `console.log(${JSON.stringify(`${DIALOG_PICKER_STAGE_PREFIX}open`)});`,
      `console.log(${JSON.stringify(`${DIALOG_PICKER_STAGE_PREFIX}cancel`)});`,
      `console.log(${JSON.stringify(DIALOG_PICKER_SMOKE_MARKER)});`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );

  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "darwin",
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      driveDialog({ step }) {
        if (step === "save") {
          writeFileSync(path.join(directory, DIALOG_PICKER_SAVE_FILE), DIALOG_PICKER_SAVE_BODY);
        }
      },
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /expected one Notes journey proof/u,
  );
});

test("rejects driver failures, early exit, and timeout", async (t) => {
  const driverDirectory = fixture(t);
  const driverScript = writeJourneyScript(driverDirectory);
  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "darwin",
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [driverScript],
      workingDirectory: driverDirectory,
      timeoutMs: 5_000,
      driveDialog() {
        throw new Error("accessibility permission unavailable");
      },
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /accessibility permission unavailable/u,
  );

  const exitDirectory = fixture(t);
  const exitScript = path.join(exitDirectory, "exit.mjs");
  writeFileSync(exitScript, "process.exit(0);\n");
  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "darwin",
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [exitScript],
      workingDirectory: exitDirectory,
      timeoutMs: 5_000,
      driveDialog() {},
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /exited before success/u,
  );

  const timeoutDirectory = fixture(t);
  const timeoutScript = path.join(timeoutDirectory, "timeout.mjs");
  writeFileSync(timeoutScript, "setInterval(() => {}, 1000);\n");
  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "darwin",
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [timeoutScript],
      workingDirectory: timeoutDirectory,
      timeoutMs: 50,
      driveDialog() {},
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /timed out/u,
  );
});

test("settles only after an owned working directory is cleaned up", async (t) => {
  const directory = fixture(t);
  const script = writeJourneyScript(directory);
  let childClosed = false;
  let removed = false;

  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "darwin",
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      timeoutMs: 5_000,
      createTemporaryDirectory() {
        return directory;
      },
      removeTemporaryDirectory(target, options) {
        assert.equal(childClosed, true);
        assert.equal(target, directory);
        assert.deepEqual(options, { recursive: true, force: true });
        removed = true;
        rmSync(target, options);
      },
      spawnImpl(command, args, options) {
        const child = spawn(command, args, options);
        child.once("close", () => {
          childClosed = true;
        });
        return child;
      },
      driveDialog() {
        throw new Error("primary driver failure");
      },
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /primary driver failure/u,
  );

  assert.equal(removed, true);
});

test("reports cleanup failure without hiding the primary picker failure", async (t) => {
  const directory = fixture(t);
  const script = writeJourneyScript(directory);

  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "darwin",
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      timeoutMs: 5_000,
      createTemporaryDirectory() {
        return directory;
      },
      removeTemporaryDirectory() {
        throw new Error("temporary directory cleanup failed");
      },
      driveDialog() {
        throw new Error("primary driver failure");
      },
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.message, /primary driver failure/u);
      assert.match(error.message, /temporary directory cleanup failed/u);
      assert.deepEqual(
        error.errors.map((entry) => entry.message),
        ["primary driver failure", "temporary directory cleanup failed"],
      );
      return true;
    },
  );
});

test("POSIX close performs a final process-group kill after successful soft termination", async (t) => {
  const directory = fixture(t);
  const child = inertChild();
  const signals = [];

  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "darwin",
      hostPlatform: "darwin",
      compile: false,
      binaryPath: process.execPath,
      workingDirectory: directory,
      timeoutMs: 5_000,
      spawnImpl() {
        queueMicrotask(() => {
          child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}save\n`);
        });
        return child;
      },
      terminateChild(target, signal) {
        assert.equal(target, child);
        signals.push(signal);
        queueMicrotask(() => {
          child.signalCode = signal;
          child.emit("close", null, signal);
        });
      },
      forceTerminateChild(target, signal) {
        assert.equal(target, child);
        signals.push(signal);
      },
      driveDialog() {
        throw new Error("primary driver failure");
      },
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /primary driver failure/u,
  );

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("escalates shutdown and cleans only after the child close event", async (t) => {
  const directory = fixture(t);
  const child = inertChild();
  const startedAt = Date.now();
  let removed = false;
  const terminateSignals = [];
  const forceSignals = [];

  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "win32",
      compile: false,
      binaryPath: process.execPath,
      timeoutMs: 5_000,
      shutdownTimeoutMs: 25,
      createTemporaryDirectory: () => directory,
      removeTemporaryDirectory(target, options) {
        assert.equal(target, directory);
        removed = true;
        rmSync(target, options);
      },
      spawnImpl() {
        queueMicrotask(() => {
          child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}save\n`);
        });
        return child;
      },
      terminateChild(target, signal) {
        assert.equal(target, child);
        terminateSignals.push(signal);
      },
      forceTerminateChild(target, signal) {
        assert.equal(target, child);
        forceSignals.push(signal);
        queueMicrotask(() => {
          child.signalCode = signal;
          child.emit("close", null, signal);
        });
      },
      driveDialog() {
        throw new Error("primary driver failure");
      },
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.message, /primary driver failure/u);
      assert.match(error.message, /did not close within 25 ms; forcing termination/u);
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(removed, true);
  assert.deepEqual(child.killSignals, []);
  assert.deepEqual(terminateSignals, ["SIGTERM"]);
  assert.deepEqual(forceSignals, ["SIGKILL", "SIGKILL"]);
});

test("retains the owned directory until forced shutdown is confirmed by close", async (t) => {
  const directory = fixture(t);
  const child = inertChild({ killResult: true });
  let removed = false;
  let forced = false;

  const result = runReferenceNotesDialogPickerSmoke({
    platform: "darwin",
    compile: false,
    binaryPath: process.execPath,
    timeoutMs: 5_000,
    shutdownTimeoutMs: 10,
    terminationConfirmationTimeoutMs: 100,
    createTemporaryDirectory: () => directory,
    removeTemporaryDirectory(target, options) {
      assert.equal(target, directory);
      removed = true;
      rmSync(target, options);
    },
    spawnImpl(_command, _args, options) {
      assert.equal(options.detached, true);
      queueMicrotask(() => {
        child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}save\n`);
      });
      return child;
    },
    terminateChild(target, signal) {
      assert.equal(target, child);
      assert.equal(signal, "SIGTERM");
    },
    forceTerminateChild(target, signal) {
      assert.equal(target, child);
      assert.equal(signal, "SIGKILL");
      forced = true;
    },
    driveDialog() {
      throw new Error("primary driver failure");
    },
    stdout: silentWriter(),
    stderr: silentWriter(),
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(forced, true);
  assert.equal(removed, false);

  child.signalCode = "SIGKILL";
  child.emit("close", null, "SIGKILL");
  await assert.rejects(result, /primary driver failure/u);
  assert.equal(removed, true);
});

test("bounds unconfirmed hard shutdown and retains the owned directory", async (t) => {
  const directory = fixture(t);
  const child = inertChild({ killResult: true });
  let removed = false;
  const signals = [];
  const startedAt = Date.now();

  const result = runReferenceNotesDialogPickerSmoke({
    platform: "win32",
    compile: false,
    binaryPath: process.execPath,
    timeoutMs: 5_000,
    shutdownTimeoutMs: 10,
    terminationConfirmationTimeoutMs: 15,
    createTemporaryDirectory: () => directory,
    removeTemporaryDirectory() {
      removed = true;
    },
    spawnImpl() {
      queueMicrotask(() => {
        child.stdout.write(`${DIALOG_PICKER_STAGE_PREFIX}save\n`);
      });
      return child;
    },
    terminateChild(target, signal) {
      assert.equal(target, child);
      signals.push(signal);
    },
    forceTerminateChild(target, signal) {
      assert.equal(target, child);
      signals.push(signal);
    },
    driveDialog() {
      throw new Error("primary driver failure");
    },
    stdout: silentWriter(),
    stderr: silentWriter(),
  });

  const error = await Promise.race([
    result.then(
      () => new Error("runner unexpectedly resolved"),
      (failure) => failure,
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve(new Error("runner stayed pending after forced shutdown")), 250),
    ),
  ]);

  assert(error instanceof AggregateError);
  assert.match(error.message, /primary driver failure/u);
  assert.match(error.message, /termination was not confirmed within 15 ms/u);
  assert.match(error.message, new RegExp(directory.replaceAll("\\", "\\\\"), "u"));
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(removed, false);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(child.killSignals, []);
});

test("retains the owned directory when early exit cannot confirm process-tree shutdown", async (t) => {
  const directory = fixture(t);
  const child = inertChild();
  let removed = false;
  const forceSignals = [];

  await assert.rejects(
    runReferenceNotesDialogPickerSmoke({
      platform: "darwin",
      compile: false,
      binaryPath: process.execPath,
      timeoutMs: 5_000,
      createTemporaryDirectory: () => directory,
      removeTemporaryDirectory() {
        removed = true;
      },
      spawnImpl() {
        queueMicrotask(() => {
          child.exitCode = 7;
          child.emit("close", 7, null);
        });
        return child;
      },
      forceTerminateChild(target, signal) {
        assert.equal(target, child);
        forceSignals.push(signal);
        throw new Error("process-tree termination unavailable");
      },
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.message, /exited before success/u);
      assert.match(error.message, /process-tree termination unavailable/u);
      assert.match(error.message, /owned working directory retained/u);
      return true;
    },
  );

  assert.equal(removed, false);
  assert.deepEqual(forceSignals, ["SIGKILL"]);
});

test("cleans an owned working directory when setup fails before spawn", async (t) => {
  const directory = fixture(t);
  const invalidDirectory = path.join(directory, "not-a-directory");
  writeFileSync(invalidDirectory, "file blocks child paths");
  let removed = false;

  await assert.rejects(
    async () =>
      runReferenceNotesDialogPickerSmoke({
        platform: "darwin",
        compile: false,
        binaryPath: process.execPath,
        createTemporaryDirectory: () => invalidDirectory,
        removeTemporaryDirectory(target, options) {
          assert.equal(target, invalidDirectory);
          assert.deepEqual(options, { recursive: true, force: true });
          removed = true;
        },
        stdout: silentWriter(),
        stderr: silentWriter(),
      }),
    /ENOTDIR|not a directory/u,
  );

  assert.equal(removed, true);
});

test("preserves setup and cleanup failures in an AggregateError", async (t) => {
  const directory = fixture(t);
  const invalidDirectory = path.join(directory, "not-a-directory");
  writeFileSync(invalidDirectory, "file blocks child paths");

  await assert.rejects(
    async () =>
      runReferenceNotesDialogPickerSmoke({
        platform: "darwin",
        compile: false,
        binaryPath: process.execPath,
        createTemporaryDirectory: () => invalidDirectory,
        removeTemporaryDirectory() {
          throw new Error("setup cleanup failed");
        },
        stdout: silentWriter(),
        stderr: silentWriter(),
      }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.message, /ENOTDIR|not a directory/u);
      assert.match(error.message, /setup cleanup failed/u);
      return true;
    },
  );
});

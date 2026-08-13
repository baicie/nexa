import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DIALOG_RUNTIME_OPEN_BODY,
  DIALOG_RUNTIME_OPEN_FILE,
  DIALOG_RUNTIME_SAVE_BODY,
  DIALOG_RUNTIME_SAVE_FILE,
  DIALOG_RUNTIME_SMOKE_FAILURE,
  DIALOG_RUNTIME_SMOKE_MARKER,
  DIALOG_RUNTIME_SMOKE_STATE_PREFIX,
  compileReferenceNotesDialogRuntimeSmoke,
  runReferenceNotesDialogRuntimeSmoke,
} from "./reference-notes-dialog-runtime-smoke.mjs";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-notes-dialog-runner-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function silentWriter() {
  return { write() {} };
}

const expectedProof = {
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
};
const perryOverrideEnvironment = "NEXA_PERRY_BIN";

test("compiles the Dialog smoke with trusted manifest and build-time fixture", () => {
  const calls = [];
  const binary = compileReferenceNotesDialogRuntimeSmoke({
    platform: "win32",
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    existsImpl: () => true,
  });

  assert.match(binary, /reference-notes-dialog-runtime-smoke\.exe$/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pnpm.cmd");
  assert.deepEqual(calls[0].args, [
    "exec",
    "perry",
    "compile",
    "dialog-runtime-smoke.tsx",
    "-o",
    "reference-notes-dialog-runtime-smoke",
    "--windows-subsystem",
    "console",
  ]);
  assert.match(calls[0].options.env.NEXA_APP_MANIFEST_PATH, /app\.manifest\.json$/u);
  assert.match(
    calls[0].options.env.NEXA_DIALOG_TEST_FIXTURE_PATH,
    /dialog-runtime-smoke\.fixture\.json$/u,
  );
});

test("compiles the Dialog smoke with a native Perry override and sanitized environment", (t) => {
  const directory = fixture(t);
  const compiler = path.join(directory, "perry.exe");
  writeFileSync(compiler, "native Perry fixture\n");
  const canonicalCompiler = realpathSync(compiler);
  const calls = [];

  compileReferenceNotesDialogRuntimeSmoke({
    platform: "win32",
    environment: { PATH: process.env.PATH, [perryOverrideEnvironment]: compiler },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    existsImpl: () => true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, canonicalCompiler);
  assert.deepEqual(calls[0].args, [
    "compile",
    "dialog-runtime-smoke.tsx",
    "-o",
    "reference-notes-dialog-runtime-smoke",
    "--windows-subsystem",
    "console",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(
    Object.keys(calls[0].options.env).some(
      (name) => name.toUpperCase() === perryOverrideEnvironment,
    ),
    false,
  );
});

test("rejects unsupported platforms before starting a compiler", () => {
  assert.throws(
    () =>
      compileReferenceNotesDialogRuntimeSmoke({
        platform: "linux",
        spawnSyncImpl() {
          throw new Error("must not spawn");
        },
      }),
    /only macOS and Windows/u,
  );
});

test("accepts only the complete native Dialog and Notes controller journey", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "success.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
      DIALOG_RUNTIME_SAVE_FILE,
    )}, ${JSON.stringify(DIALOG_RUNTIME_SAVE_BODY)});\nconsole.log(${JSON.stringify(
      `${DIALOG_RUNTIME_SMOKE_STATE_PREFIX}${JSON.stringify(expectedProof)}`,
    )});\nconsole.log(${JSON.stringify(DIALOG_RUNTIME_SMOKE_MARKER)});\nsetInterval(() => {}, 1000);\n`,
  );

  await runReferenceNotesDialogRuntimeSmoke({
    compile: false,
    binaryPath: process.execPath,
    binaryArgs: [script],
    workingDirectory: directory,
    timeoutMs: 5_000,
    stdout: silentWriter(),
    stderr: silentWriter(),
  });
  assert.equal(
    readFileSync(path.join(directory, DIALOG_RUNTIME_OPEN_FILE), "utf8"),
    DIALOG_RUNTIME_OPEN_BODY,
  );
});

test("rejects disk output and marker without the Notes journey proof", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "missing-proof.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
      DIALOG_RUNTIME_SAVE_FILE,
    )}, ${JSON.stringify(DIALOG_RUNTIME_SAVE_BODY)});\nconsole.log(${JSON.stringify(
      DIALOG_RUNTIME_SMOKE_MARKER,
    )});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesDialogRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /Notes journey proof/u,
  );
});

test("rejects a Notes journey proof whose cancel step changed application state", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "changed-after-cancel.mjs");
  const changedProof = structuredClone(expectedProof);
  changedProof.afterCancel.revision += 1;
  changedProof.afterCancel.dirty = true;
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
      DIALOG_RUNTIME_SAVE_FILE,
    )}, ${JSON.stringify(DIALOG_RUNTIME_SAVE_BODY)});\nconsole.log(${JSON.stringify(
      `${DIALOG_RUNTIME_SMOKE_STATE_PREFIX}${JSON.stringify(changedProof)}`,
    )});\nconsole.log(${JSON.stringify(DIALOG_RUNTIME_SMOKE_MARKER)});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesDialogRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /journey proof did not match/u,
  );
});

test("rejects an explicit Dialog runtime failure marker", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "failure.mjs");
  writeFileSync(
    script,
    `console.log(${JSON.stringify(`${DIALOG_RUNTIME_SMOKE_FAILURE}: PLATFORM_FAILURE`)});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesDialogRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /PLATFORM_FAILURE/u,
  );
});

test("rejects a process that exits before publishing the Dialog journey", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "early-exit.mjs");
  writeFileSync(script, "process.exit(0);\n");

  await assert.rejects(
    runReferenceNotesDialogRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /exited before success/u,
  );
});

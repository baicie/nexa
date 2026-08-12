import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FS_RUNTIME_SMOKE_BODY,
  FS_RUNTIME_SMOKE_FAILURE,
  FS_RUNTIME_SMOKE_FILE,
  FS_RUNTIME_SMOKE_MARKER,
  FS_RUNTIME_SMOKE_STATE_PREFIX,
  compileReferenceNotesFsRuntimeSmoke,
  runReferenceNotesFsRuntimeSmoke,
} from "./reference-notes-fs-runtime-smoke.mjs";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-notes-fs-runner-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function silentWriter() {
  return { write() {} };
}

const invalidFile = "nexa-ui-fs-runtime-invalid.txt";
const invalidProofPrefix = "nexa-ui reference notes invalid utf-8: ";
const savedState = {
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
};
const invalidProof = {
  afterInvalidOpen: {
    ...savedState,
    status: `打开失败: INVALID_DATA: invalid utf-8 data: ${invalidFile}`,
  },
  diagnostic: {
    code: 0x0200_000b,
    operation: "readTextFile",
    context: { format: "utf-8", identifier: invalidFile },
  },
};

test("compiles the FS smoke with the trusted manifest and Windows console subsystem", () => {
  const calls = [];
  const binary = compileReferenceNotesFsRuntimeSmoke({
    platform: "win32",
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    existsImpl: () => true,
  });

  assert.match(binary, /reference-notes-fs-runtime-smoke\.exe$/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pnpm.cmd");
  assert.deepEqual(calls[0].args, [
    "exec",
    "perry",
    "compile",
    "fs-runtime-smoke.tsx",
    "-o",
    "reference-notes-fs-runtime-smoke",
    "--no-auto-optimize",
    "--windows-subsystem",
    "console",
  ]);
  assert.match(calls[0].options.env.NEXA_APP_MANIFEST_PATH, /app\.manifest\.json$/u);
  assert.equal(calls[0].options.stdio, "inherit");
});

test("rejects unsupported platforms before starting a compiler", () => {
  assert.throws(
    () =>
      compileReferenceNotesFsRuntimeSmoke({
        platform: "linux",
        spawnSyncImpl() {
          throw new Error("must not spawn");
        },
      }),
    /only macOS and Windows/u,
  );
});

test("accepts a success marker only after the UTF-8 disk round-trip exists", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "success.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
      FS_RUNTIME_SMOKE_FILE,
    )}, ${JSON.stringify(FS_RUNTIME_SMOKE_BODY)});\nconsole.log(${JSON.stringify(
      `${FS_RUNTIME_SMOKE_STATE_PREFIX}${JSON.stringify(savedState)}`,
    )});\nconsole.log(${JSON.stringify(
      `${invalidProofPrefix}${JSON.stringify(invalidProof)}`,
    )});\nconsole.log(${JSON.stringify(FS_RUNTIME_SMOKE_MARKER)});\nsetInterval(() => {}, 1000);\n`,
  );

  await runReferenceNotesFsRuntimeSmoke({
    compile: false,
    binaryPath: process.execPath,
    binaryArgs: [script],
    workingDirectory: directory,
    timeoutMs: 5_000,
    stdout: silentWriter(),
    stderr: silentWriter(),
  });
});

test("rejects a saved-state marker without the invalid UTF-8 Notes proof", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "missing-invalid-proof.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
      FS_RUNTIME_SMOKE_FILE,
    )}, ${JSON.stringify(FS_RUNTIME_SMOKE_BODY)});\nconsole.log(${JSON.stringify(
      `${FS_RUNTIME_SMOKE_STATE_PREFIX}${JSON.stringify(savedState)}`,
    )});\nconsole.log(${JSON.stringify(FS_RUNTIME_SMOKE_MARKER)});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesFsRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /invalid UTF-8 Notes proof/u,
  );
});

test("rejects a marker and matching disk content without Notes controller state proof", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "missing-state-proof.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
      FS_RUNTIME_SMOKE_FILE,
    )}, ${JSON.stringify(FS_RUNTIME_SMOKE_BODY)});\nconsole.log(${JSON.stringify(
      FS_RUNTIME_SMOKE_MARKER,
    )});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesFsRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /controller state proof/u,
  );
});

test("rejects a controller proof whose saved state is still dirty", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "dirty-state-proof.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
      FS_RUNTIME_SMOKE_FILE,
    )}, ${JSON.stringify(FS_RUNTIME_SMOKE_BODY)});\nconsole.log(${JSON.stringify(
      `${FS_RUNTIME_SMOKE_STATE_PREFIX}${JSON.stringify({
        path: FS_RUNTIME_SMOKE_FILE,
        title: FS_RUNTIME_SMOKE_FILE,
        body: FS_RUNTIME_SMOKE_BODY,
        revision: 2,
        savedRevision: 1,
        dirty: true,
        status: "未保存",
        busy: false,
        operation: "idle",
        window: "active",
      })}`,
    )});\nconsole.log(${JSON.stringify(FS_RUNTIME_SMOKE_MARKER)});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesFsRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /controller state proof did not match/u,
  );
});

test("rejects an explicit runtime failure marker", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "failure.mjs");
  writeFileSync(
    script,
    `console.log(${JSON.stringify(`${FS_RUNTIME_SMOKE_FAILURE}: PERMISSION_DENIED`)});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesFsRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      workingDirectory: directory,
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /PERMISSION_DENIED/u,
  );
});

test("rejects a process that exits before publishing proof", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "early-exit.mjs");
  mkdirSync(path.join(directory, "empty"));
  writeFileSync(script, "process.exit(0);\n");

  await assert.rejects(
    runReferenceNotesFsRuntimeSmoke({
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

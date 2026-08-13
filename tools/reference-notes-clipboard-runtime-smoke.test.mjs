import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLIPBOARD_RUNTIME_SMOKE_FAILURE,
  CLIPBOARD_RUNTIME_SMOKE_MARKER,
  CLIPBOARD_RUNTIME_SMOKE_PROOF_PREFIX,
  CLIPBOARD_RUNTIME_SMOKE_VALUE,
  compileReferenceNotesClipboardRuntimeSmoke,
  runReferenceNotesClipboardRuntimeSmoke,
} from "./reference-notes-clipboard-runtime-smoke.mjs";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-notes-clipboard-runner-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function silentWriter() {
  return { write() {} };
}

const proof = {
  written: CLIPBOARD_RUNTIME_SMOKE_VALUE,
  read: CLIPBOARD_RUNTIME_SMOKE_VALUE,
  restoreAttempted: true,
  restoreVerified: true,
};
const perryOverrideEnvironment = "NEXA_PERRY_BIN";

test("compiles the Clipboard smoke with the trusted manifest and Windows console subsystem", () => {
  const calls = [];
  const binary = compileReferenceNotesClipboardRuntimeSmoke({
    platform: "win32",
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    existsImpl: () => true,
  });

  assert.match(binary, /reference-notes-clipboard-runtime-smoke\.exe$/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pnpm.cmd");
  assert.deepEqual(calls[0].args, [
    "exec",
    "perry",
    "compile",
    "clipboard-runtime-smoke.tsx",
    "-o",
    "reference-notes-clipboard-runtime-smoke",
    "--windows-subsystem",
    "console",
  ]);
  assert.match(calls[0].options.env.NEXA_APP_MANIFEST_PATH, /app\.manifest\.json$/u);
  assert.equal(calls[0].options.stdio, "inherit");
});

test("compiles the Clipboard smoke with a native Perry override and sanitized environment", (t) => {
  const directory = fixture(t);
  const compiler = path.join(directory, "perry.exe");
  writeFileSync(compiler, "native Perry fixture\n");
  const canonicalCompiler = realpathSync(compiler);
  const calls = [];

  compileReferenceNotesClipboardRuntimeSmoke({
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
    "clipboard-runtime-smoke.tsx",
    "-o",
    "reference-notes-clipboard-runtime-smoke",
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
      compileReferenceNotesClipboardRuntimeSmoke({
        platform: "linux",
        spawnSyncImpl() {
          throw new Error("must not spawn");
        },
      }),
    /only macOS and Windows/u,
  );
});

test("accepts exact native Clipboard Promise round-trip and restoration proof", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "success.mjs");
  writeFileSync(
    script,
    `console.log(${JSON.stringify(
      `${CLIPBOARD_RUNTIME_SMOKE_PROOF_PREFIX}${JSON.stringify(proof)}`,
    )});\nconsole.log(${JSON.stringify(CLIPBOARD_RUNTIME_SMOKE_MARKER)});\nsetInterval(() => {}, 1000);\n`,
  );

  await runReferenceNotesClipboardRuntimeSmoke({
    compile: false,
    binaryPath: process.execPath,
    binaryArgs: [script],
    timeoutMs: 5_000,
    stdout: silentWriter(),
    stderr: silentWriter(),
  });
});

test("rejects a success marker without exact Clipboard proof", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "missing-proof.mjs");
  writeFileSync(
    script,
    `console.log(${JSON.stringify(CLIPBOARD_RUNTIME_SMOKE_MARKER)});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesClipboardRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /emitted no round-trip proof/u,
  );
});

test("rejects malformed Clipboard proof", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "malformed-proof.mjs");
  writeFileSync(
    script,
    `console.log(${JSON.stringify(
      `${CLIPBOARD_RUNTIME_SMOKE_PROOF_PREFIX}${JSON.stringify({ ...proof, read: "wrong" })}`,
    )});\nconsole.log(${JSON.stringify(CLIPBOARD_RUNTIME_SMOKE_MARKER)});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesClipboardRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /proof did not match/u,
  );
});

test("rejects an explicit Clipboard runtime failure", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "failure.mjs");
  writeFileSync(
    script,
    `console.log(${JSON.stringify(`${CLIPBOARD_RUNTIME_SMOKE_FAILURE}: PLATFORM_FAILURE`)});\nsetInterval(() => {}, 1000);\n`,
  );

  await assert.rejects(
    runReferenceNotesClipboardRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /PLATFORM_FAILURE/u,
  );
});

test("rejects a process that exits before publishing Clipboard proof", async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, "early-exit.mjs");
  writeFileSync(script, "process.exit(0);\n");

  await assert.rejects(
    runReferenceNotesClipboardRuntimeSmoke({
      compile: false,
      binaryPath: process.execPath,
      binaryArgs: [script],
      timeoutMs: 5_000,
      stdout: silentWriter(),
      stderr: silentWriter(),
    }),
    /exited before success/u,
  );
});

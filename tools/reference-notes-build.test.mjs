import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const { REFERENCE_NOTES_STARTUP_MARKER, runReferenceNotesBuild } =
  await import("./reference-notes-build.mjs");
const outputSink = { write() {} };
const perryOverrideEnvironment = "NEXA_PERRY_BIN";

function nativePerryFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-notes-perry-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const compiler = path.join(directory, "perry.exe");
  writeFileSync(compiler, "native Perry fixture\n");
  return realpathSync(compiler);
}

function trustedManifestMarkers() {
  return Buffer.from(
    [
      "dev.nexa.notes",
      "system.ClipboardRead",
      "system.ClipboardWrite",
      "system.FsRead",
      "system.FsWrite",
      "system.DialogOpen",
      "system.DialogSave",
    ].join("\0"),
  );
}

test("Notes build embeds its trusted manifest and verifies the resulting binary", () => {
  const calls = [];
  const markerBytes = trustedManifestMarkers();

  runReferenceNotesBuild({
    platform: "win32",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return calls.length === 3
        ? { status: 0, stdout: `${REFERENCE_NOTES_STARTUP_MARKER}\n`, stderr: "" }
        : { status: 0 };
    },
    readBinary() {
      return markerBytes;
    },
    stdout: outputSink,
    stderr: outputSink,
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, "pnpm.cmd");
  assert.deepEqual(calls[0].args, [
    "exec",
    "perry",
    "compile",
    "main.tsx",
    "-o",
    "reference-notes",
    "--target",
    "windows",
    "--windows-subsystem",
    "console",
  ]);
  assert.equal(
    calls[0].options.env.NEXA_APP_MANIFEST_PATH,
    path.join(calls[0].options.cwd, "app.manifest.json"),
  );
  assert.deepEqual(calls[1].args, [
    "exec",
    "perry",
    "compile",
    "startup-smoke.tsx",
    "-o",
    "reference-notes-startup-smoke",
    "--target",
    "windows",
    "--windows-subsystem",
    "console",
  ]);
  assert.equal(
    calls[2].command,
    path.join(calls[0].options.cwd, "reference-notes-startup-smoke.exe"),
  );
});

test("Notes build uses a native Perry override without a shell or environment leak", (t) => {
  const compiler = nativePerryFixture(t);
  const calls = [];

  runReferenceNotesBuild({
    platform: "win32",
    environment: {
      PATH: process.env.PATH,
      [perryOverrideEnvironment]: compiler,
    },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return calls.length === 3
        ? { status: 0, stdout: `${REFERENCE_NOTES_STARTUP_MARKER}\n`, stderr: "" }
        : { status: 0 };
    },
    readBinary: trustedManifestMarkers,
    stdout: outputSink,
    stderr: outputSink,
  });

  assert.equal(calls.length, 3);
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.command, compiler);
    assert.equal(call.args[0], "compile");
    assert.equal(call.options.shell, false);
  }
  for (const call of calls) {
    assert.equal(
      Object.keys(call.options.env).some((name) => name.toUpperCase() === perryOverrideEnvironment),
      false,
    );
  }
});

test("Notes build requires the compiled application tree startup marker", () => {
  const markerBytes = trustedManifestMarkers();

  assert.throws(
    () =>
      runReferenceNotesBuild({
        spawn: () => ({ status: 0, stdout: "unexpected output", stderr: "" }),
        readBinary: () => markerBytes,
        stdout: outputSink,
        stderr: outputSink,
      }),
    /startup smoke did not emit/u,
  );
});

test("Notes build fails when the linked binary omits a manifest marker", () => {
  assert.throws(
    () =>
      runReferenceNotesBuild({
        spawn: () => ({ status: 0 }),
        readBinary: () => Buffer.from("dev.nexa.notes"),
      }),
    /system\.ClipboardRead/u,
  );
});

test("Notes production build strips the Dialog test fixture from every child process", (t) => {
  const fixtureVariable = "NEXA_DIALOG_TEST_FIXTURE_PATH";
  const previous = process.env[fixtureVariable];
  process.env[fixtureVariable] = "/tmp/should-never-enter-production.json";
  t.after(() => {
    if (previous === undefined) delete process.env[fixtureVariable];
    else process.env[fixtureVariable] = previous;
  });

  const calls = [];
  runReferenceNotesBuild({
    platform: "darwin",
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return calls.length === 3
        ? { status: 0, stdout: `${REFERENCE_NOTES_STARTUP_MARKER}\n`, stderr: "" }
        : { status: 0 };
    },
    readBinary: trustedManifestMarkers,
    stdout: outputSink,
    stderr: outputSink,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, [
    "exec",
    "perry",
    "compile",
    "main.tsx",
    "-o",
    "reference-notes",
  ]);
  assert.deepEqual(calls[1].args, [
    "exec",
    "perry",
    "compile",
    "startup-smoke.tsx",
    "-o",
    "reference-notes-startup-smoke",
  ]);
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.options.env, fixtureVariable), false);
  }
});

test("Notes production build rejects a binary containing the Dialog test fixture", () => {
  const contaminatedBinary = Buffer.concat([
    trustedManifestMarkers(),
    Buffer.from("\0nexa-ui-dialog-open.txt\0"),
  ]);

  assert.throws(
    () =>
      runReferenceNotesBuild({
        spawn: () => ({
          status: 0,
          stdout: `${REFERENCE_NOTES_STARTUP_MARKER}\n`,
          stderr: "",
        }),
        readBinary: () => contaminatedBinary,
        stdout: outputSink,
        stderr: outputSink,
      }),
    /Dialog test fixture/u,
  );
});

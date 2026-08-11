import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleDirectory = fileURLToPath(new URL("../examples/reference-notes/", import.meta.url));
const manifestPath = path.join(exampleDirectory, "app.manifest.json");
const manifestMarkers = [
  "dev.nexa.notes",
  "system.ClipboardRead",
  "system.ClipboardWrite",
  "system.FsRead",
  "system.FsWrite",
  "system.DialogOpen",
  "system.DialogSave",
];
const dialogTestFixtureEnvironment = "NEXA_DIALOG_TEST_FIXTURE_PATH";
const dialogTestFixtureMarkers = ["nexa-ui-dialog-open.txt", "nexa-ui-dialog-save.txt"];
export const REFERENCE_NOTES_STARTUP_MARKER = "nexa-ui reference notes startup smoke ok";

function assertSucceeded(result, stage) {
  if (result.error) {
    throw new Error(`Notes ${stage} could not start: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`Notes ${stage} failed with exit code ${result.status ?? "no status"}`);
  }
}

export function runReferenceNotesBuild({
  platform = process.platform,
  spawn = spawnSync,
  readBinary = readFileSync,
  run = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const binaryName = platform === "win32" ? "reference-notes.exe" : "reference-notes";
  const binaryPath = path.join(exampleDirectory, binaryName);
  const compileArgs = ["exec", "perry", "compile", "main.tsx", "-o", "reference-notes"];
  if (platform === "win32") compileArgs.push("--windows-subsystem", "console");

  const productionEnvironment = { ...process.env };
  delete productionEnvironment[dialogTestFixtureEnvironment];
  const options = {
    cwd: exampleDirectory,
    env: { ...productionEnvironment, NEXA_APP_MANIFEST_PATH: manifestPath },
    stdio: "inherit",
  };
  assertSucceeded(spawn(pnpm, compileArgs, options), "compilation");

  const binary = readBinary(binaryPath);
  for (const marker of manifestMarkers) {
    if (!binary.includes(Buffer.from(marker))) {
      throw new Error(`Notes binary does not contain trusted manifest marker ${marker}`);
    }
  }
  for (const marker of dialogTestFixtureMarkers) {
    if (binary.includes(Buffer.from(marker))) {
      throw new Error(`Notes binary contains Dialog test fixture marker ${marker}`);
    }
  }

  const smokeName =
    platform === "win32" ? "reference-notes-startup-smoke.exe" : "reference-notes-startup-smoke";
  const smokePath = path.join(exampleDirectory, smokeName);
  const smokeCompileArgs = [
    "exec",
    "perry",
    "compile",
    "startup-smoke.tsx",
    "-o",
    "reference-notes-startup-smoke",
  ];
  if (platform === "win32") smokeCompileArgs.push("--windows-subsystem", "console");
  assertSucceeded(spawn(pnpm, smokeCompileArgs, options), "startup smoke compilation");

  const smoke = spawn(smokePath, [], {
    cwd: exampleDirectory,
    env: productionEnvironment,
    encoding: "utf8",
  });
  if (smoke.stdout) stdout.write(smoke.stdout);
  if (smoke.stderr) stderr.write(smoke.stderr);
  assertSucceeded(smoke, "startup smoke execution");
  if (!smoke.stdout?.includes(REFERENCE_NOTES_STARTUP_MARKER)) {
    throw new Error(
      `Notes startup smoke did not emit the success marker: ${REFERENCE_NOTES_STARTUP_MARKER}`,
    );
  }

  if (run) {
    assertSucceeded(
      spawn(binaryPath, [], {
        cwd: exampleDirectory,
        env: productionEnvironment,
        stdio: "inherit",
      }),
      "execution",
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runReferenceNotesBuild({ run: process.argv.includes("--run") });
}

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { environmentWithoutPerryCompilerOverride } from "../packages/cli/src/perry-command.mjs";
import { runPerryCompile } from "./perry-compile.mjs";

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
  environment = process.env,
  spawn = spawnSync,
  readBinary = readFileSync,
  run = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const binaryName = platform === "win32" ? "reference-notes.exe" : "reference-notes";
  const binaryPath = path.join(exampleDirectory, binaryName);
  const compileArgs = ["main.tsx", "-o", "reference-notes"];
  if (platform === "win32") {
    compileArgs.push("--windows-subsystem", "console");
  }

  const productionEnvironment = { ...environment };
  delete productionEnvironment[dialogTestFixtureEnvironment];
  const executionEnvironment = environmentWithoutPerryCompilerOverride(productionEnvironment);
  runPerryCompile({
    args: compileArgs,
    cwd: exampleDirectory,
    manifestPath,
    environment: productionEnvironment,
    forceRuntime: spawn === spawnSync,
    platform,
    runner: spawn,
  });

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
  const smokeCompileArgs = ["startup-smoke.tsx", "-o", "reference-notes-startup-smoke"];
  if (platform === "win32") {
    smokeCompileArgs.push("--windows-subsystem", "console");
  }
  runPerryCompile({
    args: smokeCompileArgs,
    cwd: exampleDirectory,
    manifestPath,
    environment: productionEnvironment,
    forceRuntime: spawn === spawnSync,
    platform,
    runner: spawn,
  });

  const smoke = spawn(smokePath, [], {
    cwd: exampleDirectory,
    env: executionEnvironment,
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
        env: executionEnvironment,
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

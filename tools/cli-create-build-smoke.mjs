import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../packages/cli/src/index.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

function assertCliSucceeded(exitCode, command) {
  if (exitCode !== 0) throw new Error(`nexa ${command} failed with exit code ${exitCode}`);
}

function linkDirectory(target, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  symlinkSync(realpathSync(target), destination, process.platform === "win32" ? "junction" : "dir");
}

export function runCreateBuildSmoke({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nexa-cli-create-build-"));
  try {
    assertCliSucceeded(runCli(["new", "smoke-app"], { cwd: temporaryRoot, stdout, stderr }), "new");
    const projectDirectory = path.join(temporaryRoot, "smoke-app");
    linkDirectory(
      path.join(workspaceRoot, "packages", "ui"),
      path.join(projectDirectory, "node_modules", "@nexa", "ui"),
    );
    linkDirectory(
      path.join(workspaceRoot, "node_modules", "@perryts", "perry"),
      path.join(projectDirectory, "node_modules", "@perryts", "perry"),
    );

    assertCliSucceeded(runCli(["build"], { cwd: projectDirectory, stdout, stderr }), "build");
    const executable = path.join(
      projectDirectory,
      "dist",
      process.platform === "win32" ? "smoke-app.exe" : "smoke-app",
    );
    if (!existsSync(executable) || !lstatSync(executable).isFile()) {
      throw new Error(`nexa build smoke did not produce a regular executable: ${executable}`);
    }
    stdout.write(`nexa-ui cli create-build smoke ok: ${process.platform}/${process.arch}\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) runCreateBuildSmoke();

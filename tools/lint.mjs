import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const options = new Set(process.argv.slice(2));

if ([...options].some((option) => option !== "--list-only")) {
  throw new Error("Usage: node tools/lint.mjs [--list-only]");
}

const discovery = spawnSync(pnpm, ["exec", "oxlint", ".", "--debug=files"], {
  cwd: workspaceRoot,
  encoding: "utf8",
});

if (discovery.error) {
  throw discovery.error;
}
if (discovery.status !== 0) {
  process.stderr.write(discovery.stderr || discovery.stdout);
  process.exitCode = discovery.status ?? 1;
} else {
  const files = discovery.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (files.length === 0) {
    throw new Error("Oxlint discovered zero source files");
  }

  console.log(`Oxlint will check ${files.length} source files.`);

  if (!options.has("--list-only")) {
    const lint = spawnSync(
      pnpm,
      ["exec", "oxlint", ".", "--deny-warnings", "--report-unused-disable-directives"],
      {
        cwd: workspaceRoot,
        stdio: "inherit",
      },
    );
    if (lint.error) {
      throw lint.error;
    }
    process.exitCode = lint.status ?? 1;
  }
}

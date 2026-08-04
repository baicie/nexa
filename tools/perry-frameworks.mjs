import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PERRY_FRAMEWORK_MARKER = "nexa-ui perry framework ok";

export const PERRY_FRAMEWORKS = [
  {
    id: "solid",
    packageName: "@nexa/example-solid-counter",
    directory: "solid-counter",
    output: "solid-counter",
    clean: ["dist"],
  },
  {
    id: "vue",
    packageName: "@nexa/example-vue-counter",
    directory: "vue-counter",
    output: "vue-counter",
    clean: [],
  },
  {
    id: "react",
    packageName: "@nexa/example-react-counter",
    directory: "react-counter",
    output: "react-counter",
    clean: [],
  },
  {
    id: "svelte",
    packageName: "@nexa/example-svelte-counter",
    directory: "svelte-counter",
    output: "svelte-counter",
    clean: [],
  },
];

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

function writeChildOutput(build, stdout, stderr) {
  if (build.stdout) {
    stdout.write(build.stdout);
  }
  if (build.stderr) {
    stderr.write(build.stderr);
  }
}

function selectFrameworks(frameworkIds) {
  const byId = new Map(PERRY_FRAMEWORKS.map((framework) => [framework.id, framework]));
  const selectedIds = frameworkIds.length > 0 ? frameworkIds : PERRY_FRAMEWORKS.map(({ id }) => id);

  return selectedIds.map((id) => {
    const framework = byId.get(id);
    if (!framework) {
      throw new Error(`Unknown Perry framework: ${id}`);
    }
    return framework;
  });
}

export function runPerryFrameworkBuilds({
  frameworkIds = [],
  platform = process.platform,
  spawn = spawnSync,
  exists = existsSync,
  stat = statSync,
  remove = rmSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";

  for (const framework of selectFrameworks(frameworkIds)) {
    const exampleDirectory = path.join(workspaceRoot, "examples", framework.directory);
    const executableName = platform === "win32" ? `${framework.output}.exe` : framework.output;
    const executablePath = path.join(exampleDirectory, executableName);

    remove(executablePath, { force: true });
    for (const relativePath of framework.clean) {
      remove(path.join(exampleDirectory, relativePath), { force: true, recursive: true });
    }

    const build = spawn(pnpm, ["--filter", framework.packageName, "build"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: { ...process.env, PERRY_NO_CACHE: "1" },
      stdio: "inherit",
      // Node cannot execute pnpm's .cmd shim directly on Windows.
      shell: platform === "win32",
      timeout: 30 * 60_000,
    });
    writeChildOutput(build, stdout, stderr);

    if (build.error) {
      throw new Error(
        `Perry framework build could not start for ${framework.id}: ${build.error.message}`,
        { cause: build.error },
      );
    }
    if (build.status !== 0) {
      throw new Error(
        `Perry framework build failed for ${framework.id} with exit code ${build.status ?? "no status"}`,
      );
    }
    if (!exists(executablePath)) {
      throw new Error(`Perry framework build produced no executable for ${framework.id}`);
    }
    if (stat(executablePath).size <= 0) {
      throw new Error(`Perry framework build produced an empty executable for ${framework.id}`);
    }

    stdout.write(`${PERRY_FRAMEWORK_MARKER} framework=${framework.id} platform=${platform}\n`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runPerryFrameworkBuilds({ frameworkIds: process.argv.slice(2) });
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checks = ["typecheck", "test", "build", "lint"];
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(toolsDir, "..");
const matrixPath = path.join(toolsDir, "workspace-checks.json");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function toWorkspacePath(absolutePath) {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return relativePath === "" ? "." : relativePath.split(path.sep).join("/");
}

function discoverProjects() {
  const result = spawnSync(pnpmCommand(), ["list", "--recursive", "--depth", "-1", "--json"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`pnpm workspace discovery failed:\n${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout).map((project) => ({
    name: project.name,
    path: toWorkspacePath(project.path),
    absolutePath: project.path,
    packageJson: readJson(path.join(project.path, "package.json")),
  }));
}

function validateCell({ cell, check, project, matrixByPath, reasons }) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
    return `${project.path}:${check} has no explicit status`;
  }

  const kinds = ["script", "command", "skip", "inherit"].filter((kind) => kind in cell);
  if (kinds.length !== 1) {
    return `${project.path}:${check} must declare exactly one status`;
  }

  const [kind] = kinds;
  if (kind === "script") {
    if (typeof cell.script !== "string" || !project.packageJson.scripts?.[cell.script]) {
      return `${project.path}:${check} references missing script ${JSON.stringify(cell.script)}`;
    }
  } else if (kind === "command") {
    if (!Array.isArray(cell.command) || cell.command.length === 0) {
      return `${project.path}:${check} command must be a non-empty argument array`;
    }
    if (!cell.command.every((argument) => typeof argument === "string" && argument.length > 0)) {
      return `${project.path}:${check} command contains an invalid argument`;
    }
  } else if (kind === "skip") {
    if (typeof reasons[cell.skip] !== "string" || reasons[cell.skip].length === 0) {
      return `${project.path}:${check} references unknown skip reason ${JSON.stringify(cell.skip)}`;
    }
  } else {
    if (!matrixByPath.has(cell.inherit)) {
      return `${project.path}:${check} inherits from unknown project ${JSON.stringify(cell.inherit)}`;
    }
    if (typeof reasons[cell.reason] !== "string" || reasons[cell.reason].length === 0) {
      return `${project.path}:${check} references unknown inherit reason ${JSON.stringify(cell.reason)}`;
    }
  }

  return null;
}

function validateMatrix() {
  const matrix = readJson(matrixPath);
  const projects = discoverProjects();
  const actualByPath = new Map(projects.map((project) => [project.path, project]));
  const matrixByPath = new Map();
  const unclassified = [];

  for (const entry of matrix.projects ?? []) {
    if (matrixByPath.has(entry.path)) {
      unclassified.push(`duplicate matrix entry: ${entry.path}`);
    }
    matrixByPath.set(entry.path, entry);
  }

  let classifiedCheckCount = 0;
  for (const project of projects) {
    const entry = matrixByPath.get(project.path);
    if (!entry) {
      unclassified.push(`workspace missing from matrix: ${project.path}`);
      continue;
    }

    for (const check of checks) {
      const error = validateCell({
        cell: entry.checks?.[check],
        check,
        project,
        matrixByPath,
        reasons: matrix.reasons ?? {},
      });
      if (error) {
        unclassified.push(error);
      } else {
        classifiedCheckCount += 1;
      }
    }

    const extraChecks = Object.keys(entry.checks ?? {}).filter((check) => !checks.includes(check));
    for (const check of extraChecks) {
      unclassified.push(`${project.path} declares unknown check: ${check}`);
    }
  }

  for (const matrixProject of matrixByPath.keys()) {
    if (!actualByPath.has(matrixProject)) {
      unclassified.push(`stale matrix entry: ${matrixProject}`);
    }
  }

  return {
    matrix,
    projects,
    matrixByPath,
    report: {
      checks,
      projectCount: projects.length,
      classifiedCheckCount,
      unclassified,
    },
  };
}

function buildPlan(context, check) {
  const projectsByPath = new Map(context.projects.map((project) => [project.path, project]));
  const entries = context.matrix.projects.map((matrixProject) => {
    const project = projectsByPath.get(matrixProject.path);
    const cell = matrixProject.checks[check];
    const base = {
      name: project.name,
      path: project.path,
    };

    if (cell.script) {
      return {
        ...base,
        status: "run",
        command: [pnpmCommand(), "run", cell.script],
        cwd: project.absolutePath,
      };
    }
    if (cell.command) {
      const [executable, ...args] = cell.command;
      return {
        ...base,
        status: "run",
        command: [executable === "pnpm" ? pnpmCommand() : executable, ...args],
        cwd: project.absolutePath,
      };
    }
    if (cell.skip) {
      return {
        ...base,
        status: "skip",
        reason: context.matrix.reasons[cell.skip],
      };
    }
    return {
      ...base,
      status: "inherit",
      inheritedFrom: cell.inherit,
      reason: context.matrix.reasons[cell.reason],
    };
  });

  return {
    check,
    entries,
    runnableCount: entries.filter((entry) => entry.status === "run").length,
    skippedCount: entries.filter((entry) => entry.status === "skip").length,
    inheritedCount: entries.filter((entry) => entry.status === "inherit").length,
  };
}

function printablePlan(plan) {
  return {
    check: plan.check,
    entries: plan.entries.map(({ cwd: _cwd, ...entry }) => entry),
    runnableCount: plan.runnableCount,
    skippedCount: plan.skippedCount,
    inheritedCount: plan.inheritedCount,
  };
}

function printPlan(plan) {
  console.log(`Workspace ${plan.check} matrix:`);
  for (const entry of plan.entries) {
    if (entry.status === "run") {
      console.log(`[RUN]     ${entry.name} (${entry.path}): ${entry.command.join(" ")}`);
    } else if (entry.status === "inherit") {
      console.log(
        `[INHERIT] ${entry.name} (${entry.path}) <- ${entry.inheritedFrom}: ${entry.reason}`,
      );
    } else {
      console.log(`[SKIP]    ${entry.name} (${entry.path}): ${entry.reason}`);
    }
  }
  console.log(
    `Summary: ${plan.runnableCount} run, ${plan.skippedCount} skipped, ${plan.inheritedCount} inherited.`,
  );
}

function executePlan(plan) {
  const failures = [];
  for (const entry of plan.entries) {
    if (entry.status !== "run") {
      continue;
    }

    console.log(`\n==> ${entry.name}: ${plan.check}`);
    const [executable, ...args] = entry.command;
    const result = spawnSync(executable, args, {
      cwd: entry.cwd,
      env: process.env,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      failures.push(`${entry.name} (${entry.path}) exited with ${result.status ?? "no status"}`);
    }
  }
  return failures;
}

function main() {
  const [command, ...options] = process.argv.slice(2);
  const context = validateMatrix();
  const { report } = context;

  if (command === "validate") {
    if (options.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else if (report.unclassified.length === 0) {
      console.log(
        `Workspace matrix valid: ${report.projectCount} projects, ${report.classifiedCheckCount} checks.`,
      );
    } else {
      for (const error of report.unclassified) {
        console.error(`- ${error}`);
      }
    }

    if (report.unclassified.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (!checks.includes(command)) {
    throw new Error(
      `Usage: node tools/workspace-checks.mjs <${checks.join("|")}|validate> [--dry-run] [--json]`,
    );
  }
  if (report.unclassified.length > 0) {
    for (const error of report.unclassified) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const plan = buildPlan(context, command);
  const dryRun = options.includes("--dry-run");
  if (options.includes("--json")) {
    if (!dryRun) {
      throw new Error("--json is only supported together with --dry-run");
    }
    process.stdout.write(`${JSON.stringify(printablePlan(plan))}\n`);
    return;
  }

  printPlan(plan);
  if (dryRun) {
    return;
  }

  const failures = executePlan(plan);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
  }
}

main();

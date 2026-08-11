import { runProjectBuild, runProjectDev } from "./build.mjs";
import { runDoctor } from "./doctor.mjs";
import { createProject } from "./new.mjs";
import { runProjectPackage } from "./package.mjs";
import path from "node:path";

import { COMPATIBILITY } from "./constants.mjs";

const USAGE = `Usage: nexa <command> [options]

Commands:
  nexa new <directory>  Create a Minimal TSX project
  nexa dev              Watch, rebuild, and run the current project
  nexa build            Build the current project
  nexa package          Build and package the current project
  nexa doctor [--json]  Check the local Nexa toolchain and target

Options:
  -h, --help            Show this help
`;

function writeUsage(stream) {
  stream.write(USAGE);
}

export function runCli(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();

  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    writeUsage(stdout);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    stdout.write(`${COMPATIBILITY.cli}\n`);
    return 0;
  }
  if (
    ["new", "dev", "build", "package", "doctor"].includes(argv[0]) &&
    argv.length === 2 &&
    (argv[1] === "--help" || argv[1] === "-h")
  ) {
    writeUsage(stdout);
    return 0;
  }
  if (argv[0] === "new" && argv.length === 2 && !argv[1].startsWith("-")) {
    try {
      const project = createProject({
        requestedPath: argv[1],
        cwd,
        filesystem: options.filesystem,
      });
      stdout.write(`Created ${project.displayName} in ${pathForOutput(cwd, project.target)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (argv[0] === "doctor" && (argv.length === 1 || argv.join(" ") === "doctor --json")) {
    return runDoctor({
      json: argv[1] === "--json",
      cwd,
      stdout,
      stderr,
      runner: options.runner,
      readPackageManifest: options.readPackageManifest,
      resolvePerryBin: options.resolvePerryBin,
      runtime: options.runtime,
    });
  }
  if (argv[0] === "build" && argv.length === 1) {
    try {
      const artifact = runProjectBuild({
        cwd,
        environment: options.environment,
        filesystem: options.filesystem,
        runner: options.runner,
        runtime: options.runtime,
      });
      stdout.write(`Built ${artifact.id}@${artifact.version}: ${artifact.binaryRelative}\n`);
      return 0;
    } catch (error) {
      stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (argv[0] === "dev" && argv.length === 1) {
    try {
      runProjectDev({
        cwd,
        environment: options.environment,
        filesystem: options.filesystem,
        onStart({ entryRelative, id }) {
          stdout.write(`Starting ${id} from ${entryRelative}\n`);
        },
        runner: options.runner,
        runtime: options.runtime,
      });
      return 0;
    } catch (error) {
      stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (argv[0] === "package" && argv.length === 1) {
    try {
      const artifact = runProjectPackage({
        build: options.build,
        cwd,
        environment: options.environment,
        filesystem: options.filesystem,
        runner: options.runner,
        runtime: options.runtime,
      });
      stdout.write(`Packaged ${artifact.id}@${artifact.version}: ${artifact.bundleRelative}\n`);
      return 0;
    } catch (error) {
      stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  writeUsage(stderr);
  return 2;
}

function pathForOutput(cwd, target) {
  const relative = path.relative(path.resolve(cwd), target);
  return relative || target;
}

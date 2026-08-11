import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readInstalledPackageManifest } from "../packages/cli/src/doctor.mjs";
import { runCli } from "../packages/cli/src/index.mjs";
import { COMPATIBILITY } from "../packages/cli/src/constants.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

const expectedVersions = {
  node: ">=22",
  pnpm: "10.34.3",
  perry: "0.5.1220",
  ui: "0.1.0",
  hostRuntime: "0.1.0",
  hostAbi: "0.5",
};

function temporaryDirectory(t, prefix = "nexa-cli-") {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function workspaceTemporaryDirectory(t) {
  const directory = mkdtempSync(path.join(workspaceRoot, ".nexa-cli-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function outputSink() {
  const chunks = [];
  return {
    stream: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
    value() {
      return chunks.join("");
    },
  };
}

function invoke(argv, options = {}) {
  const stdout = outputSink();
  const stderr = outputSink();
  const exitCode = runCli(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...options,
  });
  return { exitCode, stdout: stdout.value(), stderr: stderr.value() };
}

function projectFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory()
      ? projectFiles(path.join(directory, entry.name), relative)
      : relative;
  });
}

function manifestReader(overrides = {}) {
  const manifests = {
    "@perryts/perry": {
      name: "@perryts/perry",
      version: expectedVersions.perry,
    },
    "@nexa/nui-host": {
      name: "@nexa/nui-host",
      version: expectedVersions.hostRuntime,
      perry: { nativeLibrary: { abiVersion: expectedVersions.hostAbi } },
    },
    "@nexa/system-host": {
      name: "@nexa/system-host",
      version: expectedVersions.hostRuntime,
      perry: { nativeLibrary: { abiVersion: expectedVersions.hostAbi } },
    },
    ...overrides,
  };
  return (packageName) => manifests[packageName];
}

function versionRunner(overrides = {}) {
  const versions = {
    pnpm: { status: 0, stdout: `${expectedVersions.pnpm}\n`, stderr: "" },
    perry: { status: 0, stdout: `perry ${expectedVersions.perry}\n`, stderr: "" },
    ...overrides,
  };
  return (command, args) => {
    if (command === "pnpm" && args.length === 1 && args[0] === "--version") {
      return versions.pnpm;
    }
    if (command === process.execPath && args.length === 2 && args[1] === "--version") {
      return versions.perry;
    }
    throw new Error(`Unexpected doctor command: ${command} ${args.join(" ")}`);
  };
}

function runDoctor({
  runner = versionRunner(),
  readPackageManifest = manifestReader(),
  resolvePerryBin = () => "/fixture/perry/bin/perry.js",
  runtime = { nodeVersion: "22.23.1", platform: "darwin", arch: "arm64" },
} = {}) {
  return invoke(["doctor", "--json"], {
    runner,
    readPackageManifest,
    resolvePerryBin,
    runtime,
  });
}

function parseJsonOutput(result) {
  assert.equal(result.stderr, "", "--json must not mix human diagnostics into stderr");
  assert.match(result.stdout, /^\{.*\}\n$/u, "--json must emit one JSON object and a newline");
  return JSON.parse(result.stdout);
}

function checkById(report, id) {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `doctor report must contain ${id}`);
  return check;
}

test("CLI compatibility metadata matches every repository truth source", () => {
  const rootPackage = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
  const cliPackage = JSON.parse(
    readFileSync(path.join(workspaceRoot, "packages", "cli", "package.json"), "utf8"),
  );
  const protocol = JSON.parse(
    readFileSync(path.join(workspaceRoot, "protocol", "common.json"), "utf8"),
  );
  const uiPackage = JSON.parse(
    readFileSync(path.join(workspaceRoot, "packages", "ui", "package.json"), "utf8"),
  );
  const hostPackages = ["nui-host", "system-host"].map((packageName) =>
    JSON.parse(
      readFileSync(path.join(workspaceRoot, "packages", packageName, "package.json"), "utf8"),
    ),
  );

  assert.equal(COMPATIBILITY.cli, cliPackage.version);
  assert.equal(COMPATIBILITY.node, rootPackage.engines.node);
  assert.equal(COMPATIBILITY.pnpm, rootPackage.packageManager.split("@").at(-1));
  assert.equal(COMPATIBILITY.perry, rootPackage.devDependencies["@perryts/perry"]);
  assert.equal(
    COMPATIBILITY.typescript,
    rootPackage.devDependencies.typescript.replace(/^\^/u, ""),
  );
  assert.equal(
    COMPATIBILITY.protocol,
    `${protocol.protocol.major}.${protocol.protocol.minor}.${protocol.protocol.patch}`,
  );
  assert.equal(COMPATIBILITY.ui, uiPackage.version);
  for (const hostPackage of hostPackages) {
    assert.equal(COMPATIBILITY.hostRuntime, hostPackage.version);
    assert.equal(COMPATIBILITY.hostAbi, hostPackage.perry.nativeLibrary.abiVersion);
  }
});

function assertDoctorFailure(result, failedIds) {
  assert.equal(result.exitCode, 1);
  const report = parseJsonOutput(result);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.checks.filter((check) => !check.ok).map((check) => check.id),
    failedIds,
  );
  return report;
}

test("new generates a standalone Minimal TSX project with a deny-all manifest", (t) => {
  const cwd = temporaryDirectory(t);
  const result = invoke(["new", "my-app"], { cwd });
  const projectDirectory = path.join(cwd, "my-app");

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(projectFiles(projectDirectory).sort(), [
    ".gitignore",
    "README.md",
    "app.manifest.json",
    "package.json",
    path.join("src", "main.tsx"),
    "tsconfig.json",
  ]);

  const packageJson = JSON.parse(readFileSync(path.join(projectDirectory, "package.json"), "utf8"));
  assert.equal(packageJson.name, "my-app");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.packageManager, `pnpm@${expectedVersions.pnpm}`);
  assert.equal(packageJson.engines.node, expectedVersions.node);
  assert.equal(packageJson.dependencies["@nexa/ui"], expectedVersions.ui);
  assert.equal(packageJson.devDependencies["@perryts/perry"], expectedVersions.perry);
  for (const dependencyVersion of [
    ...Object.values(packageJson.dependencies ?? {}),
    ...Object.values(packageJson.devDependencies ?? {}),
  ]) {
    assert.doesNotMatch(dependencyVersion, /^workspace:/u);
  }
  assert.deepEqual(packageJson.perry.allow.nativeLibrary, [
    "@nexa/nui-host",
    "@nexa/system-host",
    "@nexa/ui",
  ]);
  assert.deepEqual(packageJson.perry.compilePackages, [
    "@nexa/ui",
    "@nexa/fs",
    "@nexa/dialog",
    "@nexa/clipboard",
    "@nexa/protocol",
    "@nexa/nui-host",
    "@nexa/system-host",
  ]);
  assert.deepEqual(packageJson.perry.allow.compilePackages, packageJson.perry.compilePackages);

  const tsconfig = JSON.parse(readFileSync(path.join(projectDirectory, "tsconfig.json"), "utf8"));
  assert.equal(Object.hasOwn(tsconfig, "extends"), false);
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.jsx, "react-jsx");
  assert.equal(tsconfig.compilerOptions.jsxImportSource, "@nexa/ui");
  assert.equal(tsconfig.compilerOptions.moduleResolution, "Bundler");

  const manifest = JSON.parse(
    readFileSync(path.join(projectDirectory, "app.manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest, {
    $schema: "https://nexa-ui.dev/schema/app-manifest-v1.json",
    schemaVersion: 1,
    id: "dev.nexa.my-app",
    name: "My App",
    version: "0.1.0",
    requiredProtocol: { major: 1, minor: 0 },
    permissions: [],
  });

  const source = readFileSync(path.join(projectDirectory, "src", "main.tsx"), "utf8");
  assert.match(source, /from "@nexa\/ui"/u);
  assert.match(source, /<Window title="My App">/u);
  assert.match(source, /mount\(App\)/u);
  assert.match(readFileSync(path.join(projectDirectory, "README.md"), "utf8"), /My App/u);
});

test("generated template typechecks and explains Nexa package availability", (t) => {
  const cwd = workspaceTemporaryDirectory(t);
  const result = invoke(["new", "parseable-app"], { cwd });
  assert.equal(result.exitCode, 0, result.stderr);

  const projectDirectory = path.join(cwd, "parseable-app");
  const scopeDirectory = path.join(projectDirectory, "node_modules", "@nexa");
  mkdirSync(scopeDirectory, { recursive: true });
  symlinkSync(
    path.join(workspaceRoot, "packages", "ui"),
    path.join(scopeDirectory, "ui"),
    directoryLinkType,
  );
  const typecheck = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "tsc", "-p", "tsconfig.json", "--noEmit"],
    {
      cwd: projectDirectory,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout);
  assert.match(
    readFileSync(path.join(projectDirectory, "README.md"), "utf8"),
    /registry|published|access/u,
  );
});

test("new rejects absolute paths without creating or overwriting the target", (t) => {
  const cwd = temporaryDirectory(t);
  const absoluteTarget = path.join(temporaryDirectory(t, "nexa-cli-absolute-"), "app");

  const result = invoke(["new", absoluteTarget], { cwd });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /absolute path/u);
  assert.equal(existsSync(absoluteTarget), false);
});

test("new rejects parent traversal without writing outside cwd", (t) => {
  const root = temporaryDirectory(t);
  const cwd = path.join(root, "workspace");
  mkdirSync(cwd);
  const escapedTarget = path.join(root, "escaped-app");

  const result = invoke(["new", "../escaped-app"], { cwd });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /outside|traversal|\.\./u);
  assert.equal(existsSync(escapedTarget), false);
});

test("new rejects symlink targets and symlinked parent directories", (t) => {
  const root = temporaryDirectory(t);
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  mkdirSync(cwd);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "keep.txt"), "unchanged");

  const targetLink = path.join(cwd, "linked-app");
  symlinkSync(outside, targetLink, directoryLinkType);
  const linkedTargetResult = invoke(["new", "linked-app"], { cwd });
  assert.equal(linkedTargetResult.exitCode, 1);
  assert.match(linkedTargetResult.stderr, /symbolic link|symlink/u);
  assert.equal(lstatSync(targetLink).isSymbolicLink(), true);

  const parentLink = path.join(cwd, "linked-parent");
  symlinkSync(outside, parentLink, directoryLinkType);
  const linkedParentResult = invoke(["new", path.join("linked-parent", "app")], { cwd });
  assert.equal(linkedParentResult.exitCode, 1);
  assert.match(linkedParentResult.stderr, /symbolic link|symlink/u);
  assert.equal(existsSync(path.join(outside, "app")), false);
  assert.equal(readFileSync(path.join(outside, "keep.txt"), "utf8"), "unchanged");
});

test("new rejects a non-empty directory and preserves every existing byte", (t) => {
  const cwd = temporaryDirectory(t);
  const target = path.join(cwd, "existing-app");
  mkdirSync(target);
  const existingFile = path.join(target, "keep.txt");
  writeFileSync(existingFile, "do not overwrite\n");

  const result = invoke(["new", "existing-app"], { cwd });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not empty|non-empty/u);
  assert.deepEqual(projectFiles(target), ["keep.txt"]);
  assert.equal(readFileSync(existingFile, "utf8"), "do not overwrite\n");
});

test("new can populate an existing empty directory", (t) => {
  const cwd = temporaryDirectory(t);
  const target = path.join(cwd, "empty-app");
  mkdirSync(target);

  const result = invoke(["new", "empty-app"], { cwd });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(projectFiles(target).sort(), [
    ".gitignore",
    "README.md",
    "app.manifest.json",
    "package.json",
    path.join("src", "main.tsx"),
    "tsconfig.json",
  ]);
});

test("new rejects unsafe project names before creating files", (t) => {
  const cwd = temporaryDirectory(t);

  for (const name of ["Uppercase", "under_score", "con", "./-leading", "trailing-"]) {
    const result = invoke(["new", name], { cwd });
    assert.equal(result.exitCode, 1, `${name} must be rejected`);
    assert.match(result.stderr, /project name|reserved/u);
    assert.equal(existsSync(path.resolve(cwd, name)), false);
  }
});

test("doctor reports the pinned toolchain, both Hosts, ABI, and supported target", () => {
  const result = runDoctor();

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const report = parseJsonOutput(result);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, true);
  assert.deepEqual(report.target, { platform: "darwin", arch: "arm64" });
  assert.deepEqual(
    report.checks.map((check) => check.id),
    [
      "node",
      "pnpm",
      "perry",
      "nui-host-runtime",
      "nui-host-abi",
      "system-host-runtime",
      "system-host-abi",
      "target",
    ],
  );
  assert.ok(report.checks.every((check) => check.ok));
  assert.deepEqual(checkById(report, "pnpm"), {
    id: "pnpm",
    ok: true,
    expected: expectedVersions.pnpm,
    actual: expectedVersions.pnpm,
  });
  assert.deepEqual(checkById(report, "perry"), {
    id: "perry",
    ok: true,
    expected: expectedVersions.perry,
    actual: expectedVersions.perry,
  });
});

test("doctor returns clean JSON and a non-zero exit for Node and pnpm mismatches", () => {
  const result = runDoctor({
    runtime: { nodeVersion: "20.19.0", platform: "darwin", arch: "arm64" },
    runner: versionRunner({ pnpm: { status: 0, stdout: "9.15.0\n", stderr: "" } }),
  });

  const report = assertDoctorFailure(result, ["node", "pnpm"]);
  assert.equal(checkById(report, "node").actual, "20.19.0");
  assert.equal(checkById(report, "node").expected, expectedVersions.node);
  assert.equal(checkById(report, "pnpm").actual, "9.15.0");
});

test("doctor returns clean JSON and a non-zero exit for a Perry mismatch", () => {
  const result = runDoctor({
    runner: versionRunner({
      perry: { status: 0, stdout: "perry 0.5.1219\n", stderr: "" },
    }),
  });

  const report = assertDoctorFailure(result, ["perry"]);
  assert.equal(checkById(report, "perry").actual, "0.5.1219");
  assert.equal(checkById(report, "perry").expected, expectedVersions.perry);
});

test("doctor cannot accept a PATH-only Perry when the project package is missing", () => {
  const installedManifests = manifestReader();
  const result = runDoctor({
    readPackageManifest(packageName) {
      if (packageName === "@perryts/perry") {
        throw new Error("project-local Perry is not installed");
      }
      return installedManifests(packageName);
    },
  });

  const report = assertDoctorFailure(result, ["perry"]);
  assert.equal(checkById(report, "perry").actual, "unavailable");
  assert.match(checkById(report, "perry").detail, /project-local|not installed/u);
});

test("package resolution cannot escape a project dependency graph through an ancestor", (t) => {
  const root = temporaryDirectory(t);
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "project" }));

  const ancestorPackageDirectory = path.join(root, "node_modules", "@nexa", "ui");
  mkdirSync(ancestorPackageDirectory, { recursive: true });
  writeFileSync(
    path.join(ancestorPackageDirectory, "package.json"),
    JSON.stringify({ name: "@nexa/ui", version: expectedVersions.ui }),
  );
  writeFileSync(path.join(ancestorPackageDirectory, "index.js"), "export {};\n");

  assert.throws(
    () => readInstalledPackageManifest("@nexa/ui", cwd),
    /dependency graph|not declared|Could not resolve/u,
  );
});

test("doctor rejects Perry output with warnings or more than one version", () => {
  const result = runDoctor({
    runner: versionRunner({
      perry: {
        status: 0,
        stdout: `warning: compatibility ${expectedVersions.perry}\nperry ${expectedVersions.perry}\n`,
        stderr: "",
      },
    }),
  });

  const report = assertDoctorFailure(result, ["perry"]);
  assert.equal(checkById(report, "perry").actual, "unavailable");
  assert.match(checkById(report, "perry").detail, /Unexpected output/u);
});

test("doctor diagnoses UI Host runtime and System Host ABI mismatches independently", () => {
  const result = runDoctor({
    readPackageManifest: manifestReader({
      "@nexa/nui-host": {
        name: "@nexa/nui-host",
        version: "0.2.0",
        perry: { nativeLibrary: { abiVersion: expectedVersions.hostAbi } },
      },
      "@nexa/system-host": {
        name: "@nexa/system-host",
        version: expectedVersions.hostRuntime,
        perry: { nativeLibrary: { abiVersion: "0.6" } },
      },
    }),
  });

  const report = assertDoctorFailure(result, ["nui-host-runtime", "system-host-abi"]);
  assert.equal(checkById(report, "nui-host-runtime").actual, "0.2.0");
  assert.equal(checkById(report, "system-host-abi").actual, "0.6");
});

test("doctor diagnoses System Host runtime and UI Host ABI mismatches independently", () => {
  const result = runDoctor({
    readPackageManifest: manifestReader({
      "@nexa/nui-host": {
        name: "@nexa/nui-host",
        version: expectedVersions.hostRuntime,
        perry: { nativeLibrary: { abiVersion: "1.0" } },
      },
      "@nexa/system-host": {
        name: "@nexa/system-host",
        version: "0.0.9",
        perry: { nativeLibrary: { abiVersion: expectedVersions.hostAbi } },
      },
    }),
  });

  const report = assertDoctorFailure(result, ["nui-host-abi", "system-host-runtime"]);
  assert.equal(checkById(report, "nui-host-abi").actual, "1.0");
  assert.equal(checkById(report, "system-host-runtime").actual, "0.0.9");
});

test("doctor rejects unsupported Technical Preview targets", () => {
  const result = runDoctor({
    runtime: { nodeVersion: "22.23.1", platform: "linux", arch: "x64" },
  });

  const report = assertDoctorFailure(result, ["target"]);
  assert.equal(checkById(report, "target").actual, "linux/x64");
  assert.match(checkById(report, "target").expected, /darwin|win32/u);
});

test("doctor reports missing tools and Host manifests as structured failures", () => {
  const result = runDoctor({
    runner(command, args) {
      if (args[0] === "--version") {
        return { status: null, stdout: "", stderr: "", error: new Error(`${command} missing`) };
      }
      return { status: 1, stdout: "", stderr: "Perry is unavailable" };
    },
    readPackageManifest(packageName) {
      throw new Error(`${packageName} is not installed`);
    },
  });

  const report = assertDoctorFailure(result, [
    "pnpm",
    "perry",
    "nui-host-runtime",
    "nui-host-abi",
    "system-host-runtime",
    "system-host-abi",
  ]);
  for (const id of ["pnpm", "perry", "nui-host-runtime", "system-host-runtime"]) {
    assert.equal(checkById(report, id).actual, "unavailable");
  }
});

test("doctor uses the Windows pnpm executable and accepts the x64 target", () => {
  const calls = [];
  const result = runDoctor({
    runtime: { nodeVersion: "22.23.1", platform: "win32", arch: "x64" },
    runner(command, args) {
      calls.push([command, ...args]);
      if (args.length === 1) {
        return { status: 0, stdout: `${expectedVersions.pnpm}\n`, stderr: "" };
      }
      return { status: 0, stdout: `perry ${expectedVersions.perry}\n`, stderr: "" };
    },
  });

  const report = parseJsonOutput(result);
  assert.equal(result.exitCode, 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.target, { platform: "win32", arch: "x64" });
  assert.deepEqual(calls, [
    ["pnpm.cmd", "--version"],
    [process.execPath, "/fixture/perry/bin/perry.js", "--version"],
  ]);
});

test("help prints usage while missing commands and unknown options fail with usage", () => {
  for (const argv of [["--help"], ["new", "--help"], ["doctor", "-h"]]) {
    const help = invoke(argv);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /Usage:\s+nexa/u);
    assert.equal(help.stderr, "");
  }

  const version = invoke(["--version"]);
  assert.deepEqual(version, { exitCode: 0, stdout: "0.1.0\n", stderr: "" });

  for (const argv of [
    [],
    ["unknown"],
    ["doctor", "--unknown"],
    ["new"],
    ["new", "--unknown"],
    ["new", "app", "--x"],
  ]) {
    const result = invoke(argv);
    assert.equal(result.exitCode, 2, `${argv.join(" ")} should be a usage error`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:\s+nexa/u);
  }
});

test("the package bin runs and the default doctor resolves this workspace", () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(workspaceRoot, "packages", "cli", "package.json"), "utf8"),
  );
  assert.deepEqual(packageJson.bin, { nexa: "./dist/bin.mjs" });
  const build = spawnSync(
    process.execPath,
    [path.join(workspaceRoot, "tools", "build-release-packages.mjs"), "--package", "@nexa/cli"],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const packagedCli = path.join(workspaceRoot, "packages", "cli", "dist", "bin.mjs");

  const help = spawnSync(process.execPath, [packagedCli, "--help"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /Usage:\s+nexa/u);

  const doctor = spawnSync(process.execPath, [packagedCli, "doctor", "--json"], {
    cwd: path.join(workspaceRoot, "examples", "reference-notes"),
    encoding: "utf8",
  });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.equal(doctor.stderr, "");
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true);
  assert.equal(checkById(report, "nui-host-abi").actual, expectedVersions.hostAbi);
  assert.equal(checkById(report, "system-host-abi").actual, expectedVersions.hostAbi);
});

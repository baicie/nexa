import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMPATIBILITY } from "../packages/cli/src/constants.mjs";
import { runCli } from "../packages/cli/src/index.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestSchema = JSON.parse(
  readFileSync(path.join(workspaceRoot, "protocol", "schema", "app-manifest.schema.json"), "utf8"),
);
const systemProtocol = JSON.parse(
  readFileSync(path.join(workspaceRoot, "protocol", "system-host.json"), "utf8"),
);
const commonProtocol = JSON.parse(
  readFileSync(path.join(workspaceRoot, "protocol", "common.json"), "utf8"),
);
const dialogFixtureCanary = "nexa-ui-dialog-open.txt";

const validManifest = {
  $schema: "https://nexa-ui.dev/schema/app-manifest-v1.json",
  schemaVersion: 1,
  id: "dev.nexa.temp-app",
  name: "Temp App",
  version: "0.1.0",
  requiredProtocol: { major: 1, minor: 0 },
  permissions: ["system.FsRead"],
};

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-cli-build-"));
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
  return { exitCode, stderr: stderr.value(), stdout: stdout.value() };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fakePerrySource() {
  return `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const record = {
  args,
  cwd: process.cwd(),
  manifestPath: process.env.NEXA_APP_MANIFEST_PATH,
  hasDialogFixture: Object.hasOwn(process.env, "NEXA_DIALOG_TEST_FIXTURE_PATH"),
  hasSkipCodegen: Object.hasOwn(process.env, "PERRY_SKIP_CODEGEN"),
};
writeFileSync(process.env.NEXA_TEST_LOG, JSON.stringify(record));

if (args[0] === "compile") {
  const output = args[args.indexOf("-o") + 1];
  const outputPath = path.resolve(process.cwd(), output);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    Buffer.concat([readFileSync(process.env.NEXA_APP_MANIFEST_PATH), Buffer.from("\\0fake-binary")]),
  );
}
`;
}

function projectFixture(t, { manifest = validManifest, perryVersion = COMPATIBILITY.perry } = {}) {
  const cwd = temporaryDirectory(t);
  const sourceDirectory = path.join(cwd, "src");
  const perryDirectory = path.join(cwd, "node_modules", "@perryts", "perry");
  const perryBin = path.join(perryDirectory, "bin", "perry.js");
  const logPath = path.join(cwd, "perry-call.json");

  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(path.dirname(perryBin), { recursive: true });
  writeJson(path.join(cwd, "package.json"), {
    name: "temp-app",
    private: true,
    type: "module",
    devDependencies: { "@perryts/perry": perryVersion },
  });
  writeFileSync(path.join(sourceDirectory, "main.tsx"), "export {};\n");
  writeJson(path.join(cwd, "app.manifest.json"), manifest);
  writeJson(path.join(perryDirectory, "package.json"), {
    name: "@perryts/perry",
    version: perryVersion,
    type: "module",
    bin: { perry: "bin/perry.js" },
  });
  writeFileSync(perryBin, fakePerrySource());

  return {
    cwd,
    environment: {
      ...process.env,
      NEXA_DIALOG_TEST_FIXTURE_PATH: path.join(cwd, "must-not-leak.json"),
      NEXA_TEST_LOG: logPath,
      PERRY_SKIP_CODEGEN: "1",
    },
    logPath,
    manifestPath: path.join(cwd, "app.manifest.json"),
    perryBin,
  };
}

function supportedRuntime(platform = "darwin") {
  return platform === "win32"
    ? { arch: "x64", platform: "win32" }
    : { arch: "arm64", platform: "darwin" };
}

test("build executes the project-local Perry bin and verifies embedded manifest bytes", (t) => {
  const fixture = projectFixture(t);
  const result = invoke(["build"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    runtime: supportedRuntime(),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Built dev\.nexa\.temp-app@0\.1\.0: dist\/temp-app\n$/u);

  const call = JSON.parse(readFileSync(fixture.logPath, "utf8"));
  assert.deepEqual(call.args, ["compile", "src/main.tsx", "-o", path.join("dist", "temp-app")]);
  assert.equal(call.cwd, realpathSync(fixture.cwd));
  assert.equal(call.manifestPath, fixture.manifestPath);
  assert.equal(call.hasDialogFixture, false);
  assert.equal(call.hasSkipCodegen, false);

  const manifestBytes = readFileSync(fixture.manifestPath);
  const binary = readFileSync(path.join(fixture.cwd, "dist", "temp-app"));
  assert.equal(binary.includes(manifestBytes), true);
});

test("Windows build selects an exe and the GUI subsystem without a shell", (t) => {
  const fixture = projectFixture(t);
  const calls = [];
  const result = invoke(["build"], {
    cwd: fixture.cwd,
    environment: {
      ...fixture.environment,
      nexa_app_manifest_path: "C:\\stale-manifest.json",
      nexa_dialog_test_fixture_path: "C:\\fixture.json",
      perry_skip_codegen: "1",
    },
    runtime: supportedRuntime("win32"),
    runner(command, args, options) {
      calls.push({ args, command, options });
      const binaryPath = path.join(fixture.cwd, "dist", "temp-app.exe");
      writeFileSync(binaryPath, readFileSync(fixture.manifestPath));
      return { status: 0 };
    },
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    realpathSync(fixture.perryBin),
    "compile",
    "src/main.tsx",
    "-o",
    path.join("dist", "temp-app"),
    "--windows-subsystem",
    "windows",
  ]);
  assert.equal(calls[0].options.cwd, fixture.cwd);
  assert.equal(calls[0].options.stdio, "inherit");
  const environmentKeys = Object.keys(calls[0].options.env).map((key) => key.toUpperCase());
  assert.equal(environmentKeys.filter((key) => key === "NEXA_APP_MANIFEST_PATH").length, 1);
  assert.equal(environmentKeys.includes("NEXA_DIALOG_TEST_FIXTURE_PATH"), false);
  assert.equal(environmentKeys.includes("PERRY_SKIP_CODEGEN"), false);
});

test("dev delegates watch, recompile, and run to project-local Perry", (t) => {
  const fixture = projectFixture(t);
  const result = invoke(["dev"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    runtime: supportedRuntime(),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^Starting dev\.nexa\.temp-app from src\/main\.tsx\n$/u);
  const call = JSON.parse(readFileSync(fixture.logPath, "utf8"));
  assert.deepEqual(call.args, ["dev", "src/main.tsx", "-o", path.join(".nexa", "dev", "temp-app")]);
  assert.equal(call.manifestPath, fixture.manifestPath);
  assert.equal(call.hasDialogFixture, false);
  assert.equal(call.hasSkipCodegen, false);
});

test("manifest validation fails closed before starting Perry", (t) => {
  const fixture = projectFixture(t);
  const invalidManifests = [
    { ...validManifest, extra: true },
    { ...validManifest, requiredProtocol: { major: 2, minor: 0 } },
    { ...validManifest, permissions: ["system.Unknown"] },
    { ...validManifest, permissions: ["system.FsRead", "system.FsRead"] },
    { ...validManifest, version: "1.0.0-01" },
    { ...validManifest, name: "Bad\nName" },
    { ...validManifest, name: "\u00a0" },
    { ...validManifest, name: "Invalid \ufffe XML" },
  ];
  let calls = 0;

  for (const manifest of invalidManifests) {
    writeJson(fixture.manifestPath, manifest);
    const result = invoke(["build"], {
      cwd: fixture.cwd,
      runtime: supportedRuntime(),
      runner() {
        calls += 1;
        return { status: 0 };
      },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(manifest));
    assert.match(result.stderr, /^Error: .*manifest/iu);
    assert.doesNotMatch(result.stdout, /Built/u);
  }
  assert.equal(calls, 0);
});

test("build rejects oversized and symlinked manifests before starting Perry", (t) => {
  const fixture = projectFixture(t);
  let calls = 0;
  const runner = () => {
    calls += 1;
    return { status: 0 };
  };

  writeFileSync(fixture.manifestPath, Buffer.alloc(64 * 1024 + 1, 0x20));
  const oversized = invoke(["build"], {
    cwd: fixture.cwd,
    runtime: supportedRuntime(),
    runner,
  });
  assert.equal(oversized.exitCode, 1);
  assert.match(oversized.stderr, /64 KiB|65536/u);

  rmSync(fixture.manifestPath);
  const outsideManifest = path.join(fixture.cwd, "outside-manifest.json");
  writeJson(outsideManifest, validManifest);
  symlinkSync(outsideManifest, fixture.manifestPath, "file");
  const symlinked = invoke(["build"], {
    cwd: fixture.cwd,
    runtime: supportedRuntime(),
    runner,
  });
  assert.equal(symlinked.exitCode, 1);
  assert.match(symlinked.stderr, /symbolic link|regular file/u);
  assert.equal(calls, 0);
});

test("build rejects mismatched Perry versions and unsupported targets", (t) => {
  const wrongPerry = projectFixture(t, { perryVersion: "0.5.1219" });
  const versionResult = invoke(["build"], {
    cwd: wrongPerry.cwd,
    runtime: supportedRuntime(),
  });
  assert.equal(versionResult.exitCode, 1);
  assert.match(versionResult.stderr, /Perry.*0\.5\.1219.*0\.5\.1220/iu);

  const fixture = projectFixture(t);
  const targetResult = invoke(["build"], {
    cwd: fixture.cwd,
    runtime: { arch: "x64", platform: "linux" },
  });
  assert.equal(targetResult.exitCode, 1);
  assert.match(targetResult.stderr, /unsupported.*linux\/x64/iu);
});

test("build reports child failure and never accepts a missing artifact", (t) => {
  const fixture = projectFixture(t);
  const failed = invoke(["build"], {
    cwd: fixture.cwd,
    runtime: supportedRuntime(),
    runner: () => ({ status: 17 }),
  });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /compile.*17/iu);
  assert.doesNotMatch(failed.stdout, /Built/u);

  const missing = invoke(["build"], {
    cwd: fixture.cwd,
    runtime: supportedRuntime(),
    runner: () => ({ status: 0 }),
  });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /binary.*does not exist|missing.*artifact/iu);
  assert.doesNotMatch(missing.stdout, /Built/u);
});

test("build rejects a mismatched or test-contaminated binary", (t) => {
  const fixture = projectFixture(t);
  const outputPath = path.join(fixture.cwd, "dist", "temp-app");

  const mismatched = invoke(["build"], {
    cwd: fixture.cwd,
    runtime: supportedRuntime(),
    runner() {
      writeFileSync(outputPath, "not the manifest");
      return { status: 0 };
    },
  });
  assert.equal(mismatched.exitCode, 1);
  assert.match(mismatched.stderr, /embedded manifest.*match|manifest bytes/iu);

  const contaminated = invoke(["build"], {
    cwd: fixture.cwd,
    runtime: supportedRuntime(),
    runner() {
      writeFileSync(
        outputPath,
        Buffer.concat([
          readFileSync(fixture.manifestPath),
          Buffer.from(`\0${dialogFixtureCanary}\0`),
        ]),
      );
      return { status: 0 };
    },
  });
  assert.equal(contaminated.exitCode, 1);
  assert.match(contaminated.stderr, /Dialog test fixture/u);
});

test("build never follows a dangling output symlink", (t) => {
  const fixture = projectFixture(t);
  const outputDirectory = path.join(fixture.cwd, "dist");
  const outsidePath = path.join(fixture.cwd, "outside-binary");
  const outputPath = path.join(outputDirectory, "temp-app");
  mkdirSync(outputDirectory);
  symlinkSync(outsidePath, outputPath, "file");
  let calls = 0;

  const result = invoke(["build"], {
    cwd: fixture.cwd,
    runtime: supportedRuntime(),
    runner() {
      calls += 1;
      writeFileSync(outputPath, readFileSync(fixture.manifestPath));
      return { status: 0 };
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /binary path.*regular file|symbolic link/iu);
  assert.equal(calls, 0);
  assert.equal(existsSync(outsidePath), false);
});

test("generated projects use real CLI dev/build scripts and ignore owned outputs", (t) => {
  const cwd = temporaryDirectory(t);
  const result = invoke(["new", "generated-app"], { cwd });
  assert.equal(result.exitCode, 0, result.stderr);

  const projectDirectory = path.join(cwd, "generated-app");
  const packageJson = JSON.parse(readFileSync(path.join(projectDirectory, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.dev, "nexa dev");
  assert.equal(packageJson.scripts.build, "nexa build");
  assert.equal(packageJson.scripts.doctor, "nexa doctor");
  assert.equal(
    readFileSync(path.join(projectDirectory, ".gitignore"), "utf8"),
    "node_modules/\ndist/\n.nexa/\n.nexa-package-*/\n",
  );
});

test("manifest compatibility constants stay bound to the canonical schema", async () => {
  const constants = await import("../packages/cli/src/constants.mjs");
  const activePermissions = systemProtocol.permissions
    .filter((permission) => permission.lifecycle.status === "active")
    .map((permission) => `system.${permission.name}`)
    .sort();

  assert.equal(constants.APP_MANIFEST_MAX_BYTES, 64 * 1024);
  assert.deepEqual([...constants.APP_MANIFEST_PERMISSIONS].sort(), activePermissions);
  assert.deepEqual(
    [...constants.APP_MANIFEST_PERMISSIONS].sort(),
    [...manifestSchema.properties.permissions.items.enum].sort(),
  );
  assert.equal(constants.APP_MANIFEST_PROTOCOL.major, 1);
  assert.equal(constants.APP_MANIFEST_PROTOCOL.minor, 0);
  assert.equal(constants.APP_MANIFEST_PROTOCOL.major, commonProtocol.protocol.major);
  assert.equal(constants.APP_MANIFEST_PROTOCOL.minor, commonProtocol.protocol.minor);
});

test("dev/build help is successful and unsupported options are usage errors", () => {
  for (const argv of [
    ["dev", "--help"],
    ["build", "-h"],
  ]) {
    const result = invoke(argv);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /nexa dev/u);
    assert.match(result.stdout, /nexa build/u);
    assert.equal(result.stderr, "");
  }

  for (const argv of [
    ["dev", "src/other.tsx"],
    ["build", "--json"],
  ]) {
    const result = invoke(argv);
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:\s+nexa/u);
  }
});

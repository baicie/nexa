import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAllReleasePackages } from "./build-release-packages.mjs";
import { cargoDependencyRoots, collectDependencyGraph } from "./release-dependency-graph.mjs";
import { generateEvidence, verifyEvidence } from "./release-evidence.mjs";
import { stageWindowsSkia } from "./stage-windows-skia.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const release = JSON.parse(readFileSync(path.join(root, "release/packages.json"), "utf8"));
const version = JSON.parse(readFileSync(path.join(root, "release/version.json"), "utf8"));
const repository = "https://github.com/baicie/nexa-ui";
const builderId = `${repository}/.github/workflows/release-rehearsal.yml`;
const buildType = "https://nexa-ui.dev/build-types/technical-preview/v1";
const nuiHostLinkMarker = Buffer.from("nexa-nui-host");
const publicRuntimeCompilePackages = ["solid-js"];

function portablePath(value) {
  return value.split(path.sep).join("/");
}

function replaceEnvironmentCaseInsensitive(environment, values) {
  const names = new Set(Object.keys(values).map((name) => name.toUpperCase()));
  return {
    ...Object.fromEntries(
      Object.entries(environment ?? {}).filter(([name]) => !names.has(name.toUpperCase())),
    ),
    ...values,
  };
}

function run(command, args, { cwd = root, capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    env,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const output = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status ?? "no status"}${output}`,
    );
  }
  return capture ? result.stdout : "";
}

function git(args) {
  return run("git", args, { capture: true }).trim();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assertNewDirectory(directory) {
  if (existsSync(directory))
    throw new Error(`release rehearsal output already exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`release rehearsal output must be an owned directory: ${directory}`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function tarballSpec(fileName) {
  return `file:../artifacts/${fileName}`;
}

export function assertNativeHostsLinked(binary, manifestSource) {
  if (!binary.includes(manifestSource)) {
    throw new Error("final binary does not contain the System Host archive manifest bytes");
  }
  if (!binary.includes(nuiHostLinkMarker)) {
    throw new Error("final binary does not contain the NUI Host archive link marker");
  }
  return true;
}

export function createConsumerManifest(tarballs) {
  const specifications = Object.fromEntries(
    release.npm.public.map(({ name }) => {
      const file = tarballs.get(name);
      if (!file) throw new Error(`missing tarball for ${name}`);
      return [name, tarballSpec(path.basename(file))];
    }),
  );
  return {
    name: "nexa-release-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: `pnpm@${version.pnpm}`,
    engines: { node: version.node, pnpm: ">=9" },
    scripts: {
      build: "nexa build",
      doctor: "nexa doctor --json",
      package: "nexa package",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    dependencies: specifications,
    devDependencies: {
      "@perryts/perry": version.perry,
      typescript: version.typescript,
    },
    perry: {
      compilePackages: release.npm.public
        .map(({ name }) => name)
        .filter((name) => name !== "@nexa/cli")
        .concat(publicRuntimeCompilePackages),
      allow: {
        nativeLibrary: ["@nexa/nui-host", "@nexa/system-host", "@nexa/ui"],
        compilePackages: release.npm.public
          .map(({ name }) => name)
          .filter((name) => name !== "@nexa/cli")
          .concat(publicRuntimeCompilePackages),
      },
    },
    pnpm: { overrides: specifications },
  };
}

function packPublicPackages(artifactsDirectory) {
  const tarballs = new Map();
  for (const entry of release.npm.public) {
    const before = new Set(readdirSync(artifactsDirectory));
    run("pnpm", ["--dir", entry.path, "pack", "--pack-destination", artifactsDirectory], {
      capture: true,
    });
    const created = readdirSync(artifactsDirectory).filter(
      (name) => name.endsWith(".tgz") && !before.has(name),
    );
    if (created.length !== 1) {
      throw new Error(`${entry.name} pack produced ${created.length} new tarballs`);
    }
    tarballs.set(entry.name, path.join(artifactsDirectory, created[0]));
  }
  return tarballs;
}

function createDescriptor(outputDirectory) {
  const revision = git(["rev-parse", "HEAD"]);
  const sourceDateEpoch = Number(git(["show", "-s", "--format=%ct", revision]));
  const dirty = git(["status", "--porcelain"]).length > 0;
  const materials = [
    "pnpm-lock.yaml",
    "Cargo.lock",
    ...cargoDependencyRoots.map(({ lockfile }) => lockfile),
  ].map((file) => ({
    uri: `${repository}/blob/${revision}/${file}`,
    digest: { sha256: sha256(path.join(root, file)) },
  }));
  const descriptorPath = path.join(outputDirectory, "descriptor.json");
  const dependencyGraph = collectDependencyGraph({
    rootDirectory: root,
    publicPackageNames: release.npm.public.map(({ name }) => name),
  });
  writeJson(descriptorPath, {
    schemaVersion: 1,
    release: { name: "nexa-ui", version: version.npmTrain },
    source: { repository, revision, dirty },
    build: { builderId, buildType, sourceDateEpoch },
    materials,
    dependencyGraph,
  });
  return descriptorPath;
}

function createConsumerProject(consumerDirectory, tarballs) {
  mkdirSync(path.join(consumerDirectory, "src"), { recursive: true });
  writeJson(path.join(consumerDirectory, "package.json"), createConsumerManifest(tarballs));
  writeJson(path.join(consumerDirectory, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022"],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
      jsx: "react-jsx",
      jsxImportSource: "@nexa/ui",
      noEmit: true,
      types: [],
    },
    include: ["src/**/*.ts", "src/**/*.tsx"],
  });
  writeJson(path.join(consumerDirectory, "app.manifest.json"), {
    $schema: "https://nexa-ui.dev/schema/app-manifest-v1.json",
    schemaVersion: 1,
    id: "dev.nexa.release-consumer",
    name: "Release Consumer",
    version: "0.1.0",
    requiredProtocol: { major: 1, minor: 0 },
    permissions: [],
  });
  writeFileSync(
    path.join(consumerDirectory, "src", "main.tsx"),
    `import { Button, Column, Text, Window, mount, signal } from "@nexa/ui";\nimport { readTextFile } from "@nexa/fs";\n\nconst count = signal(0);\nfunction readProbe() {\n  void readTextFile("release-consumer-probe.txt");\n}\nmount(() => (\n  <Window title="Release Consumer">\n    <Column padding={24} gap={12}>\n      <Text>Count: {count}</Text>\n      <Button onClick={() => count.value++}>Increment</Button>\n      <Button onClick={readProbe}>Read probe</Button>\n    </Column>\n  </Window>\n));\n`,
    { flag: "wx" },
  );
  writeFileSync(
    path.join(consumerDirectory, "src", "contracts.ts"),
    `import { readText, writeText } from "@nexa/clipboard";\nimport { openFile, saveFile } from "@nexa/dialog";\nimport { readTextFile, writeTextFile } from "@nexa/fs";\nimport { Common, Ui } from "@nexa/protocol";\nimport type { CommandResult } from "@nexa/system-host";\n\nexport const contract = { readText, writeText, openFile, saveFile, readTextFile, writeTextFile, Common, Ui };\nexport type Result = CommandResult<string>;\n`,
    { flag: "wx" },
  );
}

function verifyDoctor(consumerDirectory) {
  const output = run("pnpm", ["exec", "nexa", "doctor", "--json"], {
    cwd: consumerDirectory,
    capture: true,
  });
  const report = JSON.parse(output);
  if (report.schemaVersion !== 1 || report.ok !== true) {
    throw new Error(`consumer doctor failed: ${output}`);
  }
  writeFileSync(
    path.join(consumerDirectory, "doctor.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

function verifyNodeImports(consumerDirectory) {
  const packages = release.npm.public
    .filter((entry) => entry.name !== "@nexa/cli")
    .map(({ name }) => name);
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `for (const packageName of ${JSON.stringify(packages)}) await import(packageName);`,
    ],
    { cwd: consumerDirectory },
  );
}

export function prepareNativeConsumerEnvironment({
  consumerDirectory,
  environment = process.env,
  runtime = { platform: process.platform, arch: process.arch },
  stageSkia = stageWindowsSkia,
} = {}) {
  const consumer = path.resolve(consumerDirectory);
  const nativeEnvironment = replaceEnvironmentCaseInsensitive(environment, {
    NEXA_REQUIRE_INSTALLED_HOSTS: "1",
  });
  if (runtime.platform !== "win32") {
    return { environment: nativeEnvironment, windowsSkia: null };
  }
  if (runtime.arch !== "x64") {
    throw new Error(`release consumer does not support Windows ${runtime.arch}`);
  }
  const archivePath = nativeEnvironment.NEXA_WINDOWS_SKIA_ARCHIVE;
  if (typeof archivePath !== "string" || !path.isAbsolute(archivePath)) {
    throw new Error("NEXA_WINDOWS_SKIA_ARCHIVE must be an absolute path on Windows");
  }
  const staged = stageSkia({
    projectDirectory: consumer,
    archivePath,
    expectedSha256: nativeEnvironment.SKIA_WINDOWS_ARCHIVE_SHA256,
    environment: nativeEnvironment,
  });
  const relativeDestination = path.relative(consumer, staged.destination);
  if (
    relativeDestination === "" ||
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDestination)
  ) {
    throw new Error("staged Windows Skia directory must stay inside the clean consumer");
  }
  return {
    environment: nativeEnvironment,
    windowsSkia: {
      destination: portablePath(relativeDestination),
      sha256: staged.sha256,
    },
  };
}

export function releaseRehearsalPlan() {
  return {
    schemaVersion: 1,
    packages: release.npm.public.map(({ name }) => name),
    stages: [
      "build-dist",
      "pack-tarballs",
      "generate-evidence",
      "install-clean-consumer",
      "prepare-installed-native-inputs",
      "typecheck",
      "node-import",
      "doctor",
      "perry-build",
      "verify-native-host-link",
      "perry-package",
      "verify-evidence",
    ],
  };
}

export function runReleaseConsumer({ outputDirectory, native = true }) {
  const output = path.resolve(outputDirectory);
  assertNewDirectory(output);
  const artifacts = path.join(output, "artifacts");
  const evidence = path.join(output, "evidence");
  const consumer = path.join(output, "consumer");
  mkdirSync(artifacts);
  mkdirSync(consumer);

  buildAllReleasePackages();
  const tarballs = packPublicPackages(artifacts);
  const descriptorPath = createDescriptor(output);
  generateEvidence({ artifactsDir: artifacts, evidenceDir: evidence, descriptorPath });
  createConsumerProject(consumer, tarballs);
  run("pnpm", ["install", "--ignore-scripts", "--registry=https://registry.npmjs.org/"], {
    cwd: consumer,
  });
  run("pnpm", ["run", "typecheck"], { cwd: consumer });
  verifyNodeImports(consumer);
  verifyDoctor(consumer);
  let nativeInputs = null;
  if (native) {
    const prepared = prepareNativeConsumerEnvironment({ consumerDirectory: consumer });
    nativeInputs = {
      installedHostsRequired: true,
      windowsSkia: prepared.windowsSkia,
    };
    run("pnpm", ["run", "build"], { cwd: consumer, env: prepared.environment });
    const binaryName =
      process.platform === "win32" ? "nexa-release-consumer.exe" : "nexa-release-consumer";
    assertNativeHostsLinked(
      readFileSync(path.join(consumer, "dist", binaryName)),
      readFileSync(path.join(consumer, "app.manifest.json")),
    );
    run("pnpm", ["run", "package"], { cwd: consumer, env: prepared.environment });
  }
  verifyEvidence({ artifactsDir: artifacts, evidenceDir: evidence, descriptorPath });
  writeJson(path.join(output, "result.json"), {
    schemaVersion: 1,
    native,
    nativeInputs,
    packages: [...tarballs.keys()],
    output: portablePath(output),
  });
  return output;
}

function usage() {
  return "Usage: node tools/release-consumer.mjs [--plan] [--contracts-only] --output <new-directory>";
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--plan") {
    process.stdout.write(`${JSON.stringify(releaseRehearsalPlan())}\n`);
    return;
  }
  const outputIndex = args.indexOf("--output");
  const outputDirectory = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!outputDirectory) throw new Error(usage());
  const allowed = new Set(["--output", outputDirectory, "--contracts-only"]);
  if (args.some((argument) => !allowed.has(argument))) throw new Error(usage());
  const output = runReleaseConsumer({
    outputDirectory,
    native: !args.includes("--contracts-only"),
  });
  console.log(`release consumer rehearsal ok: ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

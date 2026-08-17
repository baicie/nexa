import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const AUTHORIZED_REGISTRY = "https://registry.npmjs.org/";
const CHANNEL = "technical-preview";
const REPOSITORY = "baicie/nexa-ui";
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const REF_PATTERN = /^refs\/tags\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;
const SUMMARY_LIMIT = 4_096;
const REGISTRY_PHASES = new Set(["bootstrap", "final"]);
const QUICKSTART_PROJECT = "hello-nexa";
const QUICKSTART_COMPILE_PACKAGES = Object.freeze([
  "@nexa/ui",
  "@nexa/fs",
  "@nexa/dialog",
  "@nexa/clipboard",
  "@nexa/protocol",
  "@nexa/nui-host",
  "@nexa/system-host",
]);
const SUPPORTED_TARGETS = new Set(["darwin/arm64", "darwin/x64", "win32/x64"]);
const ARTIFACT_FILE_LIMIT = 8_192;
const ARTIFACT_BYTE_LIMIT = 512 * 1024 * 1024;

function fail(message) {
  throw new Error(`Registry evidence contract: ${message}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireRevision(value, label = "revision") {
  if (!REVISION_PATTERN.test(value ?? "")) fail(`${label} must be a full lowercase commit SHA`);
  return value;
}

function requireRef(value, version) {
  if (!REF_PATTERN.test(value ?? "")) fail("ref must be a version tag ref");
  if (value !== `refs/tags/v${version}`) fail(`ref must be refs/tags/v${version}`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  return value;
}

function regularFile(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch {
    fail(`${label} does not exist`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular file`);
  return file;
}

function resolveProofFile(root, name, label) {
  requireString(name, label);
  if (path.basename(name) !== name || name.includes("\\") || name === "." || name === "..") {
    fail(`${label} must be a portable file name`);
  }
  return regularFile(path.join(root, name), label);
}

function releaseTrain() {
  const packages = readJson(path.join(ROOT, "release/packages.json"), "release package manifest");
  const version = readJson(path.join(ROOT, "release/version.json"), "release version manifest");
  if (packages.schemaVersion !== 1 || !Array.isArray(packages.npm?.public)) {
    fail("release package manifest must declare public npm packages");
  }
  requireString(version.npmTrain, "release npmTrain");
  if (packages.npm.public.length !== 9)
    fail("release train must contain exactly nine public npm packages");
  const entries = packages.npm.public.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`release package entry ${index} must be an object`);
    }
    requireString(entry.name, `release package entry ${index}.name`);
    requireString(entry.path, `release package entry ${index}.path`);
    const manifest = readJson(
      path.join(ROOT, entry.path, "package.json"),
      `${entry.name} package manifest`,
    );
    if (manifest.name !== entry.name || manifest.version !== version.npmTrain) {
      fail(`${entry.name} source manifest does not match the release train`);
    }
    if (manifest.private === true || manifest.publishConfig?.access !== "public") {
      fail(`${entry.name} is not configured for public publication`);
    }
    return { name: entry.name, version: version.npmTrain };
  });
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) fail("release train has duplicate package names");
  return { entries, version: version.npmTrain, pnpm: version.pnpm, typescript: version.typescript };
}

function verifyAuthorizedRegistry(registry) {
  if (registry !== AUTHORIZED_REGISTRY) {
    fail(`registry must be the authorized public npm registry: ${AUTHORIZED_REGISTRY}`);
  }
  return registry;
}

function validSha512Integrity(value) {
  const match = SHA512_INTEGRITY_PATTERN.exec(value ?? "");
  if (!match) return false;
  try {
    return Buffer.from(match[1], "base64").toString("base64") === match[1];
  } catch {
    return false;
  }
}

function packageMetadataUrl(name) {
  return `${AUTHORIZED_REGISTRY}${encodeURIComponent(name)}`;
}

export function registryChannelForPhase({ phase = "final", revision } = {}) {
  if (!REGISTRY_PHASES.has(phase)) fail("phase must be bootstrap or final");
  if (phase === "final") return CHANNEL;
  return `${CHANNEL}-staging-${requireRevision(revision).slice(0, 12)}`;
}

export function verifyRegistryPackageMetadata({
  name,
  metadata,
  registry = AUTHORIZED_REGISTRY,
  phase = "final",
  revision,
}) {
  verifyAuthorizedRegistry(registry);
  const { version } = releaseTrain();
  const channel = registryChannelForPhase({ phase, revision });
  requireString(name, "package name");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail(`${name} registry metadata must be an object`);
  }
  if (metadata.name !== name) fail(`${name} registry metadata name does not match`);
  if (metadata["dist-tags"]?.[channel] !== version) {
    const label = phase === "bootstrap" ? "revision staging channel" : "technical-preview channel";
    fail(`${name} ${label} ${channel} must resolve to ${version}`);
  }
  const release = metadata.versions?.[version];
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    fail(`${name} version ${version} is missing from registry metadata`);
  }
  if (release.name !== name || release.version !== version) {
    fail(`${name} published metadata does not identify ${name}@${version}`);
  }
  const integrity = release.dist?.integrity;
  if (!validSha512Integrity(integrity))
    fail(`${name} published integrity must be canonical sha512`);
  const tarball = release.dist?.tarball;
  requireString(tarball, `${name} published tarball`);
  let parsed;
  try {
    parsed = new URL(tarball);
  } catch {
    fail(`${name} published tarball must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== new URL(AUTHORIZED_REGISTRY).origin) {
    fail(`${name} published tarball must use the authorized public npm registry`);
  }
  return { name, version, phase, channel, integrity, tarball };
}

export function createRegistryConsumerManifest() {
  const { entries, version, pnpm, typescript } = releaseTrain();
  const dependencies = Object.fromEntries(entries.map(({ name }) => [name, version]));
  return {
    name: "nexa-registry-evidence-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: `pnpm@${pnpm}`,
    engines: { node: ">=22", pnpm: ">=10" },
    dependencies,
    devDependencies: {
      "@perryts/perry": readJson(
        path.join(ROOT, "release/version.json"),
        "release version manifest",
      ).perry,
      typescript,
    },
    scripts: {
      typecheck: "tsc -p tsconfig.json --noEmit",
      doctor: "nexa doctor --json",
    },
    pnpm: { overrides: dependencies },
  };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function createConsumerProject(directory) {
  mkdirSync(path.join(directory, "src"), { recursive: true });
  writeJson(path.join(directory, "package.json"), createRegistryConsumerManifest());
  writeJson(path.join(directory, "tsconfig.json"), {
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
  writeFileSync(
    path.join(directory, "src", "main.tsx"),
    'import { Column, Text, Window, mount } from "@nexa/ui";\nimport { readTextFile } from "@nexa/fs";\n\nvoid readTextFile("registry-evidence.txt");\nmount(() => <Window title="Registry evidence"><Column><Text>Registry package train</Text></Column></Window>);\n',
    { encoding: "utf8", flag: "wx" },
  );
  writeFileSync(
    path.join(directory, "src", "contracts.ts"),
    'import { readText } from "@nexa/clipboard";\nimport { openFile } from "@nexa/dialog";\nimport { Common, Ui } from "@nexa/protocol";\nimport type { CommandResult } from "@nexa/system-host";\n\nexport const contract = { readText, openFile, Common, Ui };\nexport type Result = CommandResult<string>;\n',
    { encoding: "utf8", flag: "wx" },
  );
}

function expectedQuickstartPackage() {
  const version = readJson(path.join(ROOT, "release/version.json"), "release version manifest");
  return {
    name: QUICKSTART_PROJECT,
    version: "0.1.0",
    private: true,
    type: "module",
    packageManager: `pnpm@${version.pnpm}`,
    engines: { node: version.node, pnpm: ">=9" },
    scripts: {
      build: "nexa build",
      dev: "nexa dev",
      doctor: "nexa doctor",
      package: "nexa package",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    dependencies: { "@nexa/ui": version.npmTrain },
    devDependencies: {
      "@nexa/cli": version.npmTrain,
      "@perryts/perry": version.perry,
      typescript: version.typescript,
    },
    perry: {
      compilePackages: [...QUICKSTART_COMPILE_PACKAGES],
      allow: {
        nativeLibrary: ["@nexa/nui-host", "@nexa/system-host", "@nexa/ui"],
        compilePackages: [...QUICKSTART_COMPILE_PACKAGES],
      },
    },
  };
}

function expectedQuickstartAppManifest() {
  return {
    $schema: "https://nexa-ui.dev/schema/app-manifest-v1.json",
    schemaVersion: 1,
    id: "dev.nexa.hello-nexa",
    name: "Hello Nexa",
    version: "0.1.0",
    requiredProtocol: { major: 1, minor: 0 },
    permissions: [],
  };
}

function commandResult(command, args, { cwd, env }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function outputSummary(value) {
  if (typeof value !== "string") fail("command output must be text");
  const bytes = Buffer.byteLength(value, "utf8");
  const summary =
    bytes <= SUMMARY_LIMIT ? value : Buffer.from(value).subarray(0, SUMMARY_LIMIT).toString("utf8");
  return { bytes, truncated: bytes > SUMMARY_LIMIT, summary, sha256: sha256(summary) };
}

function artifactTreeDigest(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(entry.size), "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.sha256, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function packageArtifactPath(packageCommand, projectDirectory) {
  if (packageCommand.stdout.truncated) fail("package command output is unexpectedly truncated");
  const matches = [
    ...packageCommand.stdout.summary.matchAll(
      /^Packaged dev\.nexa\.hello-nexa@0\.1\.0: ([^\r\n]+)$/gmu,
    ),
  ];
  if (matches.length !== 1) fail("package command did not report exactly one generated artifact");
  const relative = matches[0][1];
  if (
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("package command reported an unsafe artifact path");
  }
  const artifact = path.resolve(projectDirectory, ...relative.split("/"));
  const relation = path.relative(projectDirectory, artifact);
  if (relation === "" || relation === ".." || relation.startsWith(`..${path.sep}`)) {
    fail("package artifact escapes the generated project");
  }
  return { artifact, relative };
}

function collectArtifactInventory({ packageCommand, projectDirectory, hosted }) {
  const { artifact, relative } = packageArtifactPath(packageCommand, projectDirectory);
  const rootMetadata = lstatSync(artifact);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("package artifact must be a regular directory");
  }
  const entries = [];
  let bytes = 0;
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      if (name.includes("\\") || name === "." || name === "..") {
        fail("package artifact contains an unsafe file name");
      }
      const file = path.join(directory, name);
      const metadata = lstatSync(file);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (metadata.isSymbolicLink()) fail(`package artifact contains a symlink: ${relativePath}`);
      if (metadata.isDirectory()) {
        visit(file, relativePath);
        continue;
      }
      if (!metadata.isFile()) fail(`package artifact contains a special file: ${relativePath}`);
      if (entries.length >= ARTIFACT_FILE_LIMIT) fail("package artifact exceeds the file limit");
      bytes += metadata.size;
      if (!Number.isSafeInteger(bytes) || bytes > ARTIFACT_BYTE_LIMIT) {
        fail("package artifact exceeds the byte limit");
      }
      entries.push({
        path: relativePath,
        size: metadata.size,
        sha256: sha256(readFileSync(file)),
      });
    }
  }
  visit(artifact, "");
  if (entries.length === 0) fail("package artifact is empty");
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    schemaVersion: 1,
    target: { platform: hosted.platform, arch: hosted.arch },
    path: relative,
    files: entries,
    bytes,
    sha256: artifactTreeDigest(entries),
  };
}

function runChecked(runCommand, id, command, args, options) {
  const result = runCommand(command, args, options);
  if (!result || typeof result !== "object" || !Number.isInteger(result.status)) {
    fail(`${id} command runner returned an invalid result`);
  }
  const record = {
    id,
    command: [command, ...args],
    exitStatus: result.status,
    stdout: outputSummary(result.stdout ?? ""),
    stderr: outputSummary(result.stderr ?? ""),
  };
  if (record.exitStatus !== 0) fail(`${id} failed with status ${record.exitStatus}`);
  return record;
}

function consumerEnvironment(directory) {
  const env = { ...process.env };
  for (const name of [
    "NODE_PATH",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "NPM_CONFIG_USERCONFIG",
  ]) {
    delete env[name];
  }
  const npmrc = path.join(directory, ".npmrc");
  writeFileSync(npmrc, `registry=${AUTHORIZED_REGISTRY}\n`, { encoding: "utf8", flag: "wx" });
  env.NPM_CONFIG_REGISTRY = AUTHORIZED_REGISTRY;
  env.npm_config_registry = AUTHORIZED_REGISTRY;
  env.NPM_CONFIG_USERCONFIG = npmrc;
  return env;
}

function importedPackageNames() {
  return releaseTrain()
    .entries.filter(({ name }) => name !== "@nexa/cli")
    .map(({ name }) => name);
}

function versionMatches(resolved, version) {
  return resolved === version || resolved.startsWith(`${version}(`);
}

function lockPackageEntries(packages, name, version) {
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) return [];
  return Object.entries(packages).filter(
    ([key]) => key === `${name}@${version}` || key.startsWith(`${name}@${version}(`),
  );
}

function verifyInstalledRegistryTrain({ lockfile, expected }) {
  let parsed;
  try {
    parsed = parseYaml(readFileSync(lockfile, "utf8"));
  } catch (error) {
    fail(
      `cannot parse consumer lockfile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const importer = parsed?.importers?.["."];
  if (!importer || typeof importer !== "object")
    fail("consumer lockfile does not contain its root importer");
  const dependencies = importer.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    fail("consumer lockfile root dependencies are missing");
  }
  for (const entry of expected) {
    const imported = dependencies[entry.name];
    if (!imported || typeof imported !== "object")
      fail(`consumer lockfile is missing ${entry.name}`);
    if (imported.specifier !== entry.version || !versionMatches(imported.version, entry.version)) {
      fail(`consumer lockfile version does not match ${entry.name}@${entry.version}`);
    }
    const matches = lockPackageEntries(parsed.packages, entry.name, entry.version);
    if (matches.length !== 1)
      fail(`consumer lockfile must contain exactly one ${entry.name}@${entry.version}`);
    if (matches[0][1]?.resolution?.integrity !== entry.integrity) {
      fail(`consumer lockfile integrity does not match ${entry.name}@${entry.version}`);
    }
  }
  return true;
}

function validateHosted(hosted) {
  exactKeys(
    hosted,
    ["arch", "platform", "provider", "repository", "runId", "runner"],
    "GitHub Actions custody",
  );
  if (hosted.provider !== "github-actions") fail("registry proof requires GitHub Actions custody");
  if (hosted.repository !== REPOSITORY)
    fail(`GitHub Actions custody repository must be ${REPOSITORY}`);
  if (!/^[1-9][0-9]*$/u.test(hosted.runId ?? "")) {
    fail("GitHub Actions custody runId must be a positive integer");
  }
  requireString(hosted.runner, "GitHub Actions custody runner");
  if (!SUPPORTED_TARGETS.has(`${hosted.platform}/${hosted.arch}`)) {
    fail("registry proof requires a supported Desktop Technical Preview target");
  }
  return hosted;
}

function recordCommandShape(command, index) {
  exactKeys(
    command,
    ["command", "exitStatus", "id", "stderr", "stdout"],
    `consumer.commands[${index}]`,
  );
  requireString(command.id, `consumer.commands[${index}].id`);
  if (!Array.isArray(command.command) || command.command.some((part) => typeof part !== "string")) {
    fail(`consumer.commands[${index}].command must be a string array`);
  }
  if (command.exitStatus !== 0) fail(`consumer.commands[${index}].exitStatus must be zero`);
  for (const stream of ["stdout", "stderr"]) {
    const summary = command[stream];
    exactKeys(
      summary,
      ["bytes", "sha256", "summary", "truncated"],
      `consumer.commands[${index}].${stream}`,
    );
    if (
      !Number.isSafeInteger(summary.bytes) ||
      summary.bytes < 0 ||
      typeof summary.truncated !== "boolean"
    ) {
      fail(`consumer.commands[${index}].${stream} has invalid byte metadata`);
    }
    if (typeof summary.summary !== "string" || !SHA256_PATTERN.test(summary.sha256)) {
      fail(`consumer.commands[${index}].${stream} has invalid summary`);
    }
    if (sha256(summary.summary) !== summary.sha256) {
      fail(`consumer.commands[${index}].${stream} summary digest does not match`);
    }
  }
}

function verifyCommandContract(command, index) {
  recordCommandShape(command, index);
  const expectedIds = [
    "install-fresh-consumer",
    "typecheck-nine-package-train",
    "node-import-nine-package-train",
    "create-with-published-cli",
    "install-generated-project",
    "doctor-generated-project",
    "typecheck-generated-project",
    "build-generated-project",
    "package-generated-project",
  ];
  if (command.id !== expectedIds[index]) fail("registry proof command order is invalid");
  const args = command.command;
  if (index === 0 || index === 4) {
    if (
      args[0] !== "pnpm" ||
      args[1] !== "install" ||
      !args.includes("--ignore-scripts") ||
      !args.includes(`--registry=${AUTHORIZED_REGISTRY}`) ||
      !args.includes("--config.shared-workspace-lockfile=false") ||
      !args.some((argument) => argument.startsWith("--store-dir="))
    ) {
      fail("registry proof install command is not isolated and pinned to public npm");
    }
    return;
  }
  if (index === 1 && JSON.stringify(args) !== JSON.stringify(["pnpm", "run", "typecheck"])) {
    fail("registry proof typecheck command is invalid");
  }
  if (index === 2 && (args[0] !== process.execPath || args[1] !== "--input-type=module")) {
    fail("registry proof import command is invalid");
  }
  const fixedCommands = new Map([
    [5, ["pnpm", "exec", "nexa", "doctor", "--json"]],
    [6, ["pnpm", "run", "typecheck"]],
    [7, ["pnpm", "run", "build"]],
    [8, ["pnpm", "run", "package"]],
  ]);
  if (
    index === 3 &&
    (args[0] !== "pnpm" ||
      !args.some((argument) => argument.startsWith("--store-dir=")) ||
      !args.includes(`--registry=${AUTHORIZED_REGISTRY}`) ||
      JSON.stringify(args.slice(-4)) !==
        JSON.stringify(["dlx", "@nexa/cli@0.1.0", "new", QUICKSTART_PROJECT]))
  ) {
    fail("registry proof create-with-published-cli command is invalid");
  }
  if (fixedCommands.has(index) && JSON.stringify(args) !== JSON.stringify(fixedCommands.get(index))) {
    fail(`registry proof ${command.id} command is invalid`);
  }
}

export function registryEvidencePlan({ phase = "final", revision } = {}) {
  return {
    schemaVersion: 1,
    registry: AUTHORIZED_REGISTRY,
    phase,
    channel: registryChannelForPhase({ phase, revision }),
    packages: releaseTrain().entries.map(({ name }) => name),
    stages: [
      "fetch-authoritative-package-metadata",
      "install-fresh-consumer",
      "verify-lockfile-integrity",
      "typecheck-nine-package-train",
      "node-import-nine-package-train",
      "create-with-published-cli",
      "install-generated-project",
      "doctor-generated-project",
      "typecheck-generated-project",
      "build-generated-project",
      "package-generated-project",
      "record-package-artifact",
      "write-revision-bound-proof",
    ],
  };
}

export async function collectRegistryEvidence({
  outputDirectory,
  revision,
  ref,
  phase = "final",
  hosted,
  fetchJson = defaultFetchJson,
  runCommand = commandResult,
}) {
  const { entries, version } = releaseTrain();
  requireRevision(revision);
  requireRef(ref, version);
  const channel = registryChannelForPhase({ phase, revision });
  validateHosted(hosted);
  const output = path.resolve(requireString(outputDirectory, "outputDirectory"));
  if (existsSync(output)) fail("outputDirectory already exists");

  const parent = path.dirname(output);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, ".nexa-registry-evidence-"));
  let consumer;
  let quickstartParent;
  try {
    consumer = mkdtempSync(path.join(tmpdir(), "nexa-registry-consumer-"));
    quickstartParent = mkdtempSync(path.join(tmpdir(), "nexa-registry-quickstart-"));
    createConsumerProject(consumer);
    const expected = [];
    for (const { name } of entries) {
      const metadata = await fetchJson(packageMetadataUrl(name));
      expected.push(verifyRegistryPackageMetadata({ name, metadata, phase, revision }));
    }
    const env = consumerEnvironment(consumer);
    const commands = [];
    commands.push(
      runChecked(
        runCommand,
        "install-fresh-consumer",
        "pnpm",
        [
          "install",
          "--ignore-scripts",
          `--registry=${AUTHORIZED_REGISTRY}`,
          `--store-dir=${path.join(consumer, ".pnpm-store")}`,
          "--config.shared-workspace-lockfile=false",
        ],
        { cwd: consumer, env },
      ),
    );
    const lockfile = path.join(consumer, "pnpm-lock.yaml");
    regularFile(lockfile, "consumer lockfile");
    verifyInstalledRegistryTrain({ lockfile, expected });
    commands.push(
      runChecked(runCommand, "typecheck-nine-package-train", "pnpm", ["run", "typecheck"], {
        cwd: consumer,
        env,
      }),
    );
    commands.push(
      runChecked(
        runCommand,
        "node-import-nine-package-train",
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `for (const packageName of ${JSON.stringify(importedPackageNames())}) await import(packageName);`,
        ],
        { cwd: consumer, env },
      ),
    );
    commands.push(
      runChecked(
        runCommand,
        "create-with-published-cli",
        "pnpm",
        [
          `--store-dir=${path.join(quickstartParent, ".pnpm-store")}`,
          `--registry=${AUTHORIZED_REGISTRY}`,
          "dlx",
          `@nexa/cli@${version}`,
          "new",
          QUICKSTART_PROJECT,
        ],
        { cwd: quickstartParent, env },
      ),
    );
    const quickstart = path.join(quickstartParent, QUICKSTART_PROJECT);
    const quickstartMetadata = lstatSync(quickstart);
    if (!quickstartMetadata.isDirectory() || quickstartMetadata.isSymbolicLink()) {
      fail("published CLI did not create a regular quickstart project directory");
    }
    const quickstartManifest = regularFile(
      path.join(quickstart, "package.json"),
      "generated quickstart package manifest",
    );
    const quickstartAppManifest = regularFile(
      path.join(quickstart, "app.manifest.json"),
      "generated quickstart app manifest",
    );
    if (
      JSON.stringify(readJson(quickstartManifest, "generated quickstart package manifest")) !==
      JSON.stringify(expectedQuickstartPackage())
    ) {
      fail("published CLI generated a non-canonical quickstart package manifest");
    }
    if (
      JSON.stringify(readJson(quickstartAppManifest, "generated quickstart app manifest")) !==
      JSON.stringify(expectedQuickstartAppManifest())
    ) {
      fail("published CLI generated a non-canonical quickstart app manifest");
    }
    commands.push(
      runChecked(
        runCommand,
        "install-generated-project",
        "pnpm",
        [
          "install",
          "--ignore-scripts",
          `--registry=${AUTHORIZED_REGISTRY}`,
          `--store-dir=${path.join(quickstartParent, ".pnpm-store")}`,
          "--config.shared-workspace-lockfile=false",
        ],
        { cwd: quickstart, env },
      ),
    );
    const quickstartLockfile = regularFile(
      path.join(quickstart, "pnpm-lock.yaml"),
      "generated quickstart lockfile",
    );
    const doctor = runChecked(
      runCommand,
      "doctor-generated-project",
      "pnpm",
      ["exec", "nexa", "doctor", "--json"],
      { cwd: quickstart, env },
    );
    let doctorReport;
    try {
      doctorReport = JSON.parse(doctor.stdout.summary);
    } catch {
      fail("doctor did not return JSON");
    }
    if (doctorReport?.schemaVersion !== 1 || doctorReport?.ok !== true) {
      fail("doctor did not report schemaVersion 1 and ok=true");
    }
    commands.push(doctor);
    commands.push(
      runChecked(
        runCommand,
        "typecheck-generated-project",
        "pnpm",
        ["run", "typecheck"],
        { cwd: quickstart, env },
      ),
    );
    commands.push(
      runChecked(runCommand, "build-generated-project", "pnpm", ["run", "build"], {
        cwd: quickstart,
        env,
      }),
    );
    const packageCommand = runChecked(
      runCommand,
      "package-generated-project",
      "pnpm",
      ["run", "package"],
      { cwd: quickstart, env },
    );
    commands.push(packageCommand);
    const artifactInventory = collectArtifactInventory({
      packageCommand,
      projectDirectory: quickstart,
      hosted,
    });

    const evidenceLockfile = "pnpm-lock.yaml";
    const evidenceManifest = "consumer-package.json";
    const quickstartEvidenceLockfile = "quickstart-pnpm-lock.yaml";
    const quickstartEvidenceManifest = "quickstart-package.json";
    const quickstartEvidenceAppManifest = "quickstart-app-manifest.json";
    const quickstartArtifactManifest = "quickstart-artifact.json";
    copyFileSync(lockfile, path.join(staging, evidenceLockfile));
    copyFileSync(path.join(consumer, "package.json"), path.join(staging, evidenceManifest));
    copyFileSync(quickstartLockfile, path.join(staging, quickstartEvidenceLockfile));
    copyFileSync(quickstartManifest, path.join(staging, quickstartEvidenceManifest));
    copyFileSync(quickstartAppManifest, path.join(staging, quickstartEvidenceAppManifest));
    writeJson(path.join(staging, quickstartArtifactManifest), artifactInventory);
    const record = {
      schemaVersion: 2,
      gate: "registry",
      phase,
      revision,
      ref,
      registry: AUTHORIZED_REGISTRY,
      channel,
      hosted: { ...hosted },
      train: expected,
      consumer: {
        lockfile: evidenceLockfile,
        lockfileSha256: sha256(readFileSync(path.join(staging, evidenceLockfile))),
        manifest: evidenceManifest,
        manifestSha256: sha256(readFileSync(path.join(staging, evidenceManifest))),
        commands,
        quickstart: {
          project: QUICKSTART_PROJECT,
          lockfile: quickstartEvidenceLockfile,
          lockfileSha256: sha256(readFileSync(path.join(staging, quickstartEvidenceLockfile))),
          manifest: quickstartEvidenceManifest,
          manifestSha256: sha256(readFileSync(path.join(staging, quickstartEvidenceManifest))),
          appManifest: quickstartEvidenceAppManifest,
          appManifestSha256: sha256(
            readFileSync(path.join(staging, quickstartEvidenceAppManifest)),
          ),
          artifact: {
            manifest: quickstartArtifactManifest,
            manifestSha256: sha256(
              readFileSync(path.join(staging, quickstartArtifactManifest)),
            ),
            path: artifactInventory.path,
            platform: artifactInventory.target.platform,
            arch: artifactInventory.target.arch,
            files: artifactInventory.files.length,
            bytes: artifactInventory.bytes,
            sha256: artifactInventory.sha256,
          },
        },
      },
    };
    writeJson(path.join(staging, "registry-evidence.json"), record);
    verifyRegistryEvidence({
      evidenceFile: path.join(staging, "registry-evidence.json"),
      revision,
      ref,
      phase,
    });
    renameSync(staging, output);
    return record;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    if (consumer) rmSync(consumer, { recursive: true, force: true });
    if (quickstartParent) rmSync(quickstartParent, { recursive: true, force: true });
  }
}

export function verifyRegistryEvidence({ evidenceFile, revision, ref, phase = "final" }) {
  requireRevision(revision);
  const { entries, version } = releaseTrain();
  requireRef(ref, version);
  const channel = registryChannelForPhase({ phase, revision });
  const proof = regularFile(
    path.resolve(requireString(evidenceFile, "evidenceFile")),
    "registry proof",
  );
  const root = path.dirname(proof);
  const proofFiles = readdirSync(root).sort();
  if (
    JSON.stringify(proofFiles) !==
    JSON.stringify([
      "consumer-package.json",
      "pnpm-lock.yaml",
      "quickstart-app-manifest.json",
      "quickstart-artifact.json",
      "quickstart-package.json",
      "quickstart-pnpm-lock.yaml",
      "registry-evidence.json",
    ])
  ) {
    fail("registry proof directory must contain only the canonical proof files");
  }
  const record = readJson(proof, "registry proof");
  exactKeys(
    record,
    [
      "channel",
      "consumer",
      "gate",
      "hosted",
      "phase",
      "ref",
      "registry",
      "revision",
      "schemaVersion",
      "train",
    ],
    "registry proof",
  );
  if (record.schemaVersion !== 2 || record.gate !== "registry")
    fail("registry proof schema or gate is invalid");
  if (record.revision !== revision || record.ref !== ref)
    fail("registry proof does not bind the requested revision and ref");
  if (record.phase !== phase) fail(`registry proof phase must be ${phase}`);
  if (record.registry !== AUTHORIZED_REGISTRY || record.channel !== channel) {
    fail("registry proof uses an unauthorized registry or channel");
  }
  validateHosted(record.hosted);
  if (!Array.isArray(record.train) || record.train.length !== entries.length) {
    fail("registry proof train must contain every public package");
  }
  for (const [index, entry] of entries.entries()) {
    const actual = record.train[index];
    exactKeys(
      actual,
      ["channel", "integrity", "name", "phase", "tarball", "version"],
      `registry proof train[${index}]`,
    );
    if (actual.name !== entry.name) fail(`registry proof train order differs at ${index}`);
    const expected = verifyRegistryPackageMetadata({
      name: entry.name,
      metadata: {
        name: actual.name,
        "dist-tags": { [channel]: actual.version },
        versions: {
          [actual.version]: {
            name: actual.name,
            version: actual.version,
            dist: { integrity: actual.integrity, tarball: actual.tarball },
          },
        },
      },
      phase,
      revision,
    });
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      fail(`registry proof train entry ${entry.name} is invalid`);
  }
  exactKeys(
    record.consumer,
    ["commands", "lockfile", "lockfileSha256", "manifest", "manifestSha256", "quickstart"],
    "registry proof consumer",
  );
  const lockfile = resolveProofFile(root, record.consumer.lockfile, "registry proof lockfile");
  const manifest = resolveProofFile(root, record.consumer.manifest, "registry proof manifest");
  if (
    sha256(readFileSync(lockfile)) !== record.consumer.lockfileSha256 ||
    !SHA256_PATTERN.test(record.consumer.lockfileSha256)
  ) {
    fail("registry proof lockfile digest does not match");
  }
  if (
    sha256(readFileSync(manifest)) !== record.consumer.manifestSha256 ||
    !SHA256_PATTERN.test(record.consumer.manifestSha256)
  ) {
    fail("registry proof manifest digest does not match");
  }
  const consumerManifest = readJson(manifest, "registry proof consumer manifest");
  if (JSON.stringify(consumerManifest) !== JSON.stringify(createRegistryConsumerManifest())) {
    fail("registry proof consumer manifest is not canonical");
  }
  verifyInstalledRegistryTrain({ lockfile, expected: record.train });
  exactKeys(
    record.consumer.quickstart,
    [
      "appManifest",
      "appManifestSha256",
      "artifact",
      "lockfile",
      "lockfileSha256",
      "manifest",
      "manifestSha256",
      "project",
    ],
    "registry proof quickstart",
  );
  if (record.consumer.quickstart.project !== QUICKSTART_PROJECT) {
    fail("registry proof quickstart project name is invalid");
  }
  const quickstartManifest = resolveProofFile(
    root,
    record.consumer.quickstart.manifest,
    "registry proof quickstart package manifest",
  );
  const quickstartLockfile = resolveProofFile(
    root,
    record.consumer.quickstart.lockfile,
    "registry proof quickstart lockfile",
  );
  const quickstartAppManifest = resolveProofFile(
    root,
    record.consumer.quickstart.appManifest,
    "registry proof quickstart app manifest",
  );
  for (const [file, digest, label] of [
    [quickstartManifest, record.consumer.quickstart.manifestSha256, "package manifest"],
    [quickstartLockfile, record.consumer.quickstart.lockfileSha256, "lockfile"],
    [quickstartAppManifest, record.consumer.quickstart.appManifestSha256, "app manifest"],
  ]) {
    if (!SHA256_PATTERN.test(digest) || sha256(readFileSync(file)) !== digest) {
      fail(`registry proof quickstart ${label} digest does not match`);
    }
  }
  if (
    JSON.stringify(readJson(quickstartManifest, "registry proof quickstart package manifest")) !==
    JSON.stringify(expectedQuickstartPackage())
  ) {
    fail("registry proof quickstart package manifest is not canonical");
  }
  if (
    JSON.stringify(readJson(quickstartAppManifest, "registry proof quickstart app manifest")) !==
    JSON.stringify(expectedQuickstartAppManifest())
  ) {
    fail("registry proof quickstart app manifest is not canonical");
  }
  const quickstartLock = parseYaml(readFileSync(quickstartLockfile, "utf8"));
  for (const entry of record.train.filter(({ name }) =>
    ["@nexa/cli", "@nexa/nui-host", "@nexa/protocol", "@nexa/system-host", "@nexa/ui"].includes(
      name,
    ),
  )) {
    const matches = lockPackageEntries(quickstartLock.packages, entry.name, entry.version);
    if (matches.length !== 1 || matches[0][1]?.resolution?.integrity !== entry.integrity) {
      fail(`quickstart lockfile integrity does not match ${entry.name}@${entry.version}`);
    }
  }
  const artifactBinding = record.consumer.quickstart.artifact;
  exactKeys(
    artifactBinding,
    ["arch", "bytes", "files", "manifest", "manifestSha256", "path", "platform", "sha256"],
    "registry proof quickstart artifact",
  );
  const artifactFile = resolveProofFile(
    root,
    artifactBinding.manifest,
    "registry proof quickstart artifact manifest",
  );
  if (
    !SHA256_PATTERN.test(artifactBinding.manifestSha256) ||
    sha256(readFileSync(artifactFile)) !== artifactBinding.manifestSha256
  ) {
    fail("registry proof quickstart artifact manifest digest does not match");
  }
  const artifact = readJson(artifactFile, "registry proof quickstart artifact manifest");
  exactKeys(
    artifact,
    ["bytes", "files", "path", "schemaVersion", "sha256", "target"],
    "registry proof quickstart artifact inventory",
  );
  exactKeys(artifact.target, ["arch", "platform"], "registry proof quickstart artifact target");
  if (
    artifact.schemaVersion !== 1 ||
    artifact.target.platform !== record.hosted.platform ||
    artifact.target.arch !== record.hosted.arch ||
    artifactBinding.platform !== artifact.target.platform ||
    artifactBinding.arch !== artifact.target.arch ||
    artifactBinding.path !== artifact.path ||
    artifactBinding.files !== artifact.files?.length ||
    artifactBinding.bytes !== artifact.bytes ||
    artifactBinding.sha256 !== artifact.sha256 ||
    !Array.isArray(artifact.files) ||
    artifact.files.length === 0
  ) {
    fail("registry proof quickstart artifact binding is invalid");
  }
  let artifactBytes = 0;
  for (const [index, entry] of artifact.files.entries()) {
    exactKeys(entry, ["path", "sha256", "size"], `quickstart artifact files[${index}]`);
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.includes("\\") ||
      entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      fail(`quickstart artifact files[${index}] is invalid`);
    }
    artifactBytes += entry.size;
  }
  if (
    artifactBytes !== artifact.bytes ||
    artifact.files.length > ARTIFACT_FILE_LIMIT ||
    artifact.bytes > ARTIFACT_BYTE_LIMIT ||
    artifactTreeDigest(artifact.files) !== artifact.sha256
  ) {
    fail("registry proof quickstart artifact inventory digest does not match");
  }
  if (!Array.isArray(record.consumer.commands) || record.consumer.commands.length !== 9) {
    fail("registry proof must include the complete nine-package and generated-project workflow");
  }
  for (const [index, command] of record.consumer.commands.entries()) {
    verifyCommandContract(command, index);
  }
  return record;
}

async function defaultFetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    redirect: "error",
  });
  if (!response.ok) fail(`registry metadata request failed (${response.status}) for ${url}`);
  return response.json();
}

function hostedFromEnvironment(environment = process.env) {
  if (environment.GITHUB_ACTIONS !== "true") {
    fail(
      "registry evidence requires GitHub Actions custody; local execution is not external proof",
    );
  }
  const hosted = {
    provider: "github-actions",
    repository: environment.GITHUB_REPOSITORY,
    runId: environment.GITHUB_RUN_ID,
    runner: environment.RUNNER_NAME,
    platform: process.platform,
    arch: process.arch,
  };
  validateHosted(hosted);
  return hosted;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || Object.hasOwn(options, flag)) {
      fail("arguments must be unique --name value pairs");
    }
    options[flag] = value;
  }
  return options;
}

async function main() {
  const [operation, ...rest] = process.argv.slice(2);
  if (operation === "plan" && rest.length === 0) {
    process.stdout.write(`${JSON.stringify(registryEvidencePlan())}\n`);
    return;
  }
  const options = parseOptions(rest);
  if (
    operation === "collect" &&
    Object.keys(options).sort().join(",") === "--output,--phase,--ref,--revision"
  ) {
    if (
      options["--revision"] !== process.env.GITHUB_SHA ||
      options["--ref"] !== process.env.GITHUB_REF
    ) {
      fail("collect revision and ref must match the GitHub Actions checkout");
    }
    const record = await collectRegistryEvidence({
      outputDirectory: options["--output"],
      revision: options["--revision"],
      ref: options["--ref"],
      phase: options["--phase"],
      hosted: hostedFromEnvironment(),
    });
    process.stdout.write(`registry evidence collected for ${record.revision}\n`);
    return;
  }
  if (
    operation === "verify" &&
    Object.keys(options).sort().join(",") === "--evidence,--phase,--ref,--revision"
  ) {
    verifyRegistryEvidence({
      evidenceFile: options["--evidence"],
      revision: options["--revision"],
      ref: options["--ref"],
      phase: options["--phase"],
    });
    process.stdout.write("registry evidence verified\n");
    return;
  }
  fail(
    "usage: registry-evidence.mjs plan | collect --output <new-directory> --revision <sha> --ref <tag-ref> --phase bootstrap|final | verify --evidence <file> --revision <sha> --ref <tag-ref> --phase bootstrap|final",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

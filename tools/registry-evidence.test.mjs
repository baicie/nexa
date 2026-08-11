import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  collectRegistryEvidence,
  createRegistryConsumerManifest,
  registryChannelForPhase,
  registryEvidencePlan,
  verifyRegistryEvidence,
  verifyRegistryPackageMetadata,
} from "./registry-evidence.mjs";

const revision = "a".repeat(40);
const ref = "refs/tags/v0.1.0";
const registry = "https://registry.npmjs.org/";
const hosted = {
  provider: "github-actions",
  repository: "baicie/nexa-ui",
  runId: "123",
  runner: "GitHub Actions macos-15",
  platform: "darwin",
  arch: "arm64",
};
const packages = [
  "@nexa/cli",
  "@nexa/ui",
  "@nexa/adapter-solid",
  "@nexa/fs",
  "@nexa/dialog",
  "@nexa/clipboard",
  "@nexa/protocol",
  "@nexa/nui-host",
  "@nexa/system-host",
];

function integrity(name) {
  return `sha512-${createHash("sha512").update(name).digest("base64")}`;
}

function metadata(name, version = "0.1.0", channel = "technical-preview") {
  return {
    name,
    "dist-tags": { [channel]: version },
    versions: {
      [version]: {
        name,
        version,
        dist: {
          integrity: integrity(name),
          tarball: `${registry}${encodeURIComponent(name)}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`,
        },
      },
    },
  };
}

function lockfile() {
  const importers = Object.fromEntries(
    packages.map((name) => [name, { specifier: "0.1.0", version: "0.1.0" }]),
  );
  const packageEntries = Object.fromEntries(
    packages.map((name) => [`${name}@0.1.0`, { resolution: { integrity: integrity(name) } }]),
  );
  return {
    lockfileVersion: "9.0",
    importers: { ".": { dependencies: importers } },
    packages: packageEntries,
  };
}

function yaml(value, indentation = "") {
  if (Array.isArray(value)) return value.map((item) => `${indentation}- ${yaml(item)}`).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => {
        const quoted = /[:@.]/u.test(key) ? JSON.stringify(key) : key;
        if (entry && typeof entry === "object")
          return `${indentation}${quoted}:\n${yaml(entry, `${indentation}  `)}`;
        return `${indentation}${quoted}: ${JSON.stringify(entry)}`;
      })
      .join("\n");
  }
  return JSON.stringify(value);
}

function commandRunner() {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "pnpm" && args[0] === "install") {
      writeFileSync(path.join(options.cwd, "pnpm-lock.yaml"), `${yaml(lockfile())}\n`);
    }
    if (
      command === "pnpm" &&
      args.includes("dlx") &&
      args.includes("@nexa/cli@0.1.0") &&
      args.slice(-2).join(" ") === "new hello-nexa"
    ) {
      const project = path.join(options.cwd, "hello-nexa");
      mkdirSync(path.join(project, "src"), { recursive: true });
      writeFileSync(
        path.join(project, "package.json"),
        `${JSON.stringify({
          name: "hello-nexa",
          version: "0.1.0",
          private: true,
          type: "module",
          packageManager: "pnpm@10.34.3",
          engines: { node: ">=22", pnpm: ">=9" },
          scripts: {
            build: "nexa build",
            dev: "nexa dev",
            doctor: "nexa doctor",
            package: "nexa package",
            typecheck: "tsc -p tsconfig.json --noEmit",
          },
          dependencies: { "@nexa/ui": "0.1.0" },
          devDependencies: {
            "@nexa/cli": "0.1.0",
            "@perryts/perry": "0.5.1220",
            typescript: "5.9.2",
          },
          perry: {
            compilePackages: [
              "@nexa/ui",
              "@nexa/fs",
              "@nexa/dialog",
              "@nexa/clipboard",
              "@nexa/protocol",
              "@nexa/nui-host",
              "@nexa/system-host",
            ],
            allow: {
              nativeLibrary: ["@nexa/nui-host", "@nexa/system-host", "@nexa/ui"],
              compilePackages: [
                "@nexa/ui",
                "@nexa/fs",
                "@nexa/dialog",
                "@nexa/clipboard",
                "@nexa/protocol",
                "@nexa/nui-host",
                "@nexa/system-host",
              ],
            },
          },
        }, null, 2)}\n`,
      );
      writeFileSync(
        path.join(project, "app.manifest.json"),
        `${JSON.stringify({
          $schema: "https://nexa-ui.dev/schema/app-manifest-v1.json",
          schemaVersion: 1,
          id: "dev.nexa.hello-nexa",
          name: "Hello Nexa",
          version: "0.1.0",
          requiredProtocol: { major: 1, minor: 0 },
          permissions: [],
        }, null, 2)}\n`,
      );
      writeFileSync(path.join(project, "src", "main.tsx"), "export {};\n");
    }
    if (command === "pnpm" && args.join(" ") === "exec nexa doctor --json") {
      return { status: 0, stdout: '{"schemaVersion":1,"ok":true}\n', stderr: "" };
    }
    if (command === "pnpm" && args.join(" ") === "run build") {
      mkdirSync(path.join(options.cwd, "dist"), { recursive: true });
      writeFileSync(path.join(options.cwd, "dist", "hello-nexa"), "native binary\n");
    }
    if (command === "pnpm" && args.join(" ") === "run package") {
      const bundle = path.join(
        options.cwd,
        "dist",
        "hello-nexa-macos-arm64",
        "hello-nexa.app",
      );
      mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
      mkdirSync(path.join(bundle, "Contents", "Resources"), { recursive: true });
      writeFileSync(path.join(bundle, "Contents", "MacOS", "hello-nexa"), "native binary\n");
      writeFileSync(path.join(bundle, "Contents", "Info.plist"), "plist\n");
      writeFileSync(
        path.join(bundle, "Contents", "Resources", "app.manifest.json"),
        readFileSync(path.join(options.cwd, "app.manifest.json")),
      );
      return {
        status: 0,
        stdout:
          "Packaged dev.nexa.hello-nexa@0.1.0: dist/hello-nexa-macos-arm64/hello-nexa.app\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: "ok\n", stderr: "" };
  };
  return { calls, run };
}

test("registry consumer manifest installs the exact nine-package train from public npm", () => {
  const manifest = createRegistryConsumerManifest();
  assert.deepEqual(Object.keys(manifest.dependencies), packages);
  assert.deepEqual(
    Object.values(manifest.dependencies),
    packages.map(() => "0.1.0"),
  );
  assert.equal(manifest.private, true);
  assert.equal(manifest.pnpm.overrides["@nexa/ui"], "0.1.0");
  assert.equal(manifest.scripts.typecheck, "tsc -p tsconfig.json --noEmit");
  assert.equal(manifest.scripts.doctor, "nexa doctor --json");
  assert.deepEqual(registryEvidencePlan().stages, [
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
  ]);
});

test("registry metadata requires the exact train version, channel, public origin, and integrity", () => {
  const expected = packages.map((name) =>
    verifyRegistryPackageMetadata({ name, metadata: metadata(name) }),
  );
  assert.deepEqual(
    expected.map(({ name, version }) => [name, version]),
    packages.map((name) => [name, "0.1.0"]),
  );

  assert.throws(
    () =>
      verifyRegistryPackageMetadata({ name: "@nexa/ui", metadata: metadata("@nexa/ui", "0.1.1") }),
    /technical-preview/u,
  );
  assert.throws(() => {
    const invalid = metadata("@nexa/ui");
    invalid.versions["0.1.0"].dist.integrity = "sha256-not-sha512";
    verifyRegistryPackageMetadata({ name: "@nexa/ui", metadata: invalid });
  }, /integrity/u);
  assert.throws(() => {
    const invalid = metadata("@nexa/ui");
    invalid.versions["0.1.0"].dist.tarball = "https://registry.example.test/ui.tgz";
    verifyRegistryPackageMetadata({ name: "@nexa/ui", metadata: invalid });
  }, /authorized public npm registry/u);
});

test("bootstrap registry evidence is tied to the revision staging channel", () => {
  const bootstrapChannel = `technical-preview-staging-${revision.slice(0, 12)}`;
  assert.equal(registryChannelForPhase({ phase: "bootstrap", revision }), bootstrapChannel);
  assert.equal(registryChannelForPhase({ phase: "final", revision }), "technical-preview");
  assert.deepEqual(
    verifyRegistryPackageMetadata({
      name: "@nexa/ui",
      metadata: metadata("@nexa/ui", "0.1.0", bootstrapChannel),
      phase: "bootstrap",
      revision,
    }),
    {
      name: "@nexa/ui",
      version: "0.1.0",
      phase: "bootstrap",
      channel: bootstrapChannel,
      integrity: integrity("@nexa/ui"),
      tarball: `${registry}${encodeURIComponent("@nexa/ui")}/-/ui-0.1.0.tgz`,
    },
  );
  assert.throws(
    () =>
      verifyRegistryPackageMetadata({
        name: "@nexa/ui",
        metadata: metadata("@nexa/ui"),
        phase: "bootstrap",
        revision,
      }),
    /revision staging channel/u,
  );
});

test("hosted collection produces a proof tied to the source revision and installed lock integrity", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-registry-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, "proof");
  const runner = commandRunner();
  const bootstrapChannel = registryChannelForPhase({ phase: "bootstrap", revision });
  const metadataByName = new Map(
    packages.map((name) => [name, metadata(name, "0.1.0", bootstrapChannel)]),
  );

  const record = await collectRegistryEvidence({
    outputDirectory,
    revision,
    ref,
    phase: "bootstrap",
    hosted,
    fetchJson: async (url) => {
      const encodedName = url.slice(registry.length);
      return metadataByName.get(decodeURIComponent(encodedName));
    },
    runCommand: runner.run,
  });

  assert.equal(record.revision, revision);
  assert.equal(record.ref, ref);
  assert.equal(record.phase, "bootstrap");
  assert.equal(record.channel, bootstrapChannel);
  assert.equal(record.registry, registry);
  assert.equal(record.train.length, 9);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.consumer.commands.length, 9);
  assert.equal(record.hosted.platform, "darwin");
  assert.equal(record.hosted.arch, "arm64");
  assert.match(record.consumer.quickstart.artifact.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(record.consumer.quickstart.artifact.files >= 3);
  assert.equal(existsSync(path.join(outputDirectory, "registry-evidence.json")), true);
  assert.deepEqual(readdirSync(outputDirectory).sort(), [
    "consumer-package.json",
    "pnpm-lock.yaml",
    "quickstart-app-manifest.json",
    "quickstart-artifact.json",
    "quickstart-package.json",
    "quickstart-pnpm-lock.yaml",
    "registry-evidence.json",
  ]);
  assert.deepEqual(
    verifyRegistryEvidence({
      evidenceFile: path.join(outputDirectory, "registry-evidence.json"),
      revision,
      ref,
      phase: "bootstrap",
    }),
    record,
  );
  const install = runner.calls.find(
    ({ command, args }) => command === "pnpm" && args[0] === "install",
  );
  assert.equal(install.args.includes(`--registry=${registry}`), true);
  assert.equal(install.args.includes("--ignore-scripts"), true);
  assert.equal(install.options.env.NPM_CONFIG_REGISTRY, registry);
  assert.equal(install.options.env.NODE_PATH, undefined);
});

test("registry proof rejects unsupported runners and a substituted package inventory", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-registry-evidence-negative-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bootstrapChannel = registryChannelForPhase({ phase: "bootstrap", revision });
  const metadataByName = new Map(
    packages.map((name) => [name, metadata(name, "0.1.0", bootstrapChannel)]),
  );
  const fetchJson = async (url) => metadataByName.get(decodeURIComponent(url.slice(registry.length)));

  await assert.rejects(
    () =>
      collectRegistryEvidence({
        outputDirectory: path.join(root, "unsupported"),
        revision,
        ref,
        phase: "bootstrap",
        hosted: { ...hosted, platform: "linux", arch: "x64" },
        fetchJson,
        runCommand: commandRunner().run,
      }),
    /supported Desktop Technical Preview target/u,
  );

  const outputDirectory = path.join(root, "proof");
  await collectRegistryEvidence({
    outputDirectory,
    revision,
    ref,
    phase: "bootstrap",
    hosted,
    fetchJson,
    runCommand: commandRunner().run,
  });
  const artifactFile = path.join(outputDirectory, "quickstart-artifact.json");
  const artifact = JSON.parse(readFileSync(artifactFile, "utf8"));
  artifact.files[0].sha256 = "0".repeat(64);
  writeFileSync(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`);
  const proofFile = path.join(outputDirectory, "registry-evidence.json");
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  proof.consumer.quickstart.artifact.manifestSha256 = createHash("sha256")
    .update(readFileSync(artifactFile))
    .digest("hex");
  writeFileSync(proofFile, `${JSON.stringify(proof, null, 2)}\n`);
  assert.throws(
    () =>
      verifyRegistryEvidence({
        evidenceFile: proofFile,
        revision,
        ref,
        phase: "bootstrap",
      }),
    /artifact binding|inventory digest/u,
  );
});

test("collection fails closed without hosted custody or when a lockfile integrity drifts", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-registry-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, "proof");
  const metadataByName = new Map(packages.map((name) => [name, metadata(name)]));

  await assert.rejects(
    () =>
      collectRegistryEvidence({
        outputDirectory,
        revision,
        ref,
        fetchJson: async (url) =>
          metadataByName.get(decodeURIComponent(url.slice(registry.length))),
        runCommand: commandRunner().run,
      }),
    /GitHub Actions custody/u,
  );
  assert.equal(existsSync(outputDirectory), false);

  const driftedRunner = commandRunner();
  const originalRun = driftedRunner.run;
  driftedRunner.run = (command, args, options) => {
    const result = originalRun(command, args, options);
    if (command === "pnpm" && args[0] === "install") {
      const file = path.join(options.cwd, "pnpm-lock.yaml");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(integrity("@nexa/ui"), integrity("drift")),
      );
    }
    return result;
  };
  await assert.rejects(
    () =>
      collectRegistryEvidence({
        outputDirectory,
        revision,
        ref,
        hosted,
        fetchJson: async (url) =>
          metadataByName.get(decodeURIComponent(url.slice(registry.length))),
        runCommand: driftedRunner.run,
      }),
    /lockfile integrity/u,
  );
  assert.equal(existsSync(outputDirectory), false);
});

test("registry workflow confines real evidence collection to an exact tagged GitHub Actions run", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/registry-evidence.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.phase.options, ["bootstrap", "final"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.phase.default, "bootstrap");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const job = workflow.jobs.registry;
  assert.equal(job.environment.name, "technical-preview-registry-evidence");
  assert.equal(job["runs-on"], "macos-15");
  const commands = job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(commands, /refs\/tags\/v0\.1\.0/u);
  assert.match(commands, /git rev-parse HEAD/u);
  assert.match(commands, /registry-evidence\.mjs collect/u);
  assert.match(commands, /registry-evidence\.mjs verify/u);
  assert.match(commands, /--phase "\$\{\{ inputs\.phase \}\}"/u);
  assert.match(commands, /--frozen-lockfile/u);
  assert.match(commands, /node --test tools\/registry-evidence\.test\.mjs/u);
  const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.with.name, "registry-evidence");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["compression-level"], 0);
});

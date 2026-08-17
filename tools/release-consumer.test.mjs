import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNativeHostsLinked,
  createConsumerManifest,
  packageManagerCommand,
  packageManagerLauncher,
  prepareNativeConsumerEnvironment,
  releaseRehearsalPlan,
} from "./release-consumer.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

test("release consumer resolves the pnpm launcher for each host platform", () => {
  assert.equal(packageManagerCommand({ platform: "win32" }), "pnpm.cmd");
  assert.equal(packageManagerCommand({ platform: "darwin" }), "pnpm");
  assert.equal(packageManagerCommand({ platform: "linux" }), "pnpm");
});

test("release consumer keeps Windows pnpm path arguments out of the command interpreter", (t) => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "nexa-release-pnpm-"));
  t.after(() => rmSync(temporaryDirectory, { force: true, recursive: true }));
  const pnpmEntrypoint = path.join(temporaryDirectory, "pnpm.cjs");
  writeFileSync(pnpmEntrypoint, "// pnpm fixture\n");
  const artifactsDirectory = path.join(temporaryDirectory, "candidate & echo injected");
  const args = ["pack", "--pack-destination", artifactsDirectory];
  const nodeExecutable = path.join(temporaryDirectory, "node.exe");

  assert.deepEqual(
    packageManagerLauncher({
      args,
      environment: { npm_execpath: pnpmEntrypoint },
      nodeExecutable,
      platform: "win32",
    }),
    {
      command: nodeExecutable,
      args: [pnpmEntrypoint, "pack", "--pack-destination", artifactsDirectory],
    },
  );
});

test("release consumer accepts only a regular pnpm.cjs from the action installation", (t) => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "nexa-release-pnpm-home-"));
  t.after(() => rmSync(temporaryDirectory, { force: true, recursive: true }));
  const pnpmHome = path.join(temporaryDirectory, "node_modules", ".bin");
  const pnpmEntrypoint = path.join(temporaryDirectory, "node_modules", "pnpm", "bin", "pnpm.cjs");
  mkdirSync(pnpmHome, { recursive: true });
  mkdirSync(path.dirname(pnpmEntrypoint), { recursive: true });
  writeFileSync(pnpmEntrypoint, "// pnpm fixture\n");

  assert.deepEqual(
    packageManagerLauncher({
      args: ["--version"],
      environment: { PNPM_HOME: pnpmHome },
      nodeExecutable: process.execPath,
      platform: "win32",
    }),
    {
      command: process.execPath,
      args: [pnpmEntrypoint, "--version"],
    },
  );

  rmSync(pnpmEntrypoint);
  mkdirSync(pnpmEntrypoint);
  assert.throws(
    () =>
      packageManagerLauncher({
        args: ["--version"],
        environment: { PNPM_HOME: pnpmHome },
        platform: "win32",
      }),
    /regular pnpm\.cjs entrypoint/u,
  );
});

test("release rehearsal plan covers every public package and fail-closed stage", () => {
  const plan = releaseRehearsalPlan();
  assert.deepEqual(plan.packages, [
    "@nexa/cli",
    "@nexa/ui",
    "@nexa/adapter-solid",
    "@nexa/fs",
    "@nexa/dialog",
    "@nexa/clipboard",
    "@nexa/protocol",
    "@nexa/nui-host",
    "@nexa/system-host",
  ]);
  assert.deepEqual(plan.stages, [
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
  ]);

  const cli = spawnSync(
    process.execPath,
    [path.join(root, "tools/release-consumer.mjs"), "--plan"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), plan);
});

test("native consumer requires installed Hosts and stages pinned Windows Skia inside it", () => {
  const consumer = path.join(root, ".test-clean-consumer");
  const archive = path.join(root, ".test-skia.tar.gz");
  const calls = [];
  const prepared = prepareNativeConsumerEnvironment({
    consumerDirectory: consumer,
    environment: {
      nexa_require_installed_hosts: "stale",
      NEXA_WINDOWS_SKIA_ARCHIVE: archive,
      SKIA_WINDOWS_ARCHIVE_SHA256: "a".repeat(64),
    },
    runtime: { platform: "win32", arch: "x64" },
    stageSkia(options) {
      calls.push(options);
      return {
        destination: path.join(consumer, "node_modules/@nexa/nui-host/native-libs"),
        sha256: "a".repeat(64),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectDirectory, consumer);
  assert.equal(calls[0].archivePath, archive);
  assert.equal(calls[0].expectedSha256, "a".repeat(64));
  assert.equal(calls[0].environment.NEXA_REQUIRE_INSTALLED_HOSTS, "1");
  assert.deepEqual(
    Object.keys(prepared.environment).filter(
      (name) => name.toUpperCase() === "NEXA_REQUIRE_INSTALLED_HOSTS",
    ),
    ["NEXA_REQUIRE_INSTALLED_HOSTS"],
  );
  assert.deepEqual(prepared.windowsSkia, {
    destination: "node_modules/@nexa/nui-host/native-libs",
    sha256: "a".repeat(64),
  });
  assert.throws(
    () =>
      prepareNativeConsumerEnvironment({
        consumerDirectory: consumer,
        environment: {},
        runtime: { platform: "win32", arch: "x64" },
        stageSkia() {
          throw new Error("must fail before staging");
        },
      }),
    /NEXA_WINDOWS_SKIA_ARCHIVE must be an absolute path/u,
  );
});

test("Windows native consumer moves Cargo output out of the installed package tree", () => {
  const consumer = path.join(root, ".test-clean-consumer", "consumer");
  const archive = path.join(root, ".test-skia.tar.gz");
  const prepared = prepareNativeConsumerEnvironment({
    consumerDirectory: consumer,
    environment: {
      cargo_target_dir: path.join(consumer, "node_modules", ".pnpm", "stale-target"),
      NEXA_WINDOWS_SKIA_ARCHIVE: archive,
    },
    runtime: { platform: "win32", arch: "x64" },
    stageSkia() {
      return {
        destination: path.join(consumer, "node_modules/@nexa/nui-host/native-libs"),
        sha256: "a".repeat(64),
      };
    },
  });

  assert.equal(
    prepared.environment.CARGO_TARGET_DIR,
    path.join(path.dirname(consumer), "cargo-target"),
  );
  assert.deepEqual(
    Object.keys(prepared.environment).filter((name) => name.toUpperCase() === "CARGO_TARGET_DIR"),
    ["CARGO_TARGET_DIR"],
  );
});

test("clean consumer uses only packed Nexa artifacts and pinned public tooling", () => {
  const tarballs = new Map(
    releaseRehearsalPlan().packages.map((name) => [
      name,
      `/outside/${name.replace("@nexa/", "nexa-")}-0.1.0.tgz`,
    ]),
  );
  const manifest = createConsumerManifest(tarballs);
  assert.equal(manifest.private, true);
  assert.equal(manifest.devDependencies["@perryts/perry"], "0.5.1220");
  assert.equal(manifest.devDependencies.typescript, "5.9.2");
  for (const dependency of releaseRehearsalPlan().packages) {
    assert.match(manifest.dependencies[dependency], /^file:\.\.\/artifacts\/.*\.tgz$/u);
    assert.equal(manifest.pnpm.overrides[dependency], manifest.dependencies[dependency]);
  }
  assert.deepEqual(manifest.perry.allow.nativeLibrary, [
    "@nexa/nui-host",
    "@nexa/system-host",
    "@nexa/ui",
  ]);
  assert.deepEqual(manifest.perry.compilePackages, [
    ...releaseRehearsalPlan().packages.slice(1),
    "solid-js",
  ]);
  assert.deepEqual(manifest.perry.allow.compilePackages, manifest.perry.compilePackages);
});

test("native consumer proof requires both Host archives in the final binary", () => {
  const manifest = Buffer.from('{"id":"dev.nexa.release-consumer"}\n');
  const linked = Buffer.concat([
    Buffer.from("binary-prefix\0nexa-nui-host\0"),
    manifest,
    Buffer.from("\0binary-suffix"),
  ]);

  assert.equal(assertNativeHostsLinked(linked, manifest), true);
  assert.throws(
    () =>
      assertNativeHostsLinked(
        Buffer.concat([Buffer.from("nexa-nui-host"), manifest.subarray(1)]),
        manifest,
      ),
    /System Host archive/u,
  );
  assert.throws(
    () =>
      assertNativeHostsLinked(Buffer.concat([Buffer.from("wrong-nui-host"), manifest]), manifest),
    /NUI Host archive/u,
  );
});

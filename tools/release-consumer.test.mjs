import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNativeHostsLinked,
  createConsumerManifest,
  releaseRehearsalPlan,
} from "./release-consumer.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

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

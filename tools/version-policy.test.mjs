import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

function versionedWorkspaceSnapshot() {
  const release = json("release/packages.json");
  const files = [".changeset/config.json"];
  for (const name of readdirSync(path.join(root, ".changeset"))) {
    if (name.endsWith(".md")) files.push(`.changeset/${name}`);
  }
  for (const entry of [...release.npm.public, ...release.npm.private]) {
    files.push(`${entry.path}/package.json`);
    if (existsSync(path.join(root, entry.path, "CHANGELOG.md"))) {
      files.push(`${entry.path}/CHANGELOG.md`);
    }
  }
  return Object.fromEntries(
    files.sort().map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
}

test("version policy keeps package, native runtime, protocol, and toolchain axes separate", () => {
  const policy = json("release/version.json");
  const constants = read("packages/cli/src/constants.mjs");
  const root = json("package.json");

  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.npmTrain, "0.1.0");
  assert.equal(policy.rustTrain, "0.1.0");
  assert.equal(policy.protocol, "1.0.0");
  assert.equal(policy.hostAbi, "0.5");
  assert.equal(policy.perry, "0.5.1220");
  assert.equal(policy.node, ">=22");
  assert.equal(policy.pnpm, "10.34.3");
  assert.equal(policy.typescript, "5.9.2");
  assert.equal(root.version, policy.npmTrain);
  for (const value of Object.values(policy)) {
    if (typeof value === "string")
      assert.match(constants, new RegExp(value.replace(/[.+]/gu, "\\$&"), "u"));
  }
  assert.match(
    read("docs/VERSIONING.md"),
    /Protocol and Host ABI compatibility are not\s+inferred from npm SemVer[\s\S]+independent axes/u,
  );
  assert.match(read("docs/VERSIONING.md"), /0\.x/u);
});

test("Changesets uses one fixed public release train and ignores private candidates", () => {
  const config = json(".changeset/config.json");
  const release = json("release/packages.json");
  const publicNames = release.npm.public.map(({ name }) => name).sort();
  const fixed = [...config.fixed[0]].sort();
  assert.deepEqual(fixed, publicNames);
  assert.equal(config.access, "public");
  assert.deepEqual([...config.ignore].sort(), release.npm.private.map(({ name }) => name).sort());
  assert.equal(config.updateInternalDependencies, "patch");
  const readme = read(".changeset/README.md");
  const initialCandidate = read(".changeset/initial-technical-preview.md");
  assert.match(readme, /nine public packages/u);
  assert.match(readme, /changeset status/u);
  assert.match(initialCandidate, /^---\n---\n/u);
  assert.match(initialCandidate, /initial `0\.1\.0` Technical Preview candidate/u);
  assert.match(read("CHANGELOG.md"), /^## 0\.1\.0/mu);
});

test("version rehearsal runs Changesets in isolation and validates its generated release", () => {
  const packageJson = json("package.json");
  assert.equal(packageJson.scripts["version:check"], "node tools/version-policy.mjs check");
  assert.equal(packageJson.scripts["version:rehearse"], "node tools/version-policy.mjs rehearse");

  const before = versionedWorkspaceSnapshot();
  const result = spawnSync(process.execPath, ["tools/version-policy.mjs", "rehearse"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Changesets version executed in an isolated temporary workspace/u);
  assert.match(result.stdout, /fixed release train 0\.1\.0 -> 0\.1\.1 \(9 packages\)/u);
  assert.match(result.stdout, /validated 9 internal dependency ranges/u);
  assert.match(result.stdout, /validated 9 generated package changelogs/u);
  assert.match(result.stdout, /packed manifests verified 9\/9/u);
  assert.match(result.stdout, /consumer dependency closure verified 9\/9/u);
  assert.match(result.stdout, /temporary workspace removed; source working tree unchanged/u);
  assert.deepEqual(versionedWorkspaceSnapshot(), before);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPerryWorkspaceEnvironment,
  resolvePerryWorkspace,
} from "../packages/cli/src/perry-workspace.mjs";
import { COMPATIBILITY, PERRY_SOURCE_REVISION } from "../packages/cli/src/constants.mjs";

const perrySource = `git+https://github.com/PerryTS/perry?rev=${PERRY_SOURCE_REVISION}#${PERRY_SOURCE_REVISION}`;
const requiredCrates = ["perry-ffi", "perry-runtime", "perry-stdlib", "perry-ui-geisterhand"];

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-perry-workspace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFile(filePath, source = '[package]\nname = "fixture"\nversion = "0.0.0"\n') {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

function workspaceFixture(t) {
  const directory = temporaryDirectory(t);
  const workspace = path.join(directory, "perry");
  writeFile(path.join(workspace, "Cargo.toml"), '[workspace]\nresolver = "2"\n');
  for (const crate of requiredCrates) {
    writeFile(path.join(workspace, "crates", crate, "Cargo.toml"));
  }
  return { directory, workspace: realpathSync(workspace) };
}

function perryMetadata(workspace, overrides = {}) {
  return {
    packages: [
      {
        name: "perry-ffi",
        version: COMPATIBILITY.perry,
        source: perrySource,
        manifest_path: path.join(workspace, "crates", "perry-ffi", "Cargo.toml"),
        ...overrides,
      },
    ],
  };
}

function commandResult(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function metadataRunner(metadata, { head = PERRY_SOURCE_REVISION, status = "" } = {}) {
  const calls = [];
  return {
    calls,
    runner(command, args, options) {
      calls.push({ command, args, options });
      if (command === "cargo") return commandResult(0, JSON.stringify(metadata));
      if (command === "git" && args.at(-1) === "HEAD") return commandResult(0, `${head}\n`);
      if (command === "git" && args.includes("status")) return commandResult(0, status);
      return commandResult(99, "", `unexpected command: ${command} ${args.join(" ")}`);
    },
  };
}

function directHostManifest(directory) {
  const manifestPath = path.join(directory, "host", "Cargo.toml");
  writeFile(manifestPath);
  return manifestPath;
}

test("resolver binds cargo metadata to the exact clean Perry source checkout", (t) => {
  const fixture = workspaceFixture(t);
  const hostManifestPath = directHostManifest(fixture.directory);
  const canonicalHostManifestPath = realpathSync(hostManifestPath);
  const command = metadataRunner(perryMetadata(fixture.workspace));

  const resolved = resolvePerryWorkspace({ hostManifestPath, runner: command.runner });

  assert.equal(resolved, fixture.workspace);
  assert.deepEqual(
    command.calls.map(({ command, args }) => ({ command, args })),
    [
      {
        command: "cargo",
        args: [
          "metadata",
          "--manifest-path",
          canonicalHostManifestPath,
          "--locked",
          "--format-version",
          "1",
        ],
      },
      {
        command: "git",
        args: ["-C", fixture.workspace, "rev-parse", "HEAD"],
      },
      {
        command: "git",
        args: ["-C", fixture.workspace, "status", "--short", "--untracked-files=no"],
      },
    ],
  );
  assert.ok(command.calls.every(({ options }) => options.encoding === "utf8"));
});

test("resolver locates the published NUI Host native closure", (t) => {
  const fixture = workspaceFixture(t);
  const hostDirectory = path.join(fixture.directory, "nui-host");
  const hostManifestPath = path.join(
    hostDirectory,
    "dist",
    "native",
    "repo",
    "packages",
    "nui-host",
    "Cargo.toml",
  );
  const manifest = {
    name: "@nexa/nui-host",
    version: COMPATIBILITY.hostRuntime,
    perry: {
      nativeLibrary: {
        targets: {
          macos: { crate: "dist/native/repo/packages/nui-host" },
          windows: { crate: "dist/native/repo/packages/nui-host" },
        },
      },
    },
  };
  writeFile(path.join(hostDirectory, "package.json"), `${JSON.stringify(manifest)}\n`);
  writeFile(hostManifestPath);
  const canonicalHostManifestPath = realpathSync(hostManifestPath);
  const command = metadataRunner(perryMetadata(fixture.workspace));

  const resolved = resolvePerryWorkspace({
    projectDirectory: fixture.directory,
    resolvePackage(packageName, projectDirectory) {
      assert.equal(packageName, "@nexa/nui-host");
      assert.equal(projectDirectory, fixture.directory);
      return { filePath: path.join(hostDirectory, "package.json"), manifest };
    },
    runner: command.runner,
  });

  assert.equal(resolved, fixture.workspace);
  assert.deepEqual(command.calls[0].args.slice(0, 4), [
    "metadata",
    "--manifest-path",
    canonicalHostManifestPath,
    "--locked",
  ]);
});

test("resolver rejects wrong Perry versions, source revisions, and checkout revisions", (t) => {
  const fixture = workspaceFixture(t);
  const hostManifestPath = directHostManifest(fixture.directory);

  const wrongVersion = metadataRunner(perryMetadata(fixture.workspace, { version: "0.5.1219" }));
  assert.throws(
    () => resolvePerryWorkspace({ hostManifestPath, runner: wrongVersion.runner }),
    /Perry source version 0\.5\.1219 does not match required 0\.5\.1220/u,
  );

  const otherRevision = "f".repeat(40);
  const wrongSource = metadataRunner(
    perryMetadata(fixture.workspace, {
      source: `git+https://github.com/PerryTS/perry?rev=${otherRevision}#${otherRevision}`,
    }),
  );
  assert.throws(
    () => resolvePerryWorkspace({ hostManifestPath, runner: wrongSource.runner }),
    new RegExp(
      `Perry source revision ${otherRevision} does not match required ${PERRY_SOURCE_REVISION}`,
      "u",
    ),
  );

  const wrongCheckout = metadataRunner(perryMetadata(fixture.workspace), { head: otherRevision });
  assert.throws(
    () => resolvePerryWorkspace({ hostManifestPath, runner: wrongCheckout.runner }),
    new RegExp(
      `Perry checkout HEAD ${otherRevision} does not match required ${PERRY_SOURCE_REVISION}`,
      "u",
    ),
  );
});

test("resolver rejects missing, dirty, and ambiguous Perry source", (t) => {
  const fixture = workspaceFixture(t);
  const hostManifestPath = directHostManifest(fixture.directory);

  rmSync(path.join(fixture.workspace, "crates", "perry-stdlib", "Cargo.toml"));
  const missing = metadataRunner(perryMetadata(fixture.workspace));
  assert.throws(
    () => resolvePerryWorkspace({ hostManifestPath, runner: missing.runner }),
    /Perry workspace is missing required crate perry-stdlib/u,
  );

  writeFile(path.join(fixture.workspace, "crates", "perry-stdlib", "Cargo.toml"));
  const dirty = metadataRunner(perryMetadata(fixture.workspace), {
    status: " M crates/perry-runtime/src/lib.rs\n",
  });
  assert.throws(
    () => resolvePerryWorkspace({ hostManifestPath, runner: dirty.runner }),
    /Perry source checkout has tracked changes/u,
  );

  const ambiguous = metadataRunner({
    packages: [
      ...perryMetadata(fixture.workspace).packages,
      ...perryMetadata(fixture.workspace).packages,
    ],
  });
  assert.throws(
    () => resolvePerryWorkspace({ hostManifestPath, runner: ambiguous.runner }),
    /Cargo metadata must contain exactly one perry-ffi package/u,
  );
});

test("resolver fails closed for a missing or escaping published native closure", (t) => {
  const fixture = workspaceFixture(t);
  const hostDirectory = path.join(fixture.directory, "nui-host");
  const packagePath = path.join(hostDirectory, "package.json");
  const manifest = {
    name: "@nexa/nui-host",
    version: COMPATIBILITY.hostRuntime,
    perry: { nativeLibrary: { targets: { macos: { crate: "../outside" } } } },
  };
  writeFile(packagePath, `${JSON.stringify(manifest)}\n`);

  assert.throws(
    () =>
      resolvePerryWorkspace({
        projectDirectory: fixture.directory,
        resolvePackage: () => ({ filePath: packagePath, manifest }),
        runner: metadataRunner(perryMetadata(fixture.workspace)).runner,
      }),
    /NUI Host native crate must stay inside the installed package/u,
  );

  manifest.perry.nativeLibrary.targets.macos.crate = "dist/native/repo/packages/nui-host";
  assert.throws(
    () =>
      resolvePerryWorkspace({
        projectDirectory: fixture.directory,
        resolvePackage: () => ({ filePath: packagePath, manifest }),
        runner: metadataRunner(perryMetadata(fixture.workspace)).runner,
      }),
    /NUI Host native (?:crate|Cargo manifest) does not exist/u,
  );
});

test("Perry environment replacement removes stale case variants", (t) => {
  const fixture = workspaceFixture(t);
  const environment = createPerryWorkspaceEnvironment(
    {
      PATH: "/usr/bin",
      PERRY_WORKSPACE_ROOT: "/stale/uppercase",
      perry_workspace_root: "/stale/lowercase",
      PERRY_NO_CACHE: "1",
    },
    fixture.workspace,
  );

  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.PERRY_NO_CACHE, "1");
  assert.equal(environment.PERRY_WORKSPACE_ROOT, fixture.workspace);
  assert.deepEqual(
    Object.keys(environment).filter((key) => key.toUpperCase() === "PERRY_WORKSPACE_ROOT"),
    ["PERRY_WORKSPACE_ROOT"],
  );
  assert.equal(
    readFileSync(path.join(environment.PERRY_WORKSPACE_ROOT, "Cargo.toml"), "utf8"),
    '[workspace]\nresolver = "2"\n',
  );
});

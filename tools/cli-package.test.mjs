import assert from "node:assert/strict";
import * as nodeFilesystem from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { COMPATIBILITY } from "../packages/cli/src/constants.mjs";
import { runCli } from "../packages/cli/src/index.mjs";
import {
  exportVerifiedPackageArtifact,
  parseCreatePackageSmokeArguments,
  runCreatePackageSmoke,
} from "./cli-create-package-smoke.mjs";

const manifest = {
  $schema: "https://nexa-ui.dev/schema/app-manifest-v1.json",
  schemaVersion: 1,
  id: "dev.nexa.temp-app",
  name: "Temp & <App>",
  version: "1.2.3-beta.1+build.5",
  requiredProtocol: { major: 1, minor: 0 },
  permissions: [],
};

function temporaryDirectory(t) {
  const directory = nodeFilesystem.mkdtempSync(path.join(tmpdir(), "nexa-cli-package-"));
  t.after(() => nodeFilesystem.rmSync(directory, { recursive: true, force: true }));
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
  nodeFilesystem.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fakePerrySource() {
  return `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
writeFileSync(process.env.NEXA_TEST_LOG, JSON.stringify({ args, cwd: process.cwd() }));
const output = args[args.indexOf("-o") + 1];
let outputPath = path.resolve(process.cwd(), output);
if (args.includes("--windows-subsystem")) outputPath += ".exe";
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  Buffer.concat([readFileSync(process.env.NEXA_APP_MANIFEST_PATH), Buffer.from("\\0fake-binary")]),
);
`;
}

function projectFixture(t, { appManifest = manifest } = {}) {
  const cwd = temporaryDirectory(t);
  const sourceDirectory = path.join(cwd, "src");
  const perryDirectory = path.join(cwd, "node_modules", "@perryts", "perry");
  const perryBin = path.join(perryDirectory, "bin", "perry.js");
  const logPath = path.join(cwd, "perry-call.json");

  nodeFilesystem.mkdirSync(sourceDirectory, { recursive: true });
  nodeFilesystem.mkdirSync(path.dirname(perryBin), { recursive: true });
  writeJson(path.join(cwd, "package.json"), {
    name: "temp-app",
    private: true,
    type: "module",
    devDependencies: { "@perryts/perry": COMPATIBILITY.perry },
  });
  nodeFilesystem.writeFileSync(path.join(sourceDirectory, "main.tsx"), "export {};\n");
  writeJson(path.join(cwd, "app.manifest.json"), appManifest);
  writeJson(path.join(perryDirectory, "package.json"), {
    name: "@perryts/perry",
    version: COMPATIBILITY.perry,
    type: "module",
    bin: { perry: "bin/perry.js" },
  });
  nodeFilesystem.writeFileSync(perryBin, fakePerrySource());

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
  };
}

function runtime(platform = "darwin") {
  return platform === "win32"
    ? { arch: "x64", platform: "win32" }
    : { arch: "arm64", platform: "darwin" };
}

function filesBelow(directory, prefix = "") {
  return nodeFilesystem.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? filesBelow(path.join(directory, entry.name), relative) : relative;
  });
}

function stagingEntries(cwd) {
  return nodeFilesystem.readdirSync(cwd).filter((name) => name.startsWith(".nexa-package-"));
}

test("package builds an unsigned macOS bundle with exact manifest, metadata, and assets", (t) => {
  const fixture = projectFixture(t);
  const assets = path.join(fixture.cwd, "assets");
  nodeFilesystem.mkdirSync(path.join(assets, "nested"), { recursive: true });
  nodeFilesystem.mkdirSync(path.join(assets, "empty"));
  nodeFilesystem.writeFileSync(path.join(assets, "icon.bin"), Buffer.from([0, 1, 2, 3]));
  nodeFilesystem.writeFileSync(path.join(assets, "nested", "readme.txt"), "asset\n");

  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    runtime: runtime(),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    "Packaged dev.nexa.temp-app@1.2.3-beta.1+build.5: " +
      "dist/temp-app-macos-arm64/temp-app.app\n",
  );

  const artifact = path.join(fixture.cwd, "dist", "temp-app-macos-arm64");
  const bundle = path.join(artifact, "temp-app.app");
  assert.deepEqual(filesBelow(artifact).sort(), [
    path.join("temp-app.app", "Contents", "Info.plist"),
    path.join("temp-app.app", "Contents", "MacOS", "temp-app"),
    path.join("temp-app.app", "Contents", "Resources", "app.manifest.json"),
    path.join("temp-app.app", "Contents", "Resources", "assets", "icon.bin"),
    path.join("temp-app.app", "Contents", "Resources", "assets", "nested", "readme.txt"),
    path.join("temp-app.app", "Contents", "Resources", "nexa-build.json"),
  ]);
  assert.equal(
    nodeFilesystem
      .lstatSync(path.join(bundle, "Contents", "Resources", "assets", "empty"))
      .isDirectory(),
    true,
  );

  const executable = path.join(bundle, "Contents", "MacOS", "temp-app");
  assert.notEqual(nodeFilesystem.lstatSync(executable).mode & 0o111, 0);
  assert.equal(
    nodeFilesystem
      .readFileSync(executable)
      .includes(nodeFilesystem.readFileSync(fixture.manifestPath)),
    true,
  );
  assert.deepEqual(
    nodeFilesystem.readFileSync(path.join(bundle, "Contents", "Resources", "app.manifest.json")),
    nodeFilesystem.readFileSync(fixture.manifestPath),
  );
  assert.deepEqual(
    nodeFilesystem.readFileSync(path.join(bundle, "Contents", "Resources", "assets", "icon.bin")),
    Buffer.from([0, 1, 2, 3]),
  );

  const metadata = JSON.parse(
    nodeFilesystem.readFileSync(
      path.join(bundle, "Contents", "Resources", "nexa-build.json"),
      "utf8",
    ),
  );
  assert.deepEqual(metadata, {
    schemaVersion: 1,
    app: { id: manifest.id, name: manifest.name, version: manifest.version },
    protocol: { major: 1, minor: 0 },
    target: { arch: "arm64", platform: "darwin" },
    toolchain: {
      cli: COMPATIBILITY.cli,
      hostAbi: COMPATIBILITY.hostAbi,
      hostRuntime: COMPATIBILITY.hostRuntime,
      perry: COMPATIBILITY.perry,
    },
    assets: { bytes: 10, files: 2 },
  });

  const plist = nodeFilesystem.readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8");
  assert.match(
    plist,
    /<key>CFBundleDisplayName<\/key>\s*<string>Temp &amp; &lt;App&gt;<\/string>/u,
  );
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>temp-app<\/string>/u);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.2\.3<\/string>/u);
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.nexa\.temp-app<\/string>/u);
  assert.equal(stagingEntries(fixture.cwd).length, 0);
});

test("package builds a Windows distribution with no development-tool files", (t) => {
  const fixture = projectFixture(t);
  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    runtime: runtime("win32"),
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(
    result.stdout,
    "Packaged dev.nexa.temp-app@1.2.3-beta.1+build.5: dist/temp-app-windows-x64\n",
  );
  const artifact = path.join(fixture.cwd, "dist", "temp-app-windows-x64");
  assert.deepEqual(filesBelow(artifact).sort(), [
    "app.manifest.json",
    "nexa-build.json",
    "temp-app.exe",
  ]);
  assert.deepEqual(
    nodeFilesystem.readFileSync(path.join(artifact, "app.manifest.json")),
    nodeFilesystem.readFileSync(fixture.manifestPath),
  );
  const metadata = JSON.parse(
    nodeFilesystem.readFileSync(path.join(artifact, "nexa-build.json"), "utf8"),
  );
  assert.deepEqual(metadata.target, { arch: "x64", platform: "win32" });
  assert.deepEqual(metadata.assets, { bytes: 0, files: 0 });
  assert.equal(nodeFilesystem.existsSync(path.join(artifact, "assets")), false);
  assert.equal(
    filesBelow(artifact).some((entry) => /node_modules|Cargo|perry/iu.test(entry)),
    false,
  );

  const call = JSON.parse(nodeFilesystem.readFileSync(fixture.logPath, "utf8"));
  assert.deepEqual(call.args.slice(-2), ["--windows-subsystem", "windows"]);
});

test("Windows publication keeps its atomic destination reservation", (t) => {
  const fixture = projectFixture(t);
  const destination = path.join(fixture.cwd, "dist", "temp-app-windows-x64");
  let removedReservation = false;
  const filesystem = {
    ...nodeFilesystem,
    rmdirSync(candidate, ...args) {
      if (candidate === destination) removedReservation = true;
      return nodeFilesystem.rmdirSync(candidate, ...args);
    },
  };
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let result;
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    result = invoke(["package"], {
      cwd: fixture.cwd,
      environment: fixture.environment,
      filesystem,
      runtime: runtime("win32"),
    });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }

  assert.equal(removedReservation, false);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(nodeFilesystem.existsSync(path.join(destination, "nexa-build.json")), true);
});

test("package refuses existing directory and symbolic-link destinations before build", (t) => {
  for (const kind of ["directory", "symlink"]) {
    const fixture = projectFixture(t);
    const dist = path.join(fixture.cwd, "dist");
    const destination = path.join(dist, "temp-app-macos-arm64");
    nodeFilesystem.mkdirSync(dist);
    let sentinel;
    if (kind === "directory") {
      nodeFilesystem.mkdirSync(destination);
      sentinel = path.join(destination, "sentinel.txt");
    } else {
      const outside = path.join(fixture.cwd, "outside");
      nodeFilesystem.mkdirSync(outside);
      nodeFilesystem.symlinkSync(
        outside,
        destination,
        process.platform === "win32" ? "junction" : "dir",
      );
      sentinel = path.join(outside, "sentinel.txt");
    }
    nodeFilesystem.writeFileSync(sentinel, kind);

    const result = invoke(["package"], {
      cwd: fixture.cwd,
      environment: fixture.environment,
      runtime: runtime(),
    });
    assert.equal(result.exitCode, 1, kind);
    assert.match(result.stderr, /package destination.*exists|artifact.*exists/iu);
    assert.equal(nodeFilesystem.readFileSync(sentinel, "utf8"), kind);
    assert.equal(nodeFilesystem.existsSync(fixture.logPath), false, `${kind} must fail pre-build`);
  }
});

test("package atomically refuses a destination claimed at publication", (t) => {
  const fixture = projectFixture(t);
  const destination = path.join(fixture.cwd, "dist", "temp-app-macos-arm64");
  const outside = path.join(fixture.cwd, "outside-destination");
  const sentinel = path.join(outside, "sentinel.txt");
  nodeFilesystem.mkdirSync(outside);
  nodeFilesystem.writeFileSync(sentinel, "preserve me");
  let raced = false;
  const filesystem = {
    ...nodeFilesystem,
    mkdirSync(candidate, ...args) {
      if (candidate === destination && !raced) {
        raced = true;
        nodeFilesystem.symlinkSync(
          outside,
          destination,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      return nodeFilesystem.mkdirSync(candidate, ...args);
    },
  };

  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    filesystem,
    runtime: runtime(),
  });

  assert.equal(raced, true, "publication must claim the exact destination atomically");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /package destination.*exists|claim.*destination/iu);
  assert.equal(nodeFilesystem.lstatSync(destination).isSymbolicLink(), true);
  assert.equal(nodeFilesystem.readFileSync(sentinel, "utf8"), "preserve me");
  assert.deepEqual(stagingEntries(fixture.cwd), []);
});

test("package rejects symlinked assets without reading their target or starting Perry", (t) => {
  const fixture = projectFixture(t);
  const outside = path.join(fixture.cwd, "outside-secret.txt");
  const assets = path.join(fixture.cwd, "assets");
  nodeFilesystem.mkdirSync(assets);
  nodeFilesystem.writeFileSync(outside, "do-not-package");
  nodeFilesystem.symlinkSync(outside, path.join(assets, "secret.txt"), "file");

  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    runtime: runtime(),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /asset.*symbolic link|symlink/iu);
  assert.equal(nodeFilesystem.existsSync(fixture.logPath), false);
  assert.equal(nodeFilesystem.readFileSync(outside, "utf8"), "do-not-package");
  assert.deepEqual(stagingEntries(fixture.cwd), []);
});

test("package rejects an asset that changes after inspection and removes staging", (t) => {
  const fixture = projectFixture(t);
  const assets = path.join(fixture.cwd, "assets");
  const asset = path.join(assets, "changing.txt");
  nodeFilesystem.mkdirSync(assets);
  nodeFilesystem.writeFileSync(asset, "before");
  let changed = false;
  let assetDescriptor;
  const filesystem = {
    ...nodeFilesystem,
    openSync(candidate, ...args) {
      const descriptor = nodeFilesystem.openSync(candidate, ...args);
      if (candidate === asset) assetDescriptor = descriptor;
      return descriptor;
    },
    readFileSync(candidate, ...args) {
      if (candidate === assetDescriptor && !changed) {
        changed = true;
        nodeFilesystem.writeFileSync(asset, "after-change");
      }
      return nodeFilesystem.readFileSync(candidate, ...args);
    },
  };

  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    filesystem,
    runtime: runtime(),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /asset.*changed while (?:packaging|reading)/iu);
  assert.equal(changed, true);
  assert.deepEqual(stagingEntries(fixture.cwd), []);
  assert.equal(
    nodeFilesystem.existsSync(path.join(fixture.cwd, "dist", "temp-app-macos-arm64")),
    false,
  );
});

test("package uses lossless descriptor identity when reading assets", (t) => {
  const fixture = projectFixture(t);
  const assets = path.join(fixture.cwd, "assets");
  const asset = path.join(assets, "identity.txt");
  nodeFilesystem.mkdirSync(assets);
  nodeFilesystem.writeFileSync(asset, "identity bytes");
  let assetDescriptor;
  let assetLstatUsedBigInt = false;
  let alteredFileId = false;
  const filesystem = {
    ...nodeFilesystem,
    fstatSync(descriptor, ...args) {
      const metadata = nodeFilesystem.fstatSync(descriptor, ...args);
      if (descriptor === assetDescriptor && args[0]?.bigint === true && !alteredFileId) {
        alteredFileId = true;
        metadata.ino += 1n;
      }
      return metadata;
    },
    lstatSync(candidate, ...args) {
      if (candidate === asset && args[0]?.bigint === true) assetLstatUsedBigInt = true;
      return nodeFilesystem.lstatSync(candidate, ...args);
    },
    openSync(candidate, ...args) {
      const descriptor = nodeFilesystem.openSync(candidate, ...args);
      if (candidate === asset) assetDescriptor = descriptor;
      return descriptor;
    },
  };

  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    filesystem,
    runtime: runtime(),
  });

  assert.equal(assetLstatUsedBigInt, true);
  assert.equal(alteredFileId, true);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /asset.*changed before it could be read/iu);
  assert.equal(
    nodeFilesystem.existsSync(path.join(fixture.cwd, "dist", "temp-app-macos-arm64")),
    false,
  );
  assert.deepEqual(stagingEntries(fixture.cwd), []);
});

test("package rejects an asset replaced by a symlink before it is opened", (t) => {
  const fixture = projectFixture(t);
  const assets = path.join(fixture.cwd, "assets");
  const asset = path.join(assets, "race.txt");
  const original = path.join(fixture.cwd, "race-original.txt");
  const outside = path.join(fixture.cwd, "outside-secret.txt");
  nodeFilesystem.mkdirSync(assets);
  nodeFilesystem.writeFileSync(asset, "public-bytes");
  nodeFilesystem.writeFileSync(outside, "secret-bytes");
  let raced = false;
  const filesystem = {
    ...nodeFilesystem,
    openSync(candidate, ...args) {
      if (candidate === asset && !raced) {
        raced = true;
        nodeFilesystem.renameSync(asset, original);
        nodeFilesystem.symlinkSync(outside, asset, "file");
      }
      return nodeFilesystem.openSync(candidate, ...args);
    },
  };

  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    filesystem,
    runtime: runtime(),
  });

  assert.equal(raced, true);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /asset.*symbolic link|asset.*changed|too many.*symbolic/iu);
  assert.equal(nodeFilesystem.readFileSync(outside, "utf8"), "secret-bytes");
  assert.deepEqual(stagingEntries(fixture.cwd), []);
});

test("package rejects a compiled binary replaced by a symlink before it is opened", (t) => {
  const fixture = projectFixture(t);
  const binary = path.join(fixture.cwd, "dist", "temp-app");
  const outside = path.join(fixture.cwd, "outside-binary");
  nodeFilesystem.writeFileSync(
    outside,
    Buffer.concat([nodeFilesystem.readFileSync(fixture.manifestPath), Buffer.from("\0outside")]),
  );
  let raced = false;
  const filesystem = {
    ...nodeFilesystem,
    openSync(candidate, ...args) {
      if (candidate === binary && !raced) {
        raced = true;
        nodeFilesystem.unlinkSync(binary);
        nodeFilesystem.symlinkSync(outside, binary, "file");
      }
      return nodeFilesystem.openSync(candidate, ...args);
    },
  };

  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    filesystem,
    runtime: runtime(),
  });

  assert.equal(raced, true);
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /compiled binary.*symbolic link|compiled binary.*changed|too many.*symbolic/iu,
  );
  assert.equal(nodeFilesystem.readFileSync(outside).includes(Buffer.from("\0outside")), true);
  assert.deepEqual(stagingEntries(fixture.cwd), []);
});

test("package enforces individual and aggregate asset byte budgets before build", (t) => {
  const individual = projectFixture(t);
  nodeFilesystem.mkdirSync(path.join(individual.cwd, "assets"));
  const individualAsset = path.join(individual.cwd, "assets", "too-large.bin");
  nodeFilesystem.writeFileSync(individualAsset, "");
  nodeFilesystem.truncateSync(individualAsset, 64 * 1024 * 1024 + 1);
  const individualResult = invoke(["package"], {
    cwd: individual.cwd,
    environment: individual.environment,
    runtime: runtime(),
  });
  assert.equal(individualResult.exitCode, 1);
  assert.match(individualResult.stderr, /asset.*64 MiB|67108864/iu);
  assert.equal(nodeFilesystem.existsSync(individual.logPath), false);

  const aggregate = projectFixture(t);
  const aggregateAssets = path.join(aggregate.cwd, "assets");
  nodeFilesystem.mkdirSync(aggregateAssets);
  for (let index = 0; index < 5; index += 1) {
    const asset = path.join(aggregateAssets, `${index}.bin`);
    nodeFilesystem.writeFileSync(asset, "");
    nodeFilesystem.truncateSync(asset, 64 * 1024 * 1024);
  }
  const aggregateResult = invoke(["package"], {
    cwd: aggregate.cwd,
    environment: aggregate.environment,
    runtime: runtime(),
  });
  assert.equal(aggregateResult.exitCode, 1);
  assert.match(aggregateResult.stderr, /assets.*256 MiB|268435456/iu);
  assert.equal(nodeFilesystem.existsSync(aggregate.logPath), false);
});

test("package reports build failure without staging or a success summary", (t) => {
  const fixture = projectFixture(t);
  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    runner: () => ({ status: 17 }),
    runtime: runtime(),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Perry compile.*17/iu);
  assert.doesNotMatch(result.stdout, /Packaged/u);
  assert.deepEqual(stagingEntries(fixture.cwd), []);
  assert.equal(
    nodeFilesystem.existsSync(path.join(fixture.cwd, "dist", "temp-app-macos-arm64")),
    false,
  );
});

test("package removes its staging directory when atomic publication fails", (t) => {
  const fixture = projectFixture(t);
  const filesystem = {
    ...nodeFilesystem,
    renameSync(source, destination) {
      if (
        path.basename(source).startsWith(".nexa-package-") ||
        path.basename(path.dirname(source)).startsWith(".nexa-package-")
      ) {
        throw new Error("injected publish failure");
      }
      return nodeFilesystem.renameSync(source, destination);
    },
  };
  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    filesystem,
    runtime: runtime(),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /publish failure/u);
  assert.doesNotMatch(result.stdout, /Packaged/u);
  assert.deepEqual(stagingEntries(fixture.cwd), []);
  assert.equal(
    nodeFilesystem.existsSync(path.join(fixture.cwd, "dist", "temp-app-macos-arm64")),
    false,
  );
});

test("Windows publication rolls back entries moved before its commit marker", (t) => {
  const fixture = projectFixture(t);
  const assets = path.join(fixture.cwd, "assets");
  nodeFilesystem.mkdirSync(assets);
  nodeFilesystem.writeFileSync(path.join(assets, "asset.txt"), "asset");
  let movedManifest = false;
  let movedAssets = false;
  const filesystem = {
    ...nodeFilesystem,
    renameSync(source, destination) {
      if (path.basename(path.dirname(source)).startsWith(".nexa-package-")) {
        if (path.basename(source) === "app.manifest.json") movedManifest = true;
        if (path.basename(source) === "assets") movedAssets = true;
        if (path.basename(source) === "nexa-build.json") {
          throw new Error("injected Windows commit failure");
        }
      }
      return nodeFilesystem.renameSync(source, destination);
    },
  };

  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    filesystem,
    runtime: runtime("win32"),
  });

  assert.equal(movedManifest, true);
  assert.equal(movedAssets, true);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Windows commit failure/u);
  assert.equal(
    nodeFilesystem.existsSync(path.join(fixture.cwd, "dist", "temp-app-windows-x64")),
    false,
  );
  assert.deepEqual(stagingEntries(fixture.cwd), []);
});

test("Windows publication rejects required staging entries that disappear before commit", (t) => {
  for (const requiredEntry of ["temp-app.exe", "app.manifest.json", "nexa-build.json"]) {
    const fixture = projectFixture(t);
    let removed = false;
    const filesystem = {
      ...nodeFilesystem,
      lstatSync(candidate, ...args) {
        if (
          path.basename(candidate) === requiredEntry &&
          path.basename(path.dirname(candidate)).startsWith(".nexa-package-") &&
          !removed
        ) {
          removed = true;
          nodeFilesystem.unlinkSync(candidate);
        }
        return nodeFilesystem.lstatSync(candidate, ...args);
      },
    };

    const result = invoke(["package"], {
      cwd: fixture.cwd,
      environment: fixture.environment,
      filesystem,
      runtime: runtime("win32"),
    });

    assert.equal(removed, true, requiredEntry);
    assert.equal(result.exitCode, 1, requiredEntry);
    assert.match(result.stderr, /required staged package entry.*(?:disappeared|missing)/iu);
    assert.doesNotMatch(result.stdout, /Packaged/u);
    assert.equal(
      nodeFilesystem.existsSync(path.join(fixture.cwd, "dist", "temp-app-windows-x64")),
      false,
      requiredEntry,
    );
    assert.deepEqual(stagingEntries(fixture.cwd), [], requiredEntry);
  }
});

test("Windows publication rejects wrong-type and symbolic-link staging entries", (t) => {
  for (const replacement of ["directory", "symlink"]) {
    const fixture = projectFixture(t);
    const outside = path.join(fixture.cwd, `${replacement}-outside.txt`);
    nodeFilesystem.writeFileSync(outside, "outside bytes");
    let replaced = false;
    const filesystem = {
      ...nodeFilesystem,
      lstatSync(candidate, ...args) {
        if (
          path.basename(candidate) === "app.manifest.json" &&
          path.basename(path.dirname(candidate)).startsWith(".nexa-package-") &&
          !replaced
        ) {
          replaced = true;
          nodeFilesystem.unlinkSync(candidate);
          if (replacement === "directory") {
            nodeFilesystem.mkdirSync(candidate);
          } else {
            nodeFilesystem.symlinkSync(outside, candidate, "file");
          }
        }
        return nodeFilesystem.lstatSync(candidate, ...args);
      },
    };

    const result = invoke(["package"], {
      cwd: fixture.cwd,
      environment: fixture.environment,
      filesystem,
      runtime: runtime("win32"),
    });

    assert.equal(replaced, true, replacement);
    assert.equal(result.exitCode, 1, replacement);
    assert.match(result.stderr, /staged package entry.*non-symbolic-link regular file/iu);
    assert.equal(nodeFilesystem.readFileSync(outside, "utf8"), "outside bytes");
    assert.equal(
      nodeFilesystem.existsSync(path.join(fixture.cwd, "dist", "temp-app-windows-x64")),
      false,
      replacement,
    );
    assert.deepEqual(stagingEntries(fixture.cwd), [], replacement);
  }
});

test("package reports both publication and staging-cleanup failures", (t) => {
  const fixture = projectFixture(t);
  const filesystem = {
    ...nodeFilesystem,
    renameSync(source, destination) {
      if (
        path.basename(source).startsWith(".nexa-package-") ||
        path.basename(path.dirname(source)).startsWith(".nexa-package-")
      ) {
        throw new Error("injected publish failure");
      }
      return nodeFilesystem.renameSync(source, destination);
    },
    rmSync(candidate, options) {
      if (path.basename(candidate).startsWith(".nexa-package-")) {
        throw new Error("injected cleanup failure");
      }
      return nodeFilesystem.rmSync(candidate, options);
    },
  };

  const result = invoke(["package"], {
    cwd: fixture.cwd,
    environment: fixture.environment,
    filesystem,
    runtime: runtime(),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /publish failure/u);
  assert.match(result.stderr, /cleanup failure/u);
  assert.doesNotMatch(result.stdout, /Packaged/u);
});

test("create-to-package smoke rejects unsupported platform and architecture pairs up front", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const architecture = Object.getOwnPropertyDescriptor(process, "arch");
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    Object.defineProperty(process, "arch", { configurable: true, value: "arm64" });
    assert.throws(
      () => runCreatePackageSmoke({ stdout: outputSink().stream, stderr: outputSink().stream }),
      /Unsupported CLI package smoke target win32\/arm64/u,
    );
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", architecture);
  }
});

test("create-to-package smoke exports a verified artifact to an unclaimed destination", (t) => {
  const root = temporaryDirectory(t);
  const sourceParent = path.join(root, "source");
  const artifact = path.join(sourceParent, "smoke-app-macos-arm64");
  const output = path.join(root, "exported-artifact");
  const executable = path.join(artifact, "smoke-app.app", "Contents", "MacOS", "smoke-app");
  nodeFilesystem.mkdirSync(path.dirname(executable), { recursive: true });
  nodeFilesystem.writeFileSync(executable, "native-binary");
  nodeFilesystem.chmodSync(executable, 0o755);

  const exported = exportVerifiedPackageArtifact({
    artifactDirectory: artifact,
    outputDirectory: output,
  });

  assert.equal(exported, output);
  assert.equal(nodeFilesystem.existsSync(artifact), false);
  assert.equal(
    nodeFilesystem.readFileSync(path.join(exported, path.relative(artifact, executable)), "utf8"),
    "native-binary",
  );
  if (process.platform !== "win32") {
    assert.notEqual(
      nodeFilesystem.statSync(path.join(exported, path.relative(artifact, executable))).mode &
        0o111,
      0,
    );
  }

  const secondArtifact = path.join(sourceParent, "second-artifact");
  nodeFilesystem.mkdirSync(secondArtifact, { recursive: true });
  assert.throws(
    () =>
      exportVerifiedPackageArtifact({
        artifactDirectory: secondArtifact,
        outputDirectory: output,
      }),
    /output destination.*exists/iu,
  );
  assert.equal(nodeFilesystem.existsSync(secondArtifact), true);
});

test("create-to-package smoke export refuses symbolic-link outputs and parents", (t) => {
  const root = temporaryDirectory(t);
  const actualOutput = path.join(root, "actual-output");
  const linkedOutput = path.join(root, "linked-output");
  const actualParent = path.join(root, "actual-parent");
  const linkedParent = path.join(root, "linked-parent");
  const artifact = path.join(root, "artifact");
  nodeFilesystem.mkdirSync(actualOutput);
  nodeFilesystem.mkdirSync(actualParent);
  nodeFilesystem.mkdirSync(artifact);
  nodeFilesystem.symlinkSync(
    actualOutput,
    linkedOutput,
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.throws(
    () =>
      exportVerifiedPackageArtifact({
        artifactDirectory: artifact,
        outputDirectory: linkedOutput,
      }),
    /output destination.*exists|symbolic link/iu,
  );
  assert.equal(nodeFilesystem.existsSync(artifact), true);

  nodeFilesystem.symlinkSync(
    actualParent,
    linkedParent,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () =>
      exportVerifiedPackageArtifact({
        artifactDirectory: artifact,
        outputDirectory: path.join(linkedParent, "artifact"),
      }),
    /output parent must be a non-symbolic-link directory/iu,
  );
  assert.equal(nodeFilesystem.existsSync(artifact), true);
});

test("create-to-package smoke parses only the optional artifact output", (t) => {
  const root = temporaryDirectory(t);

  assert.deepEqual(parseCreatePackageSmokeArguments([], { cwd: root }), {});
  assert.deepEqual(
    parseCreatePackageSmokeArguments(["--artifact-output", "export"], { cwd: root }),
    {
      artifactOutputDirectory: path.join(root, "export"),
    },
  );
  for (const argv of [["--artifact-output"], ["--unknown"], ["--artifact-output", "one", "two"]]) {
    assert.throws(() => parseCreatePackageSmokeArguments(argv, { cwd: root }), /Usage:/u);
  }
});

test("create-to-package smoke cleans its sibling temporary root after a pre-Perry failure", (t) => {
  const parent = temporaryDirectory(t);
  const destination = path.join(parent, "exported-artifact");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const architecture = Object.getOwnPropertyDescriptor(process, "arch");
  let temporaryRoot;

  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    Object.defineProperty(process, "arch", { configurable: true, value: "arm64" });
    assert.throws(
      () =>
        runCreatePackageSmoke({
          artifactOutputDirectory: destination,
          stderr: outputSink().stream,
          stdout: {
            write() {
              const temporaryEntries = nodeFilesystem
                .readdirSync(parent)
                .filter((entry) => entry.startsWith("nexa-cli-create-package-"));
              assert.equal(temporaryEntries.length, 1);
              temporaryRoot = path.join(parent, temporaryEntries[0]);
              throw new Error("injected stdout failure");
            },
          },
        }),
      /nexa new failed with exit code 1/u,
    );
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", architecture);
  }

  assert.equal(path.dirname(temporaryRoot), parent);
  assert.equal(nodeFilesystem.existsSync(temporaryRoot), false);
  assert.equal(nodeFilesystem.existsSync(destination), false);
  assert.deepEqual(nodeFilesystem.readdirSync(parent), []);
});

test("generated projects expose package and CLI usage rejects package options", (t) => {
  const cwd = temporaryDirectory(t);
  const generated = invoke(["new", "generated-app"], { cwd });
  assert.equal(generated.exitCode, 0, generated.stderr);

  const project = path.join(cwd, "generated-app");
  const packageJson = JSON.parse(
    nodeFilesystem.readFileSync(path.join(project, "package.json"), "utf8"),
  );
  assert.equal(packageJson.scripts.package, "nexa package");
  assert.match(
    nodeFilesystem.readFileSync(path.join(project, "README.md"), "utf8"),
    /pnpm package/u,
  );

  const help = invoke(["package", "--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /nexa package/u);
  const unsupported = invoke(["package", "--output", "release"]);
  assert.equal(unsupported.exitCode, 2);
  assert.match(unsupported.stderr, /^Usage:/u);
});

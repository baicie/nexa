import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { COMPATIBILITY, PERRY_SOURCE_REVISION } from "../packages/cli/src/constants.mjs";
import {
  WINDOWS_CLOSURE_RUST_TOOLCHAIN,
  preparePerryRuntimeForCompile,
  prepareWindowsPerryRuntime,
} from "../packages/cli/src/windows-runtime.mjs";

const sharedFiles = {
  "Cargo.toml": '[workspace]\nresolver = "2"\n',
  "Cargo.lock": "version = 4\n",
  "rust-toolchain.toml": '[toolchain]\nchannel = "1.95.0"\n',
  "crates/nui-app-runtime/Cargo.toml": '[package]\nname = "nui-app-runtime"\nversion = "0.1.0"\n',
  "crates/nui-app-runtime/src/lib.rs": "pub const FIXTURE: bool = true;\n",
  "protocol/generated/protocol.rs": "pub const PROTOCOL: u32 = 1;\n",
};

const perrySource = `git+https://github.com/PerryTS/perry?rev=${PERRY_SOURCE_REVISION}#${PERRY_SOURCE_REVISION}`;
const windowsLongjmpUpstreamCommit = "4f397c7ae0b9349d3eddf32b873c5a753cffa3fd";
const windowsLongjmpBeforeSha256 =
  "10073a4f45bb1db32d989be5f9d31405fb8d2798ef42315b67e7ea5bd75b1b05";
const windowsLongjmpAfterSha256 =
  "0a7b0a0f676748a1dd1a166aed57d6e08f1e8b3016d9c51495062cbe48cdae43";
const windowsLongjmpAnchor = "    unsafe { longjmp(jb_ptr, 1) }\n";
const windowsLongjmpReplacement = `    #[cfg(windows)]
    unsafe {
        (jb_ptr as *mut u64).write(0);
    }
${windowsLongjmpAnchor}`;
const fixturePerryRuntimeOriginal = readFileSync(
  new URL("./fixtures/perry-runtime/0613785/exception.rs", import.meta.url),
  "utf8",
);
const fixturePerryRuntimePatched = fixturePerryRuntimeOriginal.replace(
  windowsLongjmpAnchor,
  windowsLongjmpReplacement,
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function windowsLongjmpPatchContract() {
  return {
    schemaVersion: 1,
    sourceRevision: PERRY_SOURCE_REVISION,
    upstreamCommit: windowsLongjmpUpstreamCommit,
    target: "crates/perry-runtime/src/exception.rs",
    beforeSha256: sha256(fixturePerryRuntimeOriginal),
    afterSha256: sha256(fixturePerryRuntimePatched),
    anchor: windowsLongjmpAnchor,
    replacement: windowsLongjmpReplacement,
  };
}

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-windows-runtime-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(filePath, source) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

function hostManifest(name) {
  const host = name.slice("@nexa/".length);
  const target = { crate: `dist/native/repo/packages/${host}`, cargo_features: [] };
  const windows = { ...target };
  if (host === "nui-host") {
    windows.libDirs = ["target/perry-native/windows/skia-binaries"];
  }
  return {
    name,
    version: COMPATIBILITY.hostRuntime,
    perry: {
      nativeLibrary: {
        abiVersion: COMPATIBILITY.hostAbi,
        targets: { macos: target, windows },
      },
    },
  };
}

function createHost(root, name) {
  const host = name.slice("@nexa/".length);
  const packageDirectory = path.join(root, "node_modules", "@nexa", host);
  const manifest = hostManifest(name);
  const manifestPath = path.join(packageDirectory, "package.json");
  write(manifestPath, `${JSON.stringify(manifest)}\n`);
  const nativeRoot = path.join(packageDirectory, "dist/native/repo");
  for (const [relative, source] of Object.entries(sharedFiles)) {
    write(path.join(nativeRoot, relative), source);
  }
  write(
    path.join(nativeRoot, "RELEASE-CLOSURE.json"),
    `${JSON.stringify({ schemaVersion: 1, host: name, layout: "repository-relative", source: "vendored" })}\n`,
  );
  write(
    path.join(nativeRoot, "packages", host, "Cargo.toml"),
    `[package]\nname = "perry-ext-${host.replace("-", "_")}"\nversion = "0.1.0"\n`,
  );
  write(
    path.join(nativeRoot, "packages", host, "src/lib.rs"),
    `pub const HOST: &str = "${host}";\n`,
  );
  if (host === "system-host")
    write(path.join(nativeRoot, "packages/system-host/build.rs"), "fn main() {}\n");
  return { filePath: manifestPath, manifest, nativeRoot, packageDirectory };
}

function closureTemplate(root) {
  const template = path.join(root, "template");
  write(
    path.join(template, "Cargo.toml"),
    `[package]\nname = "nexa-windows-static-closure"\nversion = "0.1.0"\n[lib]\ncrate-type = ["staticlib"]\npath = "src/lib.rs"\n[dependencies]\nperry-stdlib = { git = "https://github.com/PerryTS/perry", rev = "06137858dc8c6f80975238377138f2f948d6ef88", default-features = false, features = ["core", "async-runtime"] }\nperry-runtime = { git = "https://github.com/PerryTS/perry", rev = "06137858dc8c6f80975238377138f2f948d6ef88", default-features = false, features = ["stdlib", "regex-engine"] }\nperry-ext-nui_host = { path = "../../../nui-host" }\nperry-ext-nexa_system_host = { path = "../../../system-host" }\n[workspace]\nresolver = "2"\n`,
  );
  write(path.join(template, "Cargo.lock"), "version = 4\n");
  write(path.join(template, "src/lib.rs"), "extern crate perry_runtime;\n");
  write(
    path.join(template, "patches/perry-runtime-windows-longjmp.json"),
    `${JSON.stringify(windowsLongjmpPatchContract(), null, 2)}\n`,
  );
  return template;
}

function fixture(t) {
  const root = temporaryDirectory(t);
  const projectDirectory = path.join(root, "consumer");
  mkdirSync(projectDirectory, { recursive: true });
  const hosts = new Map([
    ["@nexa/nui-host", createHost(projectDirectory, "@nexa/nui-host")],
    ["@nexa/system-host", createHost(projectDirectory, "@nexa/system-host")],
  ]);
  const manifestPath = path.join(projectDirectory, "app.manifest.json");
  write(manifestPath, '{"id":"dev.nexa.first"}\n');
  const tempRoot = path.join(root, "runtime-temp");
  mkdirSync(tempRoot);
  return {
    root,
    projectDirectory,
    hosts,
    manifestPath,
    templateRoot: closureTemplate(root),
    environment: {
      PATH: process.env.PATH,
      NEXA_RUNTIME_TMPDIR: tempRoot,
      perry_runtime_dir: "C:\\stale-runtime",
      PERRY_LIB_DIR: "C:\\stale-stdlib",
      lib: "C:\\toolchain\\lib",
      nexa_app_manifest_path: "C:\\stale-manifest.json",
      nexa_dialog_test_fixture_path: "C:\\stale-dialog.json",
    },
    resolvePackage(name, cwd) {
      assert.equal(cwd, projectDirectory);
      return hosts.get(name);
    },
  };
}

function successfulRunner(calls, closureBytes = Buffer.from("closure\0first-manifest")) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (args[1] === "metadata") {
      const perryRoot = path.join(
        options.env.CARGO_HOME ?? options.cwd,
        "git/checkouts/perry-fixture/0613785",
      );
      const perryRuntimeManifest = path.join(perryRoot, "crates/perry-runtime/Cargo.toml");
      const exceptionSource = path.join(perryRoot, "crates/perry-runtime/src/exception.rs");
      if (!existsSync(exceptionSource)) {
        write(perryRuntimeManifest, '[package]\nname = "perry-runtime"\nversion = "0.5.1220"\n');
        write(exceptionSource, fixturePerryRuntimeOriginal);
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          packages: [
            {
              name: "perry-ext-nui_host",
              manifest_path: path.join(options.cwd, "packages/nui-host/Cargo.toml"),
            },
            {
              name: "perry-ext-nexa_system_host",
              manifest_path: path.join(options.cwd, "packages/system-host/Cargo.toml"),
            },
            {
              name: "perry-runtime",
              version: "0.5.1220",
              source: perrySource,
              manifest_path: perryRuntimeManifest,
            },
          ],
        }),
      };
    }
    const target = args[args.indexOf("--target-dir") + 1];
    const rustTarget = args[args.indexOf("--target") + 1];
    const releaseDirectory = path.join(target, rustTarget, "release");
    write(path.join(releaseDirectory, "nexa_windows_static_closure.lib"), closureBytes);
    write(path.join(releaseDirectory, "build/skia-bindings-current/out/skia/skia.lib"), "skia\n");
    write(
      path.join(releaseDirectory, "build/skia-bindings-current/out/skia/skia-bindings.lib"),
      "bindings\n",
    );
    return { status: 0 };
  };
}

test("ships the exact reviewed Perry Windows longjmp patch contract", () => {
  const contract = JSON.parse(
    readFileSync(
      new URL(
        "../packages/cli/src/windows-static-closure/patches/perry-runtime-windows-longjmp.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  assert.deepEqual(contract, {
    schemaVersion: 1,
    sourceRevision: PERRY_SOURCE_REVISION,
    upstreamCommit: windowsLongjmpUpstreamCommit,
    target: "crates/perry-runtime/src/exception.rs",
    beforeSha256: windowsLongjmpBeforeSha256,
    afterSha256: windowsLongjmpAfterSha256,
    anchor: windowsLongjmpAnchor,
    replacement: windowsLongjmpReplacement,
  });
});

test("builds one installed-source closure for the current manifest and owns both Perry libraries", (t) => {
  const value = fixture(t);
  const calls = [];
  const environment = {
    ...value.environment,
    cargo_build_target: "wasm32-unknown-unknown",
    cargo_home: "C:\\stale-cargo-home",
    link: "/DEBUG",
    rustup_toolchain: "1.88.0",
  };
  const prepared = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: value.manifestPath,
    environment,
    resolvePackage: value.resolvePackage,
    runner: successfulRunner(calls),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
    cleanup: false,
  });
  t.after(prepared.cleanup);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "cargo");
  assert.deepEqual(calls[0].args.slice(0, 5), [
    `+${WINDOWS_CLOSURE_RUST_TOOLCHAIN}`,
    "metadata",
    "--locked",
    "--format-version",
    "1",
  ]);
  assert.equal(calls[0].options.stdio, "pipe");
  assert.equal(calls[0].options.maxBuffer, 16 * 1024 * 1024);
  assert.equal(calls[0].options.env.CARGO_HOME, path.join(prepared.root, "cargo-home"));
  assert.equal("cargo_home" in calls[0].options.env, false);
  assert.deepEqual(calls[1].args.slice(0, 4), [
    `+${WINDOWS_CLOSURE_RUST_TOOLCHAIN}`,
    "build",
    "--locked",
    "--release",
  ]);
  assert.equal(calls[1].options.env.RUSTUP_TOOLCHAIN, WINDOWS_CLOSURE_RUST_TOOLCHAIN);
  assert.equal(calls[1].options.env.NEXA_APP_MANIFEST_PATH, value.manifestPath);
  assert.equal(calls[1].options.env.NEXA_DIALOG_TEST_FIXTURE_PATH, undefined);
  assert.equal(calls[1].options.env.PERRY_NO_AUTO_OPTIMIZE, "1");
  assert.equal(calls[1].options.env.CARGO_BUILD_TARGET, "x86_64-pc-windows-msvc");
  assert.equal(calls[1].options.env.CARGO_HOME, path.join(prepared.root, "cargo-home"));
  assert.equal("cargo_build_target" in calls[1].options.env, false);
  assert.deepEqual(calls[1].args.slice(-2), ["--target", "x86_64-pc-windows-msvc"]);
  const keys = Object.keys(prepared.environment).map((name) => name.toUpperCase());
  assert.equal(keys.filter((name) => name === "PERRY_RUNTIME_DIR").length, 1);
  assert.equal(keys.filter((name) => name === "PERRY_LIB_DIR").length, 1);
  assert.equal(keys.filter((name) => name === "NEXA_APP_MANIFEST_PATH").length, 1);
  assert.equal(keys.includes("NEXA_DIALOG_TEST_FIXTURE_PATH"), false);
  const runtime = readFileSync(
    path.join(prepared.environment.PERRY_RUNTIME_DIR, "perry_runtime.lib"),
  );
  const stdlib = readFileSync(path.join(prepared.environment.PERRY_LIB_DIR, "perry_stdlib.lib"));
  assert.deepEqual(runtime, stdlib);
  assert.equal(prepared.environment.LIB, "C:\\toolchain\\lib");
  assert.equal("lib" in prepared.environment, false);
  assert.equal(prepared.environment.CARGO_BUILD_TARGET, "x86_64-pc-windows-msvc");
  assert.equal("cargo_build_target" in prepared.environment, false);
  assert.equal(prepared.environment.RUSTUP_TOOLCHAIN, WINDOWS_CLOSURE_RUST_TOOLCHAIN);
  assert.equal("rustup_toolchain" in prepared.environment, false);
  assert.equal("link" in prepared.environment, false);
  assert.equal(prepared.environment.CARGO_HOME, path.join(prepared.root, "cargo-home"));
  const linkMatch = prepared.environment.LINK.match(/^\/LIBPATH:"([^"]+)" \/DEBUG$/u);
  assert.ok(linkMatch);
  const skiaDirectory = linkMatch[1];
  assert.equal(readFileSync(path.join(skiaDirectory, "skia.lib"), "utf8"), "skia\n");
  assert.equal(readFileSync(path.join(skiaDirectory, "skia-bindings.lib"), "utf8"), "bindings\n");
  assert.equal(existsSync(path.join(prepared.merged, "packages/nui-host/src/lib.rs")), true);
  assert.equal(existsSync(path.join(prepared.merged, "packages/system-host/build.rs")), true);
  assert.equal(
    existsSync(path.join(prepared.merged, "packages/cli/src/windows-static-closure/Cargo.lock")),
    true,
  );
  const template = readFileSync(
    path.join(prepared.merged, "packages/cli/src/windows-static-closure/Cargo.toml"),
    "utf8",
  );
  assert.match(template, /features = \["core", "async-runtime"\]/u);
  assert.match(template, /features = \["stdlib", "regex-engine"\]/u);
  assert.doesNotMatch(template, /"crypto"/u);
  assert.match(prepared.provenance.closureSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    prepared.provenance.windowsSkia.map(({ name }) => name),
    ["skia.lib", "skia-bindings.lib"],
  );
  assert.ok(prepared.provenance.windowsSkia.every(({ sha256 }) => /^[a-f0-9]{64}$/u.test(sha256)));
  assert.match(prepared.provenance.mergedSourceSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(prepared.provenance.perryRuntimePatch, {
    sourceRevision: PERRY_SOURCE_REVISION,
    upstreamCommit: windowsLongjmpUpstreamCommit,
    contractSha256: sha256(
      readFileSync(path.join(value.templateRoot, "patches/perry-runtime-windows-longjmp.json")),
    ),
    sourceSha256: sha256(fixturePerryRuntimePatched),
  });
  const patchedRuntime = path.join(
    calls[0].options.env.CARGO_HOME,
    "git/checkouts/perry-fixture/0613785/crates/perry-runtime/src/exception.rs",
  );
  assert.equal(readFileSync(patchedRuntime, "utf8"), fixturePerryRuntimePatched);
  assert.equal(prepared.provenance.installedHosts.length, 2);
  assert.ok(
    prepared.provenance.installedHosts.every(({ sourceSha256 }) =>
      /^[a-f0-9]{64}$/u.test(sourceSha256),
    ),
  );
});

test("keeps LIB absent so Perry can discover clean-user MSVC and SDK paths", (t) => {
  const value = fixture(t);
  const environment = Object.fromEntries(
    Object.entries(value.environment).filter(([name]) => name.toUpperCase() !== "LIB"),
  );
  const prepared = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: value.manifestPath,
    environment,
    resolvePackage: value.resolvePackage,
    runner: successfulRunner([]),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
  });
  t.after(prepared.cleanup);

  assert.equal(
    Object.keys(prepared.environment).some((name) => name.toUpperCase() === "LIB"),
    false,
  );
  const linkMatch = prepared.environment.LINK.match(/^\/LIBPATH:"([^"]+)"$/u);
  assert.ok(linkMatch);
  assert.equal(readFileSync(path.join(linkMatch[1], "skia.lib"), "utf8"), "skia\n");
});

test("consecutive closure builds bind different manifests and only the explicit Dialog fixture", (t) => {
  const value = fixture(t);
  const secondManifest = path.join(value.projectDirectory, "second.manifest.json");
  const fixturePath = path.join(value.projectDirectory, "dialog.fixture.json");
  write(secondManifest, '{"id":"dev.nexa.second"}\n');
  write(fixturePath, '{"open":"nexa-ui-dialog-open.txt"}\n');
  const calls = [];

  const first = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: value.manifestPath,
    environment: value.environment,
    resolvePackage: value.resolvePackage,
    runner: successfulRunner(calls, readFileSync(value.manifestPath)),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
  });
  first.cleanup();
  const second = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: secondManifest,
    dialogFixturePath: fixturePath,
    environment: value.environment,
    resolvePackage: value.resolvePackage,
    runner: successfulRunner(
      calls,
      Buffer.concat([readFileSync(secondManifest), readFileSync(fixturePath)]),
    ),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
    cleanup: false,
  });
  t.after(second.cleanup);

  assert.equal(calls[1].options.env.NEXA_APP_MANIFEST_PATH, value.manifestPath);
  assert.equal(calls[1].options.env.NEXA_DIALOG_TEST_FIXTURE_PATH, undefined);
  assert.equal(calls[3].options.env.NEXA_APP_MANIFEST_PATH, secondManifest);
  assert.equal(calls[3].options.env.NEXA_DIALOG_TEST_FIXTURE_PATH, fixturePath);
  assert.equal(readFileSync(second.closure).includes(readFileSync(secondManifest)), true);
  assert.equal(readFileSync(second.closure).includes(readFileSync(value.manifestPath)), false);
});

test("persistent builds rebuild source trees, share Cargo cache and target, and isolate runtime output", (t) => {
  const value = fixture(t);
  const persistentRoot = path.join(value.root, "persistent-runtime");
  const environment = {
    ...value.environment,
    NEXA_WINDOWS_RUNTIME_ROOT: persistentRoot,
  };
  const calls = [];

  const first = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: value.manifestPath,
    environment,
    resolvePackage: value.resolvePackage,
    runner: successfulRunner(calls),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
  });
  const firstMerged = first.merged;
  const firstTarget = calls[1].args[calls[1].args.indexOf("--target-dir") + 1];
  const firstRuntime = first.environment.PERRY_RUNTIME_DIR;
  write(
    path.join(firstMerged, "protocol/generated/protocol.rs"),
    "pub const PROTOCOL: u32 = 999;\n",
  );
  first.cleanup();
  assert.equal(existsSync(firstMerged), false);

  const second = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: value.manifestPath,
    environment,
    resolvePackage: value.resolvePackage,
    runner: successfulRunner(calls),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
  });
  t.after(second.cleanup);
  const secondTarget = calls[3].args[calls[3].args.indexOf("--target-dir") + 1];

  assert.notEqual(second.merged, firstMerged);
  assert.equal(secondTarget, firstTarget);
  assert.notEqual(second.environment.PERRY_RUNTIME_DIR, firstRuntime);
  assert.equal(
    readFileSync(path.join(second.merged, "protocol/generated/protocol.rs"), "utf8"),
    sharedFiles["protocol/generated/protocol.rs"],
  );
  assert.deepEqual(
    readdirSync(persistentRoot)
      .filter((entry) => !entry.startsWith("invocation-"))
      .sort(),
    [".build-lock", "cargo-home", "target"],
  );
});

test("fails closed when the pinned Perry runtime source cannot be proven or patched", (t) => {
  const value = fixture(t);

  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner(command, args, options) {
          const result = successfulRunner([])(command, args, options);
          if (args[1] === "metadata") {
            const metadata = JSON.parse(result.stdout);
            const runtime = metadata.packages.find(({ name }) => name === "perry-runtime");
            write(
              path.join(path.dirname(runtime.manifest_path), "src/exception.rs"),
              "tampered runtime source\n",
            );
            result.stdout = JSON.stringify(metadata);
          }
          return result;
        },
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /runtime source hash does not match/u,
  );

  const patchPath = path.join(value.templateRoot, "patches/perry-runtime-windows-longjmp.json");
  const invalidContract = windowsLongjmpPatchContract();
  invalidContract.beforeSha256 = "0".repeat(64);
  write(patchPath, `${JSON.stringify(invalidContract, null, 2)}\n`);
  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner: successfulRunner([]),
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /reviewed Perry runtime patch contract is invalid/u,
  );

  rmSync(patchPath);
  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner: successfulRunner([]),
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /reviewed closure template patches[/\\]perry-runtime-windows-longjmp\.json does not exist/u,
  );
});

test("fails closed when Cargo metadata resolves a different Perry revision", (t) => {
  const value = fixture(t);

  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner(command, args, options) {
          const result = successfulRunner([])(command, args, options);
          if (args[1] === "metadata") {
            const metadata = JSON.parse(result.stdout);
            const runtime = metadata.packages.find(({ name }) => name === "perry-runtime");
            runtime.source =
              "git+https://github.com/PerryTS/perry?rev=0000000000000000000000000000000000000000#0000000000000000000000000000000000000000";
            result.stdout = JSON.stringify(metadata);
          }
          return result;
        },
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /Perry runtime does not match the pinned version and revision/u,
  );
});

test("fails closed when the Perry runtime checkout escapes the controlled Cargo home", (t) => {
  const value = fixture(t);
  const externalRoot = path.join(value.root, "external-perry");
  const externalManifest = path.join(externalRoot, "crates/perry-runtime/Cargo.toml");
  write(externalManifest, '[package]\nname = "perry-runtime"\nversion = "0.5.1220"\n');
  write(
    path.join(externalRoot, "crates/perry-runtime/src/exception.rs"),
    fixturePerryRuntimeOriginal,
  );

  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner(command, args, options) {
          const result = successfulRunner([])(command, args, options);
          if (args[1] === "metadata") {
            const metadata = JSON.parse(result.stdout);
            const runtime = metadata.packages.find(({ name }) => name === "perry-runtime");
            runtime.manifest_path = externalManifest;
            result.stdout = JSON.stringify(metadata);
          }
          return result;
        },
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /Perry runtime Cargo manifest escapes/u,
  );
});

test("consecutive builds ignore Perry-generated Host targets without merging cached output", (t) => {
  const value = fixture(t);
  const first = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: value.manifestPath,
    environment: value.environment,
    resolvePackage: value.resolvePackage,
    runner: successfulRunner([]),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
  });
  const firstSourceDigests = first.provenance.installedHosts.map(
    ({ sourceSha256 }) => sourceSha256,
  );
  first.cleanup();

  for (const [name, host] of value.hosts) {
    const crate = name.slice("@nexa/".length);
    write(
      path.join(host.nativeRoot, "packages", crate, "target", "release", `${crate}.lib`),
      `${crate} cache\n`,
    );
  }

  const second = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: value.manifestPath,
    environment: value.environment,
    resolvePackage: value.resolvePackage,
    runner: successfulRunner([]),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
  });
  t.after(second.cleanup);

  assert.deepEqual(
    second.provenance.installedHosts.map(({ sourceSha256 }) => sourceSha256),
    firstSourceDigests,
  );
  for (const [name, host] of value.hosts) {
    const crate = name.slice("@nexa/".length);
    assert.equal(existsSync(path.join(host.nativeRoot, "packages", crate, "target")), true);
    assert.equal(existsSync(path.join(second.merged, "packages", crate, "target")), false);
  }
});

test("persistent closure manifest validation failure removes the partial source tree", (t) => {
  const value = fixture(t);
  const persistentRoot = path.join(value.root, "persistent-runtime");
  rmSync(path.join(value.templateRoot, "Cargo.lock"));

  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: {
          ...value.environment,
          NEXA_WINDOWS_RUNTIME_ROOT: persistentRoot,
        },
        resolvePackage: value.resolvePackage,
        runner: successfulRunner([]),
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /reviewed closure template Cargo\.lock does not exist/u,
  );

  assert.deepEqual(readdirSync(persistentRoot), []);
});

test("persistent metadata failure removes the invocation and partial source tree", (t) => {
  const value = fixture(t);
  const persistentRoot = path.join(value.root, "persistent-runtime");

  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: {
          ...value.environment,
          NEXA_WINDOWS_RUNTIME_ROOT: persistentRoot,
        },
        resolvePackage: value.resolvePackage,
        runner() {
          return { status: 1 };
        },
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /merged closure cargo metadata failed with exit code 1/u,
  );

  assert.deepEqual(readdirSync(persistentRoot), ["cargo-home"]);
});

test("persistent build failure removes invocation output but preserves shared Cargo cache and target", (t) => {
  const value = fixture(t);
  const persistentRoot = path.join(value.root, "persistent-runtime");

  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: {
          ...value.environment,
          NEXA_WINDOWS_RUNTIME_ROOT: persistentRoot,
        },
        resolvePackage: value.resolvePackage,
        runner(command, args, options) {
          if (args[1] === "metadata") {
            return successfulRunner([])(command, args, options);
          }
          const target = args[args.indexOf("--target-dir") + 1];
          write(path.join(target, "release/partial.lib"), "partial\n");
          return { status: 1 };
        },
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /unified static closure build failed with exit code 1/u,
  );

  assert.deepEqual(readdirSync(persistentRoot).sort(), ["cargo-home", "target"]);
  assert.equal(existsSync(path.join(persistentRoot, "target/release/partial.lib")), true);
});

test("persistent build lock is held until Perry finishes and released by cleanup", (t) => {
  const value = fixture(t);
  const persistentRoot = path.join(value.root, "persistent-runtime");
  const prepared = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: value.manifestPath,
    environment: {
      ...value.environment,
      NEXA_WINDOWS_RUNTIME_ROOT: persistentRoot,
    },
    resolvePackage: value.resolvePackage,
    runner: successfulRunner([]),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
  });

  assert.equal(existsSync(path.join(persistentRoot, ".build-lock")), true);
  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: {
          ...value.environment,
          NEXA_WINDOWS_RUNTIME_ROOT: persistentRoot,
        },
        resolvePackage: value.resolvePackage,
        runner: successfulRunner([]),
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    new RegExp(`another build owns.*pid ${process.pid}`),
  );
  prepared.cleanup();
  assert.equal(existsSync(path.join(persistentRoot, ".build-lock")), false);
});

test("recovers a dead persistent lock in an isolated runtime without deleting the stale owner", (t) => {
  const value = fixture(t);
  const persistentRoot = path.join(value.root, "persistent-runtime");
  mkdirSync(persistentRoot);
  const lockPath = path.join(persistentRoot, ".build-lock");
  const staleLock = `${JSON.stringify({ schemaVersion: 1, pid: 2147483647, token: "stale" })}\n`;
  writeFileSync(lockPath, staleLock);

  const prepared = prepareWindowsPerryRuntime({
    projectDirectory: value.projectDirectory,
    manifestPath: value.manifestPath,
    environment: {
      ...value.environment,
      NEXA_WINDOWS_RUNTIME_ROOT: persistentRoot,
    },
    resolvePackage: value.resolvePackage,
    runner: successfulRunner([]),
    runtime: { platform: "win32", arch: "x64" },
    templateRoot: value.templateRoot,
  });
  t.after(prepared.cleanup);

  assert.notEqual(prepared.root, realpathSync.native(persistentRoot));
  assert.equal(path.dirname(prepared.root), realpathSync.native(persistentRoot));
  assert.match(path.basename(prepared.root), /^recovery-/u);
  assert.equal(readFileSync(lockPath, "utf8"), staleLock);
  prepared.cleanup();
  assert.equal(existsSync(prepared.root), false);
  assert.equal(readFileSync(lockPath, "utf8"), staleLock);
});

test("recovers empty and truncated persistent locks without rewriting their evidence", (t) => {
  const value = fixture(t);

  for (const [name, staleLock] of [
    ["empty", ""],
    ["truncated", '{"schemaVersion":1,"pid":'],
  ]) {
    const persistentRoot = path.join(value.root, `persistent-runtime-${name}`);
    mkdirSync(persistentRoot);
    const lockPath = path.join(persistentRoot, ".build-lock");
    writeFileSync(lockPath, staleLock);

    const prepared = prepareWindowsPerryRuntime({
      projectDirectory: value.projectDirectory,
      manifestPath: value.manifestPath,
      environment: {
        ...value.environment,
        NEXA_WINDOWS_RUNTIME_ROOT: persistentRoot,
      },
      resolvePackage: value.resolvePackage,
      runner: successfulRunner([]),
      runtime: { platform: "win32", arch: "x64" },
      templateRoot: value.templateRoot,
    });

    assert.match(path.basename(prepared.root), /^recovery-/u);
    assert.equal(readFileSync(lockPath, "utf8"), staleLock);
    prepared.cleanup();
    assert.equal(existsSync(prepared.root), false);
    assert.equal(readFileSync(lockPath, "utf8"), staleLock);
  }
});

test("fails closed for shared-source drift and forbidden installed closure entries", (t) => {
  const value = fixture(t);
  write(
    path.join(value.hosts.get("@nexa/system-host").nativeRoot, "protocol/generated/protocol.rs"),
    "pub const PROTOCOL: u32 = 2;\n",
  );
  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner: successfulRunner([]),
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /drift at protocol[/\\]generated[/\\]protocol\.rs/u,
  );

  write(
    path.join(value.hosts.get("@nexa/system-host").nativeRoot, "protocol/generated/protocol.rs"),
    sharedFiles["protocol/generated/protocol.rs"],
  );
  write(path.join(value.hosts.get("@nexa/nui-host").nativeRoot, "target/stale.lib"), "stale\n");
  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner: successfulRunner([]),
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /forbidden build output.*target/u,
  );
});

test("fails closed for package escape, symlinked manifests, and wrong target", (t) => {
  const value = fixture(t);
  const nui = value.hosts.get("@nexa/nui-host");
  nui.manifest.perry.nativeLibrary.targets.windows.crate = "../outside";
  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner: successfulRunner([]),
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /published vendored native source closure/u,
  );

  nui.manifest = hostManifest("@nexa/nui-host");
  const target = path.join(value.root, "manifest-target.json");
  write(target, "{}\n");
  rmSync(value.manifestPath);
  symlinkSync(target, value.manifestPath, "file");
  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner: successfulRunner([]),
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /application manifest must be a regular file/u,
  );

  const untouched = prepareWindowsPerryRuntime({
    environment: value.environment,
    runtime: { platform: "darwin", arch: "arm64" },
  });
  assert.equal(untouched.environment, value.environment);
});

test("rejects a native closure reached through a package-internal symbolic link", (t) => {
  const value = fixture(t);
  const nui = value.hosts.get("@nexa/nui-host");
  const nativeParent = path.join(nui.packageDirectory, "dist/native");
  const outsideNativeParent = path.join(value.root, "outside-native");
  renameSync(nativeParent, outsideNativeParent);
  symlinkSync(outsideNativeParent, nativeParent, "dir");

  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: value.environment,
        resolvePackage: value.resolvePackage,
        runner: successfulRunner([]),
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /native closure contains a symbolic link/u,
  );
});

test("fails closed when Cargo metadata resolves either Host outside the merged source root", (t) => {
  const value = fixture(t);
  const persistentRoot = path.join(value.root, "persistent-runtime");
  const checkoutManifest = path.join(value.root, "checkout/packages/nui-host/Cargo.toml");
  write(checkoutManifest, '[package]\nname = "perry-ext-nui_host"\nversion = "0.1.0"\n');

  assert.throws(
    () =>
      prepareWindowsPerryRuntime({
        projectDirectory: value.projectDirectory,
        manifestPath: value.manifestPath,
        environment: {
          ...value.environment,
          NEXA_WINDOWS_RUNTIME_ROOT: persistentRoot,
        },
        resolvePackage: value.resolvePackage,
        runner(command, args, options) {
          if (args[1] === "metadata") {
            return {
              status: 0,
              stdout: JSON.stringify({
                packages: [
                  { name: "perry-ext-nui_host", manifest_path: checkoutManifest },
                  {
                    name: "perry-ext-nexa_system_host",
                    manifest_path: path.join(options.cwd, "packages/system-host/Cargo.toml"),
                  },
                ],
              }),
            };
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
        runtime: { platform: "win32", arch: "x64" },
        templateRoot: value.templateRoot,
      }),
    /must resolve both Hosts from the owned merged source root/u,
  );

  assert.deepEqual(readdirSync(persistentRoot), ["cargo-home"]);
});

test("resolves the installed NUI Host Windows library directory from its manifest", async (t) => {
  const value = fixture(t);
  const { resolveWindowsNativeLibraryDirectories } =
    await import("../packages/cli/src/windows-runtime.mjs");

  assert.deepEqual(
    resolveWindowsNativeLibraryDirectories({
      projectDirectory: value.projectDirectory,
      environment: value.environment,
      resolvePackage: value.resolvePackage,
      runtime: { platform: "win32", arch: "x64" },
    }),
    [
      path.join(
        realpathSync.native(value.hosts.get("@nexa/nui-host").packageDirectory),
        "target/perry-native/windows/skia-binaries",
      ),
    ],
  );
});

test("real Windows compiler paths force the application-specific closure without CI overrides", () => {
  assert.throws(
    () =>
      preparePerryRuntimeForCompile({
        environment: {},
        force: true,
        runtime: { platform: "win32", arch: "x64" },
      }),
    /application manifest path must be an absolute path/u,
  );
  const untouched = preparePerryRuntimeForCompile({
    environment: {},
    force: true,
    runtime: { platform: "darwin", arch: "arm64" },
  });
  assert.deepEqual(untouched.environment, {});
});

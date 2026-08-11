import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { matchesGlob } from "node:path";
import { parse } from "yaml";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const ffiWorkflowUrl = new URL("../.github/workflows/ffi.yml", import.meta.url);
const docsWorkflowUrl = new URL("../.github/workflows/docs.yml", import.meta.url);
const perryFrameworksWorkflowUrl = new URL(
  "../.github/workflows/perry-frameworks.yml",
  import.meta.url,
);
const rustWorkflowUrl = new URL("../.github/workflows/rust.yml", import.meta.url);
const typescriptWorkflowUrl = new URL("../.github/workflows/typescript.yml", import.meta.url);
const nativeWorkflowUrl = new URL("../.github/workflows/native-smoke.yml", import.meta.url);
const notesPackageWorkflowUrl = new URL(
  "../.github/workflows/reference-notes-package.yml",
  import.meta.url,
);
const rootPackageUrl = new URL("../package.json", import.meta.url);
const cliPackageUrl = new URL("../packages/cli/package.json", import.meta.url);
const notesPackageUrl = new URL("../examples/reference-notes/package.json", import.meta.url);
const counterPackageUrl = new URL("../examples/counter/package.json", import.meta.url);
const nuiHostPackageUrl = new URL("../packages/nui-host/package.json", import.meta.url);
const perrySmokeUrl = new URL("./perry-smoke.mjs", import.meta.url);

const ci = parse(workflow);
const filterStep = ci.jobs.changes.steps.find((step) => step.id === "filter");
assert.ok(filterStep, "ci.yml must contain the paths-filter step");
const filters = parse(filterStep.with.filters);

function routes(path, filter) {
  return filters[filter].some((pattern) => matchesGlob(path, pattern));
}

test("all thirteen pnpm examples trigger TypeScript checks", () => {
  const examples = [...workspace.matchAll(/^\s*- "(examples\/[^"]+)"$/gm)].map(([, path]) => path);

  assert.equal(examples.length, 13);
  for (const example of examples) {
    assert.equal(
      routes(`${example}/package.json`, "typescript"),
      true,
      `${example} must route to TypeScript`,
    );
  }
});

test("both independent FFI crates trigger Rust and future FFI checks", () => {
  for (const packageName of ["nui-host", "system-host"]) {
    for (const path of ["Cargo.toml", "Cargo.lock", "src/lib.rs"]) {
      const fixture = `packages/${packageName}/${path}`;
      assert.equal(routes(fixture, "rust"), true, `${fixture} must route to Rust`);
      assert.equal(routes(fixture, "ffi"), true, `${fixture} must route to FFI`);
    }

    assert.equal(
      routes(`packages/${packageName}/package.json`, "ffi"),
      true,
      `${packageName}'s Perry manifest must route to FFI`,
    );
  }

  assert.match(workflow, /^\s+ffi: \$\{\{ steps\.filter\.outputs\.ffi \}\}$/m);
});

test("System Host build-time inputs trigger every owning integration gate", () => {
  for (const path of [
    "packages/system-host/build.rs",
    "packages/system-host/build_support.rs",
    "packages/system-host/tests/build_input_contract.rs",
  ]) {
    for (const filter of ["rust", "ffi", "package"]) {
      assert.equal(routes(path, filter), true, `${path} must route to ${filter}`);
    }
  }
});

test("CLI implementation and contracts trigger the TypeScript quality gate", () => {
  for (const path of [
    "packages/cli/package.json",
    "packages/cli/src/build.mjs",
    "packages/cli/src/doctor.mjs",
    "packages/cli/src/package.mjs",
    "packages/cli/templates/minimal-tsx/main.tsx.tmpl",
    "tools/cli-new-doctor.test.mjs",
    "tools/cli-dev-build.test.mjs",
    "tools/cli-package.test.mjs",
  ]) {
    assert.equal(routes(path, "typescript"), true, `${path} must route to TypeScript`);
  }
  for (const path of [
    "packages/cli/src/build.mjs",
    "packages/cli/src/package.mjs",
    "packages/cli/templates/minimal-tsx/main.tsx.tmpl",
    "tools/cli-create-build-smoke.mjs",
    "tools/cli-create-package-smoke.mjs",
    "tools/cli-dev-build.test.mjs",
    "tools/cli-package.test.mjs",
  ]) {
    assert.equal(routes(path, "package"), true, `${path} must route to package smoke`);
  }

  const rootPackage = JSON.parse(readFileSync(rootPackageUrl, "utf8"));
  assert.match(rootPackage.scripts["test:workspace"], /tools\/cli-new-doctor\.test\.mjs/u);
  assert.match(rootPackage.scripts["test:workspace"], /tools\/cli-dev-build\.test\.mjs/u);
  assert.match(rootPackage.scripts["test:workspace"], /tools\/cli-package\.test\.mjs/u);
  const cliPackage = JSON.parse(readFileSync(cliPackageUrl, "utf8"));
  assert.equal(
    cliPackage.scripts["smoke:package"],
    "node ../../tools/cli-create-package-smoke.mjs",
  );

  const typescriptWorkflow = parse(readFileSync(typescriptWorkflowUrl, "utf8"));
  const windowsJob = typescriptWorkflow.jobs["cli-windows"];
  assert.ok(windowsJob, "the TypeScript workflow must run CLI contracts on Windows");
  assert.equal(windowsJob["runs-on"], "windows-2022");
  assert.ok(
    windowsJob.steps.some(
      (step) => typeof step.run === "string" && step.run.includes("pnpm --filter @nexa/cli test"),
    ),
    "the Windows job must execute the full CLI contract suite",
  );
});

test("filesystem transport changes trigger every integration owner", () => {
  for (const path of [
    "packages/fs/src/index.ts",
    "packages/fs/package.json",
    "packages/system-host/src/index.ts",
    "packages/system-host/src/task_runtime.rs",
  ]) {
    assert.equal(routes(path, "typescript"), true, `${path} must route to TypeScript`);
    assert.equal(routes(path, "ffi"), true, `${path} must route to FFI`);
    assert.equal(routes(path, "perry"), true, `${path} must route to Perry`);
    assert.equal(routes(path, "native"), true, `${path} must route to native smoke`);
    assert.equal(routes(path, "package"), true, `${path} must route to Notes package`);
  }
});

test("the Notes MVP and dialog surface trigger every runtime integration gate", () => {
  for (const path of [
    "examples/reference-notes/app.tsx",
    "examples/reference-notes/state.ts",
    "packages/dialog/src/index.ts",
  ]) {
    assert.equal(routes(path, "typescript"), true, `${path} must route to TypeScript`);
    assert.equal(routes(path, "ffi"), true, `${path} must route to FFI`);
    assert.equal(routes(path, "perry"), true, `${path} must route to Perry`);
    assert.equal(routes(path, "native"), true, `${path} must route to native smoke`);
  }
});

test("workflow, script, and root config changes route to their owners", () => {
  const fixtures = new Map([
    [".github/workflows/ci.yml", ["rust", "typescript", "ffi", "perry", "native", "package"]],
    [".github/workflows/rust.yml", ["rust", "typescript"]],
    [".github/workflows/typescript.yml", ["typescript"]],
    [".github/workflows/ffi.yml", ["typescript", "ffi"]],
    [".github/workflows/perry-frameworks.yml", ["typescript", "perry"]],
    [".github/workflows/native-smoke.yml", ["typescript", "native"]],
    [".github/workflows/reference-notes-package.yml", ["typescript", "package"]],
    [".github/workflows/docs.yml", ["typescript", "docs"]],
    ["scripts/build-native.sh", ["rust", "typescript", "ffi", "native"]],
    ["protocol/nui-host.json", ["rust", "typescript", "ffi", "perry"]],
    ["tools/ci-path-filters.test.mjs", ["typescript"]],
    ["tools/security-policy.test.mjs", ["typescript", "security"]],
    ["tools/action-sha-policy.mjs", ["typescript", "security"]],
    ["tools/license-policy.mjs", ["typescript", "security"]],
    ["release/license-exceptions.json", ["security"]],
    ["deny.toml", ["security"]],
    [".gitleaks.toml", ["security"]],
    [".github/workflows/security.yml", ["typescript", "security"]],
    [".github/CODEOWNERS", ["security"]],
    ["LICENSE-MIT", ["security"]],
    ["LICENSE-APACHE", ["security"]],
    ["SECURITY.md", ["docs", "security"]],
    ["CONTRIBUTING.md", ["docs", "security"]],
    ["Cargo.toml", ["rust", "ffi", "perry", "native"]],
    ["rust-toolchain.toml", ["rust", "ffi", "perry", "native"]],
    ["rustfmt.toml", ["rust", "ffi"]],
    ["tsconfig.base.json", ["typescript", "perry"]],
  ]);

  for (const [path, expectedFilters] of fixtures) {
    for (const filter of expectedFilters) {
      assert.equal(routes(path, filter), true, `${path} must route to ${filter}`);
    }
  }
});

test("G6 release files trigger their TypeScript, security, and documentation owners", () => {
  for (const path of [
    "release/artifact-integrity.json",
    "release/performance-budgets.json",
    "release/signing-policy.json",
    "release/rehearsal-policy.json",
    "tools/release-dependency-graph.mjs",
    "tools/release-dependency-graph.test.mjs",
    "tools/release-rehearsal.mjs",
    "tools/release-rehearsal.test.mjs",
    "tools/signing-policy.mjs",
    "tools/signing-policy.test.mjs",
    "tools/signing-credentials.mjs",
    "tools/signing-credentials.test.mjs",
    "tools/signing-executor.mjs",
    "tools/signing-executor.test.mjs",
    "tools/signing-transport.mjs",
    "tools/signing-workflow.test.mjs",
    "tools/unsigned-signing-input.mjs",
    "tools/unsigned-signing-input.test.mjs",
    ".github/workflows/performance.yml",
    ".github/workflows/signing.yml",
    ".github/workflows/release-rehearsal.yml",
  ]) {
    assert.equal(routes(path, "typescript"), true, `${path} must route to TypeScript`);
    assert.equal(routes(path, "security"), true, `${path} must route to security`);
  }

  for (const path of [
    "tools/unsigned-signing-input.mjs",
    "tools/unsigned-signing-input.test.mjs",
  ]) {
    assert.equal(routes(path, "package"), true, `${path} must route to Notes package`);
  }

  for (const path of [
    "docs/RELEASE-INTEGRITY.md",
    "docs/SUPPLY-CHAIN.md",
    "docs/SIGNING.md",
    "docs/PERFORMANCE.md",
    "docs/RELEASE-REHEARSAL.md",
  ]) {
    assert.equal(routes(path, "docs"), true, `${path} must route to docs`);
    assert.equal(routes(path, "security"), true, `${path} must route to security`);
  }
});

test("the required result check fails closed when change detection fails", () => {
  assert.match(workflow, /^\s+if: always\(\)$/m);
  assert.deepEqual(ci.jobs.result.needs, [
    "changes",
    "rust",
    "typescript",
    "ffi",
    "perry-frameworks",
    "docs",
    "native-smoke",
    "reference-notes-package",
    "security",
  ]);
  assert.match(workflow, /^\s+CHANGES: \$\{\{ needs\.changes\.result \}\}$/m);
  assert.match(workflow, /if \[\[ "\$CHANGES" != "success" \]\]; then/);
});

test("the Docs route always runs for documentation changes and fails closed", () => {
  assert.equal(routes("tools/docs-contract.test.mjs", "docs"), true);
  assert.equal(ci.permissions.actions, "read");
  assert.equal(ci.permissions.contents, "read");
  assert.equal(ci.jobs.docs.if, "needs.changes.outputs.docs == 'true'");
  assert.match(workflow, /^\s+DOCS: \$\{\{ needs\.docs\.result \}\}$/m);
  assert.match(workflow, /^\s+DOCS_NEEDED: \$\{\{ needs\.changes\.outputs\.docs \}\}$/m);
  assert.match(workflow, /if \[\[ "\$DOCS_NEEDED" == "true" && "\$DOCS" != "success" \]\]; then/);

  const docsWorkflow = parse(readFileSync(docsWorkflowUrl, "utf8"));
  const docsCommands = docsWorkflow.jobs.adr.steps.flatMap((step) =>
    typeof step.run === "string" ? [step.run] : [],
  );
  assert.ok(
    docsCommands.includes("node tools/docs-contract.test.mjs"),
    "the Docs workflow must execute the documentation contract",
  );
  const rootPackage = JSON.parse(readFileSync(rootPackageUrl, "utf8"));
  assert.match(rootPackage.scripts["test:workspace"], /tools\/docs-contract\.test\.mjs/u);
});

test("native smoke is required and fails closed for every non-success result", () => {
  assert.match(workflow, /^\s+NATIVE_NEEDED: \$\{\{ needs\.changes\.outputs\.native \}\}$/m);
  assert.match(workflow, /^\s+if: needs\.changes\.outputs\.native == 'true'$/m);
  assert.doesNotMatch(workflow, /NATIVE_SMOKE_ENABLED|NATIVE_ENABLED/);
  assert.match(
    workflow,
    /if \[\[ "\$NATIVE_NEEDED" == "true" && "\$NATIVE" != "success" \]\]; then/,
  );
});

test("package and fresh launch matrices prove the generic and Notes hosted artifacts", () => {
  for (const path of [
    "tools/reference-notes-dialog-runtime-smoke.mjs",
    "tools/reference-notes-dialog-runtime-smoke.test.mjs",
    "tools/reference-notes-dialog-picker-smoke.mjs",
    "tools/reference-notes-dialog-picker-smoke.test.mjs",
    "tools/reference-notes-native-runtime-proof.mjs",
    "tools/reference-notes-native-runtime-proof.test.mjs",
    "tools/dialog-picker-driver-macos.applescript",
    "tools/dialog-picker-driver-windows.ps1",
    "tools/dialog-picker-probe-supervisor-windows.ps1",
  ]) {
    assert.equal(routes(path, "package"), true, `${path} must route to Notes package`);
  }

  const packageWorkflow = parse(readFileSync(notesPackageWorkflowUrl, "utf8"));
  const packageJob = packageWorkflow.jobs.package;
  const launchJob = packageWorkflow.jobs.launch;
  assert.deepEqual(packageJob.strategy.matrix.os, ["macos-15", "windows-2022"]);
  assert.deepEqual(launchJob.strategy.matrix.os, ["macos-15", "windows-2022"]);
  assert.equal(launchJob.needs, "package");

  const packageCommands = packageJob.steps.flatMap((step) =>
    typeof step.run === "string" ? [step.run] : [],
  );
  assert.ok(
    packageCommands.some((command) =>
      command.includes("pnpm --filter @nexa/example-reference-notes smoke:fs"),
    ),
  );
  assert.ok(
    packageCommands.some((command) =>
      command.includes("node tools/cli-create-package-smoke.mjs --artifact-output"),
    ),
    "the build job must export the verified generic package",
  );
  assert.ok(
    packageCommands.some((command) =>
      command.includes("pnpm --filter @nexa/example-reference-notes smoke:dialog"),
    ),
  );
  assert.ok(
    packageCommands.some((command) =>
      command.includes("pnpm --filter @nexa/example-reference-notes smoke:clipboard"),
    ),
    "the hosted matrix must execute the trusted native Clipboard Promise smoke",
  );
  const pickerStep = packageJob.steps.find((step) =>
    step.run?.includes("pnpm --filter @nexa/example-reference-notes smoke:picker"),
  );
  assert.ok(pickerStep, "the hosted matrix must execute the real rfd picker probe");
  assert.equal(pickerStep.if, undefined, "the picker probe must run on both hosted platforms");
  assert.equal(pickerStep.env, undefined, "the picker probe must not inject a Dialog fixture");
  assert.equal(
    pickerStep["continue-on-error"],
    undefined,
    "a picker or UI driver failure must block the package job",
  );
  assert.equal(pickerStep["timeout-minutes"], 10);
  assert.ok(
    packageCommands.some((command) =>
      command.includes("pnpm --filter @nexa/example-reference-notes package"),
    ),
  );
  assert.equal(
    packageCommands.some(
      (command) => command.includes("Start-Process") || command.includes("sleep 5"),
    ),
    false,
    "the build job must not stand in for the fresh launch job",
  );

  const archiveCommands = packageCommands.filter(
    (command) => command.includes("generic.tar.gz") && command.includes("reference-notes.tar.gz"),
  );
  assert.equal(archiveCommands.length, 2, "each platform must archive both distributions");
  for (const command of archiveCommands) {
    assert.match(command, /tar(?:\.exe)? .*(?:--gzip|-\w*z\w*)/u);
  }
  const upload = packageJob.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@") &&
      step.with?.name === "nexa-packages-${{ runner.os }}-${{ runner.arch }}",
  );
  assert.ok(upload, "the package job must upload the transport archives");
  assert.equal(upload.with.name, "nexa-packages-${{ runner.os }}-${{ runner.arch }}");
  assert.equal(upload.with.path, "${{ runner.temp }}/nexa-transport/*.tar.gz");
  assert.equal(upload.with["if-no-files-found"], "error");

  const launchActions = launchJob.steps
    .filter((step) => typeof step.uses === "string")
    .map((step) => step.uses);
  assert.deepEqual(launchActions, [
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ]);
  const download = launchJob.steps.find(
    (step) =>
      step.uses === "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093" &&
      step.with?.name === upload.with.name,
  );
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with["run-id"], undefined, "download must use the current workflow run");
  assert.equal(download.with.repository, undefined, "download must not use another repository");
  const launchCommands = launchJob.steps.flatMap((step) =>
    typeof step.run === "string" ? [step.run] : [],
  );
  const launchSource = launchCommands.join("\n");
  const extractCommands = launchCommands.filter(
    (command) =>
      command.includes("generic.tar.gz") &&
      command.includes("reference-notes.tar.gz") &&
      /tar(?:\.exe)? .*(?:--extract|-\w*x\w*)/u.test(command),
  );
  assert.equal(extractCommands.length, 2, "each fresh platform job must extract both archives");
  for (const command of extractCommands) {
    assert.match(command, /tar(?:\.exe)? .*(?:--extract|-\w*x\w*)/u);
  }
  assert.doesNotMatch(
    launchSource,
    /(?:^|\s)(?:pnpm|npm|npx|node|cargo|rustc|perry|make|cmake|xcodebuild|msbuild|dotnet)(?:\s|$)|(?:^|\s)(?:nexa\s+)?(?:build|package)(?:\s|$)/imu,
    "the launch job must not invoke a development toolchain or rebuild artifacts",
  );
  for (const marker of [
    "app.manifest.json",
    "nexa-build.json",
    "target.platform",
    "target.arch",
    "app.version",
    "smoke.txt",
    "fd273722329590ff79d8ea8edf730f80896efa749f95aa2ac8b90a8df2c5b23f",
    "Info.plist",
    "semver",
    "ReparsePoint",
    "NEXA_APP_MANIFEST_PATH",
    "NEXA_DIALOG_TEST_FIXTURE_PATH",
    "PERRY_SKIP_CODEGEN",
  ]) {
    assert.ok(launchSource.includes(marker), `fresh launch validation must contain ${marker}`);
  }
  assert.match(launchSource, /plutil .*CFBundleIdentifier/u);
  assert.match(launchSource, /plutil .*CFBundleShortVersionString/u);
  const plistLint = launchSource.split("\n").find((line) => line.includes("/usr/bin/plutil -lint"));
  assert.ok(plistLint, "macOS launch must lint both property lists");
  assert.doesNotMatch(plistLint, /app\.manifest\.json|nexa-build\.json/u);
  assert.match(launchSource, /smoke-app\.app[\s\S]*Nexa Notes\.app/u);
  assert.match(launchSource, /smoke-app\.exe[\s\S]*NexaNotes\.exe/u);
  assert.match(
    launchSource,
    /launch_for_five_seconds "Generic package" "\$generic_executable"[\s\S]*launch_for_five_seconds "Nexa Notes" "\$notes_executable"/u,
  );
  assert.match(
    launchSource,
    /Invoke-StartupCheck "Generic package" \$genericExecutable[\s\S]*Invoke-StartupCheck "Nexa Notes" \$notesExecutable/u,
  );
  assert.match(launchSource, /file "\$generic_executable" \| grep -q 'Mach-O'/u);
  assert.match(launchSource, /file "\$notes_executable" \| grep -q 'Mach-O'/u);
  assert.match(launchSource, /test ! -L "\$generic_root"[\s\S]*test ! -L "\$notes_root"/u);
  assert.equal(launchCommands.filter((command) => command.includes("sleep 5")).length, 1);
  assert.equal(
    launchCommands.filter((command) => command.includes("Start-Sleep -Seconds 5")).length,
    1,
  );
  assert.equal(ci.jobs["reference-notes-package"].if, "needs.changes.outputs.package == 'true'");
  assert.match(workflow, /^\s+PACKAGE_NEEDED: \$\{\{ needs\.changes\.outputs\.package \}\}$/m);
  assert.match(
    workflow,
    /if \[\[ "\$PACKAGE_NEEDED" == "true" && "\$PACKAGE" != "success" \]\]; then/,
  );
  const rootPackage = JSON.parse(readFileSync(rootPackageUrl, "utf8"));
  assert.match(
    rootPackage.scripts["test:workspace"],
    /tools\/reference-notes-dialog-runtime-smoke\.test\.mjs/u,
  );
  assert.match(
    rootPackage.scripts["test:workspace"],
    /tools\/reference-notes-dialog-picker-smoke\.test\.mjs/u,
  );
  assert.match(
    rootPackage.scripts["test:workspace"],
    /tools\/reference-notes-clipboard-runtime-smoke\.test\.mjs/u,
  );
  const notesPackage = JSON.parse(readFileSync(notesPackageUrl, "utf8"));
  assert.equal(
    notesPackage.scripts["smoke:picker"],
    "node ../../tools/reference-notes-dialog-picker-smoke.mjs",
  );
  assert.equal(
    notesPackage.scripts["smoke:clipboard"],
    "node ../../tools/reference-notes-clipboard-runtime-smoke.mjs",
  );
});

test("macOS and Windows native jobs run deterministic harnesses and real accessibility clients", () => {
  const nativeWorkflow = parse(readFileSync(nativeWorkflowUrl, "utf8"));
  assert.deepEqual(nativeWorkflow.jobs.smoke.strategy.matrix.os, ["macos-15", "windows-2022"]);
  const commands = nativeWorkflow.jobs.smoke.steps.flatMap((step) =>
    typeof step.run === "string" ? [step.run] : [],
  );
  assert.ok(
    commands.some(
      (command) =>
        command.includes("cargo test -p nui-platform-winit g3a11_") &&
        command.includes("cargo test -p nui-perry-bridge g3a11_"),
    ),
    "native matrix must replay the shared input scenario",
  );
  assert.ok(
    commands.some(
      (command) =>
        command.includes("cargo test -p nui-platform-winit g3b05_") &&
        command.includes("cargo test -p nui-perry-bridge g3b05_"),
    ),
    "native matrix must replay the role/name accessibility scenario",
  );
  assert.ok(
    commands.some((command) =>
      command.includes("cargo run -p semantic-accessibility-smoke --release"),
    ),
    "native matrix must drive the production Adapter from a real platform accessibility client",
  );
  for (const path of [
    "protocol/nui-host.json",
    "crates/nui-app-runtime/src/dispatcher.rs",
    "crates/nui-core/src/semantic_tree.rs",
    "crates/nui-layout-taffy/src/lib.rs",
    "crates/nui-platform-winit/src/lib.rs",
    "crates/nui-perry-bridge/src/window.rs",
    "crates/nui-render-skia/src/lib.rs",
    "crates/nui-system-core/src/clipboard.rs",
    "crates/nui-text/src/paragraph.rs",
    "packages/nui-host/src/protocol.ts",
    "packages/protocol/src/index.ts",
    "packages/ui/src/primitives.ts",
    "examples/semantic-e2e/scenario.json",
  ]) {
    assert.equal(routes(path, "native"), true, `${path} must route to native input coverage`);
  }
});

test("the Docs gate validates immutable G0 runs, jobs, and baseline links", () => {
  const docsWorkflow = parse(readFileSync(docsWorkflowUrl, "utf8"));
  const gate = docsWorkflow.jobs.adr.steps.find(
    (step) => step.name === "Verify G0 baseline evidence",
  );

  assert.ok(gate, "docs.yml must contain the G0 evidence verifier");
  assert.equal(docsWorkflow.env.G0_QUALITY_RUN_ID, "30878535145");
  assert.equal(docsWorkflow.env.G0_QUALITY_SHA, docsWorkflow.env.G0_NATIVE_SHA);
  assert.match(gate.run, /\.name == \$name and \.path == \$path/);
  assert.match(gate.run, /actions\/runs\/\$G0_QUALITY_RUN_ID\/jobs\?per_page=100/);
  assert.match(gate.run, /actions\/runs\/\$G0_NATIVE_RUN_ID\/jobs\?per_page=100/);
  assert.match(gate.run, /require_baseline_job_link/);

  for (const jobName of [
    "TypeScript / quality",
    "FFI / nui-host",
    "FFI / system-host",
    "Rust / fmt",
    "Rust / clippy",
    "Rust / test",
    "Rust / build",
    "result",
    "smoke (macos-latest)",
    "smoke (windows-latest)",
  ]) {
    assert.ok(gate.run.includes(`"${jobName}"`), `Docs gate must validate ${jobName}`);
  }

  assert.match(gate.run, /for framework in solid vue react svelte; do/);
  assert.match(gate.run, /for runner in macos-15 windows-2022; do/);
  assert.match(gate.run, /"Perry frameworks \/ AOT \(\$framework, \$runner\)"/);
});

test("the FFI route runs a required two-package verification gate", () => {
  assert.ok(existsSync(ffiWorkflowUrl), "ffi.yml must exist");
  assert.match(workflow, /^  ffi:\n(?:    .+\n)+?    uses: \.\/\.github\/workflows\/ffi\.yml$/m);
  assert.ok(ci.jobs.result.needs.includes("ffi"));
  assert.match(workflow, /^\s+FFI: \$\{\{ needs\.ffi\.result \}\}$/m);
  assert.match(workflow, /^\s+FFI_NEEDED: \$\{\{ needs\.changes\.outputs\.ffi \}\}$/m);
  assert.match(workflow, /if \[\[ "\$FFI_NEEDED" == "true" && "\$FFI" != "success" \]\]; then/);

  const ffiWorkflow = parse(readFileSync(ffiWorkflowUrl, "utf8"));
  const gate = ffiWorkflow.jobs.gate;
  assert.deepEqual(gate.strategy.matrix.package, ["nui-host", "system-host"]);
  const commands = gate.steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
  for (const expected of [
    "cargo fmt",
    "cargo check",
    "cargo clippy",
    "cargo test",
    "perry native validate",
  ]) {
    assert.ok(
      commands.some((command) => command.includes(expected)),
      `FFI gate must run ${expected}`,
    );
  }
});

test("Ubuntu native link gates provision Skia libraries and Perry link flags", () => {
  const rustWorkflow = parse(readFileSync(rustWorkflowUrl, "utf8"));
  const ffiWorkflow = parse(readFileSync(ffiWorkflowUrl, "utf8"));
  const typescriptWorkflow = parse(readFileSync(typescriptWorkflowUrl, "utf8"));
  const linkingJobs = [
    ["Rust test", rustWorkflow.jobs.test, "cargo test"],
    ["Rust build", rustWorkflow.jobs.build, "cargo build"],
    ["FFI gate", ffiWorkflow.jobs.gate, "Test"],
    ["TypeScript quality", typescriptWorkflow.jobs.quality, "Build"],
  ];

  for (const [label, job, firstLinkStep] of linkingJobs) {
    const installIndex = job.steps.findIndex(
      (step) => step.name === "Install Linux native dependencies",
    );
    const linkIndex = job.steps.findIndex((step) => step.name === firstLinkStep);
    assert.ok(installIndex >= 0, `${label} must install Linux native dependencies`);
    assert.ok(installIndex < linkIndex, `${label} must install native dependencies before linking`);

    const command = job.steps[installIndex].run;
    assert.match(command, /apt-get update/);
    assert.match(command, /libfontconfig1-dev/);
    assert.match(command, /libfreetype6-dev/);
  }

  const nuiHostPackage = JSON.parse(readFileSync(nuiHostPackageUrl, "utf8"));
  assert.deepEqual(nuiHostPackage.perry.nativeLibrary.targets.linux.libs, [
    "stdc++",
    "freetype",
    "fontconfig",
  ]);
});

test("Windows Perry manifest points at the fixed staged Skia directory", () => {
  const nuiHostPackage = JSON.parse(readFileSync(nuiHostPackageUrl, "utf8"));
  const windowsTarget = nuiHostPackage.perry.nativeLibrary.targets.windows;

  assert.deepEqual(windowsTarget.libDirs, ["target/perry-native/windows/skia-binaries"]);
});

test("Windows Perry manifest forwards the complete native link library set", () => {
  const nuiHostPackage = JSON.parse(readFileSync(nuiHostPackageUrl, "utf8"));
  const windowsTarget = nuiHostPackage.perry.nativeLibrary.targets.windows;

  assert.deepEqual(windowsTarget.libs, [
    "skia",
    "skia-bindings",
    "usp10",
    "ole32",
    "user32",
    "gdi32",
    "fontsub",
    "advapi32",
    "imm32",
    "uxtheme",
  ]);
});

test("the required Perry framework gate runs the adapters and Tier-1 Notes as independent clean AOT builds", () => {
  assert.ok(existsSync(perryFrameworksWorkflowUrl), "perry-frameworks.yml must exist");
  assert.ok(filters.perry, "ci.yml must define the Perry framework path filter");

  for (const path of [
    "crates/nui-core/src/lib.rs",
    "packages/nui-host/src/ffi.ts",
    "packages/adapter-solid/src/index.ts",
    "packages/adapter-vue/src/index.ts",
    "packages/adapter-react/src/index.ts",
    "packages/compiler-svelte/src/index.ts",
    "examples/solid-counter/main.tsx",
    "examples/reference-notes/solid-main.tsx",
    "examples/vue-counter/main.ts",
    "examples/react-counter/main.tsx",
    "examples/svelte-counter/main.ts",
    "tools/perry-frameworks.mjs",
    "tools/perry-frameworks.test.mjs",
  ]) {
    assert.equal(routes(path, "perry"), true, `${path} must route to Perry frameworks`);
  }

  const rootPackage = JSON.parse(readFileSync(rootPackageUrl, "utf8"));
  assert.equal(rootPackage.scripts["test:perry"], "node tools/perry-frameworks.mjs");

  assert.match(workflow, /^\s+perry: \$\{\{ steps\.filter\.outputs\.perry \}\}$/m);
  assert.match(
    workflow,
    /^  perry-frameworks:\n(?:    .+\n)+?    uses: \.\/\.github\/workflows\/perry-frameworks\.yml$/m,
  );
  assert.match(workflow, /^\s+PERRY: \$\{\{ needs\.perry-frameworks\.result \}\}$/m);
  assert.match(workflow, /^\s+PERRY_NEEDED: \$\{\{ needs\.changes\.outputs\.perry \}\}$/m);
  assert.match(workflow, /if \[\[ "\$PERRY_NEEDED" == "true" && "\$PERRY" != "success" \]\]; then/);

  const perryWorkflow = parse(readFileSync(perryFrameworksWorkflowUrl, "utf8"));
  const build = perryWorkflow.jobs.build;
  assert.equal(build.name, "AOT (${{ matrix.framework }}, ${{ matrix.os }})");
  assert.equal(build.strategy["fail-fast"], false);
  assert.deepEqual(build.strategy.matrix.framework, [
    "solid",
    "solid-notes",
    "vue",
    "react",
    "svelte",
  ]);
  assert.deepEqual(build.strategy.matrix.os, ["macos-15", "windows-2022"]);
  assert.equal(build["runs-on"], "${{ matrix.os }}");
  assert.equal(build["timeout-minutes"], 60);
  assert.equal(build["continue-on-error"], undefined);
  assert.equal(
    build.steps.some((step) =>
      typeof step.uses === "string" ? step.uses.startsWith("Swatinem/rust-cache") : false,
    ),
    false,
    "clean AOT jobs must not restore Cargo build output",
  );

  const msvcStep = build.steps.find(
    (step) => step.uses === "ilammy/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756",
  );
  assert.ok(msvcStep, "Windows AOT jobs must initialize the MSVC SDK environment");
  assert.equal(msvcStep.if, "runner.os == 'Windows'");

  const windowsSkiaStep = build.steps.find((step) => step.name === "Stage Windows Skia binaries");
  assert.ok(windowsSkiaStep, "Windows AOT jobs must stage Skia outside Cargo's deep OUT_DIR");
  assert.equal(windowsSkiaStep.if, "runner.os == 'Windows'");
  assert.equal(windowsSkiaStep.shell, "pwsh");
  assert.match(windowsSkiaStep.run, /curl\.exe/);
  assert.match(windowsSkiaStep.run, /Get-FileHash -Algorithm SHA256/);
  assert.match(windowsSkiaStep.run, /SKIA_BINARIES_URL/);
  assert.match(build.env.SKIA_WINDOWS_ARCHIVE_URL, /rust-skia\/skia-binaries/);
  assert.match(build.env.SKIA_WINDOWS_ARCHIVE_SHA256, /^[a-f0-9]{64}$/);

  const commands = build.steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
  assert.ok(commands.includes("pnpm install --frozen-lockfile"));
  assert.ok(commands.includes("pnpm test:perry ${{ matrix.framework }}"));
});

test("Windows Perry bootstrap prepares fixed Skia link inputs before AOT", () => {
  const perryWorkflow = parse(readFileSync(perryFrameworksWorkflowUrl, "utf8"));
  const steps = perryWorkflow.jobs.build.steps;
  const aotIndex = steps.findIndex((step) => step.name === "Clean AOT build");
  const stagingIndex = steps.findIndex((step) => step.name === "Stage Windows Skia binaries");

  assert.ok(aotIndex >= 0, "Perry workflow must contain the clean AOT step");
  assert.ok(
    stagingIndex >= 0 && stagingIndex < aotIndex,
    "Windows Skia staging must run before AOT",
  );

  const stagingCommand = steps[stagingIndex].run;
  assert.match(
    stagingCommand,
    /packages[\\/]nui-host[\\/]target[\\/]perry-native[\\/]windows/,
    "Windows Skia archive must be extracted into nui-host's fixed Perry native directory",
  );
  assert.match(
    stagingCommand,
    /(?:tar(?:\.exe)?\s+.*(?:--extract|-[^\r\n]*x)|Expand-Archive)/i,
    "Windows Skia staging must extract the pinned archive",
  );

  const windowsBootstrapSteps = steps
    .slice(0, aotIndex)
    .filter(
      (step) =>
        step.if === "runner.os == 'Windows'" &&
        step.shell === "pwsh" &&
        typeof step.run === "string",
    );
  const verificationStep = windowsBootstrapSteps.find(
    (step) =>
      /skia-binaries[\\/]skia\.lib/.test(step.run) &&
      /skia-binaries[\\/]skia-bindings\.lib/.test(step.run),
  );
  assert.ok(verificationStep, "Windows bootstrap must verify both Skia link inputs before AOT");
  assert.match(verificationStep.run, /Test-Path/i);
  assert.match(
    verificationStep.run,
    /throw/i,
    "Windows bootstrap must fail before AOT when either Skia link input is missing",
  );
});

test("the required FFI gate executes the Minimal TSX Perry runtime smoke", () => {
  for (const path of [
    "crates/nui-core/src/lib.rs",
    "packages/ui/src/mount/materialize.ts",
    "examples/counter/smoke.tsx",
    "tools/perry-smoke.mjs",
  ]) {
    assert.equal(routes(path, "ffi"), true, `${path} must route to FFI`);
  }

  const counterPackage = JSON.parse(readFileSync(counterPackageUrl, "utf8"));
  assert.equal(counterPackage.scripts.smoke, "node ../../tools/perry-smoke.mjs");
  assert.ok(existsSync(perrySmokeUrl), "the cross-platform Perry smoke runner must exist");

  const ffiWorkflow = parse(readFileSync(ffiWorkflowUrl, "utf8"));
  const smokeStep = ffiWorkflow.jobs.gate.steps.find(
    (step) => step.name === "Run Minimal TSX Perry smoke",
  );
  assert.ok(smokeStep, "the FFI gate must contain the Perry runtime smoke step");
  assert.equal(smokeStep.if, "matrix.package == 'nui-host'");
  assert.equal(smokeStep.run, "pnpm --filter @nexa/example-counter smoke");
  assert.notEqual(smokeStep["continue-on-error"], true);

  const commands = ffiWorkflow.jobs.gate.steps.flatMap((step) =>
    typeof step.run === "string" ? [step.run] : [],
  );
  for (const versionCommand of [
    "node --version",
    "pnpm --version",
    "rustc --version",
    "pnpm exec perry --version",
  ]) {
    assert.ok(
      commands.some((command) => command.includes(versionCommand)),
      `FFI gate must report ${versionCommand}`,
    );
  }
});

test("the TypeScript gate runs the complete workspace quality sequence", () => {
  const typescriptWorkflow = parse(readFileSync(typescriptWorkflowUrl, "utf8"));
  const job = Object.values(typescriptWorkflow.jobs)[0];
  const commands = job.steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));

  assert.deepEqual(
    commands.filter((command) => command.startsWith("pnpm ")),
    [
      "pnpm install --frozen-lockfile",
      "pnpm release:build",
      "pnpm workspace:validate",
      "pnpm protocol:check",
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
    ],
  );
});

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
const rootPackageUrl = new URL("../package.json", import.meta.url);
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

test("all ten pnpm examples trigger TypeScript checks", () => {
  const examples = [...workspace.matchAll(/^\s*- "(examples\/[^"]+)"$/gm)].map(([, path]) => path);

  assert.equal(examples.length, 10);
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

test("workflow, script, and root config changes route to their owners", () => {
  const fixtures = new Map([
    [".github/workflows/ci.yml", ["rust", "typescript", "ffi", "perry", "native"]],
    [".github/workflows/rust.yml", ["rust", "typescript"]],
    [".github/workflows/typescript.yml", ["typescript"]],
    [".github/workflows/ffi.yml", ["typescript", "ffi"]],
    [".github/workflows/perry-frameworks.yml", ["typescript", "perry"]],
    [".github/workflows/native-smoke.yml", ["typescript", "native"]],
    [".github/workflows/docs.yml", ["typescript", "docs"]],
    ["scripts/build-native.sh", ["rust", "typescript", "ffi", "native"]],
    ["tools/ci-path-filters.test.mjs", ["typescript"]],
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

test("the required result check fails closed when change detection fails", () => {
  assert.match(workflow, /^\s+if: always\(\)$/m);
  assert.match(
    workflow,
    /^\s+needs: \[changes, rust, typescript, ffi, perry-frameworks, docs, native-smoke\]$/m,
  );
  assert.match(workflow, /^\s+CHANGES: \$\{\{ needs\.changes\.result \}\}$/m);
  assert.match(workflow, /if \[\[ "\$CHANGES" != "success" \]\]; then/);
});

test("the Docs route always runs for documentation changes and fails closed", () => {
  assert.equal(ci.permissions.actions, "read");
  assert.equal(ci.permissions.contents, "read");
  assert.equal(ci.jobs.docs.if, "needs.changes.outputs.docs == 'true'");
  assert.match(workflow, /^\s+DOCS: \$\{\{ needs\.docs\.result \}\}$/m);
  assert.match(workflow, /^\s+DOCS_NEEDED: \$\{\{ needs\.changes\.outputs\.docs \}\}$/m);
  assert.match(workflow, /if \[\[ "\$DOCS_NEEDED" == "true" && "\$DOCS" != "success" \]\]; then/);
});

test("enabled native smoke fails closed for every non-success result", () => {
  assert.match(workflow, /^\s+NATIVE_NEEDED: \$\{\{ needs\.changes\.outputs\.native \}\}$/m);
  assert.match(workflow, /^\s+NATIVE_ENABLED: \$\{\{ vars\.NATIVE_SMOKE_ENABLED \}\}$/m);
  assert.match(
    workflow,
    /if \[\[ "\$NATIVE_NEEDED" == "true" && "\$NATIVE_ENABLED" == "true" && "\$NATIVE" != "success" \]\]; then/,
  );
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
  assert.match(
    workflow,
    /^\s+needs: \[changes, rust, typescript, ffi, perry-frameworks, docs, native-smoke\]$/m,
  );
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

test("the required Perry framework gate runs four independent clean AOT builds", () => {
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
  assert.deepEqual(build.strategy.matrix.framework, ["solid", "vue", "react", "svelte"]);
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
      "pnpm workspace:validate",
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
    ],
  );
});

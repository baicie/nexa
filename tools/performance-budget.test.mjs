import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  evaluatePerformanceReport,
  measureArtifactBytes,
  validateActiveBaselineEvidence,
  validateFrozenPerformancePolicy,
  validatePerformanceConfig,
  validatePerformanceReport,
} from "./performance-budget.mjs";

const metricNames = [
  "coldStartMs",
  "idleRssBytes",
  "artifactBytes",
  "tickMs",
  "layoutMs",
  "paintMs",
];
const temporaryDirectories = [];
const runnerPath = fileURLToPath(new URL("./performance-budget.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not hide the contract assertion.
    }
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nexa-performance-contract-"));
  temporaryDirectories.push(directory);
  return directory;
}

function activeConfig() {
  const metric = (unit, collection, statistic, maxRegressionPercent, minimumSamples = 5) => ({
    unit,
    collection,
    statistic,
    maxRegressionPercent,
    minimumSamples,
  });
  const metrics = {
    coldStartMs: metric("ms", "hosted-native", "median", 20),
    idleRssBytes: metric("bytes", "hosted-native", "median", 20),
    artifactBytes: metric("bytes", "deterministic-artifact", "max", 5, 1),
    tickMs: metric("ms", "hosted-native", "p95", 15),
    layoutMs: metric("ms", "hosted-native", "p95", 15),
    paintMs: metric("ms", "hosted-native", "p95", 15),
  };
  const values = {
    coldStartMs: 100,
    idleRssBytes: 100_000_000,
    artifactBytes: 25_000_000,
    tickMs: 10,
    layoutMs: 4,
    paintMs: 5,
  };
  const baselines = Object.fromEntries(
    metricNames.map((name) => [
      name,
      {
        status: "active",
        value: values[name],
        evidence: {
          report: "report.json",
          commit: "b".repeat(40),
          capturedAt: "2026-08-09T01:00:00.000Z",
        },
      },
    ]),
  );
  const darwin = { runner: "macos-15", baselines };
  return {
    schemaVersion: 1,
    workload: {
      id: "reference-notes-v1",
      definition: "docs/PERFORMANCE.md#reference-workload",
      samplePolicy: { warmupRuns: 1, measuredRuns: 5 },
    },
    metrics,
    platforms: {
      "darwin-arm64": darwin,
      "win32-x64": JSON.parse(JSON.stringify({ runner: "windows-2022", baselines })),
    },
  };
}

function report(overrides = {}) {
  const samples = {
    coldStartMs: [95, 100, 98, 102, 101],
    idleRssBytes: [95_000_000, 99_000_000, 100_000_000, 101_000_000, 102_000_000],
    artifactBytes: [25_500_000],
    tickMs: [8, 9, 10, 10.5, 11],
    layoutMs: [2, 3, 3.5, 4, 4.5],
    paintMs: [3, 4, 4.5, 5, 5.5],
  };
  return {
    schemaVersion: 1,
    workload: "reference-notes-v1",
    platform: "darwin-arm64",
    commit: "b".repeat(40),
    capturedAt: "2026-08-09T01:00:00.000Z",
    runner: { provider: "github-actions", image: "macos-15", hosted: true },
    artifact: {
      name: "reference-notes-macos-arm64",
      executable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
      executableSha256: "c".repeat(64),
    },
    quality: { failedRuns: 0, droppedFrames: 0 },
    samples,
    ...overrides,
  };
}

test("the release config covers every G6-07 metric with raw hosted evidence", () => {
  const config = JSON.parse(
    readFileSync(new URL("../release/performance-budgets.json", import.meta.url), "utf8"),
  );

  assert.doesNotThrow(() =>
    validatePerformanceConfig(config, {
      verifyActiveEvidence: true,
      evidenceRoot: repositoryRoot,
    }),
  );
  assert.deepEqual(Object.keys(config.metrics).sort(), [...metricNames].sort());
  assert.equal(config.metrics.artifactBytes.collection, "deterministic-artifact");
  for (const name of metricNames.filter((metricName) => metricName !== "artifactBytes")) {
    assert.equal(config.metrics[name].collection, "hosted-native");
  }
  assert.deepEqual(Object.keys(config.platforms).sort(), ["darwin-arm64", "win32-x64"]);
  for (const platform of Object.values(config.platforms)) {
    for (const baseline of Object.values(platform.baselines)) {
      assert.equal(baseline.status, "active");
      assert.equal(Number.isFinite(baseline.value), true);
      assert.equal(baseline.evidence.commit, "892e1cede80762f791564302c86b8afa42157575");
    }
  }
});

test("production capture policy is frozen while unit fixtures may stay small", () => {
  const config = JSON.parse(
    readFileSync(new URL("../release/performance-budgets.json", import.meta.url), "utf8"),
  );
  assert.doesNotThrow(() => validateFrozenPerformancePolicy(config));

  const weakened = JSON.parse(JSON.stringify(config));
  weakened.workload.samplePolicy.measuredRuns = 1;
  assert.throws(() => validateFrozenPerformancePolicy(weakened), /measuredRuns is frozen at 10/u);
});

test("active baseline evidence is a bound raw report, not an unchecked label", () => {
  const directory = temporaryDirectory();
  const config = activeConfig();
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report()));
  const baselines = config.platforms["darwin-arm64"].baselines;
  baselines.coldStartMs.value = 100;
  baselines.idleRssBytes.value = 100_000_000;
  baselines.artifactBytes.value = 25_500_000;
  baselines.tickMs.value = 11;
  baselines.layoutMs.value = 4.5;
  baselines.paintMs.value = 5.5;

  assert.doesNotThrow(() => validateActiveBaselineEvidence(config, "darwin-arm64", directory));

  config.platforms["darwin-arm64"].baselines.tickMs.value = 999;
  assert.throws(
    () => validateActiveBaselineEvidence(config, "darwin-arm64", directory),
    /statistic for tickMs does not match/u,
  );
  config.platforms["darwin-arm64"].baselines.tickMs.value = 11;
  config.platforms["darwin-arm64"].baselines.tickMs.evidence.report = "../report.json";
  assert.throws(
    () => validateActiveBaselineEvidence(config, "darwin-arm64", directory),
    /repository-relative/u,
  );
});

test("a hosted report is summarized deterministically and passes active budgets", () => {
  const config = activeConfig();
  const input = report();

  assert.doesNotThrow(() => validatePerformanceReport(input, config));
  const result = evaluatePerformanceReport(input, config);

  assert.equal(result.status, "pass");
  assert.equal(result.metrics.coldStartMs.observed, 100);
  assert.equal(result.metrics.tickMs.observed, 11);
  assert.equal(result.metrics.artifactBytes.limit, 26_250_000);
});

test("a hosted report requires exact artifact name, executable path, and SHA identity", () => {
  const config = activeConfig();
  const { artifact: _artifact, ...missingArtifact } = report();

  assert.throws(() => validatePerformanceReport(missingArtifact, config), /report\.artifact/u);
  assert.throws(
    () =>
      validatePerformanceReport(
        report({
          artifact: {
            name: "reference-notes-windows-x64",
            executable: "NexaNotes.exe",
            executableSha256: "c".repeat(64),
          },
        }),
        config,
      ),
    /artifact.*name|report\.platform/u,
  );
  assert.throws(
    () =>
      validatePerformanceReport(
        report({
          artifact: {
            name: "reference-notes-macos-arm64",
            executable: "../NexaNotes",
            executableSha256: "c".repeat(64),
          },
        }),
        config,
      ),
    /artifact.*executable/u,
  );
  assert.throws(
    () =>
      validatePerformanceReport(
        report({
          artifact: {
            name: "reference-notes-macos-arm64",
            executable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
            executableSha256: "C".repeat(64),
          },
        }),
        config,
      ),
    /artifact.*executableSha256|lowercase.*SHA/u,
  );
});

test("hosted-native samples are rejected when the report came from a local machine", () => {
  const config = activeConfig();
  const localReport = report({
    runner: { provider: "local", image: "macos-15", hosted: false },
  });

  assert.throws(
    () => validatePerformanceReport(localReport, config),
    /hosted-native metrics require a hosted runner/u,
  );
});

test("failed runs and dropped frames cannot be hidden behind fast samples", () => {
  const config = activeConfig();

  assert.throws(
    () =>
      validatePerformanceReport(report({ quality: { failedRuns: 1, droppedFrames: 0 } }), config),
    /failedRuns must be zero/u,
  );
  assert.throws(
    () =>
      validatePerformanceReport(report({ quality: { failedRuns: 0, droppedFrames: 1 } }), config),
    /droppedFrames must be zero/u,
  );
});

test("a p95 regression fails while pending baselines remain explicit", () => {
  const config = activeConfig();
  config.platforms["darwin-arm64"].baselines.paintMs = {
    status: "pending",
    reason: "awaiting hosted macOS capture",
  };
  const regressed = report();
  regressed.samples.tickMs = [8, 9, 10, 11, 12];

  const result = evaluatePerformanceReport(regressed, config);

  assert.equal(result.status, "regression");
  assert.equal(result.metrics.tickMs.status, "regression");
  assert.equal(result.metrics.tickMs.observed, 12);
  assert.equal(result.metrics.tickMs.limit, 11.5);
  assert.equal(result.metrics.paintMs.status, "pending");
});

test("artifact bytes are counted recursively and symbolic links are rejected", () => {
  const directory = temporaryDirectory();
  mkdirSync(path.join(directory, "nested"));
  writeFileSync(path.join(directory, "app.bin"), Buffer.alloc(17));
  writeFileSync(path.join(directory, "nested", "manifest.json"), Buffer.alloc(5));

  assert.equal(measureArtifactBytes(directory), 22);

  symlinkSync(path.join(directory, "app.bin"), path.join(directory, "nested", "alias"));
  assert.throws(() => measureArtifactBytes(directory), /symbolic links are not artifacts/u);
});

test("the CLI returns distinct pass, regression, and pending exit codes", () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  const reportPath = path.join(directory, "report.json");
  const baselineReportPath = path.join(directory, "baseline.json");
  const config = JSON.parse(
    readFileSync(new URL("../release/performance-budgets.json", import.meta.url), "utf8"),
  );
  const darwinBaselines = config.platforms["darwin-arm64"].baselines;
  const baselineValues = {
    coldStartMs: 100,
    idleRssBytes: 100_000_000,
    artifactBytes: 25_000_000,
    tickMs: 10,
    layoutMs: 4,
    paintMs: 5,
  };
  for (const [metricName, value] of Object.entries(baselineValues)) {
    darwinBaselines[metricName] = {
      status: "active",
      value,
      evidence: {
        report: "baseline.json",
        commit: "b".repeat(40),
        capturedAt: "2026-08-09T01:00:00.000Z",
      },
    };
  }
  const expandSamples = (input) => {
    input.samples.coldStartMs = Array.from(
      { length: 10 },
      (_, index) => input.samples.coldStartMs[index % 5],
    );
    input.samples.idleRssBytes = Array.from(
      { length: 10 },
      (_, index) => input.samples.idleRssBytes[index % 5],
    );
    input.samples.tickMs = Array.from(
      { length: 100 },
      (_, index) => input.samples.tickMs[index % 5],
    );
    input.samples.layoutMs = Array.from(
      { length: 100 },
      (_, index) => input.samples.layoutMs[index % 5],
    );
    input.samples.paintMs = Array.from(
      { length: 100 },
      (_, index) => input.samples.paintMs[index % 5],
    );
    return input;
  };
  const baselineReport = report({
    samples: {
      coldStartMs: Array(5).fill(100),
      idleRssBytes: Array(5).fill(100_000_000),
      artifactBytes: [25_000_000],
      tickMs: Array(5).fill(10),
      layoutMs: Array(5).fill(4),
      paintMs: Array(5).fill(5),
    },
  });
  expandSamples(baselineReport);
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(reportPath, JSON.stringify(expandSamples(report())));
  writeFileSync(baselineReportPath, JSON.stringify(baselineReport));

  const passed = spawnSync(
    process.execPath,
    [runnerPath, "check", "--config", configPath, "--report", reportPath, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).status, "pass");

  const regressed = expandSamples(report());
  regressed.samples.tickMs = Array(100).fill(12);
  writeFileSync(reportPath, JSON.stringify(regressed));
  const failed = spawnSync(
    process.execPath,
    [runnerPath, "check", "--config", configPath, "--report", reportPath, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).status, "regression");

  config.platforms["darwin-arm64"].baselines.paintMs = {
    status: "pending",
    reason: "awaiting hosted capture",
  };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(reportPath, JSON.stringify(expandSamples(report())));
  const pending = spawnSync(
    process.execPath,
    [runnerPath, "check", "--config", configPath, "--report", reportPath, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(pending.status, 2, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).status, "pending");
});

test("the performance CLI rejects unknown, duplicate, and malformed options", () => {
  const unknown = spawnSync(
    process.execPath,
    [runnerPath, "status", "--platform", "darwin-arm64", "--require-actve"],
    { encoding: "utf8" },
  );
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option/u);

  const booleanValue = spawnSync(process.execPath, [runnerPath, "validate", "--json", "true"], {
    encoding: "utf8",
  });
  assert.equal(booleanValue.status, 1);
  assert.match(booleanValue.stderr, /does not accept a value/u);

  const duplicate = spawnSync(
    process.execPath,
    [
      runnerPath,
      "validate",
      "--config",
      "release/performance-budgets.json",
      "--config",
      "release/performance-budgets.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /duplicate option/u);
});

test("the dedicated workflow keeps native capture on pinned macOS and Windows hosted runners", () => {
  const perryRevision = "06137858dc8c6f80975238377138f2f948d6ef88";
  const source = readFileSync(
    new URL("../.github/workflows/performance.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(source);
  const hosted = workflow.jobs["hosted-boundary"];

  assert.deepEqual(hosted.strategy.matrix.include, [
    { os: "macos-15", platform: "darwin-arm64" },
    { os: "windows-2022", platform: "win32-x64" },
  ]);
  assert.equal(hosted["runs-on"], "${{ matrix.os }}");
  assert.match(source, /actions\/checkout@[0-9a-f]{40}/u);
  assert.match(source, /actions\/setup-node@[0-9a-f]{40}/u);
  assert.match(source, /node-version: "22"/u);
  assert.equal(hosted.env.PERRY_NO_AUTO_OPTIMIZE, "1");
  assert.equal(hosted.env.RUSTUP_TOOLCHAIN, "1.95.0");
  assert.equal(hosted.env.PERRY_WORKSPACE_ROOT, "${{ github.workspace }}/.perry-source");
  assert.equal(
    hosted.env.PERRY_RUNTIME_DIR,
    "${{ github.workspace }}/.perry-source/target/release",
  );
  assert.equal(hosted.env.PERRY_LIB_DIR, "${{ github.workspace }}/.perry-source/target/release");
  assert.equal(
    hosted.env.NEXA_WINDOWS_RUNTIME_ROOT,
    "${{ github.workspace }}/.nexa-windows-runtime",
  );
  assert.match(
    source,
    /node tools\/performance-budget\.mjs status --platform "\$\{\{ matrix\.platform \}\}"/u,
  );

  const perryCheckoutIndex = hosted.steps.findIndex(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@") &&
      step.with?.repository === "PerryTS/perry",
  );
  const perryCheckout = hosted.steps[perryCheckoutIndex];
  assert.ok(perryCheckoutIndex >= 0, "the hosted build must check out Perry source");
  assert.equal(perryCheckout.with.ref, perryRevision);
  assert.equal(perryCheckout.with.path, ".perry-source");
  assert.equal(perryCheckout.with["persist-credentials"], false);

  const rustToolchainIndex = hosted.steps.findIndex(
    (step) => typeof step.uses === "string" && step.uses.startsWith("dtolnay/rust-toolchain@"),
  );
  const rustToolchain = hosted.steps[rustToolchainIndex];
  assert.ok(rustToolchainIndex > perryCheckoutIndex, "Rust must be installed after Perry checkout");
  assert.equal(rustToolchain.with.toolchain, "1.95.0");

  const installIndex = hosted.steps.findIndex(
    (step) => step.run === "pnpm install --frozen-lockfile",
  );
  const releaseBuildIndex = hosted.steps.findIndex((step) => step.run === "pnpm release:build");
  const macRuntimeIndex = hosted.steps.findIndex(
    (step) => step.name === "Build pinned Perry full unwind runtime closure (macOS)",
  );
  const windowsCompilerIndex = hosted.steps.findIndex(
    (step) => step.name === "Build patched Perry compiler (Windows)",
  );
  const macRuntime = hosted.steps[macRuntimeIndex];
  const windowsCompiler = hosted.steps[windowsCompilerIndex];
  assert.ok(
    rustToolchainIndex < macRuntimeIndex && installIndex < macRuntimeIndex,
    "the macOS runtime must use the pinned toolchain after the dependency graph is installed",
  );
  assert.equal(macRuntime.if, "runner.os == 'macOS'");
  assert.equal(macRuntime.shell, "bash");
  assert.equal(macRuntime.env.CARGO_PROFILE_RELEASE_PANIC, "unwind");
  assert.equal(macRuntime.env.PERRY_SOURCE_REVISION, perryRevision);
  assert.match(macRuntime.run, /git -C "\$PERRY_WORKSPACE_ROOT" rev-parse HEAD/u);
  assert.match(macRuntime.run, /cargo build[\s\S]*--locked[\s\S]*--release/u);
  assert.match(macRuntime.run, /-p perry-runtime-static/u);
  assert.match(macRuntime.run, /-p perry-stdlib-static/u);
  assert.match(macRuntime.run, /libperry_runtime\.a/u);
  assert.match(macRuntime.run, /libperry_stdlib\.a/u);

  assert.ok(
    rustToolchainIndex < windowsCompilerIndex && installIndex < windowsCompilerIndex,
    "the patched Windows compiler must use the installed pinned toolchain",
  );
  assert.equal(windowsCompiler.if, "runner.os == 'Windows'");
  assert.equal(windowsCompiler.shell, "pwsh");
  assert.equal(windowsCompiler.env.CARGO_PROFILE_RELEASE_PANIC, "unwind");
  assert.equal(windowsCompiler.env.PERRY_SOURCE_REVISION, perryRevision);
  assert.match(
    windowsCompiler.run,
    /patches\/perry\/0001-windows-reject-duplicate-symbols\.patch/u,
  );
  assert.match(windowsCompiler.run, /git -C \$env:PERRY_WORKSPACE_ROOT apply --check \$patch/u);
  assert.match(
    windowsCompiler.run,
    /git -C \$env:PERRY_WORKSPACE_ROOT apply --reverse --check \$patch/u,
  );
  assert.match(windowsCompiler.run, /cargo build[\s\S]*-p perry/u);
  assert.match(windowsCompiler.run, /NEXA_PERRY_BIN=\$compiler/u);
  assert.doesNotMatch(
    windowsCompiler.run,
    /windows-static-closure|perry_runtime\.lib|perry_stdlib\.lib|FORCE:MULTIPLE/u,
  );

  const skiaDownloadIndex = hosted.steps.findIndex(
    (step) => step.name === "Download verified Windows Skia archive",
  );
  const skiaDownload = hosted.steps[skiaDownloadIndex];
  assert.ok(skiaDownloadIndex >= 0, "Windows must download the reviewed Skia archive");
  assert.equal(skiaDownload.if, "runner.os == 'Windows'");
  assert.equal(skiaDownload.shell, "pwsh");
  assert.match(skiaDownload.run, /Get-FileHash -Algorithm SHA256/u);
  assert.match(skiaDownload.run, /NEXA_WINDOWS_SKIA_ARCHIVE=\$archive/u);
  assert.doesNotMatch(skiaDownload.run, /tar\.exe|packages[\\/]nui-host|stage-windows-skia/u);
  assert.match(skiaDownload.run, /SKIA_BINARIES_URL=\$fileUrl/u);

  const skiaStageIndex = hosted.steps.findIndex(
    (step) => step.name === "Stage verified Windows Skia for Reference Notes",
  );
  const skiaStage = hosted.steps[skiaStageIndex];
  assert.ok(
    releaseBuildIndex < skiaStageIndex,
    "Skia must be staged only after the release Host snapshot exists",
  );
  assert.equal(skiaStage.if, "runner.os == 'Windows'");
  assert.equal(skiaStage.shell, "pwsh");
  assert.match(skiaStage.run, /node tools\/stage-windows-skia\.mjs/u);
  assert.match(skiaStage.run, /--project "examples\/reference-notes"/u);
  assert.match(skiaStage.run, /--archive "\$env:NEXA_WINDOWS_SKIA_ARCHIVE"/u);
  assert.match(skiaStage.run, /--sha256 "\$env:SKIA_WINDOWS_ARCHIVE_SHA256"/u);

  const hostedCommands = hosted.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  const notesPackageIndex = hosted.steps.findIndex(
    (step) => step.run === "pnpm --filter @nexa/example-reference-notes package",
  );
  assert.ok(releaseBuildIndex >= 0, "the hosted job must materialize release package inputs");
  assert.ok(
    notesPackageIndex > releaseBuildIndex,
    "Notes must be packaged only after the native Host release snapshots exist",
  );
  assert.ok(macRuntimeIndex < notesPackageIndex);
  assert.ok(windowsCompilerIndex < notesPackageIndex);
  assert.ok(skiaStageIndex < notesPackageIndex);
  assert.match(hostedCommands, /node tools\/performance-collector\.mjs/u);
  assert.match(hostedCommands, /node tools\/performance-budget\.mjs check[\s\S]*--allow-pending/u);
  const captureStep = hosted.steps.find((step) => step.id === "capture");
  const checkStep = hosted.steps.find(
    (step) => typeof step.run === "string" && step.run.includes("performance-budget.mjs check"),
  );
  assert.match(captureStep?.run ?? "", /performance-collector\.mjs/u);
  assert.doesNotMatch(captureStep?.run ?? "", /performance-budget\.mjs check/u);
  assert.notEqual(checkStep, undefined, "the native report must be checked after capture");
  const rawReportUpload = hosted.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      /^actions\/upload-artifact@[0-9a-f]{40}$/u.test(step.uses) &&
      typeof step.with?.path === "string" &&
      step.with.path.includes("nexa-performance-${{ matrix.platform }}.json"),
  );
  assert.notEqual(
    rawReportUpload,
    undefined,
    "the complete raw performance report must be uploaded",
  );
  assert.equal(rawReportUpload.if, "${{ always() && steps.capture.outcome == 'success' }}");
  assert.doesNotMatch(source, /tools\/fixtures\/performance/u);
});

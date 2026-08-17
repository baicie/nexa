import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  createPerformanceReportSet,
  evaluatePerformanceReport,
  evaluatePerformanceReportSet,
  measureArtifactBytes,
  measureArtifactTreeSha256,
  summarizePerformanceReport,
  validateActiveBaselineEvidence,
  validateFrozenPerformancePolicy,
  validatePerformanceConfig,
  validatePerformanceReport,
  validatePerformanceReportSet,
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
      id: "reference-notes-v2",
      definition: "docs/PERFORMANCE.md#reference-workload",
      samplePolicy: {
        warmupRuns: 1,
        measuredRuns: 5,
        startupPresentsPerMeasuredRun: 1,
      },
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
    workload: "reference-notes-v2",
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

function v3Config() {
  const metric = (unit, collection, statistic, maxRegressionPercent, minimumSamples) => ({
    unit,
    collection,
    statistic,
    maxRegressionPercent,
    minimumSamples,
  });
  const values = {
    coldStartMs: 100,
    idleRssBytes: 100_000_000,
    artifactBytes: 25_000_000,
    tickMs: 20,
    layoutMs: 10,
    paintMs: 10,
  };
  const baselines = Object.fromEntries(
    metricNames.map((name) => [
      name,
      {
        status: "active",
        value: values[name],
        evidence: {
          reportSet: "report-set.json",
          commit: "d".repeat(40),
          capturedAt: "2026-08-17T01:00:00.000Z",
        },
      },
    ]),
  );
  return {
    schemaVersion: 2,
    workload: {
      id: "reference-notes-v3",
      definition: "docs/PERFORMANCE.md#reference-workload",
      samplePolicy: {
        warmupRuns: 3,
        measuredRuns: 10,
        startupPresentsPerMeasuredRun: 1,
        steadyPresentsPerMeasuredRun: 100,
        replicasPerPlatform: 3,
      },
    },
    metrics: {
      coldStartMs: metric("ms", "hosted-native", "median", 20, 10),
      idleRssBytes: metric("bytes", "hosted-native", "median", 20, 10),
      artifactBytes: metric("bytes", "deterministic-artifact", "max", 5, 1),
      tickMs: metric("ms", "hosted-native", "median-of-process-p95", 15, 1_000),
      layoutMs: metric("ms", "hosted-native", "median-of-process-p95", 15, 1_000),
      paintMs: metric("ms", "hosted-native", "median-of-process-p95", 15, 1_000),
    },
    platforms: {
      "darwin-arm64": { runner: "macos-15", baselines },
      "win32-x64": {
        runner: "windows-2022",
        baselines: JSON.parse(JSON.stringify(baselines)),
      },
    },
  };
}

function v3Report({
  replica = 1,
  tickMs = 10,
  slowProcessTickMs,
  runAttempt = 1,
  artifact = {},
  quality = { failedRuns: 0, droppedFrames: 0 },
} = {}) {
  const measuredProcesses = Array.from({ length: 10 }, (_, processIndex) => {
    const processTickMs = processIndex === 9 && slowProcessTickMs ? slowProcessTickMs : tickMs;
    return {
      index: processIndex + 1,
      coldStartMs: 90 + processIndex,
      idleRssBytes: 90_000_000 + processIndex,
      frames: {
        tickMs: Array(100).fill(processTickMs),
        layoutMs: Array(100).fill(3),
        paintMs: Array(100).fill(5),
      },
    };
  });
  return {
    schemaVersion: 2,
    kind: "performance-runner-report",
    workload: "reference-notes-v3",
    platform: "darwin-arm64",
    commit: "d".repeat(40),
    capturedAt: `2026-08-17T01:00:0${replica}.000Z`,
    replica,
    runner: {
      provider: "github-actions",
      image: "macos-15",
      hosted: true,
      runId: "31970000000",
      runAttempt,
    },
    artifact: {
      name: "reference-notes-macos-arm64",
      executable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
      bytes: 25_000_000,
      executableSha256: "a".repeat(64),
      treeSha256: "b".repeat(64),
      archiveSha256: "c".repeat(64),
      ...artifact,
    },
    quality,
    measuredProcesses,
  };
}

function v3Entries(reports) {
  return reports.map((input, index) => ({
    path: `replica-${index + 1}.json`,
    rawBytes: Buffer.from(`${JSON.stringify(input, null, 2)}\n`),
  }));
}

test("v3 preserves process boundaries instead of pooling one slow process into p95", () => {
  const config = v3Config();
  const input = v3Report({ tickMs: 10, slowProcessTickMs: 100 });

  assert.doesNotThrow(() => validatePerformanceReport(input, config));
  const summary = summarizePerformanceReport(input, config);

  assert.equal(summary.tickMs, 10);
  assert.equal(summary.coldStartMs, 94.5);
});

test("v3 platform result is the median of three complete runner summaries", () => {
  const config = v3Config();
  const entries = v3Entries([
    v3Report({ replica: 1, tickMs: 10 }),
    v3Report({ replica: 2, tickMs: 11 }),
    v3Report({ replica: 3, tickMs: 100 }),
  ]);
  const reportSet = createPerformanceReportSet({
    config,
    reportEntries: entries,
    capturedAt: "2026-08-17T01:00:00.000Z",
  });

  assert.doesNotThrow(() =>
    validatePerformanceReportSet(reportSet, config, { reportEntries: entries }),
  );
  const result = evaluatePerformanceReportSet(reportSet, config, { reportEntries: entries });

  assert.equal(result.metrics.tickMs.observed, 11);
  assert.equal(result.status, "pass");
  assert.throws(
    () => evaluatePerformanceReport(v3Report(), config),
    /complete three-replica report set/u,
  );

  const changedEntries = entries.map((entry) => ({ ...entry }));
  changedEntries[1].rawBytes = Buffer.from(
    `${JSON.stringify(v3Report({ replica: 2, tickMs: 12 }), null, 2)}\n`,
  );
  assert.throws(
    () => validatePerformanceReportSet(reportSet, config, { reportEntries: changedEntries }),
    /does not match its complete raw reports/u,
  );
});

test("v3 rejects inexact process counts, frame counts, quality, and mixed report sets", () => {
  const config = v3Config();
  const shortProcess = v3Report();
  shortProcess.measuredProcesses[0].frames.tickMs.pop();
  assert.throws(() => validatePerformanceReport(shortProcess, config), /exactly 100/u);

  const extraProcess = v3Report();
  extraProcess.measuredProcesses[0].frames.paintMs.push(5);
  assert.throws(() => validatePerformanceReport(extraProcess, config), /exactly 100/u);

  assert.throws(
    () =>
      validatePerformanceReport(v3Report({ quality: { failedRuns: 1, droppedFrames: 0 } }), config),
    /failedRuns must be zero/u,
  );

  const duplicateReplica = v3Entries([
    v3Report({ replica: 1 }),
    v3Report({ replica: 1 }),
    v3Report({ replica: 3 }),
  ]);
  assert.throws(
    () =>
      createPerformanceReportSet({
        config,
        reportEntries: duplicateReplica,
        capturedAt: "2026-08-17T01:00:00.000Z",
      }),
    /replica/u,
  );

  const mixedAttempt = v3Entries([
    v3Report({ replica: 1 }),
    v3Report({ replica: 2, runAttempt: 2 }),
    v3Report({ replica: 3 }),
  ]);
  assert.throws(
    () =>
      createPerformanceReportSet({
        config,
        reportEntries: mixedAttempt,
        capturedAt: "2026-08-17T01:00:00.000Z",
      }),
    /runAttempt/u,
  );

  const mixedArtifact = v3Entries([
    v3Report({ replica: 1 }),
    v3Report({ replica: 2, artifact: { archiveSha256: "e".repeat(64) } }),
    v3Report({ replica: 3 }),
  ]);
  assert.throws(
    () =>
      createPerformanceReportSet({
        config,
        reportEntries: mixedArtifact,
        capturedAt: "2026-08-17T01:00:00.000Z",
      }),
    /archiveSha256|artifact identity/u,
  );

  const impossibleRunId = v3Report();
  impossibleRunId.runner.runId = "0";
  assert.throws(
    () => validatePerformanceReport(impossibleRunId, config),
    /canonical positive decimal/u,
  );

  const legacyShape = report({ workload: "reference-notes-v3" });
  assert.throws(
    () => validatePerformanceReport(legacyShape, config),
    /schemaVersion must exactly match/u,
  );
});

test("the release config freezes reference-notes-v3 with reviewed active report sets", () => {
  const config = JSON.parse(
    readFileSync(new URL("../release/performance-budgets.json", import.meta.url), "utf8"),
  );

  assert.doesNotThrow(() =>
    validatePerformanceConfig(config, {
      verifyActiveEvidence: true,
      evidenceRoot: repositoryRoot,
    }),
  );
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.workload.id, "reference-notes-v3");
  assert.equal(config.workload.samplePolicy.startupPresentsPerMeasuredRun, 1);
  assert.equal(config.workload.samplePolicy.steadyPresentsPerMeasuredRun, 100);
  assert.equal(config.workload.samplePolicy.replicasPerPlatform, 3);
  for (const metricName of ["tickMs", "layoutMs", "paintMs"]) {
    assert.equal(config.metrics[metricName].minimumSamples, 1_000);
  }
  assert.deepEqual(Object.keys(config.metrics).sort(), [...metricNames].sort());
  assert.equal(config.metrics.artifactBytes.collection, "deterministic-artifact");
  for (const name of metricNames.filter((metricName) => metricName !== "artifactBytes")) {
    assert.equal(config.metrics[name].collection, "hosted-native");
  }
  assert.deepEqual(Object.keys(config.platforms).sort(), ["darwin-arm64", "win32-x64"]);
  for (const [platformName, platform] of Object.entries(config.platforms)) {
    const evidenceRecords = Object.values(platform.baselines).map(({ evidence }) => evidence);
    assert.equal(new Set(evidenceRecords.map((evidence) => JSON.stringify(evidence))).size, 1);
    const [evidence] = evidenceRecords;
    assert.match(evidence.reportSet, new RegExp(`/${platformName}/`, "u"));
    const reportSet = JSON.parse(
      readFileSync(path.join(repositoryRoot, evidence.reportSet), "utf8"),
    );
    assert.equal(reportSet.platform, platformName);
    assert.equal(evidence.commit, reportSet.commit);
    assert.equal(evidence.capturedAt, reportSet.capturedAt);
    for (const metricName of metricNames) {
      const baseline = platform.baselines[metricName];
      assert.equal(baseline.status, "active");
      assert.equal(baseline.value, reportSet.summary.metrics[metricName]);
      assert.equal("reason" in baseline, false);
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

  const mixedStartup = JSON.parse(JSON.stringify(config));
  mixedStartup.workload.samplePolicy.startupPresentsPerMeasuredRun = 2;
  assert.throws(
    () => validateFrozenPerformancePolicy(mixedStartup),
    /startupPresentsPerMeasuredRun is frozen at 1/u,
  );

  const pooled = JSON.parse(JSON.stringify(config));
  pooled.workload.samplePolicy.steadyPresentsPerMeasuredRun = 99;
  assert.throws(
    () => validateFrozenPerformancePolicy(pooled),
    /steadyPresentsPerMeasuredRun is frozen at 100/u,
  );

  const singleReplica = JSON.parse(JSON.stringify(config));
  singleReplica.workload.samplePolicy.replicasPerPlatform = 1;
  assert.throws(
    () => validateFrozenPerformancePolicy(singleReplica),
    /replicasPerPlatform is frozen at 3/u,
  );

  const wrongColdStatistic = JSON.parse(JSON.stringify(config));
  wrongColdStatistic.metrics.coldStartMs.statistic = "p95";
  assert.throws(
    () => validateFrozenPerformancePolicy(wrongColdStatistic),
    /coldStartMs\.statistic is frozen at median/u,
  );
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

test("v3 active baselines bind the complete report set and every raw report byte", () => {
  const directory = temporaryDirectory();
  const config = v3Config();
  const reports = [];
  const reportEntries = [1, 2, 3].map((replica) => {
    const input = v3Report({ replica, tickMs: 9 + replica });
    reports.push(input);
    const fileName = `replica-${replica}.json`;
    const raw = `${JSON.stringify(input, null, 2)}\n`;
    writeFileSync(path.join(directory, fileName), raw);
    return {
      path: fileName,
      rawBytes: Buffer.from(raw),
    };
  });
  const reportSet = createPerformanceReportSet({
    config,
    reportEntries,
    capturedAt: "2026-08-17T01:00:00.000Z",
  });
  writeFileSync(path.join(directory, "report-set.json"), `${JSON.stringify(reportSet, null, 2)}\n`);
  for (const metricName of metricNames) {
    config.platforms["darwin-arm64"].baselines[metricName] = {
      status: "active",
      value: reportSet.summary.metrics[metricName],
      evidence: {
        reportSet: "report-set.json",
        commit: reportSet.commit,
        capturedAt: reportSet.capturedAt,
      },
    };
  }

  assert.doesNotThrow(() => validateActiveBaselineEvidence(config, "darwin-arm64", directory));

  writeFileSync(path.join(directory, "replica-2.json"), `${JSON.stringify(reports[1])}\n`);
  assert.throws(
    () => validateActiveBaselineEvidence(config, "darwin-arm64", directory),
    /SHA-256 does not match/u,
  );
});

test("v3 active metrics cannot splice together different report sets", () => {
  const config = v3Config();
  config.platforms["darwin-arm64"].baselines.tickMs.evidence = {
    reportSet: "other-report-set.json",
    commit: "e".repeat(40),
    capturedAt: "2026-08-17T02:00:00.000Z",
  };

  assert.throws(() => validatePerformanceConfig(config), /must reference one complete report set/u);
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
  const originalTree = measureArtifactTreeSha256(directory);
  writeFileSync(path.join(directory, "nested", "manifest.json"), Buffer.alloc(5, 1));
  assert.notEqual(measureArtifactTreeSha256(directory), originalTree);

  symlinkSync(path.join(directory, "app.bin"), path.join(directory, "nested", "alias"));
  assert.throws(() => measureArtifactBytes(directory), /symbolic links are not artifacts/u);
});

test("the CLI returns distinct pass, regression, and pending exit codes", () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "config.json");
  const config = v3Config();
  const darwinBaselines = config.platforms["darwin-arm64"].baselines;
  const writeRawReports = (prefix, reports) =>
    reports.map((input) => {
      const fileName = `${prefix}-replica-${input.replica}.json`;
      const raw = `${JSON.stringify(input, null, 2)}\n`;
      writeFileSync(path.join(directory, fileName), raw);
      return {
        path: fileName,
        rawBytes: Buffer.from(raw),
      };
    });
  const baselineEntries = writeRawReports(
    "baseline",
    [1, 2, 3].map((replica) => v3Report({ replica, tickMs: 20 })),
  );
  const baselineSet = createPerformanceReportSet({
    config,
    reportEntries: baselineEntries,
    capturedAt: "2026-08-17T01:00:00.000Z",
  });
  writeFileSync(
    path.join(directory, "baseline-set.json"),
    `${JSON.stringify(baselineSet, null, 2)}\n`,
  );
  for (const [metricName, value] of Object.entries(baselineSet.summary.metrics)) {
    darwinBaselines[metricName] = {
      status: "active",
      value,
      evidence: {
        reportSet: "baseline-set.json",
        commit: "d".repeat(40),
        capturedAt: baselineSet.capturedAt,
      },
    };
  }
  writeFileSync(configPath, JSON.stringify(config));

  const aggregate = (prefix, reports) => {
    const entries = writeRawReports(prefix, reports);
    const outputPath = path.join(directory, `${prefix}-set.json`);
    const result = spawnSync(
      process.execPath,
      [
        runnerPath,
        "aggregate",
        "--config",
        configPath,
        ...entries.flatMap((entry) => ["--report", path.join(directory, entry.path)]),
        "--output",
        outputPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return outputPath;
  };
  const passingSetPath = aggregate(
    "passing",
    [1, 2, 3].map((replica) => v3Report({ replica, tickMs: 10 })),
  );

  const passed = spawnSync(
    process.execPath,
    [runnerPath, "check-set", "--config", configPath, "--report-set", passingSetPath, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).status, "pass");

  const regressedSetPath = aggregate(
    "regressed",
    [1, 2, 3].map((replica) => v3Report({ replica, tickMs: 30 })),
  );
  const failed = spawnSync(
    process.execPath,
    [runnerPath, "check-set", "--config", configPath, "--report-set", regressedSetPath, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).status, "regression");

  config.platforms["darwin-arm64"].baselines.paintMs = {
    status: "pending",
    reason: "awaiting hosted capture",
  };
  writeFileSync(configPath, JSON.stringify(config));
  const pending = spawnSync(
    process.execPath,
    [runnerPath, "check-set", "--config", configPath, "--report-set", passingSetPath, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(pending.status, 2, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).status, "pending");
});

test("the performance CLI rejects unknown, duplicate, and malformed options", () => {
  const directory = temporaryDirectory();
  const singleReportPath = path.join(directory, "single-runner.json");
  writeFileSync(singleReportPath, `${JSON.stringify(v3Report(), null, 2)}\n`);
  const singleRunnerGate = spawnSync(
    process.execPath,
    [runnerPath, "check", "--report", singleReportPath, "--allow-pending"],
    { encoding: "utf8" },
  );
  assert.equal(singleRunnerGate.status, 1);
  assert.match(singleRunnerGate.stderr, /complete three-replica report set/u);

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
  const producer = workflow.jobs["candidate-producer"];
  const capture = workflow.jobs["hosted-capture"];
  const aggregate = workflow.jobs["platform-aggregate"];
  const hosted = producer;

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
  assert.doesNotMatch(hostedCommands, /performance-collector\.mjs/u);
  const archiveStep = hosted.steps.find(
    (step) => step.name === "Archive the shared performance candidate",
  );
  assert.equal(archiveStep?.shell, "bash");
  assert.match(
    archiveStep?.run ?? "",
    /if \[\[ "\$\{\{ runner\.os \}\}" == "Windows" \]\]; then[\s\S]*cygpath -u "\$RUNNER_TEMP"/u,
    "the Windows producer must translate RUNNER_TEMP before passing an archive path to tar",
  );
  assert.match(archiveStep?.run ?? "", /archive="\$runner_temp\/performance-candidate-/u);
  const captureCommands = capture.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(captureCommands, /node tools\/performance-collector\.mjs/u);
  assert.match(captureCommands, /performance-budget\.mjs validate-report/u);
  assert.doesNotMatch(captureCommands, /performance-budget\.mjs check-set/u);
  const captureStep = capture.steps.find((step) => step.id === "capture");
  const checkStep = aggregate.steps.find(
    (step) => typeof step.run === "string" && step.run.includes("performance-budget.mjs check-set"),
  );
  assert.match(captureStep?.run ?? "", /performance-collector\.mjs/u);
  assert.doesNotMatch(captureStep?.run ?? "", /performance-budget\.mjs check/u);
  assert.match(
    captureStep?.run ?? "",
    /if \[\[ "\$\{\{ runner\.os \}\}" == "Windows" \]\]; then[\s\S]*cygpath -u "\$RUNNER_TEMP"/u,
    "Windows capture must translate every downloaded, extracted, and report path used by bash",
  );
  assert.match(captureStep?.run ?? "", /archive="\$runner_temp\/performance-candidate-download/u);
  assert.match(captureStep?.run ?? "", /extract="\$runner_temp\/performance-candidate-extract"/u);
  assert.match(captureStep?.run ?? "", /report="\$runner_temp\/nexa-performance-/u);
  assert.notEqual(checkStep, undefined, "the native report must be checked after capture");
  const rawReportUpload = capture.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      /^actions\/upload-artifact@[0-9a-f]{40}$/u.test(step.uses) &&
      typeof step.with?.path === "string" &&
      step.with.path.includes(
        "nexa-performance-${{ matrix.platform }}-replica-${{ matrix.replica }}.json",
      ),
  );
  assert.notEqual(
    rawReportUpload,
    undefined,
    "the complete raw performance report must be uploaded",
  );
  assert.equal(rawReportUpload.if, "${{ always() && steps.capture.outcome == 'success' }}");
  assert.doesNotMatch(source, /tools\/fixtures\/performance/u);
});

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PERFORMANCE_METRICS = Object.freeze([
  "coldStartMs",
  "idleRssBytes",
  "artifactBytes",
  "tickMs",
  "layoutMs",
  "paintMs",
]);
export const FRAME_PERFORMANCE_METRICS = Object.freeze(["tickMs", "layoutMs", "paintMs"]);

const PLATFORM_RUNNERS = Object.freeze({
  "darwin-arm64": "macos-15",
  "win32-x64": "windows-2022",
});
const PLATFORM_ARTIFACTS = Object.freeze({
  "darwin-arm64": {
    name: "reference-notes-macos-arm64",
    executable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
  },
  "win32-x64": {
    name: "reference-notes-windows-x64",
    executable: "NexaNotes.exe",
  },
});
const COLLECTIONS = new Set(["hosted-native", "deterministic-artifact"]);
const STATISTICS = new Set(["median", "p95", "max", "median-of-process-p95"]);
const UNITS = new Set(["ms", "bytes"]);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d*$/u;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`Performance contract: ${message}`);
}

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

function requireNonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a finite non-negative number`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function validateBaseline(baseline, metricName, platformName, schemaVersion) {
  requireObject(baseline, `platforms.${platformName}.baselines.${metricName}`);
  if (baseline.status !== "pending" && baseline.status !== "active") {
    fail(`baseline status for ${platformName}/${metricName} must be pending or active`);
  }
  if (baseline.status === "pending") {
    requireString(baseline.reason, `platforms.${platformName}.baselines.${metricName}.reason`);
    if ("value" in baseline || "evidence" in baseline) {
      fail(`pending baseline for ${platformName}/${metricName} cannot contain value or evidence`);
    }
    return;
  }

  requireNonNegativeNumber(
    baseline.value,
    `platforms.${platformName}.baselines.${metricName}.value`,
  );
  const evidence = requireObject(
    baseline.evidence,
    `platforms.${platformName}.baselines.${metricName}.evidence`,
  );
  if (schemaVersion === 2) {
    assertExactKeys(evidence, ["reportSet", "commit", "capturedAt"], "baseline evidence");
    requireString(evidence.reportSet, "baseline evidence.reportSet");
  } else {
    requireString(evidence.report, "baseline evidence.report");
  }
  if (!COMMIT_PATTERN.test(evidence.commit))
    fail("baseline evidence.commit must be a 40-character SHA");
  requireString(evidence.capturedAt, "baseline evidence.capturedAt");
  if (
    !ISO_DATE_PATTERN.test(evidence.capturedAt) ||
    Number.isNaN(Date.parse(evidence.capturedAt))
  ) {
    fail("baseline evidence.capturedAt must be an ISO timestamp");
  }
}

function resolveEvidenceReportPath(evidenceRoot, reportPath, label) {
  requireString(reportPath, `${label}.report`);
  if (
    path.isAbsolute(reportPath) ||
    reportPath.includes("\\") ||
    /^[A-Za-z]:/u.test(reportPath) ||
    reportPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${label}.report must be a repository-relative regular-file path`);
  }

  const root = path.resolve(evidenceRoot);
  let current = root;
  const segments = reportPath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      fail(`${label}.report does not point to an existing regular file: ${error.message}`);
    }
    if (entry.isSymbolicLink()) fail(`${label}.report must not point to a symbolic link`);
    if (index < segments.length - 1 && !entry.isDirectory()) {
      fail(`${label}.report parent entries must be directories`);
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      fail(`${label}.report must point to a regular file`);
    }
  }
  return current;
}

/** Verify that active baselines are backed by the exact raw report they claim. */
export function validateActiveBaselineEvidence(config, platformName, evidenceRoot = process.cwd()) {
  const platformNames = platformName ? [platformName] : Object.keys(config.platforms);
  const reportSetCache = new Map();
  for (const currentPlatformName of platformNames) {
    const platform = config.platforms[currentPlatformName];
    if (!platform) fail(`unknown platform: ${currentPlatformName}`);
    for (const metricName of PERFORMANCE_METRICS) {
      const baseline = platform.baselines[metricName];
      if (baseline.status !== "active") continue;
      const evidence = baseline.evidence;
      const label = `platforms.${currentPlatformName}.baselines.${metricName}.evidence`;
      if (config.schemaVersion === 2) {
        const reportSetPath = resolveEvidenceReportPath(evidenceRoot, evidence.reportSet, label);
        let loaded = reportSetCache.get(reportSetPath);
        if (!loaded) {
          loaded = loadPerformanceReportSetFile(reportSetPath, config);
          reportSetCache.set(reportSetPath, loaded);
        }
        const { reportSet, reportEntries } = loaded;
        if (reportSet.platform !== currentPlatformName) {
          fail(`${label}.reportSet platform does not match ${currentPlatformName}`);
        }
        if (reportSet.commit !== evidence.commit) {
          fail(`${label}.commit does not match report set commit`);
        }
        if (reportSet.capturedAt !== evidence.capturedAt) {
          fail(`${label}.capturedAt does not match report set capturedAt`);
        }
        const result = evaluatePerformanceReportSet(reportSet, config, { reportEntries });
        if (result.metrics[metricName].observed !== baseline.value) {
          fail(`${label}.reportSet statistic for ${metricName} does not match baseline.value`);
        }
        continue;
      }
      const reportPath = resolveEvidenceReportPath(evidenceRoot, evidence.report, label);
      const report = readJson(reportPath);
      validatePerformanceReport(report, config);
      if (report.platform !== currentPlatformName) {
        fail(`${label}.report platform does not match ${currentPlatformName}`);
      }
      if (report.commit !== evidence.commit) fail(`${label}.commit does not match report.commit`);
      if (report.capturedAt !== evidence.capturedAt) {
        fail(`${label}.capturedAt does not match report.capturedAt`);
      }
      const observed = summarizeSamples(
        report.samples[metricName],
        config.metrics[metricName].statistic,
      );
      if (observed !== baseline.value) {
        fail(`${label}.report statistic for ${metricName} does not match baseline.value`);
      }
    }
  }
}

/** Validate the checked-in release performance contract. */
export function validatePerformanceConfig(
  config,
  { verifyActiveEvidence = false, platformName, evidenceRoot = process.cwd() } = {},
) {
  requireObject(config, "config");
  if (config.schemaVersion !== 1 && config.schemaVersion !== 2) {
    fail("schemaVersion must be 1 or 2");
  }

  const workload = requireObject(config.workload, "workload");
  requireString(workload.id, "workload.id");
  requireString(workload.definition, "workload.definition");
  const samplePolicy = requireObject(workload.samplePolicy, "workload.samplePolicy");
  if (!Number.isSafeInteger(samplePolicy.warmupRuns) || samplePolicy.warmupRuns < 0) {
    fail("workload.samplePolicy.warmupRuns must be a non-negative integer");
  }
  requirePositiveInteger(samplePolicy.measuredRuns, "workload.samplePolicy.measuredRuns");
  requirePositiveInteger(
    samplePolicy.startupPresentsPerMeasuredRun,
    "workload.samplePolicy.startupPresentsPerMeasuredRun",
  );
  if (config.schemaVersion === 2) {
    requirePositiveInteger(
      samplePolicy.steadyPresentsPerMeasuredRun,
      "workload.samplePolicy.steadyPresentsPerMeasuredRun",
    );
    requirePositiveInteger(
      samplePolicy.replicasPerPlatform,
      "workload.samplePolicy.replicasPerPlatform",
    );
  }

  const metrics = requireObject(config.metrics, "metrics");
  assertExactKeys(metrics, PERFORMANCE_METRICS, "metrics");
  for (const metricName of PERFORMANCE_METRICS) {
    const metric = requireObject(metrics[metricName], `metrics.${metricName}`);
    if (!UNITS.has(metric.unit)) fail(`metrics.${metricName}.unit is unsupported`);
    if (!COLLECTIONS.has(metric.collection))
      fail(`metrics.${metricName}.collection is unsupported`);
    if (!STATISTICS.has(metric.statistic)) fail(`metrics.${metricName}.statistic is unsupported`);
    requirePositiveInteger(metric.minimumSamples, `metrics.${metricName}.minimumSamples`);
    requireNonNegativeNumber(
      metric.maxRegressionPercent,
      `metrics.${metricName}.maxRegressionPercent`,
    );
    if (metric.collection === "deterministic-artifact" && metricName !== "artifactBytes") {
      fail(`only artifactBytes may use deterministic-artifact collection`);
    }
    if (metric.collection === "hosted-native" && metricName === "artifactBytes") {
      fail("artifactBytes must use deterministic-artifact collection");
    }
  }

  const platforms = requireObject(config.platforms, "platforms");
  assertExactKeys(platforms, Object.keys(PLATFORM_RUNNERS), "platforms");
  for (const [platformName, platform] of Object.entries(platforms)) {
    requireObject(platform, `platforms.${platformName}`);
    if (platform.runner !== PLATFORM_RUNNERS[platformName]) {
      fail(`platforms.${platformName}.runner must be ${PLATFORM_RUNNERS[platformName]}`);
    }
    const baselines = requireObject(platform.baselines, `platforms.${platformName}.baselines`);
    assertExactKeys(baselines, PERFORMANCE_METRICS, `platforms.${platformName}.baselines`);
    for (const metricName of PERFORMANCE_METRICS) {
      validateBaseline(baselines[metricName], metricName, platformName, config.schemaVersion);
    }
    if (config.schemaVersion === 2) {
      const activeEvidence = PERFORMANCE_METRICS.filter(
        (metricName) => baselines[metricName].status === "active",
      ).map((metricName) => baselines[metricName].evidence);
      const expectedEvidence = activeEvidence[0];
      if (activeEvidence.some((evidence) => !sameValue(evidence, expectedEvidence))) {
        fail(`active baselines for ${platformName} must reference one complete report set`);
      }
    }
  }
  if (verifyActiveEvidence) validateActiveBaselineEvidence(config, platformName, evidenceRoot);
  return config;
}

/** Enforce the production sampling policy; unit tests may use smaller fixtures. */
export function validateFrozenPerformancePolicy(config) {
  validatePerformanceConfig(config);
  if (config.schemaVersion !== 2)
    fail("production performance config schemaVersion is frozen at 2");
  if (config.workload.id !== "reference-notes-v3") {
    fail("production workload is frozen at reference-notes-v3");
  }
  if (config.workload.samplePolicy.warmupRuns !== 3) {
    fail("workload.samplePolicy.warmupRuns is frozen at 3 for production capture");
  }
  if (config.workload.samplePolicy.measuredRuns !== 10) {
    fail("workload.samplePolicy.measuredRuns is frozen at 10 for production capture");
  }
  if (config.workload.samplePolicy.startupPresentsPerMeasuredRun !== 1) {
    fail(
      "workload.samplePolicy.startupPresentsPerMeasuredRun is frozen at 1 for production capture",
    );
  }
  if (config.workload.samplePolicy.steadyPresentsPerMeasuredRun !== 100) {
    fail("workload.samplePolicy.steadyPresentsPerMeasuredRun is frozen at 100");
  }
  if (config.workload.samplePolicy.replicasPerPlatform !== 3) {
    fail("workload.samplePolicy.replicasPerPlatform is frozen at 3");
  }
  const expectedStatistics = {
    coldStartMs: "median",
    idleRssBytes: "median",
    artifactBytes: "max",
    tickMs: "median-of-process-p95",
    layoutMs: "median-of-process-p95",
    paintMs: "median-of-process-p95",
  };
  for (const metricName of PERFORMANCE_METRICS) {
    if (config.metrics[metricName].statistic !== expectedStatistics[metricName]) {
      fail(`metrics.${metricName}.statistic is frozen at ${expectedStatistics[metricName]}`);
    }
  }
  for (const metricName of PERFORMANCE_METRICS) {
    const expected =
      metricName === "artifactBytes"
        ? 1
        : ["tickMs", "layoutMs", "paintMs"].includes(metricName)
          ? 1_000
          : 10;
    if (config.metrics[metricName].minimumSamples !== expected) {
      fail(`metrics.${metricName}.minimumSamples is frozen at ${expected} for production capture`);
    }
  }
  return config;
}

function validateCommonPerformanceReport(report, config) {
  if (report.workload !== config.workload.id) fail("report.workload does not match config");
  requireString(report.platform, "report.platform");
  const platform = config.platforms[report.platform];
  if (!platform) fail(`report.platform is unsupported: ${report.platform}`);
  if (!COMMIT_PATTERN.test(report.commit)) fail("report.commit must be a 40-character SHA");
  requireString(report.capturedAt, "report.capturedAt");
  if (!ISO_DATE_PATTERN.test(report.capturedAt) || Number.isNaN(Date.parse(report.capturedAt))) {
    fail("report.capturedAt must be an ISO timestamp");
  }
  const runner = requireObject(report.runner, "report.runner");
  requireString(runner.provider, "report.runner.provider");
  requireString(runner.image, "report.runner.image");
  if (runner.image !== platform.runner) fail("report.runner.image does not match report.platform");
  if (typeof runner.hosted !== "boolean") fail("report.runner.hosted must be boolean");

  for (const metricName of PERFORMANCE_METRICS) {
    if (config.metrics[metricName].collection === "hosted-native" && !runner.hosted) {
      fail("hosted-native metrics require a hosted runner");
    }
    if (
      config.metrics[metricName].collection === "hosted-native" &&
      runner.provider !== "github-actions"
    ) {
      fail("hosted-native metrics require the github-actions provider");
    }
  }
  return { platform, runner };
}

function validateLegacyPerformanceReport(report, config) {
  validateCommonPerformanceReport(report, config);

  const artifact = requireObject(report.artifact, "report.artifact");
  assertExactKeys(artifact, ["name", "executable", "executableSha256"], "report.artifact");
  const expectedArtifact = PLATFORM_ARTIFACTS[report.platform];
  if (artifact.name !== expectedArtifact.name) {
    fail("report.artifact.name does not match report.platform");
  }
  if (artifact.executable !== expectedArtifact.executable) {
    fail("report.artifact.executable does not match report.platform");
  }
  if (!SHA256_PATTERN.test(artifact.executableSha256)) {
    fail("report.artifact.executableSha256 must be a 64-character lowercase SHA-256");
  }

  const quality = requireObject(report.quality, "report.quality");
  for (const field of ["failedRuns", "droppedFrames"]) {
    if (!Number.isSafeInteger(quality[field]) || quality[field] !== 0) {
      fail(`report.quality.${field} must be zero`);
    }
  }

  const samples = requireObject(report.samples, "report.samples");
  assertExactKeys(samples, PERFORMANCE_METRICS, "report.samples");
  for (const metricName of PERFORMANCE_METRICS) {
    const values = samples[metricName];
    if (!Array.isArray(values) || values.length < config.metrics[metricName].minimumSamples) {
      fail(
        `report.samples.${metricName} must contain at least ${config.metrics[metricName].minimumSamples} values`,
      );
    }
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      fail(`report.samples.${metricName} must contain finite non-negative numbers`);
    }
  }
  return report;
}

function validateDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a 64-character lowercase SHA-256`);
  }
  return value;
}

function validateV3Artifact(artifact, platformName, label = "report.artifact") {
  requireObject(artifact, label);
  assertExactKeys(
    artifact,
    ["name", "executable", "bytes", "executableSha256", "treeSha256", "archiveSha256"],
    label,
  );
  const expectedArtifact = PLATFORM_ARTIFACTS[platformName];
  if (artifact.name !== expectedArtifact.name) fail(`${label}.name does not match report.platform`);
  if (artifact.executable !== expectedArtifact.executable) {
    fail(`${label}.executable does not match report.platform`);
  }
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
    fail(`${label}.bytes must be a non-negative safe integer`);
  }
  validateDigest(artifact.executableSha256, `${label}.executableSha256`);
  validateDigest(artifact.treeSha256, `${label}.treeSha256`);
  validateDigest(artifact.archiveSha256, `${label}.archiveSha256`);
  return artifact;
}

function validateV3PerformanceReport(report, config) {
  assertExactKeys(
    report,
    [
      "schemaVersion",
      "kind",
      "workload",
      "platform",
      "commit",
      "capturedAt",
      "replica",
      "runner",
      "artifact",
      "quality",
      "measuredProcesses",
    ],
    "report",
  );
  if (report.kind !== "performance-runner-report") {
    fail("report.kind must be performance-runner-report");
  }
  const { runner } = validateCommonPerformanceReport(report, config);
  assertExactKeys(runner, ["provider", "image", "hosted", "runId", "runAttempt"], "report.runner");
  requireString(runner.runId, "report.runner.runId");
  if (!POSITIVE_DECIMAL_PATTERN.test(runner.runId)) {
    fail("report.runner.runId must be a canonical positive decimal string");
  }
  requirePositiveInteger(runner.runAttempt, "report.runner.runAttempt");

  const replicas = config.workload.samplePolicy.replicasPerPlatform;
  if (!Number.isSafeInteger(report.replica) || report.replica < 1 || report.replica > replicas) {
    fail(`report.replica must be an integer between 1 and ${replicas}`);
  }
  validateV3Artifact(report.artifact, report.platform);

  const quality = requireObject(report.quality, "report.quality");
  assertExactKeys(quality, ["failedRuns", "droppedFrames"], "report.quality");
  for (const field of ["failedRuns", "droppedFrames"]) {
    if (!Number.isSafeInteger(quality[field]) || quality[field] !== 0) {
      fail(`report.quality.${field} must be zero`);
    }
  }

  const measuredRuns = config.workload.samplePolicy.measuredRuns;
  if (
    !Array.isArray(report.measuredProcesses) ||
    report.measuredProcesses.length !== measuredRuns
  ) {
    fail(`report.measuredProcesses must contain exactly ${measuredRuns} processes`);
  }
  const steadyFrames = config.workload.samplePolicy.steadyPresentsPerMeasuredRun;
  for (const [processIndex, measuredProcess] of report.measuredProcesses.entries()) {
    const label = `report.measuredProcesses[${processIndex}]`;
    requireObject(measuredProcess, label);
    assertExactKeys(measuredProcess, ["index", "coldStartMs", "idleRssBytes", "frames"], label);
    if (measuredProcess.index !== processIndex + 1) {
      fail(`${label}.index must be ${processIndex + 1}`);
    }
    requireNonNegativeNumber(measuredProcess.coldStartMs, `${label}.coldStartMs`);
    requireNonNegativeNumber(measuredProcess.idleRssBytes, `${label}.idleRssBytes`);
    const frames = requireObject(measuredProcess.frames, `${label}.frames`);
    assertExactKeys(frames, FRAME_PERFORMANCE_METRICS, `${label}.frames`);
    for (const metricName of FRAME_PERFORMANCE_METRICS) {
      const values = frames[metricName];
      if (!Array.isArray(values) || values.length !== steadyFrames) {
        fail(`${label}.frames.${metricName} must contain exactly ${steadyFrames} values`);
      }
      if (
        values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)
      ) {
        fail(`${label}.frames.${metricName} must contain finite non-negative numbers`);
      }
    }
  }
  return report;
}

/** Validate a complete raw benchmark report before any statistic is calculated. */
export function validatePerformanceReport(report, config) {
  validatePerformanceConfig(config);
  requireObject(report, "report");
  if (report.schemaVersion !== config.schemaVersion) {
    fail("report.schemaVersion must exactly match the performance config");
  }
  if (report.schemaVersion === 1) return validateLegacyPerformanceReport(report, config);
  if (report.schemaVersion === 2) return validateV3PerformanceReport(report, config);
  fail("report.schemaVersion is unsupported");
}

function sorted(values) {
  return [...values].sort((left, right) => left - right);
}

/** Return a stable nearest-rank p95, or a midpoint median. */
export function summarizeSamples(values, statistic) {
  if (!Array.isArray(values) || values.length === 0) fail("cannot summarize an empty sample set");
  const ordered = sorted(values);
  if (statistic === "max") return ordered[ordered.length - 1];
  if (statistic === "median") {
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  }
  if (statistic === "p95") {
    const rank = Math.max(1, Math.ceil(ordered.length * 0.95));
    return ordered[rank - 1];
  }
  fail(`unsupported statistic: ${statistic}`);
}

/** Summarize one hosted runner without discarding measured-process boundaries. */
export function summarizePerformanceReport(report, config) {
  validatePerformanceReport(report, config);
  if (report.schemaVersion === 1) {
    return Object.fromEntries(
      PERFORMANCE_METRICS.map((metricName) => [
        metricName,
        summarizeSamples(report.samples[metricName], config.metrics[metricName].statistic),
      ]),
    );
  }

  const summary = {
    coldStartMs: summarizeSamples(
      report.measuredProcesses.map((processReport) => processReport.coldStartMs),
      "median",
    ),
    idleRssBytes: summarizeSamples(
      report.measuredProcesses.map((processReport) => processReport.idleRssBytes),
      "median",
    ),
    artifactBytes: report.artifact.bytes,
  };
  for (const metricName of FRAME_PERFORMANCE_METRICS) {
    const processP95 = report.measuredProcesses.map((processReport) =>
      summarizeSamples(processReport.frames[metricName], "p95"),
    );
    summary[metricName] = summarizeSamples(processP95, "median");
  }
  return summary;
}

function normalizeReportEntry(entry, label) {
  requireObject(entry, label);
  assertExactKeys(entry, ["path", "rawBytes"], label);
  requireString(entry.path, `${label}.path`);
  if (
    path.isAbsolute(entry.path) ||
    entry.path.includes("\\") ||
    /^[A-Za-z]:/u.test(entry.path) ||
    entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${label}.path must be a normalized relative path`);
  }
  if (!Buffer.isBuffer(entry.rawBytes) && !(entry.rawBytes instanceof Uint8Array)) {
    fail(`${label}.rawBytes must be a Buffer or Uint8Array`);
  }
  const rawBytes = Buffer.from(entry.rawBytes);
  let report;
  try {
    report = JSON.parse(rawBytes.toString("utf8"));
  } catch (error) {
    fail(`${label}.rawBytes must contain valid JSON: ${error.message}`);
  }
  return {
    path: entry.path,
    sha256: createHash("sha256").update(rawBytes).digest("hex"),
    report,
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireSharedIdentity(reports, field, label) {
  const expected = reports[0][field];
  for (const report of reports.slice(1)) {
    if (!sameValue(report[field], expected)) fail(`report set ${label} must match across replicas`);
  }
  return expected;
}

/** Build a manifest that binds three complete raw reports and their exact bytes. */
export function createPerformanceReportSet({
  config,
  reportEntries,
  capturedAt = new Date().toISOString(),
}) {
  validateFrozenPerformancePolicy(config);
  if (!ISO_DATE_PATTERN.test(capturedAt) || Number.isNaN(Date.parse(capturedAt))) {
    fail("report set capturedAt must be an ISO timestamp");
  }
  const expectedReplicas = config.workload.samplePolicy.replicasPerPlatform;
  if (!Array.isArray(reportEntries) || reportEntries.length !== expectedReplicas) {
    fail(`report set requires exactly ${expectedReplicas} reports`);
  }
  const entries = reportEntries.map((entry, index) =>
    normalizeReportEntry(entry, `reportEntries[${index}]`),
  );
  for (const entry of entries) validatePerformanceReport(entry.report, config);
  const sortedEntries = [...entries].sort(
    (left, right) => left.report.replica - right.report.replica,
  );
  const replicas = sortedEntries.map((entry) => entry.report.replica);
  const wantedReplicas = Array.from({ length: expectedReplicas }, (_, index) => index + 1);
  if (!sameValue(replicas, wantedReplicas)) {
    fail(`report set replica identities must be exactly ${wantedReplicas.join(", ")}`);
  }
  if (new Set(sortedEntries.map((entry) => entry.path)).size !== expectedReplicas) {
    fail("report set paths must be unique");
  }
  if (new Set(sortedEntries.map((entry) => entry.sha256)).size !== expectedReplicas) {
    fail("report set raw report SHA-256 values must be unique");
  }

  const reports = sortedEntries.map((entry) => entry.report);
  const workload = requireSharedIdentity(reports, "workload", "workload");
  const platform = requireSharedIdentity(reports, "platform", "platform");
  const commit = requireSharedIdentity(reports, "commit", "commit");
  const runner = reports[0].runner;
  for (const field of ["provider", "image", "hosted", "runId", "runAttempt"]) {
    for (const report of reports.slice(1)) {
      if (!sameValue(report.runner[field], runner[field])) {
        fail(`report set runner.${field} must match across replicas`);
      }
    }
  }
  const artifact = requireSharedIdentity(reports, "artifact", "artifact identity");
  const runnerSummaries = sortedEntries.map((entry) => ({
    replica: entry.report.replica,
    metrics: summarizePerformanceReport(entry.report, config),
  }));
  const metrics = Object.fromEntries(
    PERFORMANCE_METRICS.map((metricName) => [
      metricName,
      summarizeSamples(
        runnerSummaries.map((runnerSummary) => runnerSummary.metrics[metricName]),
        "median",
      ),
    ]),
  );

  return {
    schemaVersion: 1,
    kind: "performance-report-set",
    workload,
    platform,
    commit,
    capturedAt,
    runner,
    artifact,
    reports: sortedEntries.map((entry) => ({
      replica: entry.report.replica,
      path: entry.path,
      sha256: entry.sha256,
      capturedAt: entry.report.capturedAt,
    })),
    summary: {
      method: "median-of-three-runner-summaries",
      runners: runnerSummaries,
      metrics,
    },
  };
}

/** Recompute and validate every field in a report-set manifest. */
export function validatePerformanceReportSet(reportSet, config, { reportEntries } = {}) {
  requireObject(reportSet, "report set");
  assertExactKeys(
    reportSet,
    [
      "schemaVersion",
      "kind",
      "workload",
      "platform",
      "commit",
      "capturedAt",
      "runner",
      "artifact",
      "reports",
      "summary",
    ],
    "report set",
  );
  if (reportSet.schemaVersion !== 1) fail("report set schemaVersion must be 1");
  if (reportSet.kind !== "performance-report-set") {
    fail("report set kind must be performance-report-set");
  }
  const expected = createPerformanceReportSet({
    config,
    reportEntries,
    capturedAt: reportSet.capturedAt,
  });
  if (!sameValue(reportSet, expected)) fail("report set does not match its complete raw reports");
  return reportSet;
}

function evaluateObservedMetrics({ workload, platform, commit, observedMetrics }, config) {
  const platformConfig = config.platforms[platform];
  const metrics = {};
  let hasPending = false;
  let hasRegression = false;

  for (const metricName of PERFORMANCE_METRICS) {
    const definition = config.metrics[metricName];
    const baseline = platformConfig.baselines[metricName];
    const observed = observedMetrics[metricName];
    if (baseline.status === "pending") {
      hasPending = true;
      metrics[metricName] = {
        status: "pending",
        observed,
        baseline: null,
        limit: null,
        reason: baseline.reason,
      };
      continue;
    }
    const limit = baseline.value * (1 + definition.maxRegressionPercent / 100);
    const status = observed <= limit ? "pass" : "regression";
    if (status === "regression") hasRegression = true;
    metrics[metricName] = {
      status,
      observed,
      baseline: baseline.value,
      limit,
      regressionPercent: baseline.value === 0 ? null : (observed / baseline.value - 1) * 100,
    };
  }
  return {
    status: hasRegression ? "regression" : hasPending ? "pending" : "pass",
    workload,
    platform,
    commit,
    metrics,
  };
}

/** Evaluate only a complete three-runner platform report set as the release gate. */
export function evaluatePerformanceReportSet(reportSet, config, { reportEntries } = {}) {
  validatePerformanceReportSet(reportSet, config, { reportEntries });
  return evaluateObservedMetrics(
    {
      workload: reportSet.workload,
      platform: reportSet.platform,
      commit: reportSet.commit,
      observedMetrics: reportSet.summary.metrics,
    },
    config,
  );
}

/** Compare a report against the platform baselines and regression allowances. */
export function evaluatePerformanceReport(report, config) {
  validatePerformanceReport(report, config);
  if (report.schemaVersion !== 1) {
    fail("schemaVersion 2 budgets require a complete three-replica report set");
  }
  return evaluateObservedMetrics(
    {
      workload: report.workload,
      platform: report.platform,
      commit: report.commit,
      observedMetrics: summarizePerformanceReport(report, config),
    },
    config,
  );
}

function rejectUnsupportedEntry(entryPath, type) {
  fail(`${type} are not artifacts: ${entryPath}`);
}

/** Count regular-file bytes without following links or depending on directory order. */
export function measureArtifactBytes(artifactPath) {
  const root = path.resolve(artifactPath);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) rejectUnsupportedEntry(root, "symbolic links");
  if (rootStat.isFile()) return rootStat.size;
  if (!rootStat.isDirectory()) rejectUnsupportedEntry(root, "special files");

  let total = 0;
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const entryStat = lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) rejectUnsupportedEntry(entryPath, "symbolic links");
      if (entryStat.isDirectory()) {
        visit(entryPath);
      } else if (entryStat.isFile()) {
        total += entryStat.size;
        if (!Number.isSafeInteger(total))
          fail("artifact byte total exceeds JavaScript safe integer range");
      } else {
        rejectUnsupportedEntry(entryPath, "special files");
      }
    }
  };
  visit(root);
  return total;
}

/** Hash sorted relative paths and file contents to bind the complete unpacked candidate tree. */
export function measureArtifactTreeSha256(artifactPath) {
  const root = path.resolve(artifactPath);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) rejectUnsupportedEntry(root, "symbolic links");
  if (!rootStat.isDirectory()) fail("artifact tree hash requires a directory");
  const hash = createHash("sha256");
  hash.update("nexa-performance-artifact-tree-v1\0");
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const entryStat = lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) rejectUnsupportedEntry(entryPath, "symbolic links");
      if (entryStat.isDirectory()) {
        visit(entryPath);
      } else if (entryStat.isFile()) {
        const relative = path.relative(root, entryPath).split(path.sep).join("/");
        const contents = readFileSync(entryPath);
        hash.update(
          `${Buffer.byteLength(relative, "utf8")}:${relative}:${contents.length}:`,
          "utf8",
        );
        hash.update(contents);
      } else {
        rejectUnsupportedEntry(entryPath, "special files");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read JSON ${filePath}: ${error.message}`, { cause: error });
  }
}

function loadPerformanceReportSetFile(reportSetPath, config) {
  const resolvedSetPath = path.resolve(reportSetPath);
  const reportSet = readJson(resolvedSetPath);
  if (!Array.isArray(reportSet.reports)) fail("report set reports must be an array");
  const expectedReplicas = config.workload.samplePolicy.replicasPerPlatform;
  if (reportSet.reports.length !== expectedReplicas) {
    fail(`report set requires exactly ${expectedReplicas} reports`);
  }
  const reportEntries = reportSet.reports.map((descriptor, index) => {
    requireObject(descriptor, `report set reports[${index}]`);
    const rawPath = resolveEvidenceReportPath(
      path.dirname(resolvedSetPath),
      descriptor.path,
      `report set reports[${index}]`,
    );
    const rawBytes = readFileSync(rawPath);
    const sha256 = createHash("sha256").update(rawBytes).digest("hex");
    if (sha256 !== descriptor.sha256) {
      fail(`report set reports[${index}] SHA-256 does not match the raw report`);
    }
    return { path: descriptor.path, rawBytes };
  });
  validatePerformanceReportSet(reportSet, config, { reportEntries });
  return { reportSet, reportEntries };
}

function usage() {
  return [
    "Usage:",
    "  node tools/performance-budget.mjs validate [--config FILE]",
    "  node tools/performance-budget.mjs status --platform PLATFORM [--require-active]",
    "  node tools/performance-budget.mjs validate-report --report FILE [--config FILE] [--json]",
    "  node tools/performance-budget.mjs aggregate --report FILE --report FILE --report FILE --output FILE [--config FILE] [--json]",
    "  node tools/performance-budget.mjs check-set --report-set FILE [--config FILE] [--allow-pending] [--json]",
    "  node tools/performance-budget.mjs artifact --path FILE_OR_DIR --platform PLATFORM [--output FILE]",
  ].join("\n");
}

const COMMAND_OPTIONS = Object.freeze({
  validate: Object.freeze({ "--config": "value", "--json": "flag" }),
  status: Object.freeze({
    "--config": "value",
    "--platform": "value",
    "--require-active": "flag",
    "--json": "flag",
  }),
  "validate-report": Object.freeze({
    "--config": "value",
    "--report": "value",
    "--json": "flag",
  }),
  aggregate: Object.freeze({
    "--config": "value",
    "--report": "many",
    "--output": "value",
    "--json": "flag",
  }),
  "check-set": Object.freeze({
    "--config": "value",
    "--report-set": "value",
    "--allow-pending": "flag",
    "--json": "flag",
  }),
  check: Object.freeze({
    "--config": "value",
    "--report": "value",
    "--allow-pending": "flag",
    "--json": "flag",
  }),
  artifact: Object.freeze({
    "--config": "value",
    "--path": "value",
    "--platform": "value",
    "--output": "value",
    "--json": "flag",
  }),
});

function parseOptions(command, argv) {
  const specs = COMMAND_OPTIONS[command];
  if (!specs) throw new Error(`unknown command: ${command}`);
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const kind = specs[option];
    if (!kind) throw new Error(`unknown option for ${command}: ${option}`);
    if (option in options && kind !== "many") throw new Error(`duplicate option: ${option}`);
    if (kind === "flag") {
      if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        throw new Error(`${option} does not accept a value`);
      }
      options[option] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (kind === "many") {
      (options[option] ??= []).push(value);
    } else {
      options[option] = value;
    }
    index += 1;
  }
  return options;
}

function defaultConfigPath() {
  return fileURLToPath(new URL("../release/performance-budgets.json", import.meta.url));
}

function printJsonOrText(value, json) {
  const output = json || typeof value !== "string" ? JSON.stringify(value, null, 2) : value;
  process.stdout.write(`${output}\n`);
}

function statusCommand(config, platformName, requireActive, json) {
  const platform = config.platforms[platformName];
  if (!platform) fail(`unknown platform: ${platformName}`);
  const pending = PERFORMANCE_METRICS.filter(
    (metricName) => platform.baselines[metricName].status === "pending",
  );
  const result = {
    platform: platformName,
    runner: platform.runner,
    status: pending.length === 0 ? "active" : "pending",
    pending,
  };
  printJsonOrText(result, json);
  if (requireActive && pending.length > 0) return 2;
  return 0;
}

function evidenceRootForConfig(configPath) {
  const directory = path.dirname(path.resolve(configPath));
  return path.basename(directory) === "release" ? path.dirname(directory) : directory;
}

/** CLI entry point, exported for contract tests and embedding by workflows. */
export function main(argv = process.argv.slice(2)) {
  try {
    const command = argv[0];
    if (!command || command === "--help" || command === "-h") {
      process.stdout.write(`${usage()}\n`);
      return command ? 0 : 1;
    }
    const options = parseOptions(command, argv);
    const configPath = options["--config"] ?? defaultConfigPath();
    const config = readJson(configPath);
    validatePerformanceConfig(config);
    const evidenceRoot = evidenceRootForConfig(configPath);

    if (command === "validate") {
      validateFrozenPerformancePolicy(config);
      printJsonOrText(
        { status: "valid", config: path.relative(process.cwd(), configPath) },
        options["--json"] === true,
      );
      return 0;
    }
    if (command === "status") {
      validateFrozenPerformancePolicy(config);
      validatePerformanceConfig(config, {
        verifyActiveEvidence: true,
        evidenceRoot,
      });
      return statusCommand(
        config,
        options["--platform"],
        options["--require-active"] === true,
        options["--json"] === true,
      );
    }
    if (command === "validate-report") {
      validateFrozenPerformancePolicy(config);
      const reportPath = options["--report"];
      if (!reportPath) throw new Error("validate-report requires --report");
      const report = readJson(reportPath);
      validatePerformanceReport(report, config);
      const result = {
        status: "valid",
        workload: report.workload,
        platform: report.platform,
        commit: report.commit,
        replica: report.replica,
        metrics: summarizePerformanceReport(report, config),
      };
      printJsonOrText(result, options["--json"] === true);
      return 0;
    }
    if (command === "aggregate") {
      validateFrozenPerformancePolicy(config);
      const reportPaths = options["--report"];
      const outputPath = options["--output"];
      const expectedReplicas = config.workload.samplePolicy.replicasPerPlatform;
      if (!Array.isArray(reportPaths) || reportPaths.length !== expectedReplicas || !outputPath) {
        throw new Error(
          `aggregate requires exactly ${expectedReplicas} --report values and --output`,
        );
      }
      const outputDirectory = path.dirname(path.resolve(outputPath));
      const reportEntries = reportPaths.map((reportPath) => {
        const resolvedReportPath = path.resolve(reportPath);
        const relative = path
          .relative(outputDirectory, resolvedReportPath)
          .split(path.sep)
          .join("/");
        const rawBytes = readFileSync(resolvedReportPath);
        return {
          path: relative,
          rawBytes,
        };
      });
      const reportSet = createPerformanceReportSet({ config, reportEntries });
      writeFileSync(outputPath, `${JSON.stringify(reportSet, null, 2)}\n`, { flag: "wx" });
      printJsonOrText(reportSet, options["--json"] === true);
      return 0;
    }
    if (command === "check-set") {
      validateFrozenPerformancePolicy(config);
      const reportSetPath = options["--report-set"];
      if (!reportSetPath) throw new Error("check-set requires --report-set");
      const { reportSet, reportEntries } = loadPerformanceReportSetFile(reportSetPath, config);
      validatePerformanceConfig(config, {
        verifyActiveEvidence: true,
        platformName: reportSet.platform,
        evidenceRoot,
      });
      const result = evaluatePerformanceReportSet(reportSet, config, { reportEntries });
      printJsonOrText(result, options["--json"] === true);
      if (result.status === "regression") return 1;
      if (result.status === "pending" && options["--allow-pending"] !== true) return 2;
      return 0;
    }
    if (command === "check") {
      const reportPath = options["--report"];
      if (!reportPath) throw new Error("check requires --report");
      validateFrozenPerformancePolicy(config);
      const input = readJson(reportPath);
      validatePerformanceConfig(config, {
        verifyActiveEvidence: true,
        platformName: input.platform,
        evidenceRoot,
      });
      const result = evaluatePerformanceReport(input, config);
      printJsonOrText(result, options["--json"] === true);
      if (result.status === "regression") return 1;
      if (result.status === "pending" && options["--allow-pending"] !== true) return 2;
      return 0;
    }
    if (command === "artifact") {
      validateFrozenPerformancePolicy(config);
      const artifactPath = options["--path"];
      const platformName = options["--platform"];
      if (!artifactPath || !platformName)
        throw new Error("artifact requires --path and --platform");
      if (!config.platforms[platformName]) fail(`unknown platform: ${platformName}`);
      const result = {
        schemaVersion: 1,
        workload: config.workload.id,
        platform: platformName,
        metric: "artifactBytes",
        collection: "deterministic-artifact",
        path: path.normalize(artifactPath).split(path.sep).join("/"),
        bytes: measureArtifactBytes(artifactPath),
      };
      const outputPath = options["--output"];
      if (outputPath) writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
      printJsonOrText(result, options["--json"] === true || !outputPath);
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = main();

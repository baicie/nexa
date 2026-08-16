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
const STATISTICS = new Set(["median", "p95", "max"]);
const UNITS = new Set(["ms", "bytes"]);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T/u;

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

function validateBaseline(baseline, metricName, platformName) {
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
  requireString(evidence.report, "baseline evidence.report");
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
  for (const currentPlatformName of platformNames) {
    const platform = config.platforms[currentPlatformName];
    if (!platform) fail(`unknown platform: ${currentPlatformName}`);
    for (const metricName of PERFORMANCE_METRICS) {
      const baseline = platform.baselines[metricName];
      if (baseline.status !== "active") continue;
      const evidence = baseline.evidence;
      const label = `platforms.${currentPlatformName}.baselines.${metricName}.evidence`;
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
  if (config.schemaVersion !== 1) fail("schemaVersion must be 1");

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
      validateBaseline(baselines[metricName], metricName, platformName);
    }
  }
  if (verifyActiveEvidence) validateActiveBaselineEvidence(config, platformName, evidenceRoot);
  return config;
}

/** Enforce the production sampling policy; unit tests may use smaller fixtures. */
export function validateFrozenPerformancePolicy(config) {
  validatePerformanceConfig(config);
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
  for (const metricName of PERFORMANCE_METRICS) {
    const expected =
      metricName === "artifactBytes"
        ? 1
        : ["tickMs", "layoutMs", "paintMs"].includes(metricName)
          ? 100
          : 10;
    if (config.metrics[metricName].minimumSamples !== expected) {
      fail(`metrics.${metricName}.minimumSamples is frozen at ${expected} for production capture`);
    }
  }
  return config;
}

/** Validate a complete raw benchmark report before any statistic is calculated. */
export function validatePerformanceReport(report, config) {
  validatePerformanceConfig(config);
  requireObject(report, "report");
  if (report.schemaVersion !== 1) fail("report.schemaVersion must be 1");
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
  return report;
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

/** Compare a report against the platform baselines and regression allowances. */
export function evaluatePerformanceReport(report, config) {
  validatePerformanceReport(report, config);
  const platform = config.platforms[report.platform];
  const metrics = {};
  let hasPending = false;
  let hasRegression = false;

  for (const metricName of PERFORMANCE_METRICS) {
    const definition = config.metrics[metricName];
    const baseline = platform.baselines[metricName];
    const observed = summarizeSamples(report.samples[metricName], definition.statistic);
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
    workload: report.workload,
    platform: report.platform,
    commit: report.commit,
    metrics,
  };
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

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read JSON ${filePath}: ${error.message}`, { cause: error });
  }
}

function usage() {
  return [
    "Usage:",
    "  node tools/performance-budget.mjs validate [--config FILE]",
    "  node tools/performance-budget.mjs status --platform PLATFORM [--require-active]",
    "  node tools/performance-budget.mjs check --report FILE [--config FILE] [--allow-pending] [--json]",
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
    if (option in options) throw new Error(`duplicate option: ${option}`);
    if (kind === "flag") {
      if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        throw new Error(`${option} does not accept a value`);
      }
      options[option] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options[option] = value;
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

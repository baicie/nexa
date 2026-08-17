import { spawn as spawnProcess, spawnSync as spawnSyncProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  measureArtifactBytes,
  measureArtifactTreeSha256,
  validateFrozenPerformancePolicy,
  validatePerformanceReport,
} from "./performance-budget.mjs";

export const NATIVE_EVENT_PREFIX = "NEXA_PERFORMANCE_EVENT ";
export const SETTLE_WINDOW_MS = 5_000;
const RUN_TIMEOUT_MS = 45_000;
const RSS_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 2_000;
const TERMINATION_TIMEOUT_MS = 5_000;
const STDERR_LIMIT = 8_192;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d*$/u;
const OUTCOMES = new Set(["noPresentRequested", "coalesced", "presented", "dropped"]);
const DROP_STAGES = new Set([
  "acquire",
  "layout",
  "semantics",
  "displayList",
  "paint",
  "present",
  "surface",
]);
const EVENT_KEYS = [
  "schemaVersion",
  "kind",
  "outcome",
  "dropStage",
  "sessionId",
  "tickId",
  "frameId",
  "surfaceGeneration",
  "counts",
  "durationsNs",
];
const COUNT_KEYS = [
  "dispatchedEvents",
  "mutationCommands",
  "commitAttempts",
  "commits",
  "layoutAttempts",
  "layoutNodes",
  "semanticAttempts",
  "semanticDiffs",
  "displayListAttempts",
  "displayCommands",
  "paintAttempts",
  "presentAttempts",
  "successfulPresents",
  "droppedFrames",
];
const DURATION_KEYS = [
  "platformEvents",
  "systemCompletion",
  "frameworkMicrotasks",
  "stateEffects",
  "hostMutationCommit",
  "layout",
  "semantics",
  "displayList",
  "paint",
  "present",
  "deferredCleanup",
];
const PLATFORM_IDENTITIES = Object.freeze({
  "darwin-arm64": { runtimePlatform: "darwin", runtimeArch: "arm64", runner: "macos-15" },
  "win32-x64": { runtimePlatform: "win32", runtimeArch: "x64", runner: "windows-2022" },
});

function fail(message) {
  throw new Error(`Performance collector: ${message}`);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
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

function requireDecimalString(value, label) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    fail(`${label} must be a non-negative decimal string`);
  }
  return value;
}

function requireOptionalDecimalString(value, label) {
  if (value === null) return null;
  return requireDecimalString(value, label);
}

function requireNonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a finite non-negative number`);
  }
  return value;
}

function validateNativeEvent(event) {
  requireObject(event, "native event");
  assertExactKeys(event, EVENT_KEYS, "native event");
  if (event.schemaVersion !== 1) fail("native event schemaVersion must be 1");
  if (event.kind !== "frame") fail("native event kind must be frame");
  if (!OUTCOMES.has(event.outcome)) fail("native event outcome is unsupported");
  if (event.outcome === "dropped") {
    if (!DROP_STAGES.has(event.dropStage)) fail("dropped native event requires a valid dropStage");
  } else if (event.dropStage !== null) {
    fail("non-dropped native event must have a null dropStage");
  }

  for (const key of ["sessionId", "tickId", "frameId", "surfaceGeneration"]) {
    requireOptionalDecimalString(event[key], `native event ${key}`);
  }
  const counts = requireObject(event.counts, "native event counts");
  assertExactKeys(counts, COUNT_KEYS, "native event counts");
  for (const key of COUNT_KEYS) requireDecimalString(counts[key], `native event counts.${key}`);
  const durations = requireObject(event.durationsNs, "native event durationsNs");
  assertExactKeys(durations, DURATION_KEYS, "native event durationsNs");
  for (const key of DURATION_KEYS) {
    requireDecimalString(durations[key], `native event durationsNs.${key}`);
  }

  const droppedFrames = BigInt(counts.droppedFrames);
  const successfulPresents = BigInt(counts.successfulPresents);
  if (event.outcome === "dropped" && (droppedFrames !== 1n || successfulPresents !== 0n)) {
    fail("dropped native event has inconsistent frame counts");
  }
  if (event.outcome === "presented" && (successfulPresents !== 1n || droppedFrames !== 0n)) {
    fail("presented native event has inconsistent frame counts");
  }
  if (
    event.outcome !== "dropped" &&
    event.outcome !== "presented" &&
    (successfulPresents !== 0n || droppedFrames !== 0n)
  ) {
    fail(`${event.outcome} native event has inconsistent frame counts`);
  }
  return event;
}

/** Parse one prefixed native frame line without losing Rust integer precision. */
export function parseNativePerformanceEvent(line) {
  if (typeof line !== "string" || !line.startsWith(NATIVE_EVENT_PREFIX)) {
    fail(`native event line must start with the ${NATIVE_EVENT_PREFIX.trim()} prefix`);
  }
  let event;
  try {
    event = JSON.parse(line.slice(NATIVE_EVENT_PREFIX.length));
  } catch (error) {
    fail(`native event is not valid JSON: ${error.message}`);
  }
  return validateNativeEvent(event);
}

function nanosecondsToMilliseconds(value, label) {
  const nanoseconds = BigInt(requireDecimalString(value, label));
  if (nanoseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${label} exceeds the exact JavaScript conversion range`);
  }
  return Number(nanoseconds) / 1_000_000;
}

/** Derive reportable samples from completed Presented records after the startup boundary. */
export function frameMetricSamples(events, { startupPresents = 0 } = {}) {
  if (!Array.isArray(events)) fail("native events must be an array");
  if (!Number.isSafeInteger(startupPresents) || startupPresents < 0) {
    fail("startup presents must be a non-negative integer");
  }
  const result = {
    tickMs: [],
    layoutMs: [],
    paintMs: [],
    droppedFrames: 0,
    presentedFrames: 0,
  };
  let sessionId;
  let previousFrameId;

  for (const event of events) {
    validateNativeEvent(event);
    if (event.outcome === "dropped") {
      result.droppedFrames += 1;
      continue;
    }
    if (event.outcome !== "presented") continue;
    if (event.sessionId === null || event.frameId === null || event.surfaceGeneration === null) {
      fail("presented native event requires complete session/frame/surface identity");
    }
    if (sessionId === undefined) sessionId = event.sessionId;
    if (event.sessionId !== sessionId) {
      fail("presented native event sessionId must remain stable within one process");
    }
    const frameId = BigInt(event.frameId);
    if (previousFrameId !== undefined && frameId <= previousFrameId) {
      fail("presented native event frameId must be unique and strictly increasing");
    }
    previousFrameId = frameId;
    result.presentedFrames += 1;
    if (result.presentedFrames <= startupPresents) continue;

    let totalNanoseconds = 0n;
    for (const key of DURATION_KEYS) totalNanoseconds += BigInt(event.durationsNs[key]);
    if (totalNanoseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("native event total duration exceeds the exact JavaScript conversion range");
    }
    result.tickMs.push(Number(totalNanoseconds) / 1_000_000);
    result.layoutMs.push(
      nanosecondsToMilliseconds(event.durationsNs.layout, "native event layout duration"),
    );
    result.paintMs.push(
      nanosecondsToMilliseconds(event.durationsNs.paint, "native event paint duration"),
    );
  }
  return result;
}

/** Prove that candidate native samples came from the configured hosted platform. */
export function assertHostedRunner({
  platform,
  runnerImage,
  environment = process.env,
  runtimePlatform = process.platform,
  runtimeArch = process.arch,
}) {
  const identity = PLATFORM_IDENTITIES[platform];
  if (!identity) fail(`unsupported report platform: ${String(platform)}`);
  if (runnerImage !== identity.runner) {
    fail(`runner image for ${platform} must be ${identity.runner}`);
  }
  if (runtimePlatform !== identity.runtimePlatform || runtimeArch !== identity.runtimeArch) {
    fail(
      `runtime platform ${runtimePlatform}-${runtimeArch} does not match report platform ${platform}`,
    );
  }
  if (
    environment?.GITHUB_ACTIONS !== "true" ||
    environment?.RUNNER_ENVIRONMENT !== "github-hosted"
  ) {
    fail("native performance evidence requires a GitHub-hosted runner");
  }
  const runId = environment.GITHUB_RUN_ID;
  if (typeof runId !== "string" || !POSITIVE_DECIMAL_PATTERN.test(runId)) {
    fail("GITHUB_RUN_ID must be a canonical positive decimal string");
  }
  const runAttempt = Number(environment.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    fail("GITHUB_RUN_ATTEMPT must be a positive integer");
  }
  return {
    provider: "github-actions",
    image: runnerImage,
    hosted: true,
    runId,
    runAttempt,
  };
}

function parsePositiveIntegerOutput(result, label) {
  if (result?.error?.code === "ETIMEDOUT") fail(`${label} timed out`);
  if (result?.error) fail(`${label} failed to start: ${result.error.message}`);
  if (result?.status !== 0) {
    fail(`${label} failed: ${String(result?.stderr ?? "").trim() || "non-zero exit"}`);
  }
  const value = String(result.stdout ?? "").trim();
  if (!DECIMAL_PATTERN.test(value)) fail(`${label} returned an invalid value`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    fail(`${label} must be a positive safe integer`);
  return parsed;
}

/** Read one target process resident-set value without a shell or localized table parsing. */
export function readResidentSetBytes({
  platform = process.platform,
  pid,
  spawnSync = spawnSyncProcess,
}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail("RSS process id must be a positive integer");
  const options = {
    encoding: "utf8",
    timeout: RSS_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  };
  if (platform === "darwin") {
    const kibibytes = parsePositiveIntegerOutput(
      spawnSync("ps", ["-o", "rss=", "-p", String(pid)], options),
      "RSS read",
    );
    const bytes = kibibytes * 1024;
    if (!Number.isSafeInteger(bytes)) fail("RSS byte count exceeds the safe integer range");
    return bytes;
  }
  if (platform === "win32") {
    return parsePositiveIntegerOutput(
      spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
        ],
        options,
      ),
      "RSS read",
    );
  }
  fail(`RSS collection is unsupported on ${platform}`);
}

function requireArtifactIdentity({
  artifactName,
  artifactExecutable,
  artifactBytes,
  executableSha256,
  artifactTreeSha256,
  archiveSha256,
}) {
  requireString(artifactName, "artifact name");
  if (artifactName.includes("/") || artifactName.includes("\\") || artifactName === ".") {
    fail("artifact name must be one path segment");
  }
  requireString(artifactExecutable, "artifact executable");
  const segments = artifactExecutable.split("/");
  if (
    artifactExecutable.startsWith("/") ||
    artifactExecutable.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("artifact executable must be a normalized relative path");
  }
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 0) {
    fail("artifact bytes must be a non-negative safe integer");
  }
  if (typeof executableSha256 !== "string" || !SHA256_PATTERN.test(executableSha256)) {
    fail("artifact executableSha256 must be a 64-character lowercase digest");
  }
  if (typeof artifactTreeSha256 !== "string" || !SHA256_PATTERN.test(artifactTreeSha256)) {
    fail("artifact treeSha256 must be a 64-character lowercase digest");
  }
  if (typeof archiveSha256 !== "string" || !SHA256_PATTERN.test(archiveSha256)) {
    fail("artifact archiveSha256 must be a 64-character lowercase digest");
  }
}

/** Assemble and revalidate a complete raw report from measured native runs. */
export function createPerformanceReport({
  config,
  platform,
  commit,
  runnerImage,
  environment = process.env,
  runtimePlatform = process.platform,
  runtimeArch = process.arch,
  artifactName,
  artifactExecutable,
  artifactBytes,
  executableSha256,
  artifactTreeSha256,
  archiveSha256,
  replica,
  runs,
  capturedAt = new Date().toISOString(),
}) {
  validateFrozenPerformancePolicy(config);
  if (!COMMIT_PATTERN.test(commit)) fail("commit must be a 40-character lowercase SHA");
  if (!COMMIT_PATTERN.test(environment?.GITHUB_SHA ?? "")) {
    fail("GITHUB_SHA must be a 40-character lowercase SHA on the hosted runner");
  }
  if (commit !== environment.GITHUB_SHA) {
    fail("commit must match the hosted runner GITHUB_SHA");
  }
  const runner = assertHostedRunner({
    platform,
    runnerImage,
    environment,
    runtimePlatform,
    runtimeArch,
  });
  requireArtifactIdentity({
    artifactName,
    artifactExecutable,
    artifactBytes,
    executableSha256,
    artifactTreeSha256,
    archiveSha256,
  });
  const measuredRuns = config.workload.samplePolicy.measuredRuns;
  if (!Array.isArray(runs) || runs.length !== measuredRuns) {
    fail(`report requires exactly ${measuredRuns} measured runs`);
  }

  const replicas = config.workload.samplePolicy.replicasPerPlatform;
  if (!Number.isSafeInteger(replica) || replica < 1 || replica > replicas) {
    fail(`replica must be an integer between 1 and ${replicas}`);
  }
  const measuredProcesses = [];
  const startupPresents = config.workload.samplePolicy.startupPresentsPerMeasuredRun;
  const steadyFrames = config.workload.samplePolicy.steadyPresentsPerMeasuredRun;
  let droppedFrames = 0;
  for (const [index, run] of runs.entries()) {
    requireObject(run, `measured run ${index + 1}`);
    const frameSamples = frameMetricSamples(run.events, { startupPresents });
    droppedFrames += frameSamples.droppedFrames;
    if (frameSamples.droppedFrames !== 0) {
      fail(
        `measured run ${index + 1} contains ${frameSamples.droppedFrames} dropped frame records`,
      );
    }
    for (const metricName of ["tickMs", "layoutMs", "paintMs"]) {
      if (frameSamples[metricName].length !== steadyFrames) {
        fail(
          `measured run ${index + 1} requires exactly ${steadyFrames} steady presented ${metricName} samples; received ${frameSamples[metricName].length}`,
        );
      }
    }
    measuredProcesses.push({
      index: index + 1,
      coldStartMs: requireNonNegativeNumber(
        run.coldStartMs,
        `measured run ${index + 1} coldStartMs`,
      ),
      idleRssBytes: requireNonNegativeNumber(
        run.idleRssBytes,
        `measured run ${index + 1} idleRssBytes`,
      ),
      frames: {
        tickMs: frameSamples.tickMs,
        layoutMs: frameSamples.layoutMs,
        paintMs: frameSamples.paintMs,
      },
    });
  }
  if (droppedFrames !== 0) fail(`measured runs contain ${droppedFrames} dropped frame records`);

  const report = {
    schemaVersion: 2,
    kind: "performance-runner-report",
    workload: config.workload.id,
    platform,
    commit,
    capturedAt,
    replica,
    runner,
    artifact: {
      name: artifactName,
      executable: artifactExecutable,
      bytes: artifactBytes,
      executableSha256,
      treeSha256: artifactTreeSha256,
      archiveSha256,
    },
    quality: { failedRuns: 0, droppedFrames: 0 },
    measuredProcesses,
  };
  validatePerformanceReport(report, config);
  return report;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForExit(exitPromise, timeoutMs, delay) {
  const timeoutController = new AbortController();
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      delay(timeoutMs, undefined, { signal: timeoutController.signal }).then(() => false),
    ]);
  } finally {
    timeoutController.abort();
  }
}

async function terminateChild(child, exitPromise, delay = wait) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!(await waitForExit(exitPromise, TERMINATION_TIMEOUT_MS, delay))) {
      fail("native benchmark process did not close after exiting");
    }
    return;
  }
  if (!child.kill()) fail("native benchmark process could not be terminated");
  if (await waitForExit(exitPromise, TERMINATION_GRACE_MS, delay)) return;
  if (child.exitCode === null && child.signalCode === null && !child.kill("SIGKILL")) {
    fail("native benchmark process could not be hard-terminated");
  }
  if (!(await waitForExit(exitPromise, TERMINATION_TIMEOUT_MS, delay))) {
    fail("native benchmark process did not terminate after SIGKILL");
  }
}

/** Execute one real Notes process and retain its raw native frame records. */
export async function collectNativeRun({
  binaryPath,
  environment = process.env,
  frameTarget,
  warmup,
  settleMs = SETTLE_WINDOW_MS,
  runtimePlatform = process.platform,
  spawn = spawnProcess,
  readRss = readResidentSetBytes,
  monotonicNow = () => performance.now(),
  delay = wait,
  runTimeoutMs = RUN_TIMEOUT_MS,
}) {
  requireString(binaryPath, "native binary path");
  if (!Number.isSafeInteger(frameTarget) || frameTarget < 1 || frameTarget > 1_000) {
    fail("native frame target must be an integer between 1 and 1000");
  }
  if (typeof warmup !== "boolean") fail("native run warmup flag must be boolean");
  if (!warmup && settleMs !== SETTLE_WINDOW_MS) {
    fail(`measured native runs require the fixed ${SETTLE_WINDOW_MS}ms settle window`);
  }

  const executablePath = path.resolve(binaryPath);
  const childEnvironment = {
    ...environment,
    NEXA_PERFORMANCE_CAPTURE_V1: "1",
    NEXA_PERFORMANCE_FRAME_TARGET: String(frameTarget),
  };
  delete childEnvironment.NEXA_DIALOG_TEST_FIXTURE_PATH;
  const startedAt = monotonicNow();
  const child = spawn(executablePath, [], {
    cwd: path.dirname(executablePath),
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) fail("native benchmark process pipes were not created");

  const firstPresent = deferred();
  const framesReady = deferred();
  const failure = deferred();
  const exited = deferred();
  const events = [];
  let presentedFrames = 0;
  let coldStartMs;
  let stderr = "";
  let intentionalTermination = false;
  let failed = false;

  const failOnce = (error) => {
    if (failed || intentionalTermination) return;
    failed = true;
    failure.reject(error instanceof Error ? error : new Error(String(error)));
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
  });
  child.once("error", (error) => {
    exited.resolve({ error });
    failOnce(
      new Error(`native benchmark process failed to start: ${error.message}`, { cause: error }),
    );
  });
  child.once("close", (code, signal) => {
    exited.resolve({ code, signal });
    if (!intentionalTermination) {
      const detail = stderr.trim();
      failOnce(
        new Error(
          `native benchmark process exited before collection completed (code ${String(code)}, signal ${String(signal)})${detail ? `: ${detail}` : ""}`,
        ),
      );
    }
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.startsWith(NATIVE_EVENT_PREFIX) || intentionalTermination) return;
    try {
      const event = parseNativePerformanceEvent(line);
      events.push(event);
      if (event.outcome === "dropped") {
        failOnce(new Error(`native benchmark observed a dropped frame at ${event.dropStage}`));
        return;
      }
      if (event.outcome !== "presented") return;
      presentedFrames += 1;
      if (coldStartMs === undefined) {
        coldStartMs = monotonicNow() - startedAt;
        firstPresent.resolve(coldStartMs);
      }
      if (presentedFrames >= frameTarget) framesReady.resolve();
    } catch (error) {
      failOnce(error);
    }
  });

  const timeout = setTimeout(() => {
    failOnce(new Error(`native benchmark timed out after ${runTimeoutMs}ms`));
  }, runTimeoutMs);
  const guard = (promise) => Promise.race([promise, failure.promise]);

  try {
    await guard(firstPresent.promise);
    if (warmup) {
      await guard(framesReady.promise);
    } else {
      await guard(Promise.all([framesReady.promise, delay(settleMs)]));
    }
    const idleRssBytes = warmup
      ? 0
      : readRss({ platform: runtimePlatform, pid: child.pid, spawnSync: spawnSyncProcess });
    intentionalTermination = true;
    await terminateChild(child, exited.promise, delay);
    return { coldStartMs, idleRssBytes, events };
  } catch (error) {
    intentionalTermination = true;
    try {
      await terminateChild(child, exited.promise, delay);
    } catch (terminationError) {
      throw new AggregateError(
        [error, terminationError],
        "native benchmark collection and termination both failed",
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref?.();
  }
}

function inspectPerformanceArtifact({ artifactPath, binaryPath, archivePath }) {
  const artifactRoot = path.resolve(artifactPath);
  const executablePath = path.resolve(binaryPath);
  const archiveFile = path.resolve(archivePath);
  const relativeExecutable = path.relative(artifactRoot, executablePath);
  if (
    relativeExecutable === "" ||
    path.isAbsolute(relativeExecutable) ||
    relativeExecutable.split(path.sep).includes("..")
  ) {
    fail("native binary must be a file below the measured artifact directory");
  }
  const executableStat = lstatSync(executablePath);
  if (executableStat.isSymbolicLink() || !executableStat.isFile()) {
    fail("native binary must be a regular file, not a symbolic link or special file");
  }
  const archiveStat = lstatSync(archiveFile);
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) {
    fail("performance candidate archive must be a regular file");
  }
  return {
    artifactName: path.basename(artifactRoot),
    artifactExecutable: relativeExecutable.split(path.sep).join("/"),
    artifactBytes: measureArtifactBytes(artifactRoot),
    executableSha256: createHash("sha256").update(readFileSync(executablePath)).digest("hex"),
    artifactTreeSha256: measureArtifactTreeSha256(artifactRoot),
    archiveSha256: createHash("sha256").update(readFileSync(archiveFile)).digest("hex"),
  };
}

function assertArtifactIdentityUnchanged(before, after) {
  requireArtifactIdentity(before);
  requireArtifactIdentity(after);
  for (const key of [
    "artifactName",
    "artifactExecutable",
    "artifactBytes",
    "executableSha256",
    "artifactTreeSha256",
    "archiveSha256",
  ]) {
    if (before[key] !== after[key]) {
      fail(`artifact identity changed during native sampling (${key})`);
    }
  }
}

function assertRunReachedTarget(run, frameTarget, label) {
  requireObject(run, label);
  const samples = frameMetricSamples(run.events);
  if (samples.droppedFrames !== 0) fail(`${label} contains dropped frames`);
  if (samples.presentedFrames < frameTarget) {
    fail(`${label} produced ${samples.presentedFrames}/${frameTarget} required presented frames`);
  }
}

/** Run the configured warmups and measurements, then assemble one candidate report. */
export async function collectPerformanceReport({
  config,
  binaryPath,
  artifactPath,
  archivePath,
  platform,
  commit,
  runnerImage,
  replica,
  environment = process.env,
  runtimePlatform = process.platform,
  runtimeArch = process.arch,
  inspectArtifact = inspectPerformanceArtifact,
  runNative = collectNativeRun,
  capturedAt,
}) {
  validateFrozenPerformancePolicy(config);
  assertHostedRunner({
    platform,
    runnerImage,
    environment,
    runtimePlatform,
    runtimeArch,
  });
  const resolvedBinaryPath = path.resolve(binaryPath);
  const resolvedArtifactPath = path.resolve(artifactPath);
  const resolvedArchivePath = path.resolve(archivePath);
  const initialArtifact = inspectArtifact({
    artifactPath: resolvedArtifactPath,
    binaryPath: resolvedBinaryPath,
    archivePath: resolvedArchivePath,
  });
  const measuredRunCount = config.workload.samplePolicy.measuredRuns;
  const steadyFrameTarget = config.workload.samplePolicy.steadyPresentsPerMeasuredRun;
  const measuredFrameTarget =
    steadyFrameTarget + config.workload.samplePolicy.startupPresentsPerMeasuredRun;
  const commonRunOptions = {
    binaryPath: resolvedBinaryPath,
    environment,
    runtimePlatform,
  };

  for (let index = 0; index < config.workload.samplePolicy.warmupRuns; index += 1) {
    const warmup = await runNative({
      ...commonRunOptions,
      frameTarget: steadyFrameTarget,
      warmup: true,
      settleMs: 0,
    });
    assertRunReachedTarget(warmup, steadyFrameTarget, `warmup run ${index + 1}`);
  }

  const runs = [];
  for (let index = 0; index < measuredRunCount; index += 1) {
    const run = await runNative({
      ...commonRunOptions,
      frameTarget: measuredFrameTarget,
      warmup: false,
      settleMs: SETTLE_WINDOW_MS,
    });
    assertRunReachedTarget(run, measuredFrameTarget, `measured run ${index + 1}`);
    runs.push(run);
  }
  const finalArtifact = inspectArtifact({
    artifactPath: resolvedArtifactPath,
    binaryPath: resolvedBinaryPath,
    archivePath: resolvedArchivePath,
  });
  assertArtifactIdentityUnchanged(initialArtifact, finalArtifact);

  return createPerformanceReport({
    config,
    platform,
    commit,
    runnerImage,
    replica,
    environment,
    runtimePlatform,
    runtimeArch,
    ...initialArtifact,
    runs,
    capturedAt,
  });
}

function optionValue(argv, option) {
  const index = argv.indexOf(option);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${option} requires a value`);
  return value;
}

function usage() {
  return [
    "Usage:",
    "  node tools/performance-collector.mjs --binary FILE --artifact DIR --archive FILE --platform PLATFORM --runner-image IMAGE --replica 1|2|3 --commit SHA --output FILE [--config FILE]",
  ].join("\n");
}

function defaultConfigPath() {
  return fileURLToPath(new URL("../release/performance-budgets.json", import.meta.url));
}

/** Hosted collector CLI. Sample counts and settle time intentionally have no flags. */
export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const allowed = new Set([
      "--binary",
      "--artifact",
      "--archive",
      "--platform",
      "--runner-image",
      "--replica",
      "--commit",
      "--output",
      "--config",
    ]);
    for (let index = 0; index < argv.length; index += 2) {
      if (!allowed.has(argv[index])) fail(`unknown option: ${String(argv[index])}`);
      if (argv[index + 1] === undefined) fail(`${argv[index]} requires a value`);
    }
    const binaryPath = optionValue(argv, "--binary");
    const artifactPath = optionValue(argv, "--artifact");
    const archivePath = optionValue(argv, "--archive");
    const platform = optionValue(argv, "--platform");
    const runnerImage = optionValue(argv, "--runner-image");
    const replicaValue = optionValue(argv, "--replica");
    const commit = optionValue(argv, "--commit");
    const outputPath = optionValue(argv, "--output");
    if (
      !binaryPath ||
      !artifactPath ||
      !archivePath ||
      !platform ||
      !runnerImage ||
      !replicaValue ||
      !commit ||
      !outputPath
    ) {
      throw new Error(usage());
    }
    if (!DECIMAL_PATTERN.test(replicaValue)) fail("--replica must be a positive integer");
    const replica = Number(replicaValue);
    const configPath = optionValue(argv, "--config") ?? defaultConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const report = await collectPerformanceReport({
      config,
      binaryPath,
      artifactPath,
      archivePath,
      platform,
      commit,
      runnerImage,
      replica,
    });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(
      `Captured ${report.workload} ${report.platform} replica ${report.replica}: ${report.measuredProcesses.length} measured processes\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = await main();

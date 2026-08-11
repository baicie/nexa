import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  NATIVE_EVENT_PREFIX,
  assertHostedRunner,
  collectNativeRun,
  collectPerformanceReport,
  createPerformanceReport,
  frameMetricSamples,
  parseNativePerformanceEvent,
  readResidentSetBytes,
} from "./performance-collector.mjs";
import { validatePerformanceReport } from "./performance-budget.mjs";

const config = JSON.parse(
  readFileSync(new URL("../release/performance-budgets.json", import.meta.url), "utf8"),
);
const hostedEnvironment = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_SHA: "a".repeat(40),
};
const hostedDarwinRuntime = { runtimePlatform: "darwin", runtimeArch: "arm64" };

function nativeEvent({
  outcome = "presented",
  layout = "3000000",
  paint = "5000000",
  sessionId = "9",
  tickId = "10",
  frameId = "11",
  surfaceGeneration = "3",
  successfulPresents = outcome === "presented" ? "1" : "0",
  droppedFrames = outcome === "dropped" ? "1" : "0",
} = {}) {
  return `${NATIVE_EVENT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    kind: "frame",
    outcome,
    dropStage: outcome === "dropped" ? "paint" : null,
    sessionId,
    tickId,
    frameId,
    surfaceGeneration,
    counts: {
      dispatchedEvents: "0",
      mutationCommands: "0",
      commitAttempts: "0",
      commits: "0",
      layoutAttempts: "1",
      layoutNodes: "4",
      semanticAttempts: "1",
      semanticDiffs: "0",
      displayListAttempts: "1",
      displayCommands: "5",
      paintAttempts: "1",
      presentAttempts: outcome === "presented" ? "1" : "0",
      successfulPresents,
      droppedFrames,
    },
    durationsNs: {
      platformEvents: "1000000",
      systemCompletion: "1000000",
      frameworkMicrotasks: "1000000",
      stateEffects: "1000000",
      hostMutationCommit: "1000000",
      layout,
      semantics: "1000000",
      displayList: "1000000",
      paint,
      present: "1000000",
      deferredCleanup: "1000000",
    },
  })}`;
}

function measuredRuns({ eventsPerRun = 10, overrides = {} } = {}) {
  return Array.from({ length: 10 }, (_, index) => ({
    coldStartMs: 90 + index,
    idleRssBytes: 90_000_000 + index,
    events: Array.from({ length: eventsPerRun }, (_, eventIndex) =>
      parseNativePerformanceEvent(
        nativeEvent({ tickId: String(eventIndex + 1), frameId: String(eventIndex + 1) }),
      ),
    ),
    ...overrides,
  }));
}

test("native event parser accepts only the versioned prefixed raw contract", () => {
  const parsed = parseNativePerformanceEvent(nativeEvent());

  assert.equal(parsed.kind, "frame");
  assert.equal(parsed.outcome, "presented");
  assert.equal(parsed.durationsNs.layout, "3000000");
  assert.equal(parsed.counts.droppedFrames, "0");
  assert.throws(() => parseNativePerformanceEvent('{"kind":"frame"}'), /prefix/u);
  assert.throws(
    () => parseNativePerformanceEvent(`${NATIVE_EVENT_PREFIX}{"schemaVersion":2}`),
    /schemaVersion/u,
  );
  assert.throws(
    () =>
      parseNativePerformanceEvent(nativeEvent().replace('"layout":"3000000"', '"layout":3000000')),
    /decimal string/u,
  );
  assert.throws(
    () =>
      parseNativePerformanceEvent(
        nativeEvent({ outcome: "noPresentRequested", droppedFrames: "1" }),
      ),
    /inconsistent/u,
  );
});

test("frame samples sum all raw phases and exclude non-present outcomes", () => {
  const samples = frameMetricSamples([
    parseNativePerformanceEvent(nativeEvent()),
    parseNativePerformanceEvent(nativeEvent({ outcome: "noPresentRequested" })),
  ]);

  assert.deepEqual(samples, {
    tickMs: [17],
    layoutMs: [3],
    paintMs: [5],
    droppedFrames: 0,
    presentedFrames: 1,
  });
});

test("presented frame samples require complete monotonic per-process identity", () => {
  assert.doesNotThrow(() =>
    frameMetricSamples([parseNativePerformanceEvent(nativeEvent({ tickId: null, frameId: "1" }))]),
  );
  assert.throws(
    () => frameMetricSamples([parseNativePerformanceEvent(nativeEvent({ frameId: null }))]),
    /identity/u,
  );
  assert.throws(
    () =>
      frameMetricSamples([
        parseNativePerformanceEvent(nativeEvent({ tickId: "1", frameId: "7" })),
        parseNativePerformanceEvent(nativeEvent({ tickId: "2", frameId: "7" })),
      ]),
    /frameId.*increasing/u,
  );
  assert.throws(
    () =>
      frameMetricSamples([
        parseNativePerformanceEvent(nativeEvent({ sessionId: "1", tickId: "1", frameId: "1" })),
        parseNativePerformanceEvent(nativeEvent({ sessionId: "2", tickId: "2", frameId: "2" })),
      ]),
    /sessionId/u,
  );
});

test("drop records are observable and cannot be silently converted to samples", () => {
  const samples = frameMetricSamples([
    parseNativePerformanceEvent(nativeEvent({ outcome: "dropped" })),
  ]);

  assert.equal(samples.droppedFrames, 1);
  assert.deepEqual(samples.tickMs, []);
  assert.throws(
    () =>
      createPerformanceReport({
        config,
        platform: "darwin-arm64",
        commit: "a".repeat(40),
        runnerImage: "macos-15",
        environment: hostedEnvironment,
        ...hostedDarwinRuntime,
        artifactName: "reference-notes-macos-arm64",
        artifactExecutable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
        artifactBytes: 10,
        executableSha256: "b".repeat(64),
        runs: measuredRuns({
          overrides: { events: [parseNativePerformanceEvent(nativeEvent({ outcome: "dropped" }))] },
        }),
      }),
    /dropped/u,
  );
});

test("hosted runner assertion rejects local and mismatched platform evidence", () => {
  assert.deepEqual(
    assertHostedRunner({
      platform: "darwin-arm64",
      runnerImage: "macos-15",
      environment: hostedEnvironment,
      runtimePlatform: "darwin",
      runtimeArch: "arm64",
    }),
    { provider: "github-actions", image: "macos-15", hosted: true },
  );
  assert.throws(
    () =>
      assertHostedRunner({
        platform: "darwin-arm64",
        runnerImage: "macos-15",
        environment: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    /hosted/u,
  );
  assert.throws(
    () =>
      assertHostedRunner({
        platform: "darwin-arm64",
        runnerImage: "macos-15",
        environment: hostedEnvironment,
        runtimePlatform: "linux",
        runtimeArch: "x64",
      }),
    /platform/u,
  );
});

test("hosted report commit must match the runner revision", () => {
  const input = {
    config,
    platform: "darwin-arm64",
    commit: "b".repeat(40),
    runnerImage: "macos-15",
    environment: hostedEnvironment,
    ...hostedDarwinRuntime,
    artifactName: "reference-notes-macos-arm64",
    artifactExecutable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
    artifactBytes: 25_000_000,
    executableSha256: "c".repeat(64),
    runs: measuredRuns(),
  };

  assert.throws(() => createPerformanceReport(input), /GITHUB_SHA/u);
  assert.throws(
    () =>
      createPerformanceReport({ ...input, environment: { ...hostedEnvironment, GITHUB_SHA: "" } }),
    /GITHUB_SHA/u,
  );
});

test("RSS reader parses native macOS and Windows outputs and rejects malformed values", () => {
  let macOptions;
  assert.equal(
    readResidentSetBytes({
      platform: "darwin",
      pid: 41,
      spawnSync: (_command, _args, options) => {
        macOptions = options;
        return { status: 0, stdout: " 42\n", stderr: "" };
      },
    }),
    42 * 1024,
  );
  assert.equal(macOptions.timeout, 5_000);
  assert.equal(macOptions.killSignal, "SIGKILL");
  assert.equal(
    readResidentSetBytes({
      platform: "win32",
      pid: 41,
      spawnSync: () => ({ status: 0, stdout: "42000000\r\n", stderr: "" }),
    }),
    42_000_000,
  );
  assert.throws(
    () =>
      readResidentSetBytes({
        platform: "darwin",
        pid: 41,
        spawnSync: () => ({ status: 1, stdout: "", stderr: "no process" }),
      }),
    /RSS/u,
  );
  assert.throws(
    () =>
      readResidentSetBytes({
        platform: "darwin",
        pid: 41,
        spawnSync: () => ({
          error: Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" }),
        }),
      }),
    /timed out/u,
  );
});

test("native run resolves a relative executable before changing the child working directory", async () => {
  const relativeBinary = "dist/reference-notes-macos-arm64/Nexa Notes.app/Contents/MacOS/NexaNotes";
  let spawnCommand;
  let spawnOptions;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 41;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.exitCode = 0;
    setImmediate(() => child.emit("close", 0, null));
    return true;
  };

  const run = await collectNativeRun({
    binaryPath: relativeBinary,
    frameTarget: 1,
    warmup: true,
    settleMs: 0,
    spawn: (command, _args, options) => {
      spawnCommand = command;
      spawnOptions = options;
      setImmediate(() => child.stdout.write(`${nativeEvent()}\n`));
      return child;
    },
  });

  const absoluteBinary = path.resolve(relativeBinary);
  assert.equal(spawnCommand, absoluteBinary);
  assert.equal(spawnOptions.cwd, path.dirname(absoluteBinary));
  assert.equal(frameMetricSamples(run.events).presentedFrames, 1);
});

test("native run escalates to a hard kill when graceful termination is ignored", async () => {
  const signals = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 42;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      child.signalCode = signal;
      child.emit("close", null, signal);
    }
    return true;
  };
  let delayCalls = 0;

  const run = await collectNativeRun({
    binaryPath: "/candidate/NexaNotes",
    frameTarget: 1,
    warmup: true,
    settleMs: 0,
    spawn: () => {
      setImmediate(() => child.stdout.write(`${nativeEvent()}\n`));
      return child;
    },
    delay: () => (delayCalls++ === 0 ? Promise.resolve() : new Promise(() => {})),
  });

  assert.deepEqual(signals, [undefined, "SIGKILL"]);
  assert.equal(frameMetricSamples(run.events).presentedFrames, 1);
});

test("native run preserves both collection and termination failures", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 43;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => false;

  await assert.rejects(
    collectNativeRun({
      binaryPath: "/candidate/NexaNotes",
      frameTarget: 1,
      warmup: false,
      spawn: () => {
        setImmediate(() => child.stdout.write(`${nativeEvent()}\n`));
        return child;
      },
      delay: () => Promise.resolve(),
      readRss: () => {
        throw new Error("RSS probe failed");
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /RSS probe failed/u);
      assert.match(error.errors[1].message, /could not be terminated/u);
      return true;
    },
  );
});

test("report aggregation binds hosted identity, artifact identity, all ten runs and 100 frames", () => {
  const report = createPerformanceReport({
    config,
    platform: "darwin-arm64",
    commit: "a".repeat(40),
    runnerImage: "macos-15",
    environment: hostedEnvironment,
    ...hostedDarwinRuntime,
    artifactName: "reference-notes-macos-arm64",
    artifactExecutable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
    artifactBytes: 25_000_000,
    executableSha256: "b".repeat(64),
    runs: measuredRuns(),
    capturedAt: "2026-08-09T02:00:00.000Z",
  });

  assert.equal(report.quality.failedRuns, 0);
  assert.equal(report.quality.droppedFrames, 0);
  assert.equal(report.samples.coldStartMs.length, 10);
  assert.equal(report.samples.idleRssBytes.length, 10);
  assert.equal(report.samples.tickMs.length, 100);
  assert.equal(report.samples.layoutMs.length, 100);
  assert.equal(report.samples.paintMs.length, 100);
  assert.equal(report.artifact.executableSha256, "b".repeat(64));
  assert.doesNotThrow(() => validatePerformanceReport(report, config));
});

test("report creation fails closed for missing measured runs or insufficient presented frames", () => {
  assert.throws(
    () =>
      createPerformanceReport({
        config,
        platform: "darwin-arm64",
        commit: "a".repeat(40),
        runnerImage: "macos-15",
        environment: hostedEnvironment,
        ...hostedDarwinRuntime,
        artifactName: "reference-notes-macos-arm64",
        artifactExecutable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
        artifactBytes: 10,
        executableSha256: "b".repeat(64),
        runs: measuredRuns().slice(0, 9),
      }),
    /measured runs/u,
  );
  assert.throws(
    () =>
      createPerformanceReport({
        config,
        platform: "darwin-arm64",
        commit: "a".repeat(40),
        runnerImage: "macos-15",
        environment: hostedEnvironment,
        ...hostedDarwinRuntime,
        artifactName: "reference-notes-macos-arm64",
        artifactExecutable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
        artifactBytes: 10,
        executableSha256: "b".repeat(64),
        runs: measuredRuns({ eventsPerRun: 9 }),
      }),
    /100.*presented/u,
  );
});

test("collector executes configured warmups and measured runs with a fixed settle window", async () => {
  const calls = [];
  const lifecycle = [];
  const report = await collectPerformanceReport({
    config,
    binaryPath: "/candidate/Nexa Notes.app/Contents/MacOS/NexaNotes",
    artifactPath: "/candidate/reference-notes-macos-arm64",
    platform: "darwin-arm64",
    commit: "a".repeat(40),
    runnerImage: "macos-15",
    environment: hostedEnvironment,
    runtimePlatform: "darwin",
    runtimeArch: "arm64",
    inspectArtifact: () => {
      lifecycle.push("inspect");
      return {
        artifactName: "reference-notes-macos-arm64",
        artifactExecutable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
        artifactBytes: 25_000_000,
        executableSha256: "b".repeat(64),
      };
    },
    runNative: async (options) => {
      lifecycle.push("run");
      calls.push(options);
      return {
        coldStartMs: options.warmup ? 999 : 100 + calls.length,
        idleRssBytes: options.warmup ? 999 : 90_000_000 + calls.length,
        events: Array.from({ length: options.frameTarget }, (_, eventIndex) =>
          parseNativePerformanceEvent(
            nativeEvent({ tickId: String(eventIndex + 1), frameId: String(eventIndex + 1) }),
          ),
        ),
      };
    },
    capturedAt: "2026-08-09T02:00:00.000Z",
  });

  assert.equal(calls.length, 13);
  assert.deepEqual(
    calls.map((call) => call.warmup),
    [true, true, true, false, false, false, false, false, false, false, false, false, false],
  );
  assert.ok(calls.every((call) => call.frameTarget === 10));
  assert.ok(calls.filter((call) => !call.warmup).every((call) => call.settleMs === 5_000));
  assert.equal(report.samples.coldStartMs.length, 10);
  assert.ok(report.samples.coldStartMs.every((sample) => sample !== 999));
  assert.equal(lifecycle[0], "inspect");
  assert.equal(lifecycle.at(-1), "inspect");
  assert.equal(lifecycle.filter((stage) => stage === "inspect").length, 2);
});

test("collector rejects an artifact whose identity changes during native sampling", async () => {
  let inspections = 0;
  await assert.rejects(
    collectPerformanceReport({
      config,
      binaryPath: "/candidate/Nexa Notes.app/Contents/MacOS/NexaNotes",
      artifactPath: "/candidate/reference-notes-macos-arm64",
      platform: "darwin-arm64",
      commit: "a".repeat(40),
      runnerImage: "macos-15",
      environment: hostedEnvironment,
      runtimePlatform: "darwin",
      runtimeArch: "arm64",
      inspectArtifact: () => ({
        artifactName: "reference-notes-macos-arm64",
        artifactExecutable: "Nexa Notes.app/Contents/MacOS/NexaNotes",
        artifactBytes: 25_000_000,
        executableSha256: (inspections++ === 0 ? "b" : "c").repeat(64),
      }),
      runNative: async (options) => ({
        coldStartMs: 100,
        idleRssBytes: options.warmup ? 0 : 90_000_000,
        events: Array.from({ length: options.frameTarget }, (_, eventIndex) =>
          parseNativePerformanceEvent(
            nativeEvent({ tickId: String(eventIndex + 1), frameId: String(eventIndex + 1) }),
          ),
        ),
      }),
    }),
    /artifact identity changed/u,
  );
});

test("performance workflow invokes the native collector and validates its report", () => {
  const source = readFileSync(
    new URL("../.github/workflows/performance.yml", import.meta.url),
    "utf8",
  );
  assert.match(source, /tools\/performance-collector\.mjs/u);
  assert.match(source, /performance-budget\.mjs check[\s\S]*--report/u);
  assert.doesNotMatch(source, /--(?:frame-target|settle|warmup-runs|measured-runs)/u);
  assert.match(source, /upload-artifact/u);
});

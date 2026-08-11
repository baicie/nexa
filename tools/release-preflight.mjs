import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateReleaseReadiness,
  releaseReadinessPhase,
  validateReleaseReadinessPolicy,
} from "./release-readiness.mjs";
import {
  PERFORMANCE_METRICS,
  validateFrozenPerformancePolicy,
  validatePerformanceConfig,
} from "./performance-budget.mjs";
import { assessSigningReadiness, validateSigningPolicy } from "./signing-policy.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const PHASES = new Set(["bootstrap", "final"]);

function usage() {
  return "Usage: node tools/release-preflight.mjs [--phase bootstrap|final] [--json]";
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} could not be read: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function git(root, args, { allowFailure = false } = {}) {
  if (!allowFailure) return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1) return "";
  throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

function currentSource(root, requiredRef) {
  const revision = git(root, ["rev-parse", "HEAD"]);
  const branch = git(root, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true });
  let ref = branch;
  if (!ref) {
    const requiredTag = requiredRef.slice("refs/tags/".length);
    const tags = git(root, ["tag", "--points-at", "HEAD"]).split("\n").filter(Boolean);
    ref = tags.includes(requiredTag) ? requiredRef : "DETACHED";
  }
  return {
    clean: git(root, ["status", "--porcelain"]) === "",
    ref,
    revision,
  };
}

function sourceReport(source, policy) {
  if (!REVISION_PATTERN.test(source.revision ?? "")) {
    throw new Error("source revision must be a full commit SHA");
  }
  if (typeof source.ref !== "string" || source.ref.length === 0) {
    throw new Error("source ref must be a non-empty string");
  }
  if (typeof source.clean !== "boolean") throw new Error("source clean must be boolean");
  const blockers = [];
  if (policy.source.requireClean && !source.clean) blockers.push("working tree is not clean");
  if (source.ref !== policy.source.requiredRef) {
    blockers.push(`source ref ${source.ref} is not ${policy.source.requiredRef}`);
  }
  return {
    ...source,
    requiredRef: policy.source.requiredRef,
    status: blockers.length === 0 ? "pass" : "blocked",
    blockers,
  };
}

function performanceReport(config) {
  return Object.fromEntries(
    Object.entries(config.platforms).map(([platformName, platform]) => {
      const pending = PERFORMANCE_METRICS.filter(
        (metricName) => platform.baselines[metricName].status === "pending",
      );
      return [
        platformName,
        {
          runner: platform.runner,
          status: pending.length === 0 ? "active" : "pending",
          pending,
        },
      ];
    }),
  );
}

export function collectReleasePreflight({ root = ROOT, phase = "final", source } = {}) {
  if (!PHASES.has(phase)) throw new Error("phase must be bootstrap or final");
  const releasePolicy = readJson(
    path.join(root, "release", "readiness-policy.json"),
    "readiness policy",
  );
  const signingPolicy = readJson(
    path.join(root, "release", "signing-policy.json"),
    "signing policy",
  );
  const performanceConfig = readJson(
    path.join(root, "release", "performance-budgets.json"),
    "performance policy",
  );
  validateReleaseReadinessPolicy(releasePolicy);
  validateSigningPolicy(signingPolicy);
  validateFrozenPerformancePolicy(performanceConfig);
  validatePerformanceConfig(performanceConfig, { verifyActiveEvidence: true, evidenceRoot: root });

  const actualSource = source ?? currentSource(root, releasePolicy.source.requiredRef);
  const checkedSource = sourceReport(actualSource, releasePolicy);
  const phasePolicy = releaseReadinessPhase(releasePolicy, phase);
  const release = evaluateReleaseReadiness(releasePolicy, {
    root,
    revision: actualSource.revision,
    ref: releasePolicy.source.requiredRef,
    phase,
  });
  const signing = {
    staging: assessSigningReadiness(signingPolicy, "staging"),
    release: assessSigningReadiness(signingPolicy, "release"),
  };
  const performance = performanceReport(performanceConfig);
  const performanceReady = Object.values(performance).every(({ status }) => status === "active");
  const ready =
    checkedSource.status === "pass" && release.ready && signing.release.ready && performanceReady;

  return {
    schemaVersion: 1,
    channel: releasePolicy.channel,
    phase,
    ready,
    version: releasePolicy.version,
    source: checkedSource,
    release: {
      status: release.ready ? "pass" : "blocked",
      requiredGates: [...phasePolicy.requiredGates],
      blockers: release.blockers,
    },
    signing,
    performance,
  };
}

function parseOptions(argv) {
  let phase = "final";
  let json = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") return { help: true };
    if (!new Set(["--json", "--phase"]).has(option) || seen.has(option)) {
      throw new Error(usage());
    }
    seen.add(option);
    if (option === "--json") json = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--") || !PHASES.has(value)) throw new Error(usage());
      phase = value;
    }
  }
  return { help: false, json, phase };
}

function printText(report) {
  console.log(`release preflight ${report.ready ? "READY" : "BLOCKED"}: ${report.phase}`);
  for (const blocker of report.source.blockers) console.log(`BLOCKED source: ${blocker}`);
  for (const blocker of report.release.blockers) console.log(`BLOCKED release: ${blocker}`);
  for (const blocker of report.signing.release.blockers) console.log(`BLOCKED signing: ${blocker}`);
  for (const [platform, status] of Object.entries(report.performance)) {
    for (const metric of status.pending) console.log(`BLOCKED performance/${platform}: ${metric}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseOptions(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
    const report = collectReleasePreflight({ phase: options.phase });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printText(report);
    return report.ready ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.includes("Usage:") ? message : `${message}\n${usage()}`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = main();

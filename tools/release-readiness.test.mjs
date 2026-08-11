import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateReleaseReadiness, validateReleaseReadinessPolicy } from "./release-readiness.mjs";

const root = path.resolve(new URL("../", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(path.join(root, "release/readiness-policy.json"), "utf8"));
const revision = "a".repeat(40);
const ref = "refs/tags/v0.1.0";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readyFixture() {
  const evidenceRoot = mkdtempSync(path.join(tmpdir(), "nexa-release-readiness-"));
  const candidate = structuredClone(policy);
  candidate.execution = {
    ...candidate.execution,
    state: "enabled",
    phase: "final",
    reason: "Protected release environment and owner approval are active",
  };
  for (const gate of candidate.requiredGates) {
    const proofArtifact = `${gate}-proof.bin`;
    const proofBytes = Buffer.from(`${gate} proof for ${revision}\n`);
    writeFileSync(path.join(evidenceRoot, proofArtifact), proofBytes);
    const record = {
      schemaVersion: 1,
      gate,
      conclusion: "success",
      revision,
      ref,
      capturedAt: "2026-08-10T00:00:00.000Z",
      source: {
        kind: gate === "registry" ? "registry" : "github-actions",
        url:
          gate === "registry"
            ? "https://registry.npmjs.org/"
            : `https://github.com/baicie/nexa-ui/actions/runs/${gate.length}`,
      },
      proof: {
        artifact: proofArtifact,
        sha256: digest(proofBytes),
        run: {
          id: `${gate}-run`,
          job: `${gate}-job`,
          url: `https://github.com/baicie/nexa-ui/actions/runs/${gate.length}`,
          workflow: `.github/workflows/${gate}.yml`,
          event: "workflow_dispatch",
          headSha: revision,
          conclusion: "success",
        },
      },
    };
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    const recordPath = `${gate}.json`;
    writeFileSync(path.join(evidenceRoot, recordPath), bytes);
    candidate.evidence[gate] = {
      status: "passed",
      record: recordPath,
      sha256: digest(bytes),
    };
  }
  return { candidate, evidenceRoot };
}

test("release readiness policy covers every final gate and all twelve success criteria", () => {
  assert.doesNotThrow(() => validateReleaseReadinessPolicy(policy));
  assert.deepEqual(policy.requiredGates, [
    "mvp",
    "contracts",
    "security",
    "performance",
    "consumer",
    "signing",
    "rehearsal",
    "registry",
  ]);
  assert.deepEqual(
    policy.successCriteria.map(({ id }) => id),
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
  assert.equal(policy.publication.signedArtifactsOnly, true);
  assert.equal(policy.publication.requireBothPlatforms, true);
  assert.equal(policy.publication.allowPartial, false);
  assert.equal(policy.execution.phase, "none");
  assert.deepEqual(policy.publication.phases.bootstrap, {
    oneTimeVersion: "0.1.0",
    requiredGates: policy.requiredGates.filter((gate) => gate !== "registry"),
    tagStrategy: "revision-staging",
    promoteChannel: false,
  });
  assert.deepEqual(policy.publication.phases.final, {
    requiredGates: policy.requiredGates,
    tagStrategy: "channel",
    promoteChannel: true,
  });
});

test("checked-in pending evidence and disabled execution fail closed", () => {
  const result = evaluateReleaseReadiness(policy, { root, revision, ref });
  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /release execution is disabled/u);
  for (const gate of policy.requiredGates) {
    assert.match(result.blockers.join("\n"), new RegExp(`${gate} evidence is pending`, "u"));
  }
});

test("JSON readiness output exits non-zero when release remains blocked", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "tools/release-readiness.mjs"),
      "readiness",
      "--revision",
      revision,
      "--ref",
      ref,
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.ready, false);
  assert.ok(output.blockers.length > 0);
});

test("readiness requires immutable, revision-bound evidence for every gate", () => {
  const { candidate, evidenceRoot } = readyFixture();
  const result = evaluateReleaseReadiness(candidate, { root: evidenceRoot, revision, ref });
  assert.deepEqual(result, {
    ready: true,
    blockers: [],
    phase: "final",
    version: "0.1.0",
    revision,
    ref,
  });

  const recordPath = path.join(evidenceRoot, candidate.evidence.security.record);
  writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `);
  assert.throws(
    () => evaluateReleaseReadiness(candidate, { root: evidenceRoot, revision, ref }),
    /security evidence digest does not match/u,
  );
});

test("one-time bootstrap readiness may omit only registry evidence", () => {
  const { candidate, evidenceRoot } = readyFixture();
  candidate.execution.phase = "bootstrap";
  candidate.evidence.registry = {
    status: "pending",
    reason: "The immutable train must exist before hosted registry evidence can be collected",
  };

  const bootstrap = evaluateReleaseReadiness(candidate, {
    root: evidenceRoot,
    revision,
    ref,
    phase: "bootstrap",
  });
  assert.equal(bootstrap.ready, true);
  assert.equal(bootstrap.phase, "bootstrap");

  const final = evaluateReleaseReadiness(candidate, {
    root: evidenceRoot,
    revision,
    ref,
    phase: "final",
  });
  assert.equal(final.ready, false);
  assert.match(final.blockers.join("\n"), /prepared for bootstrap, not final/u);
  assert.match(final.blockers.join("\n"), /registry evidence is pending/u);

  const wrongVersion = structuredClone(candidate);
  wrongVersion.version = "0.1.1";
  wrongVersion.source.requiredRef = "refs/tags/v0.1.1";
  assert.throws(
    () =>
      evaluateReleaseReadiness(wrongVersion, {
        root: evidenceRoot,
        revision,
        ref: "refs/tags/v0.1.1",
        phase: "bootstrap",
      }),
    /bootstrap publication is limited to 0\.1\.0/u,
  );
});

test("a passing label cannot hide a record from another revision", () => {
  const { candidate, evidenceRoot } = readyFixture();
  const recordPath = path.join(evidenceRoot, candidate.evidence.mvp.record);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.revision = "b".repeat(40);
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(recordPath, bytes);
  candidate.evidence.mvp.sha256 = digest(bytes);
  assert.throws(
    () => evaluateReleaseReadiness(candidate, { root: evidenceRoot, revision, ref }),
    /mvp evidence revision does not match/u,
  );
});

test("readiness verifies proof bytes and rejects record self-reference", () => {
  const { candidate, evidenceRoot } = readyFixture();
  const proofPath = path.join(evidenceRoot, "security-proof.bin");
  writeFileSync(proofPath, "tampered\n");
  assert.throws(
    () => evaluateReleaseReadiness(candidate, { root: evidenceRoot, revision, ref }),
    /security proof artifact digest does not match/u,
  );

  const self = readyFixture();
  const recordPath = path.join(self.evidenceRoot, self.candidate.evidence.mvp.record);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.proof.artifact = self.candidate.evidence.mvp.record;
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(recordPath, bytes);
  self.candidate.evidence.mvp.sha256 = digest(bytes);
  assert.throws(
    () => evaluateReleaseReadiness(self.candidate, { root: self.evidenceRoot, revision, ref }),
    /proof artifact must not be the gate record/u,
  );
});

test("readiness rejects a successful label whose producer run identity is not bound", () => {
  const { candidate, evidenceRoot } = readyFixture();
  const recordPath = path.join(evidenceRoot, candidate.evidence.consumer.record);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.proof.run.headSha = "b".repeat(40);
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(recordPath, bytes);
  candidate.evidence.consumer.sha256 = digest(bytes);
  assert.throws(
    () => evaluateReleaseReadiness(candidate, { root: evidenceRoot, revision, ref }),
    /consumer evidence run.headSha does not match/u,
  );
});

test("final workflow is manual, protected, readiness-gated, and publishes only built packages", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^\s+push:/mu);
  assert.match(workflow, /environment:\s*technical-preview-release/u);
  assert.match(workflow, /node tools\/release-readiness\.mjs readiness/u);
  assert.match(workflow, /node tools\/publish-release\.mjs publish --execute/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /contents: write/u);
});

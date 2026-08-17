import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  assembleReadinessBundle,
  createRunEvidenceRecord,
  READINESS_GATE_WORKFLOWS,
} from "./release-readiness-bundle.mjs";
import { evaluateReleaseReadiness } from "./release-readiness.mjs";

const revision = "a".repeat(40);
const ref = "refs/tags/v0.1.0";
const gates = Object.keys(READINESS_GATE_WORKFLOWS);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-readiness-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  mkdirSync(path.join(source, "proof"), { recursive: true });
  for (const gate of gates) {
    const proofArtifact = `proof/${gate}.json`;
    const proofFile = path.join(source, proofArtifact);
    writeFileSync(proofFile, `${JSON.stringify({ gate, revision, conclusion: "success" })}\n`);
    const workflow = READINESS_GATE_WORKFLOWS[gate];
    const record = createRunEvidenceRecord({
      gate,
      revision,
      ref,
      proofFile,
      proofArtifact,
      runJob: `${gate}-gate`,
      run: {
        id: 100 + gates.indexOf(gate),
        head_sha: revision,
        conclusion: "success",
        path: workflow,
        event: gate === "rehearsal" ? "push" : "workflow_dispatch",
        html_url: `https://github.com/baicie/nexa-ui/actions/runs/${100 + gates.indexOf(gate)}`,
      },
    });
    writeFileSync(path.join(source, `${gate}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
  return { root, source, output };
}

test("assembles an external, immutable, revision-bound readiness policy", (t) => {
  const current = fixture(t);
  const result = assembleReadinessBundle({
    sourceDirectory: current.source,
    outputDirectory: current.output,
    revision,
    ref,
  });
  assert.equal(result.ready, true);
  assert.equal(result.phase, "final");
  const policy = JSON.parse(
    readFileSync(path.join(current.output, "readiness-policy.json"), "utf8"),
  );
  assert.equal(policy.execution.state, "enabled");
  assert.deepEqual(Object.keys(policy.evidence), gates);
  for (const gate of gates) {
    assert.equal(policy.evidence[gate].status, "passed");
    const recordFile = path.join(current.output, policy.evidence[gate].record);
    assert.equal(sha256(readFileSync(recordFile)), policy.evidence[gate].sha256);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    assert.match(record.proof.artifact, new RegExp(`^proof/${gate}-`, "u"));
    assert.equal(
      sha256(readFileSync(path.join(current.output, record.proof.artifact))),
      record.proof.sha256,
    );
  }
  assert.equal(
    evaluateReleaseReadiness(policy, { root: current.output, revision, ref }).ready,
    true,
  );
});

test("assembles a bootstrap bundle without manufacturing registry evidence", (t) => {
  const current = fixture(t);
  rmSync(path.join(current.source, "registry.json"));
  rmSync(path.join(current.source, "proof/registry.json"));

  const result = assembleReadinessBundle({
    sourceDirectory: current.source,
    outputDirectory: current.output,
    revision,
    ref,
    phase: "bootstrap",
  });
  assert.equal(result.ready, true);
  assert.equal(result.phase, "bootstrap");
  const policy = JSON.parse(
    readFileSync(path.join(current.output, "readiness-policy.json"), "utf8"),
  );
  assert.equal(policy.execution.phase, "bootstrap");
  assert.equal(policy.evidence.registry.status, "pending");
  assert.equal(existsSync(path.join(current.output, "records/registry.json")), false);

  assert.equal(
    evaluateReleaseReadiness(policy, {
      root: current.output,
      revision,
      ref,
      phase: "final",
    }).ready,
    false,
  );
});

test("assembly fails atomically when a proof artifact changed after its record", (t) => {
  const current = fixture(t);
  writeFileSync(path.join(current.source, "proof/security.json"), "tampered\n");
  assert.throws(
    () =>
      assembleReadinessBundle({
        sourceDirectory: current.source,
        outputDirectory: current.output,
        revision,
        ref,
      }),
    /security proof artifact digest does not match/u,
  );
  assert.equal(existsSync(current.output), false);
});

test("run evidence rejects the wrong workflow, revision, event, or conclusion", (t) => {
  const current = fixture(t);
  const proofFile = path.join(current.source, "proof/mvp.json");
  const base = {
    gate: "mvp",
    revision,
    ref,
    proofFile,
    proofArtifact: "proof/mvp.json",
    runJob: "mvp-gate",
    run: {
      id: 100,
      head_sha: revision,
      conclusion: "success",
      path: READINESS_GATE_WORKFLOWS.mvp,
      event: "workflow_dispatch",
      html_url: "https://github.com/baicie/nexa-ui/actions/runs/100",
    },
  };
  for (const [field, value, pattern] of [
    ["path", ".github/workflows/other.yml", /workflow path/u],
    ["head_sha", "b".repeat(40), /head SHA/u],
    ["event", "pull_request", /event/u],
    ["conclusion", "failure", /conclusion/u],
  ]) {
    assert.throws(
      () => createRunEvidenceRecord({ ...base, run: { ...base.run, [field]: value } }),
      pattern,
    );
  }
});

test("protected evidence workflow downloads every proof from its exact external run", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/release-evidence.yml", import.meta.url), "utf8"),
  );
  for (const input of ["mvp_run_id", "rehearsal_run_id", "signing_run_id"]) {
    assert.equal(workflow.on.workflow_dispatch.inputs[input].required, true);
  }
  assert.equal(workflow.on.workflow_dispatch.inputs.publication_phase.required, true);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.publication_phase.options, [
    "bootstrap",
    "final",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.registry_run_id.required, false);
  const job = workflow.jobs.bundle;
  assert.equal(job.environment.name, "technical-preview-release-evidence");
  assert.equal(job.permissions, undefined);
  const downloads = job.steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(downloads.length, 4);
  for (const expected of [
    {
      name: "mvp-evidence",
      path: "${{ runner.temp }}/external-proof/mvp",
      runId: "${{ inputs.mvp_run_id }}",
    },
    {
      name: "nexa-release-decision-${{ github.sha }}",
      path: "${{ runner.temp }}/external-proof/rehearsal",
      runId: "${{ inputs.rehearsal_run_id }}",
    },
    {
      name: "signed-release-artifacts",
      path: "${{ runner.temp }}/external-proof/signing",
      runId: "${{ inputs.signing_run_id }}",
    },
    {
      name: "registry-evidence",
      path: "${{ runner.temp }}/external-proof/registry",
      runId: "${{ inputs.registry_run_id }}",
    },
  ]) {
    const download = downloads.find((step) => step.with?.name === expected.name);
    assert.ok(download, `missing ${expected.name} download`);
    assert.equal(download.with.path, expected.path);
    assert.equal(download.with["run-id"], expected.runId);
    assert.equal(download.with["github-token"], "${{ github.token }}");
    assert.equal(download.with.repository, "${{ github.repository }}");
  }
});

function protectedEvidenceCommands() {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/release-evidence.yml", import.meta.url), "utf8"),
  );
  return workflow.jobs.bundle.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

function protectedEvidenceStep(name) {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/release-evidence.yml", import.meta.url), "utf8"),
  );
  const step = workflow.jobs.bundle.steps.find((candidate) => candidate.name === name);
  assert.equal(typeof step?.run, "string", `missing run step: ${name}`);
  return step.run;
}

test("protected evidence workflow semantically verifies MVP and rehearsal proofs", () => {
  const commands = protectedEvidenceStep("Fetch and bind every external gate run");
  assert.match(
    commands,
    /node tools\/mvp-evidence\.mjs verify "\$input_root\/proof\/mvp-evidence\.json"/u,
  );
  const lines = commands.split("\n");
  const enforceIndex = lines.indexOf("node tools/release-rehearsal.mjs enforce \\");
  assert.notEqual(enforceIndex, -1);
  assert.deepEqual(lines.slice(enforceIndex, enforceIndex + 5), [
    "node tools/release-rehearsal.mjs enforce \\",
    '  --decision "$input_root/proof/rehearsal-decision.json" \\',
    "  --mode tag \\",
    '  --ref "$GITHUB_REF" \\',
    '  --revision "$GITHUB_SHA"',
  ]);
});

test("protected evidence workflow semantically verifies the signed transport", () => {
  const commands = protectedEvidenceCommands();
  assert.match(
    commands,
    /node tools\/publish-release\.mjs verify-signed[\s\S]*--signed-artifacts "\$RUNNER_TEMP\/external-proof\/signing"[\s\S]*--revision "\$GITHUB_SHA"[\s\S]*--signed-run-id "\$SIGNING_RUN_ID"/u,
  );
});

test("protected evidence workflow semantically verifies the registry proof", () => {
  const commands = protectedEvidenceCommands();
  assert.match(
    commands,
    /node tools\/registry-evidence\.mjs verify[\s\S]*--evidence "\$input_root\/proof\/registry\/registry-evidence\.json"[\s\S]*--revision "\$GITHUB_SHA"[\s\S]*--ref "\$GITHUB_REF"/u,
  );
});

test("protected evidence workflow binds every proof run before recording the gate", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/release-evidence.yml", import.meta.url), "utf8"),
  );
  const job = workflow.jobs.bundle;
  const commands = job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(commands, /gh api .*actions\/runs/u);
  assert.match(
    commands,
    /release-readiness-bundle\.mjs validate-run[\s\S]*--run "\$input_root\/\$run_metadata"[\s\S]*--revision "\$GITHUB_SHA"[\s\S]*--workflow "\$\{workflows\[\$gate\]\}"[\s\S]*--events "\$events"/u,
  );
  assert.match(commands, /release-readiness-bundle\.mjs record/u);
  assert.match(commands, /release-readiness-bundle\.mjs assemble/u);
  assert.match(commands, /release-readiness\.mjs readiness/u);
  for (const workflowPath of new Set(Object.values(READINESS_GATE_WORKFLOWS))) {
    assert.match(commands, new RegExp(workflowPath.replaceAll(".", "\\."), "u"));
  }
  const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.with.name, "release-readiness-evidence-${{ inputs.publication_phase }}");
  assert.equal(upload.with["if-no-files-found"], "error");
});

test("protected evidence workflow omits registry only for bootstrap assembly", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/release-evidence.yml", import.meta.url), "utf8"),
  );
  const registryDownload = workflow.jobs.bundle.steps.find(
    (step) => step.with?.name === "registry-evidence",
  );
  assert.equal(registryDownload.if, "inputs.publication_phase == 'final'");
  const commands = protectedEvidenceCommands();
  assert.match(commands, /if \[\[ "\$PUBLICATION_PHASE" == "final" \]\]/u);
  assert.match(commands, /registry-evidence\.mjs verify[\s\S]*--phase bootstrap/u);
  assert.match(
    commands,
    /release-readiness-bundle\.mjs assemble[\s\S]*--phase "\$PUBLICATION_PHASE"/u,
  );
  assert.match(commands, /release-readiness\.mjs readiness[\s\S]*--phase "\$PUBLICATION_PHASE"/u);
});

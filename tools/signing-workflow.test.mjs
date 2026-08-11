import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { exportSignedCustody, mergeSignedCustody } from "./signing-transport.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-signing-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function custody(root, platform) {
  const name =
    platform === "darwin"
      ? "nexa-notes-0.1.0-macos-arm64-signed.tar.gz"
      : "nexa-notes-0.1.0-windows-x64-signed.zip";
  const directory = path.join(root, "release-work", "signed", `${name}.custody`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), `${platform} archive\n`);
  writeFileSync(path.join(directory, `${name}.custody.json`), "{}\n");
  writeFileSync(path.join(directory, `${name}.SHA256SUMS`), "checksum\n");
  return { name, directory };
}

test("signed custody export and merge keep a flat exact transport", (t) => {
  const root = fixture(t);
  const darwinRoot = path.join(root, "darwin-custody");
  const windowsRoot = path.join(root, "windows-custody");
  const darwin = custody(darwinRoot, "darwin");
  const windows = custody(windowsRoot, "win32");
  const darwinExport = path.join(root, "darwin-export");
  const windowsExport = path.join(root, "windows-export");
  const merged = path.join(root, "merged");

  assert.deepEqual(
    exportSignedCustody({
      custodyRoot: darwinRoot,
      platform: "darwin",
      outputDirectory: darwinExport,
    }),
    { artifactName: darwin.name, fileCount: 3 },
  );
  assert.deepEqual(
    exportSignedCustody({
      custodyRoot: windowsRoot,
      platform: "win32",
      outputDirectory: windowsExport,
    }),
    { artifactName: windows.name, fileCount: 3 },
  );
  const result = mergeSignedCustody({
    darwinDirectory: darwinExport,
    windowsDirectory: windowsExport,
    outputDirectory: merged,
  });
  assert.equal(result.fileCount, 6);
  assert.deepEqual(
    readdirSync(merged).sort(),
    [
      darwin.name,
      `${darwin.name}.SHA256SUMS`,
      `${darwin.name}.custody.json`,
      windows.name,
      `${windows.name}.SHA256SUMS`,
      `${windows.name}.custody.json`,
    ].sort(),
  );
});

test("signed custody merge rejects duplicate names and non-regular input", (t) => {
  const root = fixture(t);
  const darwin = path.join(root, "darwin");
  const windows = path.join(root, "windows");
  mkdirSync(darwin);
  mkdirSync(windows);
  writeFileSync(path.join(darwin, "duplicate"), "darwin\n");
  writeFileSync(path.join(windows, "duplicate"), "windows\n");
  assert.throws(
    () =>
      mergeSignedCustody({
        darwinDirectory: darwin,
        windowsDirectory: windows,
        outputDirectory: path.join(root, "duplicate-output"),
      }),
    /duplicate/u,
  );

  rmSync(path.join(windows, "duplicate"));
  symlinkSync(path.join(darwin, "duplicate"), path.join(windows, "alias"));
  assert.throws(
    () =>
      mergeSignedCustody({
        darwinDirectory: darwin,
        windowsDirectory: windows,
        outputDirectory: path.join(root, "symlink-output"),
      }),
    /regular|symlink/u,
  );
  assert.equal(existsSync(path.join(root, "symlink-output")), false);
});

test("signing workflow preserves hard gates while encoding the complete producer path", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/signing.yml", import.meta.url), "utf8"),
  );
  assert.equal(workflow.on.workflow_dispatch.inputs.unsigned_run_id.required, false);
  assert.equal(workflow.on.workflow_call.inputs.unsigned_run_id.required, false);

  for (const [jobName, platform] of [
    ["macos-executor", "darwin"],
    ["windows-executor", "win32"],
  ]) {
    const job = workflow.jobs[jobName];
    assert.equal(job.if, "${{ false }}");
    assert.equal(job.permissions.actions, "read");
    const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
    assert.equal(download.with.name, "unsigned-signing-input");
    assert.equal(download.with["run-id"], "${{ inputs.unsigned_run_id }}");
    assert.equal(download.with["github-token"], "${{ github.token }}");
    const runValidation = job.steps.find(
      (step) => step.name === "Validate producer run identity and revision",
    ).run;
    assert.match(runValidation, /UNSIGNED_RUN_ID/u);
    assert.match(runValidation, /GITHUB_SHA/u);
    assert.match(runValidation, /--events workflow_dispatch,push/u);
    const commands = job.steps
      .filter((step) => typeof step.run === "string")
      .map((step) => step.run)
      .join("\n");
    assert.match(commands, /validate-run[\s\S]*reference-notes-package\.yml/u);
    assert.match(commands, /unsigned-signing-input\.mjs verify/u);
    assert.match(commands, /signing-executor\.mjs execute/u);
    assert.match(commands, new RegExp(`--platform ${platform}`, "u"));
    assert.match(commands, /signing-transport\.mjs export/u);
    if (platform === "darwin") {
      assert.match(
        commands,
        /signing-executor\.mjs execute[\s\S]*--custody-root "\$RUNNER_TEMP\/nexa-signing-input"[\s\S]*signing-transport\.mjs export[\s\S]*--custody-root "\$RUNNER_TEMP\/nexa-signing-input"/u,
      );
    } else {
      assert.match(
        commands,
        /signing-executor\.mjs execute --custody-root \$bundle[\s\S]*signing-transport\.mjs export --custody-root \$bundle/u,
      );
    }
    const stepNames = job.steps.map(({ name = "" }) => name);
    const orderedSteps = [
      "Validate producer run identity and revision",
      "Download revision-bound unsigned signing input",
      "Verify G6-05 unsigned bundle before credential activation",
      platform === "darwin"
        ? "Execute macOS signing and export immutable custody"
        : "Execute Windows signing and export immutable custody",
      platform === "darwin" ? "Upload macOS signed custody" : "Upload Windows signed custody",
      platform === "darwin"
        ? "Remove run-scoped macOS signing material"
        : "Remove run-scoped Windows signing material",
    ].map((name) => stepNames.indexOf(name));
    assert.deepEqual(
      orderedSteps,
      [...orderedSteps].sort((left, right) => left - right),
    );
    assert.ok(orderedSteps.every((index) => index >= 0));
    assert.equal(job.steps.at(-1).if, "always()");
  }

  const source = readFileSync(new URL("../.github/workflows/signing.yml", import.meta.url), "utf8");
  for (const reference of [
    "NEXA_MACOS_CERTIFICATE_P12",
    "NEXA_MACOS_CERTIFICATE_PASSWORD",
    "NEXA_APPLE_NOTARY_KEY_P8",
    "NEXA_WINDOWS_CERTIFICATE_PFX",
    "NEXA_WINDOWS_CERTIFICATE_PASSWORD",
  ]) {
    assert.match(source, new RegExp(`secrets\\.${reference}`, "u"));
  }

  const assemble = workflow.jobs.assemble;
  assert.deepEqual(assemble.needs, ["macos-executor", "windows-executor"]);
  const custodyDownload = assemble.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.equal(custodyDownload.with.pattern, "signed-custody-*-${{ github.sha }}");
  assert.equal(custodyDownload.with["merge-multiple"], false);
  const commands = assemble.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(commands, /signing-transport\.mjs merge/u);
  const manifestIndex = commands.indexOf("build-signed-manifest");
  const verifyIndex = commands.indexOf("verify-signed");
  assert.ok(manifestIndex >= 0 && verifyIndex > manifestIndex);
  assert.match(commands, /GITHUB_SHA/u);
  assert.match(commands, /GITHUB_RUN_ID/u);
  assert.match(commands, /signed-custody-darwin-\$\{GITHUB_SHA\}/u);
  assert.match(commands, /signed-custody-windows-\$\{GITHUB_SHA\}/u);
  assert.equal(assemble.steps.at(-1).name, "Remove merged signed transport");
  assert.equal(assemble.steps.at(-1).if, "always()");

  const uploads = assemble.steps.filter((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(uploads.filter((step) => step.with.name === "signed-release-artifacts").length, 1);
  const releaseUpload = uploads.find((step) => step.with.name === "signed-release-artifacts");
  assert.equal(
    releaseUpload.if,
    "github.event_name == 'workflow_dispatch' && inputs.operation == 'request-release-sign'",
  );
  assert.equal(releaseUpload.with.path, "${{ runner.temp }}/nexa-signed-release");
  assert.equal(releaseUpload.with["if-no-files-found"], "error");
});

test("reference Notes packaging uploads one canonical dual-platform unsigned signing input", () => {
  const workflow = parseYaml(
    readFileSync(
      new URL("../.github/workflows/reference-notes-package.yml", import.meta.url),
      "utf8",
    ),
  );
  const signingInput = workflow.jobs.signing_input;
  const commands = signingInput.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  assert.match(commands, /unsigned-signing-input\.mjs assemble/u);
  assert.match(commands, /unsigned-signing-input\.mjs verify/u);
  const upload = signingInput.steps.find((step) => step.with?.name === "unsigned-signing-input");
  assert.ok(upload?.uses.startsWith("actions/upload-artifact@"));
  assert.equal(upload.with.path, "${{ runner.temp }}/nexa-unsigned-signing-input");
  assert.equal(upload.with["if-no-files-found"], "error");
});

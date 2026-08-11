import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createCredentialSession,
  executeSigning as executeSigningImpl,
} from "./signing-executor.mjs";
import { loadSigningPolicy } from "./signing-policy.mjs";
import { createArchive, extractArchive } from "./archive-utils.mjs";
import { generateEvidence } from "./release-evidence.mjs";

const revision = "a".repeat(40);
const executorScript = fileURLToPath(new URL("./signing-executor.mjs", import.meta.url));

function executeSigning(options) {
  return executeSigningImpl({ revision, ...options });
}

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function dependencyGraph() {
  const npmRef = `urn:nexa:dependency:npm:sha256:${"a".repeat(64)}`;
  const cargoRef = `urn:nexa:dependency:cargo:sha256:${"b".repeat(64)}`;
  return {
    schemaVersion: 1,
    sources: [
      {
        ecosystem: "npm",
        lockfile: "pnpm-lock.yaml",
        resolver: "pnpm list --prod --json --depth Infinity",
        digest: { sha256: "c".repeat(64) },
      },
      {
        ecosystem: "cargo",
        lockfile: "Cargo.lock",
        resolver: "cargo metadata --locked --format-version 1",
        digest: { sha256: "d".repeat(64) },
      },
    ],
    roots: { npm: [npmRef], cargo: [cargoRef] },
    components: [
      {
        ref: cargoRef,
        ecosystem: "cargo",
        type: "library",
        name: "serde",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
      {
        ref: npmRef,
        ecosystem: "npm",
        type: "library",
        name: "@nexa/ui",
        version: "0.1.0",
      },
    ],
    dependencies: [
      { ref: cargoRef, dependsOn: [] },
      { ref: npmRef, dependsOn: [] },
    ],
  };
}

function writeDescriptor(descriptorPath, sourceRevision = revision) {
  const graph = dependencyGraph();
  writeFileSync(
    descriptorPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        release: { name: "nexa-notes", version: "0.1.0" },
        source: {
          repository: "https://github.com/baicie/nexa-ui",
          revision: sourceRevision,
          dirty: false,
        },
        build: {
          builderId: "https://github.com/baicie/nexa-ui/.github/workflows/release.yml",
          buildType: "https://nexa-ui.dev/build-types/technical-preview/v1",
          sourceDateEpoch: 1_786_233_600,
        },
        materials: graph.sources.map(({ lockfile, digest: materialDigest }) => ({
          uri: `https://github.com/baicie/nexa-ui/blob/${sourceRevision}/${lockfile}`,
          digest: materialDigest,
        })),
        dependencyGraph: graph,
      },
      null,
      2,
    )}\n`,
  );
}

function activePolicy() {
  const policy = structuredClone(loadSigningPolicy());
  policy.execution.state = "active";
  policy.execution.credentialActivation = "active";
  policy.execution.allowedOperations = ["validate", "request-staging-sign", "request-release-sign"];
  policy.execution.reason = "Fake-tool contract fixture";
  policy.credentials.darwin.owner = { status: "assigned", principal: "@nexa/macos-signing" };
  policy.credentials.win32.owner = { status: "assigned", principal: "@nexa/windows-signing" };
  policy.rollback.incidentOwner = { status: "assigned", principal: "@nexa/release-incident" };
  return policy;
}

function setup(platform) {
  const policy = activePolicy();
  const root = mkdtempSync(path.join(tmpdir(), "nexa-signing-executor-"));
  const unsignedDirectory = path.join(root, policy.artifacts.unsigned.root);
  mkdirSync(unsignedDirectory, { recursive: true });
  const name =
    platform === "darwin"
      ? "nexa-notes-0.1.0-macos-arm64-unsigned.tar.gz"
      : "nexa-notes-0.1.0-windows-x64-unsigned.zip";
  const fixture = path.join(root, "fixture");
  const nested =
    platform === "darwin"
      ? path.join(fixture, "Nexa.app/Contents/MacOS/NexaNotes")
      : path.join(fixture, "Nexa/NexaNotes.exe");
  mkdirSync(path.dirname(nested), { recursive: true });
  if (platform === "darwin") {
    writeFileSync(nested, Buffer.from("cafebabe000000010000000000000000", "hex"));
    chmodSync(nested, 0o755);
  } else {
    const pe = Buffer.alloc(128);
    pe.write("MZ", 0, "ascii");
    pe.writeUInt32LE(64, 60);
    pe.write("PE\0\0", 64, "ascii");
    writeFileSync(nested, pe);
  }
  const metadata =
    platform === "darwin"
      ? path.join(fixture, "Nexa.app/Contents/Resources/nexa-build.json")
      : path.join(fixture, "Nexa/nexa-build.json");
  mkdirSync(path.dirname(metadata), { recursive: true });
  writeFileSync(
    metadata,
    `${JSON.stringify({
      schemaVersion: 1,
      app: { id: "dev.nexa.notes", name: "Nexa", version: "0.1.0" },
      target: { platform, arch: platform === "darwin" ? "arm64" : "x64" },
    })}\n`,
  );
  const artifact = path.join(unsignedDirectory, name);
  createArchive(fixture, artifact, platform);
  const descriptorPath = path.join(root, "g6-05-descriptor.json");
  const evidenceDir = path.join(root, "g6-05-evidence");
  writeDescriptor(descriptorPath);
  generateEvidence({
    artifactsDir: unsignedDirectory,
    evidenceDir,
    descriptorPath,
  });
  return {
    policy,
    root,
    name,
    artifact,
    unsignedDirectory,
    unsignedEvidence: { descriptorPath, evidenceDir },
  };
}

function fakeTools(calls, failAt) {
  return ({ stage, executable, arguments: arguments_ }) => {
    calls.push({ stage, executable, arguments: arguments_ });
    if (stage === failAt) return { status: 1, stderr: `${stage} failed` };
    if (stage === "notary-submit")
      return { status: 0, stdout: '{"id":"fake-notary","status":"Accepted"}' };
    if (stage.endsWith("authenticode-verify")) {
      return {
        status: 0,
        stdout:
          '{"Status":"Valid","SignerCertificate":{"Thumbprint":"ABCDEF1234567890ABCDEF1234567890ABCDEF12"},"TimeStamperCertificate":{"Thumbprint":"1234567890ABCDEF1234567890ABCDEF12345678"}}',
      };
    }
    return { status: 0, stdout: `${stage} ok` };
  };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform} executor signs a copied artifact, records custody, and always cleans credentials`, (t) => {
    const current = setup(platform);
    t.after(() => rmSync(current.root, { recursive: true, force: true }));
    const before = digest(current.artifact);
    const calls = [];
    let cleanupCount = 0;

    const result = executeSigning({
      policy: current.policy,
      platform,
      custodyRoot: current.root,
      artifactName: current.name,
      unsignedEvidence: current.unsignedEvidence,
      toolRunner: fakeTools(calls),
      credentialSession: {
        activate() {
          return {
            identity: "Developer ID Application: Nexa Test",
            notaryProfile: "nexa-test-notary",
            signingKeychain: "/tmp/nexa-test-signing.keychain-db",
            notaryKeychain: "/tmp/nexa-test-signing.keychain-db",
            thumbprint: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            timestampUrl: "https://timestamp.invalid/rfc3161",
            cleanup() {
              cleanupCount += 1;
            },
          };
        },
      },
    });

    assert.equal(result.outcome, "signed");
    assert.equal(digest(current.artifact), before, "the unsigned input is never mutated");
    assert.equal(cleanupCount, 1);
    assert.ok(existsSync(result.artifact));
    assert.ok(existsSync(result.custodyRecord));
    assert.match(result.artifact, /-signed(?:\.tar\.gz|\.zip)$/u);
    assert.equal(statSync(result.artifact).mode & 0o222, 0, "signed output is sealed read-only");
    const custody = JSON.parse(readFileSync(result.custodyRecord, "utf8"));
    assert.equal(custody.outcome, "signed");
    assert.equal(custody.inputEvidence.schemaVersion, 1);
    assert.equal(custody.inputEvidence.artifactCount, 1);
    assert.deepEqual(custody.inputEvidence.descriptor, {
      name: path.basename(current.unsignedEvidence.descriptorPath),
      sha256: digest(current.unsignedEvidence.descriptorPath),
    });
    assert.deepEqual(
      custody.inputEvidence.outputs.map(({ name }) => name),
      ["SHA256SUMS", "provenance.intoto.jsonl", "sbom.cdx.json"],
    );
    for (const output of custody.inputEvidence.outputs) {
      assert.equal(
        output.sha256,
        digest(path.join(current.unsignedEvidence.evidenceDir, output.name)),
      );
    }
    assert.match(custody.inputEvidence.bundleSha256, /^[0-9a-f]{64}$/u);
    for (const evidenceName of [
      "SHA256SUMS",
      "sbom.cdx.json",
      "provenance.intoto.jsonl",
      "g6-05-descriptor.json",
      "g6-05-SHA256SUMS",
      "g6-05-sbom.cdx.json",
      "g6-05-provenance.intoto.jsonl",
    ]) {
      assert.ok(custody.evidence.includes(evidenceName));
      assert.ok(
        existsSync(
          path.join(
            path.dirname(result.artifact),
            `${path.basename(result.artifact)}.${evidenceName}`,
          ),
        ),
      );
    }
    assert.deepEqual(
      readFileSync(
        path.join(
          path.dirname(result.artifact),
          `${path.basename(result.artifact)}.g6-05-descriptor.json`,
        ),
      ),
      readFileSync(current.unsignedEvidence.descriptorPath),
    );
    for (const evidenceName of ["SHA256SUMS", "sbom.cdx.json", "provenance.intoto.jsonl"]) {
      assert.deepEqual(
        readFileSync(
          path.join(
            path.dirname(result.artifact),
            `${path.basename(result.artifact)}.g6-05-${evidenceName}`,
          ),
        ),
        readFileSync(path.join(current.unsignedEvidence.evidenceDir, evidenceName)),
      );
    }
    assert.equal(
      readFileSync(
        path.join(path.dirname(result.artifact), `${path.basename(result.artifact)}.SHA256SUMS`),
        "utf8",
      ),
      `${digest(result.artifact)}  ${path.basename(result.artifact)}\n`,
    );
    const sbom = JSON.parse(
      readFileSync(
        path.join(path.dirname(result.artifact), `${path.basename(result.artifact)}.sbom.cdx.json`),
        "utf8",
      ),
    );
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.equal(sbom.specVersion, "1.6");
    assert.equal(sbom.metadata.component.hashes[0].content, digest(result.artifact));
    const provenance = JSON.parse(
      readFileSync(
        path.join(
          path.dirname(result.artifact),
          `${path.basename(result.artifact)}.provenance.intoto.jsonl`,
        ),
        "utf8",
      ),
    );
    assert.equal(provenance.subject[0].name, path.basename(result.artifact));
    assert.equal(provenance.subject[0].digest.sha256, digest(result.artifact));
    assert.equal(provenance.predicate.buildDefinition.externalParameters.revision, revision);
    assert.deepEqual(
      provenance.predicate.buildDefinition.externalParameters.inputEvidence,
      custody.inputEvidence,
    );

    const expected =
      platform === "darwin"
        ? [
            "codesign-sign",
            "codesign-sign",
            "codesign-verify",
            "codesign-display",
            "notary-archive",
            "notary-submit",
            "notary-log",
            "stapler-staple",
            "stapler-validate",
            "spctl-assess",
            "fresh-codesign-verify",
            "fresh-stapler-validate",
            "fresh-spctl-assess",
            "fresh-launch",
          ]
        : [
            "signtool-sign",
            "signtool-verify",
            "authenticode-verify",
            "fresh-signtool-verify",
            "fresh-authenticode-verify",
            "fresh-launch",
          ];
    assert.deepEqual(
      calls.map(({ stage }) => stage),
      expected,
    );
    if (platform === "darwin") {
      assert.deepEqual(
        calls.map(({ executable }) => executable),
        [
          "/usr/bin/codesign",
          "/usr/bin/codesign",
          "/usr/bin/codesign",
          "/usr/bin/codesign",
          "/usr/bin/ditto",
          "/usr/bin/xcrun",
          "/usr/bin/xcrun",
          "/usr/bin/xcrun",
          "/usr/bin/xcrun",
          "/usr/sbin/spctl",
          "/usr/bin/codesign",
          "/usr/bin/xcrun",
          "/usr/sbin/spctl",
          calls.at(-1).executable,
        ],
      );
      assert.equal(calls[0].arguments.at(-1).endsWith("Contents/MacOS/NexaNotes"), true);
      assert.equal(calls[1].arguments.at(-1).endsWith("Nexa.app"), true);
      assert.deepEqual(calls[4].arguments.slice(0, 4), [
        "-c",
        "-k",
        "--keepParent",
        "--sequesterRsrc",
      ]);
      assert.deepEqual(calls[5].arguments.slice(0, 2), ["notarytool", "submit"]);
      assert.equal(calls[5].arguments[2].endsWith(".zip"), true);
      assert.deepEqual(calls[7].arguments.slice(0, 2), ["stapler", "staple"]);
      assert.equal(calls[7].arguments.at(-1).endsWith("Nexa.app"), true);
      assert.equal(calls[9].arguments.at(-1).endsWith("Nexa.app"), true);
      assert.equal(calls[9].arguments.at(-1).endsWith(".tar.gz"), false);
      for (const call of calls.filter(({ stage }) => /codesign/u.test(stage))) {
        assert.equal(call.arguments.includes("--keychain"), true);
        assert.equal(call.arguments.includes("/tmp/nexa-test-signing.keychain-db"), true);
      }
      for (const call of calls.filter(({ stage }) => stage.startsWith("notary-"))) {
        if (call.stage === "notary-archive") continue;
        assert.equal(call.arguments.includes("--keychain"), true);
        assert.equal(call.arguments.includes("/tmp/nexa-test-signing.keychain-db"), true);
      }
    } else {
      assert.equal(
        calls[0].executable,
        "C:/Program Files (x86)/Windows Kits/10/bin/x64/signtool.exe",
      );
      assert.deepEqual(calls[0].arguments.slice(0, 6), [
        "sign",
        "/fd",
        "SHA256",
        "/tr",
        "https://timestamp.invalid/rfc3161",
        "/td",
      ]);
      assert.match(calls[2].arguments[3], /Get-AuthenticodeSignature/u);
      assert.match(calls.at(-1).executable, /NexaNotes\.exe$/u);
    }
  });
}

test("tool or verification failure quarantines only the derived copy and cleans credentials", (t) => {
  const current = setup("darwin");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const before = digest(current.artifact);
  let cleanupCount = 0;

  assert.throws(
    () =>
      executeSigning({
        policy: current.policy,
        platform: "darwin",
        custodyRoot: current.root,
        artifactName: current.name,
        unsignedEvidence: current.unsignedEvidence,
        toolRunner: fakeTools([], "stapler-validate"),
        credentialSession: {
          activate: () => ({
            identity: "Developer ID Application: Nexa Test",
            notaryProfile: "nexa-test-notary",
            thumbprint: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            cleanup: () => {
              cleanupCount += 1;
            },
          }),
        },
      }),
    /stapler-validate failed/u,
  );

  const quarantine = path.join(
    current.root,
    current.policy.artifacts.quarantine.root,
    `${current.name.replace("-unsigned.tar.gz", "-quarantine.tar.gz")}.custody`,
    current.name.replace("-unsigned.tar.gz", "-quarantine.tar.gz"),
  );
  assert.equal(digest(current.artifact), before);
  assert.ok(existsSync(quarantine));
  assert.equal(statSync(quarantine).mode & 0o222, 0);
  assert.equal(cleanupCount, 1);
  const quarantineRecord = JSON.parse(readFileSync(`${quarantine}.custody.json`, "utf8"));
  assert.equal(quarantineRecord.schemaVersion, 3);
  assert.equal(
    quarantineRecord.inputEvidence.descriptor.sha256,
    digest(current.unsignedEvidence.descriptorPath),
  );
});

test("cleanup failure is reported without hiding the signing failure", (t) => {
  const current = setup("darwin");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));

  assert.throws(
    () =>
      executeSigning({
        policy: current.policy,
        platform: "darwin",
        custodyRoot: current.root,
        artifactName: current.name,
        unsignedEvidence: current.unsignedEvidence,
        toolRunner: fakeTools([], "stapler-validate"),
        credentialSession: {
          activate: () => ({
            identity: "Developer ID Application: Nexa Test",
            notaryProfile: "nexa-test-notary",
            thumbprint: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            cleanup: () => {
              throw new Error("ephemeral cleanup failed");
            },
          }),
        },
      }),
    /stapler-validate failed.*credential cleanup failed: ephemeral cleanup failed/u,
  );

  const quarantine = path.join(
    current.root,
    current.policy.artifacts.quarantine.root,
    `${current.name.replace("-unsigned.tar.gz", "-quarantine.tar.gz")}.custody`,
    current.name.replace("-unsigned.tar.gz", "-quarantine.tar.gz"),
  );
  assert.ok(existsSync(quarantine));
});

test("credential cleanup failure after successful tools leaves no publishable signed residue", (t) => {
  const current = setup("darwin");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));

  assert.throws(
    () =>
      executeSigning({
        policy: current.policy,
        platform: "darwin",
        custodyRoot: current.root,
        artifactName: current.name,
        unsignedEvidence: current.unsignedEvidence,
        toolRunner: fakeTools([]),
        credentialSession: {
          activate: () => ({
            identity: "Developer ID Application: Nexa Test",
            notaryProfile: "nexa-test-notary",
            cleanup: () => {
              throw new Error("cleanup after success failed");
            },
          }),
        },
      }),
    /signing completed but credential cleanup failed/u,
  );

  const signedName = current.name.replace("-unsigned.tar.gz", "-signed.tar.gz");
  const quarantineName = current.name.replace("-unsigned.tar.gz", "-quarantine.tar.gz");
  assert.equal(
    existsSync(
      path.join(current.root, current.policy.artifacts.signed.root, `${signedName}.custody`),
    ),
    false,
  );
  assert.equal(
    existsSync(
      path.join(
        current.root,
        current.policy.artifacts.quarantine.root,
        `${quarantineName}.custody`,
        quarantineName,
      ),
    ),
    true,
  );
});

test("executor refuses disabled credential activation before it can access a session", (t) => {
  const current = setup("win32");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const policy = structuredClone(loadSigningPolicy());
  let activated = false;

  assert.throws(
    () =>
      executeSigning({
        policy,
        platform: "win32",
        custodyRoot: current.root,
        artifactName: current.name,
        unsignedEvidence: current.unsignedEvidence,
        toolRunner: fakeTools([]),
        credentialSession: {
          activate: () => {
            activated = true;
            return { cleanup() {} };
          },
        },
      }),
    /credential activation is disabled/u,
  );
  assert.equal(activated, false);
});

test("unexpected executable code is rejected before credential activation", (t) => {
  for (const platform of ["darwin", "win32"]) {
    const current = setup(platform);
    t.after(() => rmSync(current.root, { recursive: true, force: true }));
    const fixture = path.join(current.root, "unexpected-fixture");
    const extra =
      platform === "darwin"
        ? path.join(fixture, "Nexa.app/Contents/Frameworks/Injected.dylib")
        : path.join(fixture, "Nexa/Injected.dll");
    mkdirSync(path.dirname(extra), { recursive: true });
    if (platform === "darwin") {
      writeFileSync(extra, Buffer.from("cafebabe000000010000000000000000", "hex"));
    } else {
      const pe = Buffer.alloc(128);
      pe.write("MZ", 0, "ascii");
      pe.writeUInt32LE(64, 60);
      pe.write("PE\0\0", 64, "ascii");
      writeFileSync(extra, pe);
    }
    const extracted = path.join(current.root, "repack");
    // Recreate the valid fixture through extraction, then add the unexpected code.
    extractArchive(current.artifact, extracted, platform);
    const relativeExtra = path.relative(fixture, extra);
    const destination = path.join(extracted, relativeExtra);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(extra));
    rmSync(current.artifact);
    createArchive(extracted, current.artifact, platform);
    generateEvidence({
      artifactsDir: current.unsignedDirectory,
      evidenceDir: current.unsignedEvidence.evidenceDir,
      descriptorPath: current.unsignedEvidence.descriptorPath,
    });
    let activated = false;
    assert.throws(
      () =>
        executeSigning({
          policy: current.policy,
          platform,
          custodyRoot: current.root,
          artifactName: current.name,
          unsignedEvidence: current.unsignedEvidence,
          toolRunner: fakeTools([]),
          credentialSession: {
            activate() {
              activated = true;
              return { cleanup() {} };
            },
          },
        }),
      /allowlist/u,
    );
    assert.equal(activated, false);
  }
});

test("Windows verification requires the approved signer and an RFC3161 timestamp", (t) => {
  const current = setup("win32");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  assert.throws(
    () =>
      executeSigning({
        policy: current.policy,
        platform: "win32",
        custodyRoot: current.root,
        artifactName: current.name,
        unsignedEvidence: current.unsignedEvidence,
        toolRunner: ({ stage }) => {
          if (stage === "authenticode-verify") {
            return {
              status: 0,
              stdout:
                '{"Status":"Valid","SignerCertificate":{"Thumbprint":"0000000000000000000000000000000000000000"},"TimeStamperCertificate":null}',
            };
          }
          return { status: 0, stdout: `${stage} ok` };
        },
        credentialSession: {
          activate: () => ({
            thumbprint: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            timestampUrl: "https://timestamp.invalid/rfc3161",
            cleanup() {},
          }),
        },
      }),
    /thumbprint|timestamp/u,
  );
});

test("executor requires explicit G6-05 input before credential activation", (t) => {
  const current = setup("win32");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  let activated = false;

  assert.throws(
    () =>
      executeSigningImpl({
        revision,
        policy: current.policy,
        platform: "win32",
        custodyRoot: current.root,
        artifactName: current.name,
        toolRunner: fakeTools([]),
        credentialSession: {
          activate() {
            activated = true;
            return { cleanup() {} };
          },
        },
      }),
    /unsignedEvidence with descriptorPath and evidenceDir is required/u,
  );
  assert.equal(activated, false);
});

test("executor rejects a missing unsigned artifact before credential activation", (t) => {
  const current = setup("win32");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  rmSync(current.artifact);
  let activated = false;

  assert.throws(
    () =>
      executeSigning({
        policy: current.policy,
        platform: "win32",
        custodyRoot: current.root,
        artifactName: current.name,
        unsignedEvidence: current.unsignedEvidence,
        toolRunner: fakeTools([]),
        credentialSession: {
          activate() {
            activated = true;
            return { cleanup() {} };
          },
        },
      }),
    /unsigned artifact does not exist/u,
  );
  assert.equal(activated, false);
});

test("executor rejects a tampered unsigned artifact before credential activation", (t) => {
  const current = setup("win32");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const unpacked = path.join(current.root, "tampered-unsigned");
  extractArchive(current.artifact, unpacked, "win32");
  const metadata = path.join(unpacked, "Nexa", "nexa-build.json");
  writeFileSync(metadata, `${readFileSync(metadata, "utf8").trim()}\n\n`);
  rmSync(current.artifact);
  createArchive(unpacked, current.artifact, "win32");
  let activated = false;

  assert.throws(
    () =>
      executeSigning({
        policy: current.policy,
        platform: "win32",
        custodyRoot: current.root,
        artifactName: current.name,
        unsignedEvidence: current.unsignedEvidence,
        toolRunner: fakeTools([]),
        credentialSession: {
          activate() {
            activated = true;
            return { cleanup() {} };
          },
        },
      }),
    /SHA256SUMS does not match the release artifacts/u,
  );
  assert.equal(activated, false);
});

test("executor rejects G6-05 evidence for a different revision before credential activation", (t) => {
  const current = setup("darwin");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  writeDescriptor(current.unsignedEvidence.descriptorPath, "b".repeat(40));
  generateEvidence({
    artifactsDir: current.unsignedDirectory,
    evidenceDir: current.unsignedEvidence.evidenceDir,
    descriptorPath: current.unsignedEvidence.descriptorPath,
  });
  let activated = false;

  assert.throws(
    () =>
      executeSigning({
        policy: current.policy,
        platform: "darwin",
        custodyRoot: current.root,
        artifactName: current.name,
        unsignedEvidence: current.unsignedEvidence,
        toolRunner: fakeTools([]),
        credentialSession: {
          activate() {
            activated = true;
            return { cleanup() {} };
          },
        },
      }),
    /G6-05 descriptor revision does not match the signing revision/u,
  );
  assert.equal(activated, false);
});

test("executor rejects unsigned artifacts added after G6-05 evidence generation", (t) => {
  const current = setup("darwin");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  writeFileSync(path.join(current.unsignedDirectory, "unexpected-unsigned.tar.gz"), "extra\n");
  let activated = false;

  assert.throws(
    () =>
      executeSigning({
        policy: current.policy,
        platform: "darwin",
        custodyRoot: current.root,
        artifactName: current.name,
        unsignedEvidence: current.unsignedEvidence,
        toolRunner: fakeTools([]),
        credentialSession: {
          activate() {
            activated = true;
            return { cleanup() {} };
          },
        },
      }),
    /SHA256SUMS does not match the release artifacts/u,
  );
  assert.equal(activated, false);
});

test("platform credential sessions import only on activation and clean exact ephemeral material", (t) => {
  for (const platform of ["darwin", "win32"]) {
    const sessionRoot = mkdtempSync(path.join(tmpdir(), `nexa-credential-${platform}-`));
    t.after(() => rmSync(sessionRoot, { recursive: true, force: true }));
    const environment =
      platform === "darwin"
        ? {
            NEXA_MACOS_CERTIFICATE_P12: Buffer.from("fake-p12").toString("base64"),
            NEXA_MACOS_CERTIFICATE_PASSWORD: "p12-password",
            NEXA_APPLE_NOTARY_KEY_P8: Buffer.from("fake-p8").toString("base64"),
            NEXA_MACOS_SIGNING_IDENTITY: "Developer ID Application: Nexa Test",
            NEXA_APPLE_NOTARY_KEY_ID: "KEY123",
            NEXA_APPLE_NOTARY_ISSUER_ID: "issuer-123",
            NEXA_SIGNING_SESSION_ROOT: sessionRoot,
          }
        : {
            NEXA_WINDOWS_CERTIFICATE_PFX: Buffer.from("fake-pfx").toString("base64"),
            NEXA_WINDOWS_CERTIFICATE_PASSWORD: "pfx-password",
            NEXA_WINDOWS_CERTIFICATE_THUMBPRINT: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            NEXA_WINDOWS_RFC3161_TIMESTAMP_URL: "https://timestamp.invalid/rfc3161",
            NEXA_SIGNING_SESSION_ROOT: sessionRoot,
          };
    const calls = [];
    const credentialSession = createCredentialSession({
      platform,
      environment,
      commandRunner(request) {
        calls.push(request);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(calls.length, 0, "constructing a session must not access credentials");

    const activated = credentialSession.activate({ workingDirectory: sessionRoot });
    assert.ok(calls.length >= 1);
    assert.equal(typeof activated.cleanup, "function");
    if (platform === "darwin") {
      assert.equal(activated.identity, "Developer ID Application: Nexa Test");
      assert.equal(activated.notaryProfile, "nexa-technical-preview");
      assert.match(activated.keychain, /signing\.keychain-db$/u);
      assert.equal(environment.NEXA_MACOS_CERTIFICATE_P12, undefined);
      assert.equal(environment.NEXA_MACOS_CERTIFICATE_PASSWORD, undefined);
      assert.equal(environment.NEXA_APPLE_NOTARY_KEY_P8, undefined);
      assert.ok(calls.some(({ stage }) => stage === "macos-import-certificate"));
      assert.ok(calls.some(({ stage }) => stage === "macos-store-notary-credentials"));
    } else {
      assert.equal(activated.thumbprint, "ABCDEF1234567890ABCDEF1234567890ABCDEF12");
      assert.equal(activated.certificateStore, "NexaTechnicalPreview");
      assert.equal(environment.NEXA_WINDOWS_CERTIFICATE_PFX, undefined);
      assert.equal(environment.NEXA_WINDOWS_CERTIFICATE_PASSWORD, undefined);
      assert.ok(calls.some(({ stage }) => stage === "windows-import-certificate"));
    }

    activated.cleanup();
    assert.equal(existsSync(sessionRoot), false);
    assert.ok(calls.some(({ stage }) => stage.endsWith("cleanup-credential")));
  }
});

test("executor CLI exposes execute while fail-closed policy prevents credential access", (t) => {
  const current = setup("win32");
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      executorScript,
      "execute",
      "--custody-root",
      current.root,
      "--artifact-name",
      current.name,
      "--platform",
      "win32",
      "--descriptor",
      current.unsignedEvidence.descriptorPath,
      "--evidence",
      current.unsignedEvidence.evidenceDir,
      "--revision",
      revision,
    ],
    { encoding: "utf8", env: {} },
  );
  assert.equal(result.status, 64);
  assert.match(result.stderr, /credential activation is disabled/u);
  assert.doesNotMatch(result.stderr, /NEXA_WINDOWS_CERTIFICATE/u);
});

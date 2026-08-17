import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateEvidence, verifyEvidence } from "./release-evidence.mjs";

const policyPath = new URL("../release/artifact-integrity.json", import.meta.url);
const scriptPath = fileURLToPath(new URL("./release-evidence.mjs", import.meta.url));

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
        purl: "pkg:cargo/serde@1.0.0",
        license: "MIT OR Apache-2.0",
      },
      {
        ref: npmRef,
        ecosystem: "npm",
        type: "library",
        name: "@nexa/ui",
        version: "0.1.0",
        purl: "pkg:npm/%40nexa/ui@0.1.0",
        license: "MIT OR Apache-2.0",
      },
    ],
    dependencies: [
      { ref: cargoRef, dependsOn: [] },
      { ref: npmRef, dependsOn: [] },
    ],
  };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-release-evidence-"));
  const artifactsDir = path.join(root, "artifacts");
  const evidenceDir = path.join(root, "evidence");
  const descriptorPath = path.join(root, "descriptor.json");
  mkdirSync(path.join(artifactsDir, "npm"), { recursive: true });
  writeFileSync(path.join(artifactsDir, "nexa-notes-darwin-arm64.tar.gz"), "native-app\n");
  writeFileSync(path.join(artifactsDir, "npm", "nexa-ui-0.1.0.tgz"), "npm-package\n");
  writeFileSync(
    descriptorPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        release: { name: "nexa-ui", version: "0.1.0" },
        source: {
          repository: "https://github.com/baicie/nexa-ui",
          revision: "0123456789abcdef0123456789abcdef01234567",
          dirty: false,
        },
        build: {
          builderId: "https://github.com/baicie/nexa-ui/.github/workflows/release.yml",
          buildType: "https://nexa-ui.dev/build-types/technical-preview/v1",
          sourceDateEpoch: 1_786_233_600,
        },
        materials: dependencyGraph().sources.map(({ lockfile, digest }) => ({
          uri: `https://github.com/baicie/nexa-ui/blob/0123456789abcdef0123456789abcdef01234567/${lockfile}`,
          digest,
        })),
        dependencyGraph: dependencyGraph(),
      },
      null,
      2,
    )}\n`,
  );
  return { root, artifactsDir, evidenceDir, descriptorPath };
}

test("generation emits deterministic checksums, CycloneDX SBOM, and SLSA provenance", (t) => {
  const first = fixture();
  const second = fixture();
  t.after(() => rmSync(first.root, { recursive: true, force: true }));
  t.after(() => rmSync(second.root, { recursive: true, force: true }));

  // Create the second fixture in a different directory-entry order.
  rmSync(second.artifactsDir, { recursive: true, force: true });
  mkdirSync(second.artifactsDir, { recursive: true });
  writeFileSync(path.join(second.artifactsDir, "nexa-notes-darwin-arm64.tar.gz"), "native-app\n");
  mkdirSync(path.join(second.artifactsDir, "npm"));
  writeFileSync(path.join(second.artifactsDir, "npm", "nexa-ui-0.1.0.tgz"), "npm-package\n");

  const firstResult = generateEvidence({ ...first, policyPath });
  generateEvidence({ ...second, policyPath });

  assert.equal(firstResult.artifactCount, 2);
  assert.deepEqual(firstResult.outputs, ["SHA256SUMS", "sbom.cdx.json", "provenance.intoto.jsonl"]);
  for (const output of firstResult.outputs) {
    assert.equal(
      readFileSync(path.join(first.evidenceDir, output), "utf8"),
      readFileSync(path.join(second.evidenceDir, output), "utf8"),
      `${output} must be byte-for-byte deterministic`,
    );
  }

  const checksums = readFileSync(path.join(first.evidenceDir, "SHA256SUMS"), "utf8");
  assert.equal(
    checksums,
    "43f6815f8c48d9c836e64b9711160295f03e01b2741ed14ac5de4d33902e2052  nexa-notes-darwin-arm64.tar.gz\n" +
      "116eb308dc2bf9de2c0c276824318c02a56c84bf7ccda8a201f6e65695ee5f78  npm/nexa-ui-0.1.0.tgz\n",
  );

  const sbom = JSON.parse(readFileSync(path.join(first.evidenceDir, "sbom.cdx.json"), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.metadata.timestamp, "2026-08-09T00:00:00.000Z");
  assert.deepEqual(
    sbom.components
      .filter(({ type }) => type === "file")
      .map((component) => [component.name, component.hashes[0].content]),
    [
      [
        "nexa-notes-darwin-arm64.tar.gz",
        "43f6815f8c48d9c836e64b9711160295f03e01b2741ed14ac5de4d33902e2052",
      ],
      ["npm/nexa-ui-0.1.0.tgz", "116eb308dc2bf9de2c0c276824318c02a56c84bf7ccda8a201f6e65695ee5f78"],
    ],
  );
  assert.deepEqual(
    sbom.components
      .filter(({ type }) => type === "library")
      .map(({ name, version, purl }) => [name, version, purl]),
    [
      ["serde", "1.0.0", "pkg:cargo/serde@1.0.0"],
      ["@nexa/ui", "0.1.0", "pkg:npm/%40nexa/ui@0.1.0"],
    ],
  );
  assert.deepEqual(sbom.dependencies[0], {
    ref: sbom.metadata.component["bom-ref"],
    dependsOn: [...dependencyGraph().roots.cargo, ...dependencyGraph().roots.npm].sort(),
  });
  assert.deepEqual(sbom.dependencies.slice(1), dependencyGraph().dependencies);

  const provenance = JSON.parse(
    readFileSync(path.join(first.evidenceDir, "provenance.intoto.jsonl"), "utf8"),
  );
  assert.equal(provenance._type, "https://in-toto.io/Statement/v1");
  assert.equal(provenance.predicateType, "https://slsa.dev/provenance/v1");
  assert.equal(
    provenance.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit,
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.deepEqual(
    provenance.subject.map((subject) => [subject.name, subject.digest.sha256]),
    [
      [
        "nexa-notes-darwin-arm64.tar.gz",
        "43f6815f8c48d9c836e64b9711160295f03e01b2741ed14ac5de4d33902e2052",
      ],
      ["npm/nexa-ui-0.1.0.tgz", "116eb308dc2bf9de2c0c276824318c02a56c84bf7ccda8a201f6e65695ee5f78"],
    ],
  );
});

test("verification accepts canonical evidence and rejects artifact changes", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  generateEvidence({ ...current, policyPath });

  assert.deepEqual(verifyEvidence({ ...current, policyPath }), {
    artifactCount: 2,
    outputs: ["SHA256SUMS", "sbom.cdx.json", "provenance.intoto.jsonl"],
  });

  writeFileSync(path.join(current.artifactsDir, "nexa-notes-darwin-arm64.tar.gz"), "tampered\n");
  assert.throws(
    () => verifyEvidence({ ...current, policyPath }),
    /SHA256SUMS does not match the release artifacts/u,
  );
});

test("verification fails closed for missing, extra, or modified evidence", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  generateEvidence({ ...current, policyPath });

  writeFileSync(path.join(current.evidenceDir, "sbom.cdx.json"), "{}\n");
  assert.throws(
    () => verifyEvidence({ ...current, policyPath }),
    /sbom\.cdx\.json is not canonical/u,
  );

  generateEvidence({ ...current, policyPath });
  writeFileSync(path.join(current.artifactsDir, "unexpected.zip"), "unexpected\n");
  assert.throws(
    () => verifyEvidence({ ...current, policyPath }),
    /SHA256SUMS does not match the release artifacts/u,
  );

  rmSync(path.join(current.artifactsDir, "unexpected.zip"));
  rmSync(path.join(current.evidenceDir, "provenance.intoto.jsonl"));
  assert.throws(
    () => verifyEvidence({ ...current, policyPath }),
    /missing evidence file: provenance\.intoto\.jsonl/u,
  );
});

test("generation rejects symlinked artifacts and overlapping output paths", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  symlinkSync(
    path.join(current.artifactsDir, "nexa-notes-darwin-arm64.tar.gz"),
    path.join(current.artifactsDir, "alias.tar.gz"),
  );

  assert.throws(
    () => generateEvidence({ ...current, policyPath }),
    /symlink artifact is not allowed/u,
  );
  assert.throws(
    () => generateEvidence({ ...current, evidenceDir: current.artifactsDir, policyPath }),
    /artifact and evidence directories must not overlap/u,
  );
});

test("generation rejects a dependency graph with an unknown edge", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const descriptor = JSON.parse(readFileSync(current.descriptorPath, "utf8"));
  descriptor.dependencyGraph.dependencies[0].dependsOn = ["urn:nexa:dependency:unknown"];
  writeFileSync(current.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  assert.throws(
    () => generateEvidence({ ...current, policyPath }),
    /unknown dependency reference/u,
  );
});

test("generation binds dependency graph sources to provenance materials", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const descriptor = JSON.parse(readFileSync(current.descriptorPath, "utf8"));
  descriptor.dependencyGraph.sources[0].digest.sha256 = "e".repeat(64);
  writeFileSync(current.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  assert.throws(() => generateEvidence({ ...current, policyPath }), /dependency source.*material/u);
});

test("command line generation and verification use the documented standalone contract", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));
  const arguments_ = [
    "--artifacts",
    current.artifactsDir,
    "--evidence",
    current.evidenceDir,
    "--descriptor",
    current.descriptorPath,
    "--policy",
    fileURLToPath(policyPath),
  ];

  const generated = spawnSync(process.execPath, [scriptPath, "generate", ...arguments_], {
    encoding: "utf8",
  });
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /generated release evidence for 2 artifacts/u);

  const verified = spawnSync(process.execPath, [scriptPath, "verify", ...arguments_], {
    encoding: "utf8",
  });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /verified release evidence for 2 artifacts/u);
});

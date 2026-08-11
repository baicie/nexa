import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import {
  assertFinalNpmPublication,
  buildPublicationRecord,
  evaluateReleaseReconciliation,
  expectedGithubReleaseAssetNames,
  verifyGithubReleaseAssets,
} from "./github-release.mjs";

const version = "0.1.0";
const revision = "a".repeat(40);
const tag = `v${version}`;
const publicPackageNames = JSON.parse(
  readFileSync(new URL("../release/packages.json", import.meta.url), "utf8"),
).npm.public.map(({ name }) => name);
const signedNames = [
  `nexa-notes-${version}-macos-arm64-signed.tar.gz`,
  `nexa-notes-${version}-windows-x64-signed.zip`,
];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeCanonicalJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function releaseAssetFixture(root) {
  mkdirSync(root);
  for (const name of signedNames) writeFileSync(path.join(root, name), `${name}\n`);
  const archives = signedNames.map((name, index) => ({
    name,
    size: readFileSync(path.join(root, name)).byteLength,
    sha256: digest(readFileSync(path.join(root, name))),
    platform: index === 0 ? "darwin" : "win32",
  }));
  const release = { name: "nexa-ui", version, tag, revision };
  const custody = {
    schemaVersion: 1,
    release,
    signing: {
      workflow: ".github/workflows/signing.yml",
      runId: "202",
      transportManifest: {
        name: "signed-release-artifacts.manifest.json",
        sha256: "b".repeat(64),
      },
    },
    platforms: archives.map((archive) => ({
      platform: archive.platform,
      archive: { name: archive.name, size: archive.size, sha256: archive.sha256 },
      custody: { name: `${archive.name}.custody.json`, sha256: "c".repeat(64) },
      inputEvidenceBundleSha256: "d".repeat(64),
      executor: { version: "1.2.0", sha256: "e".repeat(64), closureSha256: "f".repeat(64) },
    })),
  };
  writeCanonicalJson(path.join(root, "signing-custody.json"), custody);
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": `pkg:generic/nexa-ui@${version}`,
        name: "nexa-ui",
        version,
        properties: [
          { name: "nexa:source:revision", value: revision },
          { name: "nexa:release:tag", value: tag },
        ],
      },
    },
    components: archives.map((archive) => ({
      type: "file",
      "bom-ref": `urn:nexa:release-asset:sha256:${archive.sha256}`,
      name: archive.name,
      hashes: [{ alg: "SHA-256", content: archive.sha256 }],
      properties: [{ name: "nexa:artifact:size", value: String(archive.size) }],
    })),
    dependencies: [
      {
        ref: `pkg:generic/nexa-ui@${version}`,
        dependsOn: archives.map(({ sha256 }) => `urn:nexa:release-asset:sha256:${sha256}`),
      },
      ...archives.map(({ sha256 }) => ({
        ref: `urn:nexa:release-asset:sha256:${sha256}`,
        dependsOn: [],
      })),
    ],
  };
  writeCanonicalJson(path.join(root, "sbom.cdx.json"), sbom);
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: archives.map(({ name, sha256 }) => ({ name, digest: { sha256 } })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://nexa-ui.dev/build-types/github-release/v1",
        externalParameters: { release },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/baicie/nexa-ui@${revision}`,
            digest: { gitCommit: revision },
          },
          {
            uri: "signed-transport/signed-release-artifacts.manifest.json",
            digest: { sha256: "b".repeat(64) },
          },
        ],
      },
      runDetails: {
        builder: {
          id: `https://github.com/baicie/nexa-ui/.github/workflows/release.yml@${revision}`,
        },
      },
    },
  };
  writeFileSync(path.join(root, "provenance.intoto.jsonl"), `${JSON.stringify(provenance)}\n`);
  const payloadNames = [
    ...signedNames,
    "provenance.intoto.jsonl",
    "sbom.cdx.json",
    "signing-custody.json",
  ];
  const manifest = {
    schemaVersion: 1,
    release: { ...release, draft: true, prerelease: true },
    signing: { workflow: ".github/workflows/signing.yml", runId: "202" },
    notes: { name: `v${version}.md`, sha256: "1".repeat(64) },
    assets: payloadNames.sort().map((name) => ({
      name,
      size: readFileSync(path.join(root, name)).byteLength,
      sha256: digest(readFileSync(path.join(root, name))),
    })),
  };
  writeCanonicalJson(path.join(root, "release-manifest.json"), manifest);
  const checksumNames = [...payloadNames, "release-manifest.json"].sort();
  writeFileSync(
    path.join(root, "SHA256SUMS"),
    checksumNames
      .map((name) => `${digest(readFileSync(path.join(root, name)))}  ${name}\n`)
      .join(""),
  );
  return { archives, manifest };
}

test("the Technical Preview release has an exact seven-file public asset allowlist", () => {
  assert.deepEqual(expectedGithubReleaseAssetNames(version), [
    "SHA256SUMS",
    `nexa-notes-${version}-macos-arm64-signed.tar.gz`,
    `nexa-notes-${version}-windows-x64-signed.zip`,
    "provenance.intoto.jsonl",
    "release-manifest.json",
    "sbom.cdx.json",
    "signing-custody.json",
  ]);
});

test("fresh release verification cross-binds every release-level document", (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "nexa-github-release-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "assets");
  releaseAssetFixture(root);

  const verified = verifyGithubReleaseAssets({
    assetsDirectory: root,
    version,
    revision,
    ref: `refs/tags/${tag}`,
    signingRunId: "202",
    notesName: `v${version}.md`,
    notesSha256: "1".repeat(64),
    repository: "baicie/nexa-ui",
  });
  assert.equal(verified.assets.length, 7);

  const manifestFile = path.join(root, "release-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.release.revision = "0".repeat(40);
  writeCanonicalJson(manifestFile, manifest);
  const checksumNames = expectedGithubReleaseAssetNames(version).filter(
    (name) => name !== "SHA256SUMS",
  );
  writeFileSync(
    path.join(root, "SHA256SUMS"),
    checksumNames
      .map((name) => `${digest(readFileSync(path.join(root, name)))}  ${name}\n`)
      .join(""),
  );
  assert.throws(
    () =>
      verifyGithubReleaseAssets({
        assetsDirectory: root,
        version,
        revision,
        ref: `refs/tags/${tag}`,
        signingRunId: "202",
        notesName: `v${version}.md`,
        notesSha256: "1".repeat(64),
        repository: "baicie/nexa-ui",
      }),
    /manifest release identity/u,
  );
});

test("draft reconciliation uploads only missing assets and rejects substitutions", () => {
  const localAssets = expectedGithubReleaseAssetNames(version).map((name, index) => ({
    name,
    size: index + 10,
    sha256: String(index).padStart(64, "0"),
  }));
  const observed = localAssets.slice(0, 2).map((entry, index) => ({
    id: index + 1,
    name: entry.name,
    size: entry.size,
    sha256: entry.sha256,
  }));
  assert.deepEqual(
    evaluateReleaseReconciliation({
      release: {
        id: 7,
        tag_name: tag,
        target_commitish: revision,
        name: `Nexa UI ${tag} Technical Preview`,
        body: "notes\n",
        draft: true,
        prerelease: true,
      },
      version,
      revision,
      notes: "notes\n",
      localAssets,
      observedAssets: observed,
    }).missing,
    localAssets.slice(2).map(({ name }) => name),
  );

  const substituted = structuredClone(observed);
  substituted[0].sha256 = "f".repeat(64);
  assert.throws(
    () =>
      evaluateReleaseReconciliation({
        release: {
          id: 7,
          tag_name: tag,
          target_commitish: revision,
          name: `Nexa UI ${tag} Technical Preview`,
          body: "notes\n",
          draft: true,
          prerelease: true,
        },
        version,
        revision,
        notes: "notes\n",
        localAssets,
        observedAssets: substituted,
      }),
    /digest mismatch/u,
  );
  assert.throws(
    () =>
      evaluateReleaseReconciliation({
        release: {
          id: 7,
          tag_name: tag,
          target_commitish: revision,
          name: `Nexa UI ${tag} Technical Preview`,
          body: "notes\n",
          draft: true,
          prerelease: true,
        },
        version,
        revision,
        notes: "notes\n",
        localAssets,
        observedAssets: [{ id: 9, name: "unexpected.zip", size: 1, sha256: "0".repeat(64) }],
      }),
    /unexpected release asset/u,
  );
});

function finalNpmResult() {
  return {
    version,
    revision,
    ref: `refs/tags/${tag}`,
    phase: "final",
    packages: publicPackageNames.map((name) => ({
      name,
      version,
      tarball: `/tmp/${name.replace("@nexa/", "")}.tgz`,
      integrity: `sha512-${name}`,
    })),
    signedArtifacts: signedNames,
    channel: "technical-preview",
    targetTag: "technical-preview",
    promotesPublicChannel: true,
    resume: false,
    executed: true,
    registry: {
      state: "complete",
      published: publicPackageNames,
      remaining: [],
      promotions: [],
    },
  };
}

test("a GitHub Release cannot become public before the final npm channel converges", () => {
  assert.equal(assertFinalNpmPublication(finalNpmResult()).channel, "technical-preview");
  const pending = finalNpmResult();
  pending.registry.promotions.push(publicPackageNames[0]);
  assert.throws(() => assertFinalNpmPublication(pending), /channel did not converge/u);
  const bootstrap = finalNpmResult();
  bootstrap.phase = "bootstrap";
  assert.throws(() => assertFinalNpmPublication(bootstrap), /final npm publication/u);
});

test("publication record binds the release, signing run, assets, and npm channel", () => {
  const assets = expectedGithubReleaseAssetNames(version).map((name, index) => ({
    name,
    size: index + 10,
    sha256: String(index).padStart(64, "0"),
  }));
  const record = buildPublicationRecord({
    release: {
      id: 7,
      html_url: `https://github.com/baicie/nexa-ui/releases/tag/${tag}`,
      tag_name: tag,
      target_commitish: revision,
      draft: false,
      prerelease: true,
      published_at: "2026-08-11T00:00:00Z",
    },
    repository: "baicie/nexa-ui",
    releaseRunId: "303",
    signingRunId: "202",
    assets,
    npmPublication: finalNpmResult(),
  });
  assert.equal(record.outcome, "published");
  assert.equal(record.release.id, 7);
  assert.equal(record.signing.runId, "202");
  assert.equal(record.publication.runId, "303");
  assert.equal(record.npm.channel, "technical-preview");
  assert.deepEqual(record.assets, assets);
});

test("release workflow keeps bootstrap npm-only and publishes the draft after final convergence", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  );
  assert.equal(workflow.jobs.publish.permissions.attestations, "write");
  const steps = workflow.jobs.publish.steps;
  const githubSteps = steps.filter(
    (step) =>
      `${step.name ?? ""}\n${step.run ?? ""}`.includes("GitHub Release") ||
      `${step.run ?? ""}`.includes("github-release.mjs"),
  );
  assert.ok(githubSteps.length >= 3);
  for (const step of githubSteps) {
    assert.match(String(step.if), /PUBLICATION_PHASE == 'final'/u);
  }
  const attest = steps.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
  assert.match(attest.uses, /^actions\/attest-build-provenance@[0-9a-f]{40}$/u);
  assert.match(String(attest.if), /PUBLICATION_PHASE == 'final'/u);

  const commands = steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
  const reconcileAt = commands.indexOf("github-release.mjs reconcile");
  const npmAt = commands.indexOf("publish-release.mjs publish --execute");
  const finalizeAt = commands.indexOf("github-release.mjs finalize");
  assert.ok(reconcileAt >= 0 && npmAt > reconcileAt && finalizeAt > npmAt);
  assert.doesNotMatch(commands, /gh release upload[^\n]*--clobber/u);

  const publicationUpload = steps.find(
    (step) => step.with?.name === "technical-preview-publication-record",
  );
  assert.match(String(publicationUpload.if), /PUBLICATION_PHASE == 'final'/u);

  const implementation = readFileSync(new URL("./github-release.mjs", import.meta.url), "utf8");
  assert.match(implementation, /"release",\s*"upload"/u);
  assert.doesNotMatch(implementation, /--clobber/u);
});

test("GitHub Release CLI rejects unknown options before touching inputs", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./github-release.mjs", import.meta.url).pathname, "prepare", "--unknown", "value"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown prepare option/u);
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { findUnpinnedActions } from "./action-sha-policy.mjs";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("all external GitHub Actions are pinned to immutable full-length SHAs", () => {
  const workflowFiles = readdirSync(new URL("../.github/workflows/", import.meta.url))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`);
  const violations = [];
  for (const file of workflowFiles) {
    violations.push(...findUnpinnedActions(read(file), file));
  }
  assert.deepEqual(violations, []);
});

test("Action SHA policy rejects a symbolic external Action reference", () => {
  assert.deepEqual(findUnpinnedActions("steps:\n  - uses: owner/action@v1\n", "fixture.yml"), [
    "fixture.yml:2: owner/action@v1",
  ]);
});

test("security workflow scans every dependency graph and fails closed", () => {
  const workflow = read(".github/workflows/security.yml");
  const ci = read(".github/workflows/ci.yml");

  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
  for (const lockfile of [
    "Cargo.lock",
    "packages/nui-host/Cargo.lock",
    "packages/system-host/Cargo.lock",
    "tools/windows-static-closure/Cargo.lock",
  ]) {
    assert.match(workflow, new RegExp(lockfile.replaceAll("/", "\\/"), "u"));
  }
  assert.match(workflow, /tools\/windows-static-closure\/Cargo\.toml/u);
  for (const command of [
    "pnpm audit --audit-level=high",
    "cargo audit",
    "cargo deny",
    "gitleaks",
    "node tools/license-policy.mjs",
    "node tools/action-sha-policy.mjs",
  ]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(ci, /^  security:\n/m);
  assert.match(ci, /security\.yml/u);
  assert.match(ci, /SECURITY_NEEDED/u);
  assert.match(ci, /SECURITY_STATUS/u);
});

test("security workflow pins compatible Rust scanners and invokes cargo deny correctly", () => {
  const workflow = read(".github/workflows/security.yml");

  assert.match(workflow, /cargo install cargo-audit --locked --version 0\.22\.2/u);
  assert.match(workflow, /cargo install cargo-deny --locked --version 0\.20\.2/u);
  assert.match(
    workflow,
    /cargo deny --locked --manifest-path "\$\{\{ matrix\.manifest \}\}" --config "\$GITHUB_WORKSPACE\/deny\.toml" check advisories bans licenses sources/u,
  );
});

test("Dependabot covers every independently locked Cargo root", () => {
  const dependabot = read(".github/dependabot.yml");

  for (const directory of [
    "/",
    "/packages/nui-host",
    "/packages/system-host",
    "/tools/windows-static-closure",
  ]) {
    const escaped = directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(
      dependabot,
      new RegExp(`- package-ecosystem: cargo\\s+directory: ${escaped}(?:\\s|$)`, "u"),
    );
  }
});

test("cargo deny rejects registry wildcards while allowing private path dependencies", () => {
  const deny = read("deny.toml");

  assert.match(deny, /wildcards = "deny"/u);
  assert.match(deny, /allow-wildcard-paths = true/u);
});

test("Perry host dependencies bind the audited revision to its declared version", () => {
  const dependency =
    /perry-ffi = \{ git = "https:\/\/github\.com\/PerryTS\/perry", rev = "06137858dc8c6f80975238377138f2f948d6ef88", version = "0\.5\.1220" \}/u;

  assert.match(read("packages/nui-host/Cargo.toml"), dependency);
  assert.match(read("packages/system-host/Cargo.toml"), dependency);
});

test("Windows static closure enables only the Perry runtime features used by Preview apps", () => {
  const manifest = read("tools/windows-static-closure/Cargo.toml");

  assert.match(
    manifest,
    /perry-stdlib = \{[^\n]+default-features = false, features = \["core", "async-runtime"\] \}/u,
  );
  assert.match(
    manifest,
    /perry-runtime = \{[^\n]+default-features = false, features = \["stdlib", "regex-engine"\] \}/u,
  );
  assert.doesNotMatch(manifest, /features = \[[^\]]*"crypto"/u);
});

test("supply-chain policies define allowed licenses, exceptions, and secret boundaries", () => {
  const supplyChain = read("docs/SUPPLY-CHAIN.md");
  const deny = read("deny.toml");
  const gitleaks = read(".gitleaks.toml");
  const licensePolicy = read("tools/license-policy.mjs");
  const licenseExceptions = read("release/license-exceptions.json");

  assert.match(supplyChain, /MIT|Apache-2\.0/u);
  assert.match(supplyChain, /exception/u);
  assert.match(supplyChain, /expiration/u);
  assert.match(deny, /bans/u);
  assert.match(deny, /licenses/u);
  assert.match(deny, /sources/u);
  assert.match(gitleaks, /allowlist/u);
  assert.match(licenseExceptions, /CC-BY-4\.0/u);
  assert.match(licensePolicy, /fail/u);
});

test("pinned gitleaks CLI proves the synthetic secret is rejected outside its allowlist", () => {
  const workflow = read(".github/workflows/security.yml");

  assert.match(read("tools/fixtures/security/README.md"), /intentionally fail/u);
  assert.match(read("tools/fixtures/security/secret.txt"), /NEXA_SECURITY_FIXTURE/u);
  assert.match(workflow, /GITLEAKS_VERSION: "8\.24\.2"/u);
  assert.match(
    workflow,
    /GITLEAKS_LINUX_X64_SHA256: fa0500f6b7e41d28791ebc680f5dd9899cd42b58629218a5f041efa899151a8e/u,
  );
  assert.match(workflow, /sha256sum --check/u);
  assert.match(workflow, /tools\/fixtures\/security\/secret\.txt/u);
  assert.match(workflow, /nexa-security-negative/u);
  assert.match(workflow, /--exit-code 42/u);
  assert.match(workflow, /negative_status.*-ne 42/u);
  assert.match(workflow, /"\$GITLEAKS_BIN" git/u);
  assert.match(workflow, /"\$GITLEAKS_BIN" dir/u);
});

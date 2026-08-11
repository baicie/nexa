import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("the repository carries the complete dual-license grant", () => {
  const rootPackage = JSON.parse(read("package.json"));
  const mit = read("LICENSE-MIT");
  const apache = read("LICENSE-APACHE");

  assert.equal(rootPackage.license, "MIT OR Apache-2.0");
  assert.match(mit, /^MIT License\n/u);
  assert.match(mit, /Permission is hereby granted, free of charge/u);
  assert.match(mit, /THE SOFTWARE IS PROVIDED "AS IS"/u);
  assert.match(apache, /^Apache License\nVersion 2\.0, January 2004\n/u);
  assert.match(apache, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/u);
  assert.match(apache, /END OF TERMS AND CONDITIONS/u);
});

test("repository ownership is explicit for default and release-sensitive paths", () => {
  const codeowners = read(".github/CODEOWNERS");

  assert.match(codeowners, /^\* @baicie$/m);
  for (const path of [
    "/.github/workflows/",
    "/.github/CODEOWNERS",
    "/protocol/",
    "/packages/cli/",
  ]) {
    assert.match(codeowners, new RegExp(`^${path.replaceAll("/", "\\/")} @baicie$`, "m"));
  }
});

test("contribution and security policies define verifiable maintainer workflows", () => {
  const contributing = read("CONTRIBUTING.md");
  const security = read("SECURITY.md");

  for (const command of [
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm build",
    "cargo fmt --all -- --check",
    "cargo clippy --workspace --all-targets -- -D warnings",
    "cargo test --workspace",
  ]) {
    assert.match(contributing, new RegExp(command.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(contributing, /Developer Certificate of Origin/u);
  assert.match(contributing, /docs\/PROJECT-DESIGN\.md/u);
  assert.match(contributing, /docs\/ROADMAP\.md/u);
  assert.match(contributing, /TODO\.md/u);

  assert.match(security, /GitHub Security Advisory/u);
  assert.match(security, /Do not open a public issue/u);
  assert.match(security, /within 3 business days/u);
  assert.match(security, /0\.1\.x/u);
  assert.match(security, /unsupported/u);
});

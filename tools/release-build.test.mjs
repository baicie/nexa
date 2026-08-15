import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const release = JSON.parse(readFileSync(path.join(root, "release/packages.json"), "utf8"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args) {
  return spawnSync(
    process.execPath,
    [path.join(root, "tools/build-release-packages.mjs"), ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return [absolute];
  });
}

function moduleSpecifiers(filePath) {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

test("release package manifest validation is executable", () => {
  const result = run(["--check"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /release package build ok/u);
});

test("release build emits importable ESM and self-contained Host source in isolation", async (t) => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "nexa-release-build-"));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const result = run(["--all", "--output-root", outputRoot]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const entry of release.npm.public) {
    const dist = path.join(outputRoot, entry.path, "dist");
    assert.equal(lstatSync(dist).isDirectory(), true);
    if (entry.name === "@nexa/cli") {
      assert.equal(existsSync(path.join(dist, "bin.mjs")), true);
      const closureFiles = [
        "windows-static-closure/Cargo.toml",
        "windows-static-closure/Cargo.lock",
        "windows-static-closure/patches/perry-runtime-windows-longjmp.json",
        "windows-static-closure/src/lib.rs",
      ];
      for (const required of closureFiles) {
        assert.equal(existsSync(path.join(dist, required)), true, `@nexa/cli: ${required}`);
      }

      const cliRoot = path.join(outputRoot, entry.path);
      copyFileSync(path.join(root, entry.path, "package.json"), path.join(cliRoot, "package.json"));
      const packed = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: cliRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: path.join(outputRoot, ".npm-cache") },
      });
      assert.equal(packed.status, 0, packed.stderr || packed.stdout);
      const publishedFiles = new Set(
        JSON.parse(packed.stdout)[0].files.map(({ path: filePath }) => filePath),
      );
      for (const required of closureFiles) {
        assert.equal(publishedFiles.has(`dist/${required}`), true, `@nexa/cli pack: ${required}`);
      }
    } else {
      assert.equal(existsSync(path.join(dist, "index.js")), true, entry.name);
      assert.equal(existsSync(path.join(dist, "index.d.ts")), true, entry.name);
    }
    assert.equal(existsSync(path.join(dist, "LICENSE-MIT")), true);
    assert.equal(existsSync(path.join(dist, "LICENSE-APACHE")), true);
    for (const file of walk(dist).filter((candidate) => /\.(?:js|d\.ts)$/u.test(candidate))) {
      for (const specifier of moduleSpecifiers(file)) {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          assert.notEqual(path.posix.extname(specifier), "", `${file}: ${specifier}`);
        }
      }
    }
    assert.equal(
      walk(dist).some((candidate) => candidate.endsWith(".map")),
      false,
      `${entry.name} must not publish stale source maps`,
    );
  }

  await import(pathToFileURL(path.join(outputRoot, "packages/system-host/dist/index.js")).href);

  for (const host of ["nui-host", "system-host"]) {
    const native = path.join(outputRoot, `packages/${host}/dist/native/repo`);
    for (const required of [
      "Cargo.toml",
      "Cargo.lock",
      `packages/${host}/Cargo.toml`,
      `packages/${host}/Cargo.lock`,
      `packages/${host}/src/lib.rs`,
      "crates/nui-app-runtime/Cargo.toml",
      "protocol/generated/protocol.rs",
      "RELEASE-CLOSURE.json",
    ]) {
      assert.equal(existsSync(path.join(native, required)), true, `${host}: ${required}`);
    }
    if (host === "system-host") {
      assert.equal(existsSync(path.join(native, "packages/system-host/build.rs")), true);
      assert.equal(existsSync(path.join(native, "packages/system-host/build_support.rs")), true);
    }
    for (const entry of walk(native)) {
      assert.equal(lstatSync(entry).isSymbolicLink(), false, entry);
      assert.doesNotMatch(entry, /(?:^|[\\/])(?:node_modules|target)(?:[\\/]|$)/u);
    }
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function read(relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function json(relativePath) {
  return JSON.parse(read(relativePath));
}

test("the Technical Preview publication boundary is canonical and dependency-closed", () => {
  const release = json("release/packages.json");
  const publicPackages = release.npm.public.map(({ name }) => name);
  const privatePackages = release.npm.private.map(({ name }) => name);

  assert.equal(release.schemaVersion, 1);
  assert.deepEqual(publicPackages, [
    "@nexa/cli",
    "@nexa/ui",
    "@nexa/adapter-solid",
    "@nexa/fs",
    "@nexa/dialog",
    "@nexa/clipboard",
    "@nexa/protocol",
    "@nexa/nui-host",
    "@nexa/system-host",
  ]);
  assert.deepEqual(privatePackages, [
    "@nexa/adapter-react",
    "@nexa/adapter-vue",
    "@nexa/compiler-svelte",
    "@nexa/system",
  ]);
  assert.equal(new Set([...publicPackages, ...privatePackages]).size, 13);

  for (const entry of release.npm.public) {
    const manifest = json(`${entry.path}/package.json`);
    assert.equal(manifest.name, entry.name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@nexa/")) {
        assert.ok(publicPackages.includes(dependency), `${entry.name} leaks ${dependency}`);
      }
    }
  }

  const cli = release.npm.public.find(({ name }) => name === "@nexa/cli");
  assert.equal(cli.surface, "command");
  assert.deepEqual(cli.commands, ["nexa"]);
  assert.equal(cli.exports, false);
});

test("public packages expose built artifacts and Perry Host binding sources", () => {
  const release = json("release/packages.json");
  const nativeHosts = new Set(["@nexa/nui-host", "@nexa/system-host"]);

  for (const entry of release.npm.public) {
    const manifest = json(`${entry.path}/package.json`);
    assert.notEqual(manifest.private, true, `${entry.name} must be publishable`);
    assert.equal(manifest.publishConfig?.access, "public");
    assert.ok(
      manifest.files.some((file) => file.replace(/\/$/u, "") === "dist"),
      `${entry.name} must publish dist`,
    );

    if (entry.name === "@nexa/cli") {
      assert.equal(
        manifest.files.some((file) => file.replace(/\/$/u, "") === "src"),
        false,
      );
      assert.equal(manifest.exports, undefined, "CLI is command-only");
      assert.equal(manifest.bin?.nexa, "./dist/bin.mjs");
    } else if (nativeHosts.has(entry.name)) {
      assert.equal(
        manifest.files.some((file) => file.replace(/\/$/u, "") === "src"),
        true,
      );
      assert.equal(manifest.main, "dist/index.js");
      assert.deepEqual(manifest.exports?.["."], {
        types: "./dist/index.d.ts",
        perry: "./src/index.ts",
        import: "./dist/index.js",
      });

      const bindingSource =
        entry.name === "@nexa/nui-host"
          ? read("packages/nui-host/src/ffi.ts")
          : read("packages/system-host/src/index.ts");
      for (const { name } of manifest.perry.nativeLibrary.functions) {
        assert.match(
          bindingSource,
          new RegExp(`declare\\s+function\\s+${name}\\s*\\(`, "u"),
          `${entry.name} must preserve the Perry declaration for ${name}`,
        );
      }
    } else {
      assert.equal(
        manifest.files.some((file) => file.replace(/\/$/u, "") === "src"),
        false,
      );
      assert.deepEqual(manifest.exports?.["."], {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      });
      assert.match(manifest.scripts?.build ?? "", /build-release-packages\.mjs/u);
    }
  }

  const solid = json("packages/adapter-solid/package.json");
  assert.deepEqual(solid.exports, {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./jsx-runtime": {
      types: "./dist/jsx-runtime.d.ts",
      import: "./dist/jsx-runtime.js",
    },
    "./jsx-dev-runtime": {
      types: "./dist/jsx-runtime.d.ts",
      import: "./dist/jsx-runtime.js",
    },
  });
  assert.equal(solid.dependencies["solid-js"], "^1.9.9");
  assert.equal(solid.peerDependencies["solid-js"], "^1.9.0");

  for (const entry of release.npm.private) {
    assert.equal(
      json(`${entry.path}/package.json`).private,
      true,
      `${entry.name} must stay private`,
    );
  }
});

test("Host package metadata points Perry at the vendored native closure", () => {
  for (const host of ["nui-host", "system-host"]) {
    const manifest = json(`packages/${host}/package.json`);
    const expected = `dist/native/repo/packages/${host}`;
    assert.deepEqual(
      new Set(Object.values(manifest.perry.nativeLibrary.targets).map(({ crate }) => crate)),
      new Set([expected]),
    );
  }

  const builder = read("tools/build-release-packages.mjs");
  for (const required of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "build.rs",
    "build_support.rs",
    "RELEASE-CLOSURE.json",
  ]) {
    assert.match(builder, new RegExp(required.replace(".", "\\."), "u"));
  }
  assert.match(builder, /native closure cannot contain a symlink/u);
  assert.match(builder, /node_modules/u);
  assert.match(builder, /target/u);
});

test("standalone Rust crates remain explicitly private in the npm-first Preview", () => {
  const release = json("release/packages.json");
  assert.deepEqual(release.rust.public, []);
  assert.deepEqual(release.rust.delivery, {
    kind: "vendored-source-in-host-packages",
    hosts: ["@nexa/nui-host", "@nexa/system-host"],
  });

  for (const crate of release.rust.private) {
    const manifest = read(`${crate.path}/Cargo.toml`);
    assert.match(manifest, /^publish = false$/m, `${crate.name} must be publish=false`);
  }
});

test("the publication ADR records the frozen scope and release safety boundary", () => {
  const adr = read("docs/decisions/ADR-015-technical-preview-publication-boundary.md");

  assert.match(adr, /Status: Accepted/u);
  assert.match(adr, /npm-first/u);
  assert.match(adr, /vendored native source closure/u);
  assert.match(adr, /No standalone Rust crate/u);
  assert.match(adr, /does not authorize registry\s+publication/u);
  assert.match(adr, /Tier-1 Adapter/u);
});

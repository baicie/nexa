import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProject } from "../packages/cli/src/new.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

function read(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function walkMarkdown(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "target", "dist", ".nexa", "coverage"].includes(entry.name)) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkMarkdown(absolute, files);
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

function localDestinations(markdown) {
  const destinations = [];
  const pattern = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/gu;
  for (const match of markdown.matchAll(pattern)) {
    destinations.push(match[1].replace(/^<|>$/gu, ""));
  }
  for (const match of markdown.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gmu)) {
    destinations.push(match[1].replace(/^<|>$/gu, ""));
  }
  return destinations;
}

function isExternal(destination) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(destination) || destination.startsWith("#");
}

test("all repository-local Markdown links resolve to files or directories", () => {
  const failures = [];
  for (const markdownPath of walkMarkdown(repositoryRoot)) {
    const source = readFileSync(markdownPath, "utf8");
    for (const destination of localDestinations(source)) {
      if (isExternal(destination)) continue;
      const withoutFragment = destination.split(/[?#]/u, 1)[0];
      if (!withoutFragment) continue;
      const target = path.resolve(path.dirname(markdownPath), decodeURIComponent(withoutFragment));
      if (!target.startsWith(`${repositoryRoot}${path.sep}`) && target !== repositoryRoot) {
        failures.push(
          `${path.relative(repositoryRoot, markdownPath)} -> ${destination} escapes repo`,
        );
      } else if (!existsSync(target)) {
        failures.push(`${path.relative(repositoryRoot, markdownPath)} -> ${destination}`);
      }
    }
  }
  assert.deepEqual(failures, [], `broken local Markdown links:\n${failures.join("\n")}`);
});

test("the docs index exposes every G5-10 document", () => {
  const index = read("docs/README.md");
  for (const document of ["QUICKSTART.md", "API.md", "PACKAGING.md", "COMPATIBILITY.md"]) {
    assert.match(index, new RegExp(`\\./${document}`, "u"));
    assert.equal(statSync(path.join(repositoryRoot, "docs", document)).isFile(), true);
  }
});

test("quickstart commands are backed by a project generated from the current CLI", (t) => {
  const quickstart = read("docs/QUICKSTART.md");
  const template = read("packages/cli/templates/minimal-tsx/README.md.tmpl");
  const directory = mkdtempSync(path.join(tmpdir(), "nexa-docs-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = createProject({ requestedPath: "hello-nexa", cwd: directory });
  const manifest = JSON.parse(readFileSync(path.join(project.target, "package.json"), "utf8"));
  const commands = [
    "pnpm install",
    "pnpm doctor",
    "pnpm typecheck",
    "pnpm dev",
    "pnpm build",
    "pnpm package",
  ];
  for (const command of commands) {
    assert.match(template, new RegExp(command.replace(" ", "\\s+"), "u"));
    assert.match(quickstart, new RegExp(command.replace(" ", "\\s+"), "u"));
  }
  for (const command of ["doctor", "dev", "build", "package"]) {
    assert.equal(manifest.scripts[command], `nexa ${command}`);
  }
  assert.equal(manifest.scripts.typecheck, "tsc -p tsconfig.json --noEmit");
  assert.match(quickstart, /pnpm dlx @nexa\/cli@0\.1\.0 new hello-nexa/u);
  assert.match(quickstart, /尚未发布.*registry|registry.*尚未发布/isu);
  assert.doesNotMatch(quickstart, /仍(?:标记|为).*private/iu);
});

test("API documentation names only exports present in the source packages", () => {
  const api = read("docs/API.md");
  const sources = [
    read("packages/ui/src/index.ts"),
    read("packages/ui/src/primitives.ts"),
    read("packages/ui/src/theme.ts"),
    read("packages/fs/src/index.ts"),
    read("packages/dialog/src/index.ts"),
    read("packages/clipboard/src/index.ts"),
  ].join("\n");
  for (const exportedName of [
    "mount",
    "signal",
    "effect",
    "Window",
    "Column",
    "Button",
    "Input",
    "TextArea",
    "createTheme",
    "defaultTheme",
    "readTextFile",
    "writeTextFile",
    "openFile",
    "saveFile",
    "readText",
    "writeText",
  ]) {
    assert.match(api, new RegExp(`\\b${exportedName}\\b`, "u"));
    assert.match(sources, new RegExp(`\\b${exportedName}\\b`, "u"));
  }
  assert.match(api, /NexaSystemError/u);
  assert.match(read("packages/system-host/src/index.ts"), /NexaSystemError/u);
});

test("compatibility documentation stays tied to the CLI source of truth", () => {
  const compatibility = read("docs/COMPATIBILITY.md");
  const constants = read("packages/cli/src/constants.mjs");
  const doctor = read("packages/cli/src/doctor.mjs");
  for (const value of ["0.1.0", ">=22", "10.34.3", "0.5.1220", "5.9.2", "1.0.0", "0.5"]) {
    assert.match(constants, new RegExp(value.replace(/[.+]/gu, "\\$&"), "u"));
    assert.match(compatibility, new RegExp(value.replace(/[.+]/gu, "\\$&"), "u"));
  }
  for (const target of ["darwin/arm64", "darwin/x64", "win32/x64"]) {
    assert.match(doctor, new RegExp(target.replace("/", "\\/"), "u"));
    assert.match(compatibility, new RegExp(target.replace("/", "\\/"), "u"));
  }
});

test("docs preserve the fail-closed boundary for unpublished and hosted work", () => {
  const all = [
    read("docs/README.md"),
    read("docs/QUICKSTART.md"),
    read("docs/PACKAGING.md"),
    read("docs/COMPATIBILITY.md"),
  ].join("\n");
  assert.match(all, /尚未发布|unpublished|registry publish/iu);
  assert.match(all, /hosted/iu);
  assert.match(all, /G5-09/iu);
  assert.match(all, /PLATFORM_FAILURE/u);
  assert.match(all, /不能主动关闭|不能主动关闭.*picker/iu);
});

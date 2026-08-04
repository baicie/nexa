import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateProtocolContracts } from "./protocol-contract.mjs";
import { renderRustProtocol } from "./protocol-codegen/rust.mjs";
import { renderTypeScriptProtocol } from "./protocol-codegen/typescript.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(toolsDir, "..");

export const GENERATED_ARTIFACT_PATHS = Object.freeze([
  "protocol/generated/protocol.rs",
  "packages/protocol/src/index.ts",
  "protocol/generated/nui-host.perry.json",
  "protocol/generated/system-host.perry.json",
]);

function renderPerryFragment(common, manifest, library) {
  const functions = [
    ...common.ffiFunctions.filter((ffi) => ffi.library === library),
    ...manifest.ffiFunctions.filter((ffi) => ffi.library === library),
  ]
    .sort((left, right) => left.abiIndex - right.abiIndex)
    .map((ffi) => ({
      name: ffi.name,
      params: ffi.params.map((param) => param.type),
      returns: ffi.returns,
    }));

  const source = library === "ui" ? "protocol/nui-host.json" : "protocol/system-host.json";
  const lines = [
    "{",
    '  "generatedBy": "tools/protocol-codegen.mjs",',
    '  "source": ["protocol/common.json", "' + source + '"],',
    '  "abiVersion": "' + common.abi.major + "." + common.abi.minor + '",',
    '  "functions": [',
  ];
  functions.forEach((entry, index) => {
    lines.push("    {");
    lines.push('      "name": ' + JSON.stringify(entry.name) + ",");
    const params = "[" + entry.params.map((param) => JSON.stringify(param)).join(", ") + "]";
    lines.push('      "params": ' + params + ",");
    lines.push('      "returns": ' + JSON.stringify(entry.returns));
    lines.push("    }" + (index === functions.length - 1 ? "" : ","));
  });
  lines.push("  ]", "}");
  return lines.join("\n") + "\n";
}

export function generateProtocolArtifacts() {
  const model = validateProtocolContracts();
  const manifests = {
    common: model.common.manifest,
    ui: model.contracts.ui.manifest,
    system: model.contracts.system.manifest,
  };

  return {
    "protocol/generated/protocol.rs": renderRustProtocol(manifests),
    "packages/protocol/src/index.ts": renderTypeScriptProtocol(manifests),
    "protocol/generated/nui-host.perry.json": renderPerryFragment(
      manifests.common,
      manifests.ui,
      "ui",
    ),
    "protocol/generated/system-host.perry.json": renderPerryFragment(
      manifests.common,
      manifests.system,
      "system",
    ),
  };
}

function generatedFiles(root) {
  const files = [];
  for (const generatedRoot of ["protocol/generated", "packages/protocol/src"]) {
    const absoluteRoot = path.join(root, generatedRoot);
    if (!existsSync(absoluteRoot)) continue;

    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(absolutePath);
        } else if (entry.isFile()) {
          files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
        }
      }
    };
    visit(absoluteRoot);
  }
  return files.sort();
}

export function writeProtocolArtifacts({ root = workspaceRoot } = {}) {
  const artifacts = generateProtocolArtifacts();
  const changed = [];
  for (const relativePath of GENERATED_ARTIFACT_PATHS) {
    const absolutePath = path.join(root, relativePath);
    const expected = artifacts[relativePath];
    const current = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null;
    if (current === expected) continue;

    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, expected);
    changed.push(relativePath);
  }
  return changed;
}

export function checkProtocolArtifacts({ root = workspaceRoot } = {}) {
  const artifacts = generateProtocolArtifacts();
  const issues = [];
  for (const relativePath of GENERATED_ARTIFACT_PATHS) {
    const absolutePath = path.join(root, relativePath);
    if (!existsSync(absolutePath)) {
      issues.push("missing: " + relativePath);
    } else if (readFileSync(absolutePath, "utf8") !== artifacts[relativePath]) {
      issues.push("out of date: " + relativePath);
    }
  }

  const expected = new Set(GENERATED_ARTIFACT_PATHS);
  for (const relativePath of generatedFiles(root)) {
    if (!expected.has(relativePath)) issues.push("unexpected: " + relativePath);
  }

  if (issues.length > 0) {
    throw new Error(
      "Protocol artifact drift detected:\n" +
        issues.map((issue) => "- " + issue).join("\n") +
        "\nRun `pnpm protocol:generate` to refresh generated files.",
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") {
    checkProtocolArtifacts();
    console.log("Protocol artifacts are up to date.");
    return;
  }
  if (args.length > 0) {
    throw new Error("Usage: node tools/protocol-codegen.mjs [--check]");
  }

  const changed = writeProtocolArtifacts();
  if (changed.length === 0) {
    console.log("Protocol artifacts are already up to date.");
  } else {
    for (const relativePath of changed) console.log("Generated " + relativePath);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const release = JSON.parse(readFileSync(path.join(root, "release/packages.json"), "utf8"));
const publicPackages = new Map(release.npm.public.map((entry) => [entry.name, entry]));
const nativeHostPackages = new Set(["@nexa/nui-host", "@nexa/system-host"]);
const tscPath = path.join(root, "node_modules", "typescript", "bin", "tsc");
const ignoredDirectoryNames = new Set([
  ".git",
  ".nexa",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const nativeWorkspaceDirectories = [
  "protocol",
  "crates",
  "examples/rust-counter",
  "examples/semantic-e2e/native",
];
const nativeWorkspaceFiles = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"];
const nativeHostFiles = ["Cargo.toml", "Cargo.lock"];

function packageRoot(entry) {
  return path.join(root, entry.path);
}

function fail(message) {
  throw new Error(`[release-build] ${message}`);
}

function assertRegularFile(filePath, label = filePath) {
  const metadata = lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular file: ${filePath}`);
  }
}

function copyRegularFile(source, destination) {
  assertRegularFile(source, "source");
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { dereference: false, force: true });
}

function copyTree(source, destination, { filter = () => true } = {}) {
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink()) fail(`native closure cannot contain a symlink: ${source}`);
  if (metadata.isFile()) {
    if (filter(source)) copyRegularFile(source, destination);
    return;
  }
  if (!metadata.isDirectory()) fail(`unsupported source entry: ${source}`);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) fail(`native closure cannot contain a symlink: ${sourceEntry}`);
    copyTree(sourceEntry, destinationEntry, { filter });
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}`);
}

function cleanDist(dist) {
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  return dist;
}

function emittedModuleFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return emittedModuleFiles(candidate);
    return entry.isFile() && (candidate.endsWith(".js") || candidate.endsWith(".d.ts"))
      ? [candidate]
      : [];
  });
}

function explicitRelativeSpecifier(specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;
  return path.posix.extname(specifier) === "" ? `${specifier}.js` : specifier;
}

function rewriteEmittedModuleSpecifiers(filePath) {
  const sourceText = readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const edits = [];

  function record(literal) {
    const replacement = explicitRelativeSpecifier(literal.text);
    if (replacement === literal.text) return;
    edits.push({ start: literal.getStart(source) + 1, end: literal.getEnd() - 1, replacement });
  }

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      record(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  if (edits.length === 0) return;
  let output = sourceText;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`;
  }
  writeFileSync(filePath, output);
}

function emitTypeScript(entry, dist) {
  if (!existsSync(tscPath)) fail(`TypeScript compiler is missing: ${tscPath}`);
  run(
    process.execPath,
    [
      tscPath,
      "-p",
      "tsconfig.json",
      "--noEmit",
      "false",
      "--outDir",
      dist,
      "--sourceMap",
      "false",
      "--declarationMap",
      "false",
    ],
    packageRoot(entry),
  );
  if (!existsSync(path.join(dist, "index.js"))) {
    fail(`${entry.name} did not emit dist/index.js`);
  }
  for (const filePath of emittedModuleFiles(dist)) rewriteEmittedModuleSpecifiers(filePath);
  copyRegularFile(path.join(root, "LICENSE-MIT"), path.join(dist, "LICENSE-MIT"));
  copyRegularFile(path.join(root, "LICENSE-APACHE"), path.join(dist, "LICENSE-APACHE"));
}

function emitCli(entry, dist) {
  copyTree(path.join(packageRoot(entry), "src"), dist, {
    filter: (filePath) =>
      filePath.endsWith(".mjs") ||
      filePath.endsWith(".toml") ||
      filePath.endsWith(".rs") ||
      path.basename(filePath) === "Cargo.lock",
  });
  copyRegularFile(path.join(root, "LICENSE-MIT"), path.join(dist, "LICENSE-MIT"));
  copyRegularFile(path.join(root, "LICENSE-APACHE"), path.join(dist, "LICENSE-APACHE"));
  if (!existsSync(path.join(dist, "bin.mjs"))) fail("CLI build did not emit dist/bin.mjs");
}

function copyNativeWorkspace(destinationRoot) {
  for (const file of nativeWorkspaceFiles) {
    copyRegularFile(path.join(root, file), path.join(destinationRoot, file));
  }
  for (const directory of nativeWorkspaceDirectories) {
    copyTree(path.join(root, directory), path.join(destinationRoot, directory));
  }
}

function copyNativeHost(entry, destinationRoot) {
  const hostDirectory = packageRoot(entry);
  const hostName = entry.name === "@nexa/nui-host" ? "nui-host" : "system-host";
  const destination = path.join(destinationRoot, "packages", hostName);
  for (const file of nativeHostFiles) {
    copyRegularFile(path.join(hostDirectory, file), path.join(destination, file));
  }
  copyTree(path.join(hostDirectory, "src"), path.join(destination, "src"), {
    filter: (filePath) => filePath.endsWith(".rs"),
  });
  if (hostName === "system-host") {
    for (const file of ["build.rs", "build_support.rs"]) {
      copyRegularFile(path.join(hostDirectory, file), path.join(destination, file));
    }
  }
}

function emitNativeClosure(entry, dist) {
  const destinationRoot = path.join(dist, "native", "repo");
  mkdirSync(destinationRoot, { recursive: true });
  copyNativeWorkspace(destinationRoot);
  copyNativeHost(entry, destinationRoot);
  writeFileSync(
    path.join(destinationRoot, "RELEASE-CLOSURE.json"),
    `${JSON.stringify({ schemaVersion: 1, host: entry.name, layout: "repository-relative", source: "vendored" }, null, 2)}\n`,
  );
}

export function validateReleaseManifests() {
  const errors = [];
  for (const entry of release.npm.public) {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot(entry), "package.json"), "utf8"),
    );
    if (manifest.private === true) errors.push(`${entry.name} must be publishable`);
    if (
      !Array.isArray(manifest.files) ||
      !manifest.files.some((file) => file.replace(/\/$/u, "") === "dist")
    ) {
      errors.push(`${entry.name} must publish dist`);
    }
    if (entry.name === "@nexa/cli") {
      if (manifest.exports) errors.push("CLI must remain command-only");
      if (manifest.bin?.nexa !== "./dist/bin.mjs") errors.push("CLI bin must point to dist");
    } else if (nativeHostPackages.has(entry.name)) {
      const packageExport = manifest.exports?.["."];
      if (
        manifest.main !== "dist/index.js" ||
        manifest.types !== "dist/index.d.ts" ||
        packageExport?.types !== "./dist/index.d.ts" ||
        packageExport?.perry !== "./src/index.ts" ||
        packageExport?.import !== "./dist/index.js"
      ) {
        errors.push(`${entry.name} must separate its Perry source and JavaScript release entries`);
      }
      if (!manifest.files.some((file) => file.replace(/\/$/u, "") === "src")) {
        errors.push(`${entry.name} must publish its Perry TypeScript binding source`);
      }
    } else if (manifest.exports?.["."]?.import !== "./dist/index.js") {
      errors.push(`${entry.name} must export dist/index.js`);
    }
  }
  for (const entry of release.npm.private) {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot(entry), "package.json"), "utf8"),
    );
    if (manifest.private !== true) errors.push(`${entry.name} must remain private`);
  }
  if (errors.length) fail(errors.join("\n"));
  return true;
}

function buildPackageClosure(name, built, visiting, outputRoot) {
  if (built.has(name)) return;
  if (visiting.has(name))
    fail(`public package dependency cycle: ${[...visiting, name].join(" -> ")}`);
  const entry = publicPackages.get(name);
  if (!entry) fail(`unknown public package: ${name}`);
  visiting.add(name);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot(entry), "package.json"), "utf8"));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (publicPackages.has(dependency)) {
      buildPackageClosure(dependency, built, visiting, outputRoot);
    }
  }
  const outputPackage = outputRoot ? path.join(outputRoot, entry.path) : packageRoot(entry);
  const dist = cleanDist(path.join(outputPackage, "dist"));
  if (name === "@nexa/cli") emitCli(entry, dist);
  else emitTypeScript(entry, dist);
  if (name === "@nexa/nui-host" || name === "@nexa/system-host") emitNativeClosure(entry, dist);
  visiting.delete(name);
  built.add(name);
  return dist;
}

export function buildReleasePackage(name, { outputRoot } = {}) {
  validateReleaseManifests();
  return buildPackageClosure(name, new Set(), new Set(), outputRoot && path.resolve(outputRoot));
}

export function buildAllReleasePackages({ outputRoot } = {}) {
  validateReleaseManifests();
  const built = new Set();
  const resolvedOutputRoot = outputRoot && path.resolve(outputRoot);
  for (const entry of release.npm.public) {
    if (!built.has(entry.name)) console.log(`==> ${entry.name}`);
    buildPackageClosure(entry.name, built, new Set(), resolvedOutputRoot);
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const packageIndex = args.indexOf("--package");
  const packageName = packageIndex >= 0 ? args[packageIndex + 1] : undefined;
  if (packageIndex >= 0) args.splice(packageIndex, 2);
  const outputRootIndex = args.indexOf("--output-root");
  const outputRoot = outputRootIndex >= 0 ? args[outputRootIndex + 1] : undefined;
  if (outputRootIndex >= 0) args.splice(outputRootIndex, 2);
  const all = args.includes("--all");
  const check = args.includes("--check");
  const unknown = args.filter((argument) => argument !== "--all" && argument !== "--check");
  if (
    unknown.length > 0 ||
    (packageIndex >= 0 && !packageName) ||
    (outputRootIndex >= 0 && !outputRoot) ||
    [all, check, packageName !== undefined].filter(Boolean).length > 1 ||
    (check && outputRoot !== undefined)
  ) {
    throw new Error(
      "Usage: node tools/build-release-packages.mjs [--all|--package <name>|--check] [--output-root <directory>]",
    );
  }
  return {
    all: all || (!packageName && !check),
    check,
    packageName,
    outputRoot,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  try {
    if (options.check) validateReleaseManifests();
    else if (options.packageName) {
      buildReleasePackage(options.packageName, { outputRoot: options.outputRoot });
    } else if (options.all) {
      buildAllReleasePackages({ outputRoot: options.outputRoot });
    } else
      throw new Error(
        "Usage: node tools/build-release-packages.mjs [--all|--package <name>|--check] [--output-root <directory>]",
      );
    console.log("release package build ok");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

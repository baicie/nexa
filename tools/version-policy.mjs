import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractArchive } from "./archive-utils.mjs";
import { createConsumerManifest } from "./release-consumer.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

function read(relativePath, base = root) {
  return readFileSync(path.join(base, relativePath), "utf8");
}

function json(relativePath, base = root) {
  return JSON.parse(read(relativePath, base));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status ?? "no status"}\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function assertPolicy() {
  const policy = json("release/version.json");
  const release = json("release/packages.json");
  const rootPackage = json("package.json");
  const constants = read("packages/cli/src/constants.mjs");
  const errors = [];

  if (policy.schemaVersion !== 1) errors.push("unsupported release version schema");
  if (rootPackage.version !== policy.npmTrain) errors.push("root npm version drift");
  for (const entry of [...release.npm.public, ...release.npm.private]) {
    const manifest = json(`${entry.path}/package.json`);
    if (manifest.version !== policy.npmTrain) errors.push(`${entry.name} npm version drift`);
  }
  for (const [key, value] of Object.entries(policy)) {
    if (typeof value !== "string") continue;
    if (!constants.includes(JSON.stringify(value))) errors.push(`CLI compatibility drift: ${key}`);
  }
  const cargo = read("Cargo.toml");
  if (!cargo.includes(`version = "${policy.rustTrain}"`)) errors.push("Rust train drift");
  const changesets = json(".changeset/config.json");
  const publicNames = release.npm.public.map(({ name }) => name).sort();
  if (JSON.stringify([...changesets.fixed[0]].sort()) !== JSON.stringify(publicNames)) {
    errors.push("Changesets fixed group drift");
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return { policy, publicNames, release };
}

function nextPatch(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) throw new Error(`npm train is not a stable SemVer version: ${version}`);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(patch + 1)) throw new Error("npm patch version exceeds safe range");
  return `${match[1]}.${match[2]}.${patch + 1}`;
}

function rehearsalFiles(release) {
  const files = ["package.json", "pnpm-workspace.yaml", ".changeset/config.json", "CHANGELOG.md"];
  for (const name of readdirSync(path.join(root, ".changeset"))) {
    if (name.endsWith(".md")) files.push(`.changeset/${name}`);
  }
  for (const entry of [...release.npm.public, ...release.npm.private]) {
    files.push(`${entry.path}/package.json`);
    if (existsSync(path.join(root, entry.path, "CHANGELOG.md"))) {
      files.push(`${entry.path}/CHANGELOG.md`);
    }
  }
  return [...new Set(files)].sort();
}

function snapshot(files) {
  return Object.fromEntries(
    files.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
}

function copyWorkspace(files, destination) {
  for (const file of files) {
    const target = path.join(destination, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, file), target);
  }
  const sourceModules = path.join(root, "node_modules");
  if (!existsSync(sourceModules))
    throw new Error("node_modules is missing; run pnpm install first");
  symlinkSync(
    sourceModules,
    path.join(destination, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function createSyntheticChangeset(workspace, packageName) {
  const file = path.join(workspace, ".changeset", "version-rehearsal.md");
  writeFileSync(
    file,
    `---\n"${packageName}": patch\n---\n\nValidate the fixed Technical Preview release train.\n`,
    { flag: "wx" },
  );
  return file;
}

function assertGeneratedVersions(workspace, release, currentVersion, generatedVersion) {
  let changelogCount = 0;
  for (const entry of release.npm.public) {
    const manifest = json(`${entry.path}/package.json`, workspace);
    if (manifest.version !== generatedVersion) {
      throw new Error(`${entry.name} generated ${manifest.version}, expected ${generatedVersion}`);
    }
    const changelog = read(`${entry.path}/CHANGELOG.md`, workspace);
    if (!changelog.includes(`## ${generatedVersion}`)) {
      throw new Error(`${entry.name} changelog is missing ${generatedVersion}`);
    }
    changelogCount += 1;
  }
  for (const entry of release.npm.private) {
    const manifest = json(`${entry.path}/package.json`, workspace);
    if (manifest.version !== currentVersion) {
      throw new Error(`${entry.name} private version changed to ${manifest.version}`);
    }
  }
  return changelogCount;
}

function validateGeneratedInternalRanges(workspace, release) {
  const publicNames = new Set(release.npm.public.map(({ name }) => name));
  let count = 0;
  for (const entry of release.npm.public) {
    const before = json(`${entry.path}/package.json`);
    const after = json(`${entry.path}/package.json`, workspace);
    for (const field of dependencyFields) {
      for (const [name, range] of Object.entries(before[field] ?? {})) {
        if (!publicNames.has(name)) continue;
        if (after[field]?.[name] !== range || !range.startsWith("workspace:")) {
          throw new Error(`${entry.name} ${field}.${name} workspace range drift`);
        }
        count += 1;
      }
    }
  }
  return count;
}

function linkGeneratedWorkspaceDependencies(workspace, release) {
  const entries = new Map(
    [...release.npm.public, ...release.npm.private].map((entry) => [entry.name, entry]),
  );
  for (const entry of release.npm.public) {
    const manifest = json(`${entry.path}/package.json`, workspace);
    for (const field of dependencyFields) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!range.startsWith("workspace:")) continue;
        const dependency = entries.get(name);
        if (!dependency)
          throw new Error(`${entry.name} references unknown workspace package ${name}`);
        const link = path.join(workspace, entry.path, "node_modules", ...name.split("/"));
        mkdirSync(path.dirname(link), { recursive: true });
        symlinkSync(
          path.join(workspace, dependency.path),
          link,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
    }
  }
}

function packAndValidate(workspace, release, generatedVersion, expectedInternalRanges) {
  const artifacts = path.join(workspace, "artifacts");
  const extracted = path.join(workspace, "extracted");
  mkdirSync(artifacts);
  mkdirSync(extracted);
  const tarballs = new Map();
  const publicNames = new Set(release.npm.public.map(({ name }) => name));
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  let packedInternalRanges = 0;

  for (const entry of release.npm.public) {
    const output = run(
      pnpm,
      ["--dir", entry.path, "pack", "--pack-destination", artifacts, "--json"],
      workspace,
    );
    const packed = JSON.parse(output);
    if (packed.name !== entry.name || packed.version !== generatedVersion) {
      throw new Error(`${entry.name} pack metadata does not match ${generatedVersion}`);
    }
    const tarball = path.resolve(workspace, packed.filename);
    if (path.dirname(tarball) !== artifacts || !existsSync(tarball)) {
      throw new Error(`${entry.name} pack escaped the rehearsal artifact directory`);
    }
    tarballs.set(entry.name, tarball);

    const destination = path.join(extracted, entry.name.replaceAll("/", "__"));
    extractArchive(tarball, destination, "darwin");
    const manifest = json("package/package.json", destination);
    if (manifest.name !== entry.name || manifest.version !== generatedVersion) {
      throw new Error(`${entry.name} packed manifest version drift`);
    }
    for (const field of dependencyFields) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!publicNames.has(name)) continue;
        if (range !== generatedVersion) {
          throw new Error(`${entry.name} packed ${field}.${name} is ${range}`);
        }
        packedInternalRanges += 1;
      }
    }
  }

  if (packedInternalRanges !== expectedInternalRanges) {
    throw new Error(
      `packed internal dependency count ${packedInternalRanges} != ${expectedInternalRanges}`,
    );
  }

  const consumer = createConsumerManifest(tarballs);
  const dependencyNames = Object.keys(consumer.dependencies).sort();
  const expectedNames = [...publicNames].sort();
  if (JSON.stringify(dependencyNames) !== JSON.stringify(expectedNames)) {
    throw new Error("consumer fixture does not include the complete public release train");
  }
  for (const name of expectedNames) {
    const specification = consumer.dependencies[name];
    if (consumer.pnpm.overrides[name] !== specification || !specification.endsWith(".tgz")) {
      throw new Error(`consumer fixture tarball mapping drift: ${name}`);
    }
  }
  return tarballs.size;
}

function rehearse() {
  const result = assertPolicy();
  const files = rehearsalFiles(result.release);
  const before = snapshot(files);
  const workspace = mkdtempSync(path.join(os.tmpdir(), "nexa-version-rehearsal-"));
  const generatedVersion = nextPatch(result.policy.npmTrain);
  let summary;

  try {
    copyWorkspace(files, workspace);
    const syntheticChangeset = createSyntheticChangeset(
      workspace,
      result.release.npm.public[0].name,
    );
    const changesetBin = path.join(root, "node_modules", "@changesets", "cli", "bin.js");
    run(process.execPath, [changesetBin, "version"], workspace);
    if (existsSync(syntheticChangeset))
      throw new Error("Changesets did not consume the rehearsal file");

    const changelogCount = assertGeneratedVersions(
      workspace,
      result.release,
      result.policy.npmTrain,
      generatedVersion,
    );
    const internalRanges = validateGeneratedInternalRanges(workspace, result.release);
    linkGeneratedWorkspaceDependencies(workspace, result.release);
    const packedCount = packAndValidate(
      workspace,
      result.release,
      generatedVersion,
      internalRanges,
    );

    if (JSON.stringify(snapshot(files)) !== JSON.stringify(before)) {
      throw new Error("version rehearsal modified source version files");
    }
    summary = [
      "Changesets version executed in an isolated temporary workspace",
      `fixed release train ${result.policy.npmTrain} -> ${generatedVersion} (${result.publicNames.length} packages)`,
      `validated ${internalRanges} internal dependency ranges`,
      `validated ${changelogCount} generated package changelogs`,
      `packed manifests verified ${packedCount}/${result.publicNames.length}`,
      `consumer dependency closure verified ${result.publicNames.length}/${result.publicNames.length}`,
    ];
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  for (const line of summary) console.log(line);
  console.log("temporary workspace removed; source working tree unchanged");
}

const command = process.argv[2] ?? "check";
if (command === "check") {
  const result = assertPolicy();
  console.log(`version policy ok: ${result.policy.npmTrain}`);
} else if (command === "rehearse") {
  rehearse();
} else {
  console.error("Usage: node tools/version-policy.mjs [check|rehearse]");
  process.exitCode = 2;
}

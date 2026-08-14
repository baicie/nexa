import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ecosystemOrder = new Map([
  ["cargo", 0],
  ["npm", 1],
]);
export const cargoDependencyRoots = [
  { manifest: "packages/nui-host/Cargo.toml", lockfile: "packages/nui-host/Cargo.lock" },
  {
    manifest: "packages/system-host/Cargo.toml",
    lockfile: "packages/system-host/Cargo.lock",
  },
  {
    manifest: "packages/cli/src/windows-static-closure/Cargo.toml",
    lockfile: "packages/cli/src/windows-static-closure/Cargo.lock",
  },
];

function fail(message) {
  throw new Error(`[release-dependencies] ${message}`);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEcosystems(left, right) {
  return (ecosystemOrder.get(left) ?? 99) - (ecosystemOrder.get(right) ?? 99);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function portableRelative(value, name) {
  requireString(value, name);
  if (
    value.includes("\\") ||
    /[\0\r\n]/u.test(value) ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    fail(`${name} must be a portable relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`${name} must not contain empty, current, or parent path segments`);
  }
  return value;
}

function toPortablePath(value) {
  return value.split(path.sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256(readFileSync(file));
}

function dependencyRef(ecosystem, identity) {
  return `urn:nexa:dependency:${ecosystem}:sha256:${sha256(identity)}`;
}

function purlName(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

function readPackageManifest(directory) {
  if (!directory) return undefined;
  try {
    return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  } catch (error) {
    fail(
      `cannot read npm dependency manifest at ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function npmIdentity(node, fallbackName) {
  assertObject(node, `npm dependency ${fallbackName ?? "root"}`);
  const manifest = readPackageManifest(node.path);
  const name = requireString(manifest?.name ?? node.name ?? node.from ?? fallbackName, "npm name");
  const candidateVersion = manifest?.version ?? node.version;
  if (typeof candidateVersion !== "string" || candidateVersion.startsWith("link:")) {
    fail(`npm dependency ${name} does not expose a resolved version`);
  }
  const version = requireString(candidateVersion, `npm dependency ${name} version`);
  const identity = `${name}\0${version}`;
  return {
    ref: dependencyRef("npm", identity),
    component: {
      ref: dependencyRef("npm", identity),
      ecosystem: "npm",
      type: "library",
      name,
      version,
      purl: `pkg:npm/${purlName(name)}@${encodeURIComponent(version)}`,
      ...(typeof manifest?.license === "string" ? { license: manifest.license } : {}),
    },
  };
}

function cargoSource(package_, rootDirectory) {
  if (typeof package_.source === "string" && package_.source.length > 0) return package_.source;
  requireString(package_.manifest_path, `Cargo package ${package_.name} manifest_path`);
  const relative = path.relative(rootDirectory, package_.manifest_path);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    fail(`Cargo package ${package_.name} manifest must be inside the release source tree`);
  }
  return `path:${toPortablePath(relative)}`;
}

function cargoIdentity(package_, rootDirectory) {
  assertObject(package_, "Cargo package");
  const name = requireString(package_.name, "Cargo package name");
  const version = requireString(package_.version, `Cargo package ${name} version`);
  const source = cargoSource(package_, rootDirectory);
  const identity = `${name}\0${version}\0${source}`;
  const registry = source === "registry+https://github.com/rust-lang/crates.io-index";
  return {
    ref: dependencyRef("cargo", identity),
    component: {
      ref: dependencyRef("cargo", identity),
      ecosystem: "cargo",
      type: "library",
      name,
      version,
      source,
      ...(registry ? { purl: `pkg:cargo/${purlName(name)}@${encodeURIComponent(version)}` } : {}),
      ...(typeof package_.license === "string" ? { license: package_.license } : {}),
    },
  };
}

function addComponent(components, component) {
  const previous = components.get(component.ref);
  if (previous && JSON.stringify(previous) !== JSON.stringify(component)) {
    fail(`dependency reference collision for ${component.ref}`);
  }
  components.set(component.ref, component);
}

function addDependency(dependencies, from, to) {
  let targets = dependencies.get(from);
  if (!targets) {
    targets = new Set();
    dependencies.set(from, targets);
  }
  if (to) targets.add(to);
}

function collectNpmGraph(npmProjects, components, dependencies) {
  if (!Array.isArray(npmProjects) || npmProjects.length === 0) {
    fail("pnpm dependency output must contain at least one public package");
  }
  const roots = new Set();
  const expanded = new Set();

  function visit(node, fallbackName, ancestry) {
    const identity = npmIdentity(node, fallbackName);
    addComponent(components, identity.component);
    addDependency(dependencies, identity.ref);
    if (ancestry.has(identity.ref) || expanded.has(identity.ref)) return identity.ref;
    const nextAncestry = new Set(ancestry).add(identity.ref);
    for (const [dependencyName, dependency] of Object.entries(node.dependencies ?? {}).sort(
      ([left], [right]) => compareStrings(left, right),
    )) {
      const childRef = visit(dependency, dependencyName, nextAncestry);
      addDependency(dependencies, identity.ref, childRef);
    }
    expanded.add(identity.ref);
    return identity.ref;
  }

  for (const project of npmProjects) roots.add(visit(project, project?.name, new Set()));
  return [...roots].sort(compareStrings);
}

function cargoDependencyIds(node) {
  if (Array.isArray(node.deps)) {
    return node.deps
      .filter(
        ({ dep_kinds: dependencyKinds }) =>
          !Array.isArray(dependencyKinds) ||
          dependencyKinds.length === 0 ||
          dependencyKinds.some(({ kind }) => kind !== "dev"),
      )
      .map(({ pkg }) => pkg);
  }
  return Array.isArray(node.dependencies) ? node.dependencies : [];
}

function collectCargoGraph(cargoMetadata, rootDirectory, components, dependencies) {
  if (!Array.isArray(cargoMetadata) || cargoMetadata.length === 0) {
    fail("Cargo metadata must contain at least one Host closure");
  }
  const roots = new Set();

  for (const [metadataIndex, metadata] of cargoMetadata.entries()) {
    assertObject(metadata, `Cargo metadata ${metadataIndex}`);
    if (!Array.isArray(metadata.packages) || !Array.isArray(metadata.resolve?.nodes)) {
      fail(`Cargo metadata ${metadataIndex} must contain packages and resolve.nodes`);
    }
    const packageById = new Map(metadata.packages.map((package_) => [package_.id, package_]));
    const nodeById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
    const rootIds = metadata.workspace_members ?? metadata.resolve.workspace_members;
    if (!Array.isArray(rootIds) || rootIds.length === 0) {
      fail(`Cargo metadata ${metadataIndex} must identify a workspace root`);
    }
    const visited = new Set();

    function visit(packageId) {
      const package_ = packageById.get(packageId);
      const node = nodeById.get(packageId);
      if (!package_ || !node) fail(`Cargo metadata is missing package or node ${packageId}`);
      const identity = cargoIdentity(package_, rootDirectory);
      addComponent(components, identity.component);
      addDependency(dependencies, identity.ref);
      if (visited.has(packageId)) return identity.ref;
      visited.add(packageId);
      for (const dependencyId of cargoDependencyIds(node).sort(compareStrings)) {
        const dependencyRef = visit(dependencyId);
        addDependency(dependencies, identity.ref, dependencyRef);
      }
      return identity.ref;
    }

    for (const rootId of rootIds) roots.add(visit(rootId));
  }
  return [...roots].sort(compareStrings);
}

function normalizeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    fail("dependency graph sources must not be empty");
  }
  const seen = new Set();
  return sources
    .map((source, index) => {
      assertObject(source, `dependency graph source ${index}`);
      if (source.ecosystem !== "npm" && source.ecosystem !== "cargo") {
        fail(`dependency graph source ${index} has an unsupported ecosystem`);
      }
      const lockfile = portableRelative(
        source.lockfile,
        `dependency graph source ${index} lockfile`,
      );
      if (seen.has(lockfile)) fail(`duplicate dependency graph source ${lockfile}`);
      seen.add(lockfile);
      const resolver = requireString(source.resolver, `dependency graph source ${index} resolver`);
      if (!source.digest || !/^[0-9a-f]{64}$/u.test(source.digest.sha256 ?? "")) {
        fail(`dependency graph source ${index} must have a SHA-256 digest`);
      }
      const manifest = source.manifest;
      if (manifest !== undefined)
        portableRelative(manifest, `dependency graph source ${index} manifest`);
      return {
        ecosystem: source.ecosystem,
        lockfile,
        ...(manifest === undefined ? {} : { manifest }),
        resolver,
        digest: { sha256: source.digest.sha256 },
      };
    })
    .sort((left, right) => {
      const ecosystem = compareEcosystems(right.ecosystem, left.ecosystem);
      return ecosystem || compareStrings(left.lockfile, right.lockfile);
    });
}

function compareComponents(left, right) {
  return (
    compareEcosystems(left.ecosystem, right.ecosystem) ||
    compareStrings(left.name, right.name) ||
    compareStrings(left.version, right.version) ||
    compareStrings(left.ref, right.ref)
  );
}

export function validateDependencyGraph(graph) {
  assertObject(graph, "dependency graph");
  if (graph.schemaVersion !== 1) fail("dependency graph schemaVersion must be 1");
  const sources = normalizeSources(graph.sources);
  if (!sources.some(({ ecosystem }) => ecosystem === "npm")) {
    fail("dependency graph must include a pnpm lock source");
  }
  if (!sources.some(({ ecosystem }) => ecosystem === "cargo")) {
    fail("dependency graph must include a Cargo lock source");
  }
  if (!Array.isArray(graph.components) || graph.components.length === 0) {
    fail("dependency graph components must not be empty");
  }

  const componentByRef = new Map();
  for (const [index, component] of graph.components.entries()) {
    assertObject(component, `dependency component ${index}`);
    const ref = requireString(component.ref, `dependency component ${index} ref`);
    if (componentByRef.has(ref)) fail(`duplicate dependency component reference ${ref}`);
    if (component.ecosystem !== "npm" && component.ecosystem !== "cargo") {
      fail(`dependency component ${ref} has an unsupported ecosystem`);
    }
    if (component.type !== "library") fail(`dependency component ${ref} must be a library`);
    const normalized = {
      ref,
      ecosystem: component.ecosystem,
      type: "library",
      name: requireString(component.name, `dependency component ${ref} name`),
      version: requireString(component.version, `dependency component ${ref} version`),
      ...(component.source === undefined
        ? {}
        : { source: requireString(component.source, `dependency component ${ref} source`) }),
      ...(component.purl === undefined
        ? {}
        : { purl: requireString(component.purl, `dependency component ${ref} purl`) }),
      ...(component.license === undefined
        ? {}
        : { license: requireString(component.license, `dependency component ${ref} license`) }),
    };
    componentByRef.set(ref, normalized);
  }

  assertObject(graph.roots, "dependency graph roots");
  const roots = {};
  for (const ecosystem of ["npm", "cargo"]) {
    if (!Array.isArray(graph.roots[ecosystem]) || graph.roots[ecosystem].length === 0) {
      fail(`dependency graph roots.${ecosystem} must not be empty`);
    }
    const unique = new Set();
    for (const ref of graph.roots[ecosystem]) {
      if (!componentByRef.has(ref)) fail(`unknown dependency reference ${ref}`);
      if (componentByRef.get(ref).ecosystem !== ecosystem) {
        fail(`dependency root ${ref} does not belong to ${ecosystem}`);
      }
      if (unique.has(ref)) fail(`duplicate dependency root ${ref}`);
      unique.add(ref);
    }
    roots[ecosystem] = [...unique].sort(compareStrings);
  }

  if (!Array.isArray(graph.dependencies)) fail("dependency graph dependencies must be an array");
  const dependencyByRef = new Map();
  for (const [index, dependency] of graph.dependencies.entries()) {
    assertObject(dependency, `dependency edge set ${index}`);
    const ref = requireString(dependency.ref, `dependency edge set ${index} ref`);
    if (!componentByRef.has(ref)) fail(`unknown dependency reference ${ref}`);
    if (dependencyByRef.has(ref)) fail(`duplicate dependency edge set ${ref}`);
    if (!Array.isArray(dependency.dependsOn))
      fail(`dependency edge set ${ref} must have dependsOn`);
    const targets = new Set();
    for (const target of dependency.dependsOn) {
      if (!componentByRef.has(target)) fail(`unknown dependency reference ${target}`);
      if (targets.has(target)) fail(`duplicate dependency edge ${ref} -> ${target}`);
      targets.add(target);
    }
    dependencyByRef.set(ref, [...targets].sort(compareStrings));
  }
  for (const ref of componentByRef.keys()) {
    if (!dependencyByRef.has(ref)) fail(`dependency component ${ref} has no edge set`);
  }

  const reachable = new Set();
  const stack = [...roots.npm, ...roots.cargo];
  while (stack.length > 0) {
    const ref = stack.pop();
    if (reachable.has(ref)) continue;
    reachable.add(ref);
    stack.push(...dependencyByRef.get(ref));
  }
  for (const ref of componentByRef.keys()) {
    if (!reachable.has(ref)) fail(`dependency component ${ref} is unreachable from a release root`);
  }

  return {
    schemaVersion: 1,
    sources,
    roots,
    components: [...componentByRef.values()].sort(compareComponents),
    dependencies: [...dependencyByRef.entries()]
      .map(([ref, dependsOn]) => ({ ref, dependsOn }))
      .sort((left, right) => compareStrings(left.ref, right.ref)),
  };
}

export function normalizeDependencyGraph({ sources, npmProjects, cargoMetadata, rootDirectory }) {
  const components = new Map();
  const dependencies = new Map();
  const roots = {
    npm: collectNpmGraph(npmProjects, components, dependencies),
    cargo: collectCargoGraph(cargoMetadata, path.resolve(rootDirectory), components, dependencies),
  };
  return validateDependencyGraph({
    schemaVersion: 1,
    sources,
    roots,
    components: [...components.values()],
    dependencies: [...dependencies.entries()].map(([ref, dependsOn]) => ({
      ref,
      dependsOn: [...dependsOn],
    })),
  });
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }
  return result.stdout;
}

function parseCommandJson(source, name) {
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${name} did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function collectDependencyGraph({
  rootDirectory = defaultRoot,
  publicPackageNames,
  execute = runCommand,
} = {}) {
  const rootDirectory_ = path.resolve(rootDirectory);
  const release = JSON.parse(
    readFileSync(path.join(rootDirectory_, "release/packages.json"), "utf8"),
  );
  const packageNames = publicPackageNames ?? release.npm.public.map(({ name }) => name);
  if (!Array.isArray(packageNames) || packageNames.length === 0) {
    fail("public npm package list must not be empty");
  }
  const pnpmArgs = [
    "list",
    ...packageNames.flatMap((name) => ["--filter", name]),
    "--prod",
    "--json",
    "--depth",
    "Infinity",
  ];
  const npmProjects = parseCommandJson(execute("pnpm", pnpmArgs, rootDirectory_), "pnpm list");
  const observedPackages = npmProjects.map(({ name }) => name).sort(compareStrings);
  if (JSON.stringify(observedPackages) !== JSON.stringify([...packageNames].sort(compareStrings))) {
    fail("pnpm dependency roots do not match the public release package set");
  }

  const cargoMetadata = cargoDependencyRoots.map(({ manifest }) =>
    parseCommandJson(
      execute(
        "cargo",
        ["metadata", "--manifest-path", manifest, "--locked", "--format-version", "1"],
        rootDirectory_,
      ),
      `cargo metadata for ${manifest}`,
    ),
  );
  const sources = [
    {
      ecosystem: "npm",
      lockfile: "pnpm-lock.yaml",
      resolver: "pnpm list --filter <public-package> --prod --json --depth Infinity",
      digest: { sha256: sha256File(path.join(rootDirectory_, "pnpm-lock.yaml")) },
    },
    ...cargoDependencyRoots.map(({ manifest, lockfile }) => ({
      ecosystem: "cargo",
      lockfile,
      manifest,
      resolver: `cargo metadata --manifest-path ${manifest} --locked --format-version 1`,
      digest: { sha256: sha256File(path.join(rootDirectory_, lockfile)) },
    })),
  ];

  return normalizeDependencyGraph({
    sources,
    npmProjects,
    cargoMetadata,
    rootDirectory: rootDirectory_,
  });
}

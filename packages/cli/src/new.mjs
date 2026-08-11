import * as nodeFilesystem from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_MANIFEST_SCHEMA, COMPATIBILITY, NEXA_COMPILE_PACKAGES } from "./constants.mjs";

const templateDirectory = fileURLToPath(new URL("../templates/minimal-tsx/", import.meta.url));
const projectNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const windowsReservedNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

function isInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertProjectName(name) {
  if (name.length > 63 || !projectNamePattern.test(name)) {
    throw new Error(
      "project name must use 1-63 lowercase ASCII letters, numbers, and single hyphens",
    );
  }
  if (windowsReservedNames.test(name)) {
    throw new Error(`Project name ${JSON.stringify(name)} is reserved by Windows`);
  }
}

function displayNameFromProjectName(name) {
  return name
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function assertNoSymlinkSegments(filesystem, cwd, target) {
  const realCwd = filesystem.realpathSync(cwd);
  let current = cwd;
  for (const segment of path.relative(cwd, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!filesystem.existsSync(current)) continue;

    const metadata = filesystem.lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Target path contains a symbolic link: ${current}`);
    }
    if (current !== target && !metadata.isDirectory()) {
      throw new Error(`Target parent is not a directory: ${current}`);
    }
    if (!isInside(realCwd, filesystem.realpathSync(current))) {
      throw new Error("Target path resolves outside the current directory");
    }
  }
}

function resolveTarget(filesystem, cwd, requestedPath) {
  if (path.isAbsolute(requestedPath)) {
    throw new Error("Refusing to create a project at an absolute path");
  }
  if (requestedPath.split(/[\\/]+/u).includes("..")) {
    throw new Error("Refusing parent path traversal outside the current directory");
  }

  const root = path.resolve(cwd);
  const target = path.resolve(root, requestedPath);
  if (target === root || !isInside(root, target)) {
    throw new Error("Target must be a child of the current directory");
  }
  if (!filesystem.existsSync(root) || !filesystem.lstatSync(root).isDirectory()) {
    throw new Error(`Current directory does not exist or is not a directory: ${root}`);
  }

  assertNoSymlinkSegments(filesystem, root, target);
  if (filesystem.existsSync(target)) {
    const metadata = filesystem.lstatSync(target);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Target is a symbolic link: ${target}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Target exists and is not a directory: ${target}`);
    }
    if (filesystem.readdirSync(target).length > 0) {
      throw new Error(`Target directory is not empty: ${target}`);
    }
  }

  return { root, target };
}

function writeJson(filesystem, filePath, value) {
  filesystem.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function renderTemplate(filesystem, templateName, values) {
  let source = filesystem.readFileSync(path.join(templateDirectory, templateName), "utf8");
  for (const [key, value] of Object.entries(values)) {
    source = source.replaceAll(`{{${key}}}`, value);
  }
  return source.replaceAll("\r\n", "\n");
}

export function createProject({ requestedPath, cwd, filesystem = nodeFilesystem }) {
  const { root, target } = resolveTarget(filesystem, cwd, requestedPath);
  const projectName = path.basename(target);
  assertProjectName(projectName);
  const displayName = displayNameFromProjectName(projectName);

  filesystem.mkdirSync(path.join(target, "src"), { recursive: true });
  assertNoSymlinkSegments(filesystem, root, target);

  const packageJson = {
    name: projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    packageManager: `pnpm@${COMPATIBILITY.pnpm}`,
    engines: { node: COMPATIBILITY.node, pnpm: ">=9" },
    scripts: {
      build: "nexa build",
      dev: "nexa dev",
      doctor: "nexa doctor",
      package: "nexa package",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    dependencies: { "@nexa/ui": COMPATIBILITY.ui },
    devDependencies: {
      "@nexa/cli": COMPATIBILITY.cli,
      "@perryts/perry": COMPATIBILITY.perry,
      typescript: COMPATIBILITY.typescript,
    },
    perry: {
      compilePackages: [...NEXA_COMPILE_PACKAGES],
      allow: {
        nativeLibrary: ["@nexa/nui-host", "@nexa/system-host", "@nexa/ui"],
        compilePackages: [...NEXA_COMPILE_PACKAGES],
      },
    },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022"],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
      jsx: "react-jsx",
      jsxImportSource: "@nexa/ui",
      noEmit: true,
      types: [],
    },
    include: ["src/**/*.ts", "src/**/*.tsx"],
  };
  const manifest = {
    $schema: APP_MANIFEST_SCHEMA,
    schemaVersion: 1,
    id: `dev.nexa.${projectName}`,
    name: displayName,
    version: "0.1.0",
    requiredProtocol: { major: 1, minor: 0 },
    permissions: [],
  };
  const values = { DISPLAY_NAME: displayName, PROJECT_NAME: projectName };

  writeJson(filesystem, path.join(target, "package.json"), packageJson);
  writeJson(filesystem, path.join(target, "tsconfig.json"), tsconfig);
  writeJson(filesystem, path.join(target, "app.manifest.json"), manifest);
  filesystem.writeFileSync(
    path.join(target, "src", "main.tsx"),
    renderTemplate(filesystem, "main.tsx.tmpl", values),
    { encoding: "utf8", flag: "wx" },
  );
  filesystem.writeFileSync(
    path.join(target, "README.md"),
    renderTemplate(filesystem, "README.md.tmpl", values),
    { encoding: "utf8", flag: "wx" },
  );
  filesystem.writeFileSync(
    path.join(target, ".gitignore"),
    renderTemplate(filesystem, ".gitignore.tmpl", values),
    { encoding: "utf8", flag: "wx" },
  );

  return { displayName, projectName, target };
}

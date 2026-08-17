import { existsSync, readFileSync, readdirSync } from "node:fs";
import path, { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

const workspacePackages = new Map();
const packagesDirectory = fileURLToPath(new URL("../packages/", import.meta.url));
for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageRoot = path.join(packagesDirectory, entry.name);
  const manifestPath = path.join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.name === "string")
    workspacePackages.set(manifest.name, { manifest, packageRoot });
}

function exportTarget(exports, key) {
  const value = exports?.[key];
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.perry === "string") return value.perry;
  return typeof value.import === "string" ? value.import : null;
}

function sourceCandidate(packageRoot, target) {
  const sourceTarget = target.replace(/^\.\/dist\//u, "./src/").replace(/\.js$/u, ".ts");
  for (const candidate of [sourceTarget, sourceTarget.replace(/\.ts$/u, ".tsx")]) {
    const absolute = path.resolve(packageRoot, candidate);
    if (existsSync(absolute)) return pathToFileURL(absolute).href;
  }
  return null;
}

export function resolveWorkspaceTypeScript(specifier) {
  for (const [packageName, { manifest, packageRoot }] of workspacePackages) {
    if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue;
    const subpath = specifier.slice(packageName.length);
    const key = subpath === "" ? "." : `.${subpath}`;
    const target = exportTarget(manifest.exports, key);
    if (target !== null) return sourceCandidate(packageRoot, target);
    if (key === ".") return sourceCandidate(packageRoot, "./src/index.ts");
    return null;
  }
  return null;
}

function resolveTypeScript(specifier, parentURL) {
  if (!isRelative(specifier) || extname(specifier) !== "" || parentURL === undefined) {
    return null;
  }
  for (const suffix of [".ts", "/index.ts"]) {
    const candidate = new URL(`${specifier}${suffix}`, parentURL);
    if (candidate.protocol === "file:" && existsSync(fileURLToPath(candidate))) {
      return candidate.href;
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const workspaceUrl = resolveWorkspaceTypeScript(specifier);
    if (workspaceUrl !== null) return { url: workspaceUrl, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const url = resolveTypeScript(specifier, context.parentURL);
      if (url !== null) return { url, shortCircuit: true };
      throw error;
    }
  },

  load(url, context, nextLoad) {
    if (!url.endsWith(".ts") && !url.endsWith(".tsx")) {
      return nextLoad(url, context);
    }
    const fileName = fileURLToPath(url);
    const result = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      throw new SyntaxError(
        errors
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
          .join("\n"),
      );
    }
    return { format: "module", source: result.outputText, shortCircuit: true };
  },
});

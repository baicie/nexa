import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateDependencyGraph } from "./release-dependency-graph.mjs";

const defaultPolicyPath = new URL("../release/artifact-integrity.json", import.meta.url);
const hashBuffer = Buffer.allocUnsafe(1024 * 1024);

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireAbsoluteUrl(value, label) {
  requireNonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (!parsed.protocol || parsed.protocol === "file:") {
    throw new Error(`${label} must be a non-file absolute URL`);
  }
  return value;
}

function loadPolicy(policyPath = defaultPolicyPath) {
  const policy = parseJson(policyPath, "artifact integrity policy");
  if (policy.schemaVersion !== 1) throw new Error("unsupported artifact integrity policy schema");
  if (policy.digest !== "sha256") throw new Error("artifact integrity digest must be sha256");
  if (policy.sbom?.format !== "CycloneDX" || policy.sbom?.specVersion !== "1.6") {
    throw new Error("artifact integrity policy must use CycloneDX 1.6");
  }
  if (
    policy.sbom.dependencyGraphRequired !== true ||
    JSON.stringify(policy.sbom.ecosystems) !== JSON.stringify(["npm", "cargo"])
  ) {
    throw new Error("artifact integrity policy must require npm and Cargo dependency graphs");
  }
  if (
    policy.provenance?.statementType !== "https://in-toto.io/Statement/v1" ||
    policy.provenance?.predicateType !== "https://slsa.dev/provenance/v1"
  ) {
    throw new Error(
      "artifact integrity policy must use in-toto Statement v1 and SLSA provenance v1",
    );
  }

  const outputs = [policy.outputs?.checksums, policy.outputs?.sbom, policy.outputs?.provenance];
  for (const output of outputs) {
    requireNonEmptyString(output, "evidence output name");
    if (path.basename(output) !== output || /[\r\n]/u.test(output)) {
      throw new Error(`evidence output must be a plain file name: ${output}`);
    }
  }
  if (new Set(outputs).size !== outputs.length)
    throw new Error("evidence output names must be unique");
  return policy;
}

function normalizeDigest(digest, label) {
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) {
    throw new Error(`${label}.digest must be an object`);
  }
  const entries = Object.entries(digest).sort(([left], [right]) => compareStrings(left, right));
  if (entries.length === 0) throw new Error(`${label}.digest must not be empty`);
  const normalized = {};
  for (const [algorithm, value] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(algorithm) ||
      typeof value !== "string" ||
      !/^[0-9a-f]+$/u.test(value)
    ) {
      throw new Error(`${label}.digest must contain named lowercase hexadecimal digests`);
    }
    normalized[algorithm] = value;
  }
  return normalized;
}

function loadDescriptor(descriptorPath, policy) {
  if (!descriptorPath) throw new Error("descriptor path is required");
  const descriptor = parseJson(descriptorPath, "release build descriptor");
  if (descriptor.schemaVersion !== 1)
    throw new Error("unsupported release build descriptor schema");

  const name = requireNonEmptyString(descriptor.release?.name, "release.name");
  const version = requireNonEmptyString(descriptor.release?.version, "release.version");
  const repository = requireAbsoluteUrl(descriptor.source?.repository, "source.repository");
  const revision = requireNonEmptyString(descriptor.source?.revision, "source.revision");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision)) {
    throw new Error("source.revision must be a full lowercase Git object ID");
  }
  const dirty = descriptor.source?.dirty;
  if (typeof dirty !== "boolean") throw new Error("source.dirty must be a boolean");
  const builderId = requireAbsoluteUrl(descriptor.build?.builderId, "build.builderId");
  const buildType = requireAbsoluteUrl(descriptor.build?.buildType, "build.buildType");
  const sourceDateEpoch = descriptor.build?.sourceDateEpoch;
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new Error("build.sourceDateEpoch must be a non-negative integer");
  }
  const timestamp = new Date(sourceDateEpoch * 1000);
  if (Number.isNaN(timestamp.valueOf()))
    throw new Error("build.sourceDateEpoch is outside the supported date range");

  const materials = descriptor.materials ?? [];
  if (!Array.isArray(materials)) throw new Error("materials must be an array");
  const normalizedMaterials = materials
    .map((material, index) => ({
      uri: requireAbsoluteUrl(material?.uri, `materials[${index}].uri`),
      digest: normalizeDigest(material?.digest, `materials[${index}]`),
    }))
    .sort((left, right) => compareStrings(left.uri, right.uri));

  if (policy.sbom.dependencyGraphRequired && descriptor.dependencyGraph === undefined) {
    throw new Error("release descriptor must include a dependency graph");
  }
  const dependencyGraph = validateDependencyGraph(descriptor.dependencyGraph);
  for (const source of dependencyGraph.sources) {
    const suffix = `/${source.lockfile}`;
    const material = normalizedMaterials.find(({ uri }) => new URL(uri).pathname.endsWith(suffix));
    if (!material || material.digest.sha256 !== source.digest.sha256) {
      throw new Error(
        `dependency source ${source.lockfile} must match a SHA-256 provenance material`,
      );
    }
  }

  return {
    release: { name, version },
    source: { repository, revision, dirty },
    build: { builderId, buildType, sourceDateEpoch, timestamp: timestamp.toISOString() },
    materials: normalizedMaterials,
    dependencyGraph,
  };
}

function directoriesOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertSeparateDirectories(artifactsDir, evidenceDir) {
  if (
    directoriesOverlap(artifactsDir, evidenceDir) ||
    directoriesOverlap(evidenceDir, artifactsDir)
  ) {
    throw new Error("artifact and evidence directories must not overlap");
  }
}

function hashFile(file) {
  const hash = createHash("sha256");
  const handle = openSync(file, "r");
  let size = 0;
  try {
    for (;;) {
      const bytesRead = readSync(handle, hashBuffer, 0, hashBuffer.length, null);
      if (bytesRead === 0) break;
      hash.update(hashBuffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally {
    closeSync(handle);
  }
  return { sha256: hash.digest("hex"), size };
}

function collectArtifacts(artifactsDir) {
  if (!existsSync(artifactsDir))
    throw new Error(`artifact directory does not exist: ${artifactsDir}`);
  const artifacts = [];

  function visit(directory, relativeDirectory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (/[\\\r\n\0]/u.test(relativePath)) {
        throw new Error(`artifact path is not portable: ${relativePath}`);
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`symlink artifact is not allowed: ${relativePath}`);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        artifacts.push({ name: relativePath, ...hashFile(absolutePath) });
      } else {
        throw new Error(`special artifact is not allowed: ${relativePath}`);
      }
    }
  }

  visit(artifactsDir, "");
  if (artifacts.length === 0) throw new Error("release artifact directory is empty");
  return artifacts.sort((left, right) => compareStrings(left.name, right.name));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function stableJson(value, indentation = 0) {
  return `${JSON.stringify(canonicalize(value), null, indentation)}\n`;
}

function releaseReference(descriptor) {
  const identity = `${descriptor.release.name}@${descriptor.release.version}`;
  return `urn:nexa:release:sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

function artifactReference(artifact) {
  const identity = `${artifact.name}\0${artifact.sha256}`;
  return `urn:nexa:artifact:sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

function dependencyComponent(component) {
  return {
    type: component.type,
    "bom-ref": component.ref,
    name: component.name,
    version: component.version,
    ...(component.purl === undefined ? {} : { purl: component.purl }),
    ...(component.license === undefined
      ? {}
      : { licenses: [{ license: { name: component.license } }] }),
    properties: [
      { name: "nexa:dependency:ecosystem", value: component.ecosystem },
      ...(component.source === undefined
        ? []
        : [{ name: "nexa:dependency:source", value: component.source }]),
    ],
  };
}

function checksumDocument(artifacts) {
  return artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}\n`).join("");
}

function sbomDocument(descriptor, policy, artifacts) {
  return stableJson(
    {
      bomFormat: policy.sbom.format,
      specVersion: policy.sbom.specVersion,
      version: 1,
      metadata: {
        timestamp: descriptor.build.timestamp,
        tools: {
          components: [{ type: "application", name: "nexa-release-evidence", version: "1" }],
        },
        component: {
          type: "application",
          "bom-ref": releaseReference(descriptor),
          name: descriptor.release.name,
          version: descriptor.release.version,
        },
        properties: [
          { name: "nexa:source:repository", value: descriptor.source.repository },
          { name: "nexa:source:revision", value: descriptor.source.revision },
        ],
      },
      components: [
        ...artifacts.map((artifact) => ({
          type: "file",
          "bom-ref": artifactReference(artifact),
          name: artifact.name,
          hashes: [{ alg: "SHA-256", content: artifact.sha256 }],
          properties: [
            { name: "nexa:artifact:path", value: artifact.name },
            { name: "nexa:artifact:size", value: String(artifact.size) },
          ],
        })),
        ...descriptor.dependencyGraph.components.map(dependencyComponent),
      ],
      dependencies: [
        {
          ref: releaseReference(descriptor),
          dependsOn: [
            ...descriptor.dependencyGraph.roots.cargo,
            ...descriptor.dependencyGraph.roots.npm,
          ].sort(compareStrings),
        },
        ...descriptor.dependencyGraph.dependencies,
      ],
    },
    2,
  );
}

function provenanceDocument(descriptor, policy, artifacts) {
  const resolvedDependencies = [
    {
      uri: `git+${descriptor.source.repository}@${descriptor.source.revision}`,
      digest: { gitCommit: descriptor.source.revision },
    },
    ...descriptor.materials,
  ];
  const invocationSeed = stableJson({
    release: descriptor.release,
    source: descriptor.source,
    build: descriptor.build,
    materials: descriptor.materials,
    artifacts,
  });
  const invocationId = `urn:nexa:build:sha256:${createHash("sha256").update(invocationSeed).digest("hex")}`;

  return stableJson({
    _type: policy.provenance.statementType,
    subject: artifacts.map((artifact) => ({
      name: artifact.name,
      digest: { sha256: artifact.sha256 },
    })),
    predicateType: policy.provenance.predicateType,
    predicate: {
      buildDefinition: {
        buildType: descriptor.build.buildType,
        externalParameters: { release: descriptor.release, source: descriptor.source },
        internalParameters: {},
        resolvedDependencies,
      },
      runDetails: {
        builder: { id: descriptor.build.builderId },
        metadata: {
          invocationId,
          startedOn: descriptor.build.timestamp,
          finishedOn: descriptor.build.timestamp,
        },
      },
    },
  });
}

function buildEvidence({ artifactsDir, descriptorPath, policyPath }) {
  const policy = loadPolicy(policyPath);
  const descriptor = loadDescriptor(descriptorPath, policy);
  const artifacts = collectArtifacts(artifactsDir);
  const documents = new Map([
    [policy.outputs.checksums, checksumDocument(artifacts)],
    [policy.outputs.sbom, sbomDocument(descriptor, policy, artifacts)],
    [policy.outputs.provenance, provenanceDocument(descriptor, policy, artifacts)],
  ]);
  return { policy, artifacts, documents };
}

function normalizeDirectories(artifactsDir, evidenceDir) {
  if (!artifactsDir || !evidenceDir)
    throw new Error("artifact and evidence directories are required");
  const normalized = {
    artifactsDir: path.resolve(artifactsDir),
    evidenceDir: path.resolve(evidenceDir),
  };
  assertSeparateDirectories(normalized.artifactsDir, normalized.evidenceDir);
  return normalized;
}

export function generateEvidence({
  artifactsDir,
  evidenceDir,
  descriptorPath,
  policyPath = defaultPolicyPath,
}) {
  const directories = normalizeDirectories(artifactsDir, evidenceDir);
  const evidence = buildEvidence({
    artifactsDir: directories.artifactsDir,
    descriptorPath,
    policyPath,
  });
  mkdirSync(directories.evidenceDir, { recursive: true });
  for (const [name, source] of evidence.documents) {
    writeFileSync(path.join(directories.evidenceDir, name), source, "utf8");
  }
  return { artifactCount: evidence.artifacts.length, outputs: [...evidence.documents.keys()] };
}

export function verifyEvidence({
  artifactsDir,
  evidenceDir,
  descriptorPath,
  policyPath = defaultPolicyPath,
}) {
  const directories = normalizeDirectories(artifactsDir, evidenceDir);
  const evidence = buildEvidence({
    artifactsDir: directories.artifactsDir,
    descriptorPath,
    policyPath,
  });
  for (const [name, expected] of evidence.documents) {
    const file = path.join(directories.evidenceDir, name);
    if (!existsSync(file)) throw new Error(`missing evidence file: ${name}`);
    const actual = readFileSync(file, "utf8");
    if (actual !== expected) {
      if (name === evidence.policy.outputs.checksums) {
        throw new Error(`${name} does not match the release artifacts`);
      }
      throw new Error(
        `${name} is not canonical or does not match the release descriptor and artifacts`,
      );
    }
  }
  return { artifactCount: evidence.artifacts.length, outputs: [...evidence.documents.keys()] };
}

function usage() {
  return "Usage: node tools/release-evidence.mjs <generate|verify> --artifacts DIR --evidence DIR --descriptor FILE [--policy FILE]";
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_;
  if (command !== "generate" && command !== "verify") throw new Error(usage());
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!["--artifacts", "--evidence", "--descriptor", "--policy"].includes(flag) || !value) {
      throw new Error(usage());
    }
    if (values[flag]) throw new Error(`duplicate argument: ${flag}`);
    values[flag] = value;
  }
  if (!values["--artifacts"] || !values["--evidence"] || !values["--descriptor"])
    throw new Error(usage());
  return {
    command,
    options: {
      artifactsDir: values["--artifacts"],
      evidenceDir: values["--evidence"],
      descriptorPath: values["--descriptor"],
      policyPath: values["--policy"] ?? defaultPolicyPath,
    },
  };
}

function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const result = command === "generate" ? generateEvidence(options) : verifyEvidence(options);
  console.log(
    `${command === "generate" ? "generated" : "verified"} release evidence for ${result.artifactCount} artifacts`,
  );
  console.log(result.outputs.join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

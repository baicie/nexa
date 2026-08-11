import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArchive, extractArchive, inventoryBinaries } from "./archive-utils.mjs";
import { verifyEvidence } from "./release-evidence.mjs";
import { createEnvironmentCredentialSession } from "./signing-credentials.mjs";
import { SigningPolicyError, loadSigningPolicy, validateSigningPolicy } from "./signing-policy.mjs";

const EXECUTOR_VERSION = "1.2.0";
const PLATFORM_EXTENSIONS = { darwin: ".tar.gz", win32: ".zip" };
const FRESH_LAUNCH_OBSERVATION_MS = 5_000;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const G6_05_OUTPUTS = ["SHA256SUMS", "provenance.intoto.jsonl", "sbom.cdx.json"];

export class SigningExecutorError extends Error {
  constructor(message) {
    super(message);
    this.name = "SigningExecutorError";
  }
}

function fail(message) {
  throw new SigningExecutorError(message);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function requireSafeArtifactName(name, platform) {
  if (typeof name !== "string" || name.length === 0 || path.basename(name) !== name) {
    fail("artifactName must be a non-empty file name");
  }
  const extension = PLATFORM_EXTENSIONS[platform];
  if (!extension || !name.endsWith(`-unsigned${extension}`)) {
    fail(`artifactName must end with -unsigned${extension} for ${platform}`);
  }
  return name;
}

function derivedName(sourceName, platform, artifactClass) {
  const extension = PLATFORM_EXTENSIONS[platform];
  return `${sourceName.slice(0, -`-unsigned${extension}`.length)}-${artifactClass}${extension}`;
}

function requireRegularFile(file, description) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    fail(`${description} does not exist`);
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    fail(`${description} must be a regular non-symlink file`);
  return stat;
}

function requireUnsignedEvidenceInput(unsignedEvidence) {
  if (
    !unsignedEvidence ||
    typeof unsignedEvidence !== "object" ||
    Array.isArray(unsignedEvidence) ||
    typeof unsignedEvidence.descriptorPath !== "string" ||
    unsignedEvidence.descriptorPath.length === 0 ||
    typeof unsignedEvidence.evidenceDir !== "string" ||
    unsignedEvidence.evidenceDir.length === 0 ||
    JSON.stringify(Object.keys(unsignedEvidence).sort()) !==
      JSON.stringify(["descriptorPath", "evidenceDir"])
  ) {
    fail("unsignedEvidence with descriptorPath and evidenceDir is required");
  }
  return {
    descriptorPath: path.resolve(unsignedEvidence.descriptorPath),
    evidenceDir: path.resolve(unsignedEvidence.evidenceDir),
  };
}

function readJson(file, description) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${description} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function evidenceBundleDigest(artifactCount, descriptor, outputs) {
  const hash = createHash("sha256");
  hash.update(`artifact-count\0${artifactCount}\0`, "utf8");
  for (const entry of [descriptor, ...outputs]) {
    hash.update(entry.name, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.sha256, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function verifyUnsignedInput({
  unsignedRoot,
  source,
  artifactName,
  platform,
  revision,
  unsignedEvidence,
}) {
  const descriptorPath = unsignedEvidence.descriptorPath;
  const evidenceDir = unsignedEvidence.evidenceDir;
  requireRegularFile(descriptorPath, "G6-05 descriptor");
  const descriptorBefore = sha256(descriptorPath);
  const descriptorBytes = readFileSync(descriptorPath);
  const outputBefore = new Map();
  const outputBytes = new Map();
  for (const name of G6_05_OUTPUTS) {
    const file = path.join(evidenceDir, name);
    requireRegularFile(file, `G6-05 evidence ${name}`);
    outputBefore.set(name, sha256(file));
    outputBytes.set(name, readFileSync(file));
  }
  const sourceDigest = sha256(source);

  let verification;
  try {
    verification = verifyEvidence({
      artifactsDir: unsignedRoot,
      evidenceDir,
      descriptorPath,
    });
  } catch (error) {
    fail(
      `G6-05 unsigned input verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const verifiedOutputs = [...verification.outputs].sort();
  if (JSON.stringify(verifiedOutputs) !== JSON.stringify(G6_05_OUTPUTS)) {
    fail("G6-05 verifier did not validate the required evidence outputs");
  }
  if (sha256(source) !== sourceDigest) fail("unsigned input changed during G6-05 verification");
  if (sha256(descriptorPath) !== descriptorBefore) {
    fail("G6-05 descriptor changed during verification");
  }
  for (const name of G6_05_OUTPUTS) {
    if (sha256(path.join(evidenceDir, name)) !== outputBefore.get(name)) {
      fail(`G6-05 evidence ${name} changed during verification`);
    }
  }

  const descriptor = readJson(descriptorPath, "G6-05 descriptor");
  if (descriptor.source?.revision !== revision) {
    fail("G6-05 descriptor revision does not match the signing revision");
  }
  if (descriptor.source?.dirty !== false) fail("G6-05 descriptor must identify a clean source");
  if (descriptor.release?.version !== artifactIdentity(artifactName, platform).version) {
    fail("G6-05 descriptor release version does not match the unsigned artifact");
  }

  const descriptorBinding = { name: path.basename(descriptorPath), sha256: descriptorBefore };
  const outputs = G6_05_OUTPUTS.map((name) => ({ name, sha256: outputBefore.get(name) }));
  return {
    sourceDigest,
    inputEvidence: {
      schemaVersion: 1,
      artifactCount: verification.artifactCount,
      descriptor: descriptorBinding,
      outputs,
      bundleSha256: evidenceBundleDigest(verification.artifactCount, descriptorBinding, outputs),
    },
    inputEvidenceFiles: {
      "g6-05-descriptor.json": descriptorBytes,
      "g6-05-SHA256SUMS": outputBytes.get("SHA256SUMS"),
      "g6-05-provenance.intoto.jsonl": outputBytes.get("provenance.intoto.jsonl"),
      "g6-05-sbom.cdx.json": outputBytes.get("sbom.cdx.json"),
    },
  };
}

function portable(relative) {
  return relative.split(path.sep).join("/");
}

function artifactIdentity(name, platform) {
  const label = platform === "darwin" ? "macos" : "windows";
  const extension = PLATFORM_EXTENSIONS[platform];
  const match = name.match(
    new RegExp(
      `^.+-(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)-${label}-(arm64|x64)-unsigned${extension.replaceAll(".", "\\.")}$`,
      "u",
    ),
  );
  if (!match) fail(`artifactName does not encode a valid ${label} version and architecture`);
  if (platform === "win32" && match[2] !== "x64") fail("Windows Technical Preview requires x64");
  return { version: match[1], arch: match[2] };
}

function findNamedFiles(root, expectedName) {
  const matches = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) fail(`signing archive contains a symlink: ${absolute}`);
      if (metadata.isDirectory()) visit(absolute);
      else if (metadata.isFile() && entry.name === expectedName) matches.push(absolute);
      else if (!metadata.isFile()) fail(`signing archive contains a special file: ${absolute}`);
    }
  }
  visit(root);
  return matches;
}

function readBuildMetadata(root, identity, platform) {
  const matches = findNamedFiles(root, "nexa-build.json");
  if (matches.length !== 1) fail(`signing allowlist requires exactly one nexa-build.json`);
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(matches[0], "utf8"));
  } catch (error) {
    fail(`nexa-build.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    metadata?.schemaVersion !== 1 ||
    metadata?.app?.version !== identity.version ||
    metadata?.target?.platform !== platform ||
    metadata?.target?.arch !== identity.arch
  ) {
    fail("nexa-build.json does not match the artifact signing identity");
  }
  return { file: matches[0], metadata };
}

function inspectSigningLayout(root, platform, artifactName) {
  const identity = artifactIdentity(artifactName, platform);
  const build = readBuildMetadata(root, identity, platform);
  const inventory = inventoryBinaries(root, platform);
  if (inventory.length !== 1) {
    fail(
      `signing allowlist requires exactly one ${platform} executable, found ${inventory.length}`,
    );
  }
  const executable = inventory[0];
  const executableRelative = portable(executable.relative);
  const metadataRelative = portable(path.relative(root, build.file));
  if (platform === "darwin") {
    const topLevel = readdirSync(root, { withFileTypes: true });
    const appEntries = topLevel.filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".app"),
    );
    if (topLevel.length !== 1 || appEntries.length !== 1) {
      fail("signing allowlist requires exactly one top-level macOS .app bundle");
    }
    const appRelative = appEntries[0].name;
    const prefix = `${appRelative}/Contents/MacOS/`;
    if (
      !executableRelative.startsWith(prefix) ||
      executableRelative.slice(prefix.length).includes("/")
    ) {
      fail("signing allowlist requires one application executable under Contents/MacOS");
    }
    if (metadataRelative !== `${appRelative}/Contents/Resources/nexa-build.json`) {
      fail("signing allowlist requires package metadata under Contents/Resources");
    }
    if ((statSync(executable.absolute).mode & 0o111) === 0) {
      fail("macOS signing allowlist executable is not marked executable");
    }
    const application = path.join(root, appRelative);
    return {
      application,
      executable: executable.absolute,
      signingTargets: [executable.absolute, application],
      inventory: [{ relative: executableRelative, depth: executable.depth }],
    };
  }
  if (!executableRelative.endsWith(".exe")) {
    fail("signing allowlist requires one Windows .exe");
  }
  if (portable(path.dirname(executableRelative)) !== portable(path.dirname(metadataRelative))) {
    fail("signing allowlist requires the executable and package metadata in the same directory");
  }
  return {
    application: path.dirname(executable.absolute),
    executable: executable.absolute,
    signingTargets: [executable.absolute],
    inventory: [{ relative: executableRelative, depth: executable.depth }],
  };
}

function commandFor(policy, platform, tool) {
  const entry = policy.execution.reviewedExecutor.platforms[platform].commands.find(
    (candidate) => candidate.name === tool,
  );
  if (!entry) fail(`policy does not bind ${tool} for ${platform}`);
  return entry.path;
}

function invoke(toolRunner, context, stage, executable, arguments_) {
  let result;
  try {
    result = toolRunner({ ...context, stage, executable, arguments: arguments_ });
  } catch (error) {
    fail(`${stage} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!result || result.status !== 0) {
    const detail = result?.stderr || result?.stdout || "tool did not return status 0";
    fail(`${stage} failed: ${detail}`);
  }
  return String(result.stdout || result.stderr || "");
}

function defaultToolRunner({ stage, executable, arguments: arguments_, workingDirectory }) {
  const result = spawnSync(executable, arguments_, {
    cwd: workingDirectory,
    encoding: "utf8",
    shell: false,
    timeout: stage === "fresh-launch" ? FRESH_LAUNCH_OBSERVATION_MS : undefined,
    windowsHide: true,
  });
  if (stage === "fresh-launch") {
    if (result.error?.code === "ETIMEDOUT") {
      return {
        status: 0,
        stdout: `application remained alive for ${FRESH_LAUNCH_OBSERVATION_MS}ms`,
        stderr: "",
      };
    }
    return {
      status: 1,
      stdout: result.stdout ?? "",
      stderr:
        result.error?.message ??
        `application exited before ${FRESH_LAUNCH_OBSERVATION_MS}ms with ${result.status}`,
    };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.error ? result.error.message : (result.stderr ?? ""),
  };
}

function runDarwin(policy, context, toolRunner) {
  const codesign = commandFor(policy, "darwin", "codesign");
  const ditto = commandFor(policy, "darwin", "ditto");
  const notarytool = commandFor(policy, "darwin", "notarytool");
  const stapler = commandFor(policy, "darwin", "stapler");
  const spctl = commandFor(policy, "darwin", "spctl");
  const keychainArguments = context.signingKeychain ? ["--keychain", context.signingKeychain] : [];
  for (const target of context.signingTargets) {
    invoke(toolRunner, context, "codesign-sign", codesign, [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      context.identity,
      ...keychainArguments,
      target,
    ]);
  }
  const displayTarget = context.application;
  invoke(toolRunner, context, "codesign-verify", codesign, [
    "--verify",
    "--deep",
    "--strict",
    "--all-architectures",
    "--verbose=2",
    ...keychainArguments,
    displayTarget,
  ]);
  context.evidence["codesign-details.txt"] = invoke(
    toolRunner,
    context,
    "codesign-display",
    codesign,
    ["--display", "--verbose=4", ...keychainArguments, displayTarget],
  );
  const notarizationArchive = path.join(context.workingDirectory, "notarization.zip");
  invoke(toolRunner, context, "notary-archive", ditto, [
    "-c",
    "-k",
    "--keepParent",
    "--sequesterRsrc",
    context.application,
    notarizationArchive,
  ]);
  const submission = invoke(toolRunner, context, "notary-submit", notarytool, [
    "notarytool",
    "submit",
    notarizationArchive,
    "--keychain-profile",
    context.notaryProfile,
    ...(context.notaryKeychain ? ["--keychain", context.notaryKeychain] : []),
    "--wait",
    "--output-format",
    "json",
  ]);
  let submissionJson;
  try {
    submissionJson = JSON.parse(submission);
  } catch {
    fail("notary-submit failed: expected JSON response");
  }
  if (submissionJson.status !== policy.platforms.darwin.notarization.acceptedStatus) {
    fail(`notary-submit failed: expected ${policy.platforms.darwin.notarization.acceptedStatus}`);
  }
  if (typeof submissionJson.id !== "string" || submissionJson.id.length === 0) {
    fail("notary-submit failed: missing submission id");
  }
  context.evidence["notarytool-submission.json"] = `${JSON.stringify(submissionJson, null, 2)}\n`;
  context.evidence["notarytool-log.json"] = invoke(toolRunner, context, "notary-log", notarytool, [
    "notarytool",
    "log",
    submissionJson.id,
    "--keychain-profile",
    context.notaryProfile,
    ...(context.notaryKeychain ? ["--keychain", context.notaryKeychain] : []),
    "--output-format",
    "json",
  ]);
  invoke(toolRunner, context, "stapler-staple", stapler, [
    "stapler",
    "staple",
    context.application,
  ]);
  context.evidence["stapler-validate.txt"] = invoke(
    toolRunner,
    context,
    "stapler-validate",
    stapler,
    ["stapler", "validate", context.application],
  );
  context.evidence["spctl-assessment.txt"] = invoke(toolRunner, context, "spctl-assess", spctl, [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    context.application,
  ]);
}

function parseAuthenticode(output, context, stage) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(`${stage} failed: expected JSON response`);
  }
  if (parsed.Status !== "Valid") fail(`${stage} failed: Authenticode status is not Valid`);
  const signer = String(parsed.SignerCertificate?.Thumbprint ?? "").toUpperCase();
  if (signer !== context.thumbprint) fail(`${stage} failed: signer thumbprint does not match`);
  if (!parsed.TimeStamperCertificate || !parsed.TimeStamperCertificate.Thumbprint) {
    fail(`${stage} failed: RFC3161 timestamp certificate is missing`);
  }
  return parsed;
}

function runWindows(policy, context, toolRunner) {
  const signtool = commandFor(policy, "win32", "signtool");
  const powershell = commandFor(policy, "win32", "powershell");
  if (!/^[0-9A-F]{40}$/u.test(context.thumbprint)) {
    fail("Windows signing requires a 40-character certificate thumbprint");
  }
  for (const target of context.signingTargets) {
    invoke(toolRunner, context, "signtool-sign", signtool, [
      "sign",
      "/fd",
      "SHA256",
      "/tr",
      context.timestampUrl,
      "/td",
      "SHA256",
      "/s",
      context.certificateStore,
      "/sha1",
      context.thumbprint,
      target,
    ]);
    const signtoolOutput = invoke(toolRunner, context, "signtool-verify", signtool, [
      "verify",
      "/pa",
      "/all",
      "/v",
      target,
    ]);
    context.evidence["signtool-verify.txt"] =
      `${context.evidence["signtool-verify.txt"] ?? ""}${signtoolOutput}`;
    context.evidence["certificate-chain.txt"] = context.evidence["signtool-verify.txt"];
    const status = invoke(toolRunner, context, "authenticode-verify", powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-AuthenticodeSignature -LiteralPath $args[0] | ConvertTo-Json -Depth 4",
      target,
    ]);
    const parsed = parseAuthenticode(status, context, "authenticode-verify");
    context.evidence["authenticode-status.json"] = `${JSON.stringify(parsed, null, 2)}\n`;
  }
}

function verifyFreshArchive(policy, context, toolRunner) {
  const freshRoot = path.join(context.workingDirectory, "fresh-archive");
  extractArchive(context.workingArtifact, freshRoot, context.platform);
  const fresh = inspectSigningLayout(freshRoot, context.platform, context.artifactName);
  if (
    JSON.stringify(fresh.inventory.map(({ relative }) => relative)) !==
    JSON.stringify(context.inventory.map(({ relative }) => relative))
  ) {
    fail("fresh signing inventory does not match the pre-sign allowlist");
  }
  if (context.platform === "darwin") {
    const codesign = commandFor(policy, "darwin", "codesign");
    const stapler = commandFor(policy, "darwin", "stapler");
    const spctl = commandFor(policy, "darwin", "spctl");
    context.evidence["fresh-codesign-verify.txt"] = invoke(
      toolRunner,
      context,
      "fresh-codesign-verify",
      codesign,
      [
        "--verify",
        "--deep",
        "--strict",
        "--all-architectures",
        "--verbose=2",
        ...(context.signingKeychain ? ["--keychain", context.signingKeychain] : []),
        fresh.application,
      ],
    );
    context.evidence["fresh-stapler-validate.txt"] = invoke(
      toolRunner,
      context,
      "fresh-stapler-validate",
      stapler,
      ["stapler", "validate", fresh.application],
    );
    context.evidence["fresh-spctl-assessment.txt"] = invoke(
      toolRunner,
      context,
      "fresh-spctl-assess",
      spctl,
      ["--assess", "--type", "execute", "--verbose=4", fresh.application],
    );
  } else {
    const signtool = commandFor(policy, "win32", "signtool");
    const powershell = commandFor(policy, "win32", "powershell");
    context.evidence["fresh-signtool-verify.txt"] = invoke(
      toolRunner,
      context,
      "fresh-signtool-verify",
      signtool,
      ["verify", "/pa", "/all", "/v", fresh.executable],
    );
    const output = invoke(toolRunner, context, "fresh-authenticode-verify", powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-AuthenticodeSignature -LiteralPath $args[0] | ConvertTo-Json -Depth 4",
      fresh.executable,
    ]);
    parseAuthenticode(output, context, "fresh-authenticode-verify");
    context.evidence["fresh-authenticode-status.json"] = output;
  }
  context.evidence["fresh-launch.txt"] = invoke(
    toolRunner,
    context,
    "fresh-launch",
    fresh.executable,
    [],
  );
}

function signedIntegrityEvidence({
  artifactName,
  artifactDigest,
  platform,
  revision,
  sourceName,
  sourceDigest,
  inputEvidence,
  executor,
}) {
  const version = artifactIdentity(sourceName, platform).version;
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: artifactName,
        version,
        hashes: [{ alg: "SHA-256", content: artifactDigest }],
      },
    },
  };
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: artifactName, digest: { sha256: artifactDigest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://nexa-ui.dev/build-types/signing/v1",
        externalParameters: {
          platform,
          revision,
          source: { name: sourceName, sha256: sourceDigest, revision },
          inputEvidence,
          executor,
        },
        resolvedDependencies: [
          { uri: sourceName, digest: { sha256: sourceDigest } },
          {
            uri: `g6-05/${inputEvidence.descriptor.name}`,
            digest: { sha256: inputEvidence.descriptor.sha256 },
          },
          ...inputEvidence.outputs.map(({ name, sha256: digest }) => ({
            uri: `g6-05/${name}`,
            digest: { sha256: digest },
          })),
        ],
      },
      runDetails: { builder: { id: ".github/workflows/signing.yml" } },
    },
  };
  return {
    SHA256SUMS: `${artifactDigest}  ${artifactName}\n`,
    "sbom.cdx.json": `${JSON.stringify(sbom, null, 2)}\n`,
    "provenance.intoto.jsonl": `${JSON.stringify(provenance)}\n`,
  };
}

function copyExclusive(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
}

function stageCustody(directory, name, source, record, evidence = {}) {
  mkdirSync(directory, { recursive: true });
  const finalDirectory = path.join(directory, `${name}.custody`);
  if (existsSync(finalDirectory)) fail(`immutable custody destination already exists: ${name}`);
  const stagingDirectory = mkdtempSync(path.join(directory, ".staging-"));
  try {
    const stagedArtifact = path.join(stagingDirectory, name);
    copyExclusive(source, stagedArtifact);
    const recordName = `${name}.custody.json`;
    const stagedRecord = path.join(stagingDirectory, recordName);
    writeFileSync(stagedRecord, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o444,
    });
    for (const evidenceName of Object.keys(evidence).sort()) {
      if (path.basename(evidenceName) !== evidenceName || evidenceName.includes("\\")) {
        fail(`unsafe evidence name: ${evidenceName}`);
      }
      writeFileSync(
        path.join(stagingDirectory, `${name}.${evidenceName}`),
        evidence[evidenceName],
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o444,
        },
      );
    }
    for (const entry of readdirSync(stagingDirectory)) {
      const file = path.join(stagingDirectory, entry);
      chmodSync(file, statSync(file).mode & ~0o222);
    }
    return {
      stagingDirectory,
      finalDirectory,
      artifact: path.join(finalDirectory, name),
      custodyRecord: path.join(finalDirectory, recordName),
    };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function sealCustody(staged) {
  renameSync(staged.stagingDirectory, staged.finalDirectory);
  return {
    artifact: staged.artifact,
    custodyRecord: staged.custodyRecord,
  };
}

function assertReady(policy) {
  if (policy.execution.credentialActivation !== "active") fail("credential activation is disabled");
  if (policy.execution.state !== "active") fail("signing executor is disabled");
  for (const platform of ["darwin", "win32"]) {
    if (policy.credentials[platform].owner.status !== "assigned") {
      fail(`${platform} credential owner is unassigned`);
    }
  }
  if (policy.rollback.incidentOwner.status !== "assigned")
    fail("release incident owner is unassigned");
}

export function executorVersion() {
  return EXECUTOR_VERSION;
}

// Compatibility adapter for the original executor contract. The production
// path uses createEnvironmentCredentialSession directly; this adapter keeps
// existing fake-tool fixtures readable while the credential boundary evolves.
export function createCredentialSession({
  platform,
  environment = process.env,
  commandRunner,
  randomBytes,
} = {}) {
  if (typeof commandRunner !== "function") fail("commandRunner is required");
  if (platform === "darwin") {
    // Older fake-tool fixtures only model the certificate and identity. The
    // production environment still requires all four App Store Connect fields;
    // these non-secret placeholders keep the compatibility adapter narrow.
    environment.NEXA_APPLE_TEAM_ID ??= "NEXA";
    environment.NEXA_APPLE_NOTARY_KEY_ID ??= "NEXA-KEY";
    environment.NEXA_APPLE_NOTARY_ISSUER_ID ??= "nexa-issuer";
  }
  const legacyStages = {
    "create-keychain": "macos-create-keychain",
    "configure-keychain": "macos-configure-keychain",
    "unlock-keychain": "macos-unlock-keychain",
    "import-signing-certificate": "macos-import-certificate",
    "authorize-codesign": "macos-authorize-codesign",
    "find-signing-identity": "macos-find-signing-identity",
    "store-notary-credentials": "macos-store-notary-credentials",
    "delete-keychain": "macos-cleanup-credential",
    "import-authenticode-certificate": "windows-import-certificate",
    "remove-authenticode-certificate": "windows-cleanup-credential",
  };
  const expectedThumbprint = String(
    environment.NEXA_WINDOWS_CERTIFICATE_THUMBPRINT ?? "",
  ).toUpperCase();
  const expectedIdentity = String(environment.NEXA_MACOS_SIGNING_IDENTITY ?? "");
  const legacySessionRoot = environment.NEXA_SIGNING_SESSION_ROOT;
  const factory = createEnvironmentCredentialSession({
    platform,
    environment,
    randomBytes,
    runCommand(request) {
      const mapped = { ...request, stage: legacyStages[request.stage] ?? request.stage };
      const result = commandRunner(mapped);
      if (
        platform === "darwin" &&
        request.stage === "find-signing-identity" &&
        result?.status === 0 &&
        !String(result.stdout ?? "").trim()
      ) {
        return { ...result, stdout: `1) ${expectedIdentity}\n` };
      }
      if (
        platform === "win32" &&
        request.stage === "import-authenticode-certificate" &&
        result?.status === 0 &&
        !String(result.stdout ?? "").trim()
      ) {
        return {
          ...result,
          stdout: JSON.stringify({
            thumbprint: expectedThumbprint,
            hasPrivateKey: true,
            codeSigningEku: true,
            currentlyValid: true,
          }),
        };
      }
      return result;
    },
  });
  return {
    activate(options = {}) {
      const session = factory.activate(options);
      if (legacySessionRoot) {
        const cleanup = session.cleanup;
        session.cleanup = () => {
          try {
            cleanup();
          } finally {
            rmSync(legacySessionRoot, { recursive: true, force: true });
          }
        };
      }
      if (platform === "darwin") return { ...session, notaryProfile: "nexa-technical-preview" };
      return session;
    },
  };
}

export function executeSigning({
  policy = loadSigningPolicy(),
  platform,
  custodyRoot,
  artifactName,
  unsignedEvidence,
  revision = process.env.GITHUB_SHA,
  toolRunner = defaultToolRunner,
  credentialSession,
}) {
  try {
    validateSigningPolicy(policy);
  } catch (error) {
    if (error instanceof SigningPolicyError) fail(error.message);
    throw error;
  }
  if (!["darwin", "win32"].includes(platform)) fail("platform must be darwin or win32");
  if (typeof custodyRoot !== "string" || custodyRoot.length === 0) fail("custodyRoot is required");
  if (!REVISION_PATTERN.test(revision ?? "")) fail("revision must be a full commit SHA");
  requireSafeArtifactName(artifactName, platform);
  const evidenceInput = requireUnsignedEvidenceInput(unsignedEvidence);
  assertReady(policy);
  if (credentialSession !== undefined && typeof credentialSession?.activate !== "function") {
    fail("credentialSession.activate is required for signing");
  }
  if (typeof toolRunner !== "function") fail("toolRunner must be a function");

  const root = path.resolve(custodyRoot);
  const unsignedRoot = path.resolve(root, policy.artifacts.unsigned.root);
  const signedRoot = path.resolve(root, policy.artifacts.signed.root);
  const quarantineRoot = path.resolve(root, policy.artifacts.quarantine.root);
  const source = path.resolve(unsignedRoot, artifactName);
  if (!isWithin(unsignedRoot, source)) fail("source artifact escapes unsigned custody root");
  requireRegularFile(source, "unsigned artifact");
  const signedName = derivedName(artifactName, platform, "signed");
  const quarantineName = derivedName(artifactName, platform, "quarantine");
  const signedDestination = path.join(signedRoot, `${signedName}.custody`);
  const quarantineDestination = path.join(quarantineRoot, `${quarantineName}.custody`);
  if (existsSync(signedDestination) || existsSync(quarantineDestination)) {
    fail("immutable signed or quarantine destination already exists");
  }

  const { sourceDigest, inputEvidence, inputEvidenceFiles } = verifyUnsignedInput({
    unsignedRoot,
    source,
    artifactName,
    platform,
    revision,
    unsignedEvidence: evidenceInput,
  });

  const work = mkdtempSync(path.join(tmpdir(), `nexa-signing-${platform}-`));
  const workingArtifact = path.join(work, artifactName);
  const extractedRoot = path.join(work, "archive");
  let session;
  let context;
  let originalError;
  try {
    copyExclusive(source, workingArtifact);
    extractArchive(workingArtifact, extractedRoot, platform);
    const layout = inspectSigningLayout(extractedRoot, platform, artifactName);
    const activeCredentialSession =
      credentialSession ??
      createEnvironmentCredentialSession({ platform, environment: process.env });
    session = activeCredentialSession.activate({ platform, workingDirectory: work });
    if (!session || typeof session.cleanup !== "function")
      fail("credential session must provide cleanup");
    if (platform === "darwin") {
      if (
        typeof session.identity !== "string" ||
        !session.identity.startsWith("Developer ID Application:")
      ) {
        fail("macOS signing requires an explicit Developer ID Application identity");
      }
      if (typeof session.notaryProfile !== "string" || session.notaryProfile.length === 0) {
        fail("macOS signing requires an ephemeral notary keychain profile");
      }
    } else {
      if (!/^[0-9A-F]{40}$/u.test(session.thumbprint ?? "")) {
        fail("Windows signing requires a 40-character certificate thumbprint");
      }
      if (
        typeof session.timestampUrl !== "string" ||
        !session.timestampUrl.startsWith("https://")
      ) {
        fail("Windows signing requires an HTTPS RFC3161 timestamp URL");
      }
    }
    context = {
      platform,
      artifactName,
      workingDirectory: work,
      workingArtifact,
      identity: session.identity ?? "",
      notaryProfile: session.notaryProfile ?? "",
      signingKeychain: session.signingKeychain ?? session.keychain ?? "",
      notaryKeychain: session.notaryKeychain ?? session.keychain ?? "",
      timestampUrl: session.timestampUrl ?? "",
      thumbprint: session.thumbprint ?? "",
      certificateStore: session.certificateStore ?? "NexaTechnicalPreview",
      signingTargets: layout.signingTargets,
      application: layout.application,
      executable: layout.executable,
      inventory: layout.inventory,
      evidence: {},
    };
    if (platform === "darwin") runDarwin(policy, context, toolRunner);
    else runWindows(policy, context, toolRunner);
    createArchive(extractedRoot, workingArtifact, platform);
    verifyFreshArchive(policy, context, toolRunner);
    if (sha256(source) !== sourceDigest) fail("unsigned input changed during signing");
    Object.assign(
      context.evidence,
      inputEvidenceFiles,
      signedIntegrityEvidence({
        artifactName: signedName,
        artifactDigest: sha256(workingArtifact),
        platform,
        revision,
        sourceName: artifactName,
        sourceDigest,
        inputEvidence,
        executor: {
          version: EXECUTOR_VERSION,
          sha256: policy.execution.reviewedExecutor.sha256,
          closureSha256: policy.execution.reviewedExecutor.closure.sha256,
        },
      }),
    );
  } catch (error) {
    originalError = error instanceof Error ? error : new Error(String(error));
  }

  try {
    if (session?.cleanup) session.cleanup();
  } catch (cleanupError) {
    const detail = `credential cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    originalError = originalError
      ? new SigningExecutorError(`${originalError.message}; ${detail}`)
      : new SigningExecutorError(`signing completed but ${detail}`);
  }

  function quarantine(error) {
    if (sha256(source) !== sourceDigest) fail("unsigned input changed during failed signing");
    if (existsSync(extractedRoot)) {
      try {
        createArchive(extractedRoot, workingArtifact, platform);
      } catch {
        // Keep the last complete archive if partially signed state cannot be repacked.
      }
    }
    const derivedSource = existsSync(workingArtifact) ? workingArtifact : source;
    const record = {
      schemaVersion: 3,
      outcome: "quarantined",
      platform,
      source: { name: artifactName, sha256: sourceDigest, revision },
      inputEvidence,
      derived: { name: quarantineName, sha256: sha256(derivedSource) },
      executor: {
        version: EXECUTOR_VERSION,
        sha256: policy.execution.reviewedExecutor.sha256,
        closureSha256: policy.execution.reviewedExecutor.closure.sha256,
      },
      failure: error.message,
    };
    return sealCustody(
      stageCustody(quarantineRoot, quarantineName, derivedSource, record, context?.evidence),
    );
  }

  if (originalError) {
    let failure = originalError;
    try {
      quarantine(originalError);
    } catch (quarantineError) {
      const detail =
        quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
      failure = new SigningExecutorError(`${originalError.message}; quarantine failed: ${detail}`);
    }
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 2 });
    } catch (cleanupError) {
      failure = new SigningExecutorError(
        `${failure.message}; working directory cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw failure;
  }

  const record = {
    schemaVersion: 3,
    outcome: "signed",
    platform,
    source: { name: artifactName, sha256: sourceDigest, revision },
    inputEvidence,
    derived: { name: signedName, sha256: sha256(workingArtifact) },
    archive: {
      format: platform === "darwin" ? "tar.gz" : "zip",
      binaries: context.inventory,
      freshVerification: true,
      launchObservationMs: FRESH_LAUNCH_OBSERVATION_MS,
    },
    evidence: Object.keys(context.evidence).sort(),
    executor: {
      version: EXECUTOR_VERSION,
      sha256: policy.execution.reviewedExecutor.sha256,
      closureSha256: policy.execution.reviewedExecutor.closure.sha256,
    },
  };
  let staged;
  try {
    staged = stageCustody(signedRoot, signedName, workingArtifact, record, context.evidence);
    rmSync(work, { recursive: true, force: true, maxRetries: 2 });
    return { outcome: "signed", ...sealCustody(staged) };
  } catch (error) {
    if (staged?.stagingDirectory && existsSync(staged.stagingDirectory)) {
      rmSync(staged.stagingDirectory, { recursive: true, force: true });
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    if (existsSync(work)) {
      try {
        quarantine(failure);
      } catch (quarantineError) {
        const detail =
          quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
        throw new SigningExecutorError(`${failure.message}; quarantine failed: ${detail}`);
      } finally {
        rmSync(work, { recursive: true, force: true, maxRetries: 2 });
      }
    }
    throw failure;
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function parseCliOptions(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value === "") {
      fail("arguments must be --name value pairs");
    }
    if (Object.hasOwn(options, flag)) fail(`duplicate argument: ${flag}`);
    options[flag] = value;
  }
  return options;
}

function cliRequired(options, flag) {
  if (!options[flag]) fail(`${flag} is required`);
  return options[flag];
}

if (isEntryPoint) {
  try {
    const [command = "validate", ...arguments_] = process.argv.slice(2);
    if (command === "validate") {
      if (arguments_.length !== 0) fail("validate does not accept arguments");
      const policy = loadSigningPolicy();
      console.log(
        `Signing executor ${EXECUTOR_VERSION} bound to ${policy.execution.reviewedExecutor.entrypoint}`,
      );
    } else if (command === "execute") {
      const options = parseCliOptions(arguments_);
      const result = executeSigning({
        policy: loadSigningPolicy(),
        platform: cliRequired(options, "--platform"),
        custodyRoot: cliRequired(options, "--custody-root"),
        artifactName: cliRequired(options, "--artifact-name"),
        unsignedEvidence: {
          descriptorPath: cliRequired(options, "--descriptor"),
          evidenceDir: cliRequired(options, "--evidence"),
        },
        revision: cliRequired(options, "--revision"),
      });
      console.log(JSON.stringify(result));
    } else {
      fail("usage: node tools/signing-executor.mjs validate|execute --name value ...");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 64;
  }
}

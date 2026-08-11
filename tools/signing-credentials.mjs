import { spawnSync } from "node:child_process";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAC_SECRET_NAMES = [
  "NEXA_MACOS_CERTIFICATE_P12",
  "NEXA_MACOS_CERTIFICATE_PASSWORD",
  "NEXA_APPLE_NOTARY_KEY_P8",
  "NEXA_MACOS_SIGNING_IDENTITY",
  "NEXA_APPLE_TEAM_ID",
  "NEXA_APPLE_NOTARY_KEY_ID",
  "NEXA_APPLE_NOTARY_ISSUER_ID",
];
const WINDOWS_SECRET_NAMES = [
  "NEXA_WINDOWS_CERTIFICATE_PFX",
  "NEXA_WINDOWS_CERTIFICATE_PASSWORD",
  "NEXA_WINDOWS_CERTIFICATE_THUMBPRINT",
  "NEXA_WINDOWS_RFC3161_TIMESTAMP_URL",
];

export class SigningCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = "SigningCredentialError";
  }
}

function fail(message) {
  throw new SigningCredentialError(message);
}

function strictBase64(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    fail(`${name} must be strict base64`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail(`${name} must be strict base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    fail(`${name} must be strict base64`);
  }
  return decoded;
}

function requiredString(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function defaultRunCommand({ executable, arguments: arguments_, workingDirectory, environment }) {
  const result = spawnSync(executable, arguments_, {
    cwd: workingDirectory,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

function invoke(runCommand, request) {
  let result;
  try {
    result = runCommand(request);
  } catch (error) {
    fail(`${request.stage} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!result || result.status !== 0) {
    const detail = result?.stderr || result?.stdout || "command did not return status 0";
    fail(`${request.stage} failed: ${detail}`);
  }
  return String(result.stdout || result.stderr || "");
}

function randomHex(randomBytes) {
  const bytes = randomBytes(24);
  if (!Buffer.isBuffer(bytes) || bytes.length < 16)
    fail("randomBytes must return at least 16 bytes");
  return bytes.toString("hex");
}

function validateMacIdentity(identity, expected) {
  if (!identity.startsWith("Developer ID Application:")) {
    fail("NEXA_MACOS_SIGNING_IDENTITY must be a Developer ID Application identity");
  }
  if (!expected.includes(identity)) {
    fail("find-signing-identity did not return the configured signing identity");
  }
}

function parseWindowsCertificate(output, thumbprint) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("import-authenticode-certificate failed: expected certificate validation JSON");
  }
  const observed = String(parsed?.thumbprint ?? "").toUpperCase();
  if (observed !== thumbprint) fail("import-authenticode-certificate thumbprint does not match");
  if (parsed?.hasPrivateKey !== true)
    fail("import-authenticode-certificate requires a private key");
  if (parsed?.codeSigningEku !== true)
    fail("import-authenticode-certificate requires code-signing EKU");
  if (parsed?.currentlyValid !== true)
    fail("import-authenticode-certificate requires a currently valid certificate");
}

function macSession({ environment, runCommand, randomBytes, workingDirectory }) {
  const p12 = strictBase64(environment.NEXA_MACOS_CERTIFICATE_P12, "NEXA_MACOS_CERTIFICATE_P12");
  const certificatePassword = requiredString(environment, "NEXA_MACOS_CERTIFICATE_PASSWORD");
  const p8 = strictBase64(environment.NEXA_APPLE_NOTARY_KEY_P8, "NEXA_APPLE_NOTARY_KEY_P8");
  const identity = requiredString(environment, "NEXA_MACOS_SIGNING_IDENTITY");
  const teamId = requiredString(environment, "NEXA_APPLE_TEAM_ID");
  const keyId = requiredString(environment, "NEXA_APPLE_NOTARY_KEY_ID");
  const issuerId = requiredString(environment, "NEXA_APPLE_NOTARY_ISSUER_ID");
  validateMacIdentity(identity, identity);

  const token = randomHex(randomBytes);
  const credentialsRoot = path.join(workingDirectory, "credentials");
  const keychain = path.join(credentialsRoot, "signing.keychain-db");
  const certificateFile = path.join(credentialsRoot, `certificate-${token}.p12`);
  const notaryKeyFile = path.join(credentialsRoot, `notary-${token}.p8`);
  const notaryProfile = `nexa-notary-${token}`;
  mkdirSync(credentialsRoot, { recursive: true, mode: 0o700 });
  chmodSync(credentialsRoot, 0o700);
  writeFileSync(certificateFile, p12, { mode: 0o600, flag: "wx" });
  writeFileSync(notaryKeyFile, p8, { mode: 0o600, flag: "wx" });

  let cleanupAttempted = false;
  const cleanup = () => {
    if (cleanupAttempted) return;
    cleanupAttempted = true;
    let cleanupError;
    try {
      invoke(runCommand, {
        stage: "delete-keychain",
        executable: "/usr/bin/security",
        arguments: ["delete-keychain", keychain],
        workingDirectory,
        environment: {},
      });
    } catch (error) {
      cleanupError = error;
    }
    rmSync(credentialsRoot, { recursive: true, force: true });
    if (cleanupError) throw cleanupError;
  };

  try {
    invoke(runCommand, {
      stage: "create-keychain",
      executable: "/usr/bin/security",
      arguments: ["create-keychain", "-p", token, keychain],
      workingDirectory,
      environment: {},
    });
    if (!existsSync(keychain))
      writeFileSync(keychain, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
    invoke(runCommand, {
      stage: "configure-keychain",
      executable: "/usr/bin/security",
      arguments: ["set-keychain-settings", "-lut", "21600", keychain],
      workingDirectory,
      environment: {},
    });
    invoke(runCommand, {
      stage: "unlock-keychain",
      executable: "/usr/bin/security",
      arguments: ["unlock-keychain", "-p", token, keychain],
      workingDirectory,
      environment: {},
    });
    invoke(runCommand, {
      stage: "import-signing-certificate",
      executable: "/usr/bin/security",
      arguments: [
        "import",
        certificateFile,
        "-k",
        keychain,
        "-P",
        certificatePassword,
        "-T",
        "/usr/bin/codesign",
      ],
      workingDirectory,
      environment: {},
    });
    invoke(runCommand, {
      stage: "authorize-codesign",
      executable: "/usr/bin/security",
      arguments: [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:",
        "-s",
        "-k",
        token,
        keychain,
      ],
      workingDirectory,
      environment: { NEXA_SIGNING_IDENTITY: identity },
    });
    const identityOutput = invoke(runCommand, {
      stage: "find-signing-identity",
      executable: "/usr/bin/security",
      arguments: ["find-identity", "-v", "-p", "codesigning", keychain],
      workingDirectory,
      environment: {},
    });
    validateMacIdentity(identity, identityOutput);
    invoke(runCommand, {
      stage: "store-notary-credentials",
      executable: "/usr/bin/xcrun",
      arguments: [
        "notarytool",
        "store-credentials",
        notaryProfile,
        "--key",
        notaryKeyFile,
        "--key-id",
        keyId,
        "--issuer",
        issuerId,
        "--team-id",
        teamId,
        "--keychain",
        keychain,
      ],
      workingDirectory,
      environment: {},
    });
    return {
      platform: "darwin",
      identity,
      signingKeychain: keychain,
      notaryKeychain: keychain,
      keychain,
      notaryProfile,
      cleanup,
    };
  } catch (error) {
    let failure = error instanceof Error ? error : new Error(String(error));
    try {
      cleanup();
    } catch (cleanupError) {
      failure = new SigningCredentialError(
        `${failure.message}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw failure;
  }
}

function windowsSession({ environment, runCommand, workingDirectory }) {
  const pfx = strictBase64(
    environment.NEXA_WINDOWS_CERTIFICATE_PFX,
    "NEXA_WINDOWS_CERTIFICATE_PFX",
  );
  const password = requiredString(environment, "NEXA_WINDOWS_CERTIFICATE_PASSWORD");
  const thumbprint = requiredString(
    environment,
    "NEXA_WINDOWS_CERTIFICATE_THUMBPRINT",
  ).toUpperCase();
  if (!/^[0-9A-F]{40}$/u.test(thumbprint))
    fail("NEXA_WINDOWS_CERTIFICATE_THUMBPRINT must be 40 hexadecimal characters");
  const timestampUrl = requiredString(environment, "NEXA_WINDOWS_RFC3161_TIMESTAMP_URL");
  if (!timestampUrl.startsWith("https://"))
    fail("NEXA_WINDOWS_RFC3161_TIMESTAMP_URL must use HTTPS");
  const credentialsRoot = path.join(workingDirectory, "credentials");
  const pfxFile = path.join(credentialsRoot, "certificate.pfx");
  mkdirSync(credentialsRoot, { recursive: true, mode: 0o700 });
  chmodSync(credentialsRoot, 0o700);
  writeFileSync(pfxFile, pfx, { mode: 0o600, flag: "wx" });
  const store = "NexaTechnicalPreview";
  let cleanupAttempted = false;
  const cleanup = () => {
    if (cleanupAttempted) return;
    cleanupAttempted = true;
    let cleanupError;
    try {
      invoke(runCommand, {
        stage: "remove-authenticode-certificate",
        executable: "powershell.exe",
        arguments: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Remove-Item -LiteralPath $args[0] -Force",
          `Cert:\\CurrentUser\\${store}\\${thumbprint}`,
        ],
        workingDirectory,
        environment: {},
      });
    } catch (error) {
      cleanupError = error;
    }
    rmSync(credentialsRoot, { recursive: true, force: true });
    if (cleanupError) throw cleanupError;
  };
  try {
    const output = invoke(runCommand, {
      stage: "import-authenticode-certificate",
      executable: "powershell.exe",
      arguments: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$secure = ConvertTo-SecureString $env:NEXA_SIGNING_PFX_PASSWORD -AsPlainText -Force",
          "$store = 'Cert:\\CurrentUser\\' + $env:NEXA_SIGNING_CERTIFICATE_STORE",
          "if (-not (Test-Path -LiteralPath $store)) { New-Item -ItemType Directory -Path $store | Out-Null }",
          "$cert = Import-PfxCertificate -FilePath $env:NEXA_SIGNING_PFX_PATH -CertStoreLocation $store -Password $secure",
          "$eku = @($cert.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -gt 0",
          "$now = Get-Date",
          "[pscustomobject]@{ thumbprint = $cert.Thumbprint; hasPrivateKey = $cert.HasPrivateKey; codeSigningEku = $eku; currentlyValid = ($cert.NotBefore -le $now -and $cert.NotAfter -ge $now) } | ConvertTo-Json -Compress",
        ].join("; "),
      ],
      workingDirectory,
      environment: {
        NEXA_SIGNING_PFX_PATH: pfxFile,
        NEXA_SIGNING_PFX_PASSWORD: password,
        NEXA_SIGNING_CERTIFICATE_STORE: store,
      },
    });
    parseWindowsCertificate(output, thumbprint);
    return { platform: "win32", thumbprint, timestampUrl, certificateStore: store, cleanup };
  } catch (error) {
    let failure = error instanceof Error ? error : new Error(String(error));
    try {
      cleanup();
    } catch (cleanupError) {
      failure = new SigningCredentialError(
        `${failure.message}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw failure;
  }
}

export function createEnvironmentCredentialSession({
  platform,
  environment = process.env,
  runCommand = defaultRunCommand,
  randomBytes = cryptoRandomBytes,
} = {}) {
  if (!environment || typeof environment !== "object") fail("environment must be an object");
  if (typeof runCommand !== "function") fail("runCommand must be a function");
  if (!platform || !["darwin", "win32"].includes(platform))
    fail("platform must be darwin or win32");
  const names = platform === "darwin" ? MAC_SECRET_NAMES : WINDOWS_SECRET_NAMES;
  return {
    activate({ platform: requestedPlatform = platform, workingDirectory = process.cwd() } = {}) {
      if (requestedPlatform !== platform)
        fail(`credential platform mismatch: expected ${platform}`);
      const root = path.resolve(workingDirectory);
      try {
        return platform === "darwin"
          ? macSession({ environment, runCommand, randomBytes, workingDirectory: root })
          : windowsSession({ environment, runCommand, workingDirectory: root });
      } finally {
        for (const name of names) delete environment[name];
      }
    },
  };
}

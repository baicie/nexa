import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createEnvironmentCredentialSession } from "./signing-credentials.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "nexa-signing-credentials-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function macEnvironment() {
  return {
    NEXA_MACOS_CERTIFICATE_P12: Buffer.from("p12 bytes").toString("base64"),
    NEXA_MACOS_CERTIFICATE_PASSWORD: "certificate-password",
    NEXA_APPLE_NOTARY_KEY_P8: Buffer.from("private key bytes").toString("base64"),
    NEXA_MACOS_SIGNING_IDENTITY: "Developer ID Application: Nexa UI (ABCDE12345)",
    NEXA_APPLE_TEAM_ID: "ABCDE12345",
    NEXA_APPLE_NOTARY_KEY_ID: "KEYID12345",
    NEXA_APPLE_NOTARY_ISSUER_ID: "01234567-89ab-cdef-0123-456789abcdef",
  };
}

function windowsEnvironment() {
  return {
    NEXA_WINDOWS_CERTIFICATE_PFX: Buffer.from("pfx bytes").toString("base64"),
    NEXA_WINDOWS_CERTIFICATE_PASSWORD: "certificate-password",
    NEXA_WINDOWS_CERTIFICATE_THUMBPRINT: "A".repeat(40),
    NEXA_WINDOWS_RFC3161_TIMESTAMP_URL: "https://timestamp.example.test",
  };
}

test("macOS credentials activate lazily in a private keychain and clean every material", (t) => {
  const root = fixture(t);
  const environment = macEnvironment();
  const calls = [];
  const sessionFactory = createEnvironmentCredentialSession({
    platform: "darwin",
    environment,
    randomBytes: () => Buffer.alloc(24, 7),
    runCommand(request) {
      calls.push(request);
      if (request.stage === "find-signing-identity") {
        return { status: 0, stdout: `1) ${environment.NEXA_MACOS_SIGNING_IDENTITY}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(calls.length, 0, "constructing the session must not activate credentials");
  const session = sessionFactory.activate({ platform: "darwin", workingDirectory: root });
  assert.equal(session.identity, "Developer ID Application: Nexa UI (ABCDE12345)");
  assert.match(session.notaryProfile, /^nexa-notary-[0-9a-f]+$/u);
  assert.equal(session.signingKeychain, session.notaryKeychain);
  assert.ok(existsSync(session.signingKeychain));
  assert.deepEqual(
    calls.map(({ stage }) => stage),
    [
      "create-keychain",
      "configure-keychain",
      "unlock-keychain",
      "import-signing-certificate",
      "authorize-codesign",
      "find-signing-identity",
      "store-notary-credentials",
    ],
  );
  assert.equal(
    calls.find(({ stage }) => stage === "store-notary-credentials").arguments.includes(
      "--keychain",
    ),
    true,
  );
  for (const reference of Object.keys(macEnvironment())) assert.equal(environment[reference], undefined);

  session.cleanup();
  assert.equal(existsSync(path.join(root, "credentials")), false);
  assert.equal(calls.at(-1).stage, "delete-keychain");
  session.cleanup();
  assert.equal(
    calls.filter(({ stage }) => stage === "delete-keychain").length,
    1,
    "cleanup is idempotent",
  );
});

test("Windows credentials use one current-user store and remove it during cleanup", (t) => {
  const root = fixture(t);
  const environment = windowsEnvironment();
  const calls = [];
  const sessionFactory = createEnvironmentCredentialSession({
    platform: "win32",
    environment,
    runCommand(request) {
      calls.push(request);
      if (request.stage === "import-authenticode-certificate") {
        assert.equal(request.environment.NEXA_SIGNING_PFX_PASSWORD, "certificate-password");
        return {
          status: 0,
          stdout: `${JSON.stringify({
            thumbprint: "A".repeat(40),
            hasPrivateKey: true,
            codeSigningEku: true,
            currentlyValid: true,
          })}\n`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const session = sessionFactory.activate({ platform: "win32", workingDirectory: root });
  assert.deepEqual(
    {
      thumbprint: session.thumbprint,
      timestampUrl: session.timestampUrl,
      certificateStore: session.certificateStore,
    },
    {
      thumbprint: "A".repeat(40),
      timestampUrl: "https://timestamp.example.test",
      certificateStore: "NexaTechnicalPreview",
    },
  );
  assert.deepEqual(calls.map(({ stage }) => stage), ["import-authenticode-certificate"]);
  for (const reference of Object.keys(windowsEnvironment())) {
    assert.equal(environment[reference], undefined);
  }

  session.cleanup();
  assert.deepEqual(calls.map(({ stage }) => stage), [
    "import-authenticode-certificate",
    "remove-authenticode-certificate",
  ]);
  assert.equal(existsSync(path.join(root, "credentials")), false);
});

test("partial credential activation cleans up and reports both activation and cleanup failures", (t) => {
  const root = fixture(t);
  const calls = [];
  const factory = createEnvironmentCredentialSession({
    platform: "darwin",
    environment: macEnvironment(),
    randomBytes: () => Buffer.alloc(24, 9),
    runCommand(request) {
      calls.push(request);
      if (request.stage === "import-signing-certificate") {
        return { status: 1, stdout: "", stderr: "import rejected" };
      }
      if (request.stage === "delete-keychain") {
        return { status: 1, stdout: "", stderr: "delete rejected" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.throws(
    () => factory.activate({ platform: "darwin", workingDirectory: root }),
    /import-signing-certificate.*cleanup.*delete-keychain/u,
  );
  assert.equal(existsSync(path.join(root, "credentials")), false);
  assert.equal(calls.at(-1).stage, "delete-keychain");
});

test("malformed or missing secret material fails before a platform command runs", (t) => {
  const root = fixture(t);
  const calls = [];
  const environment = macEnvironment();
  environment.NEXA_MACOS_CERTIFICATE_P12 = "not base64!";
  const factory = createEnvironmentCredentialSession({
    platform: "darwin",
    environment,
    runCommand(request) {
      calls.push(request);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.throws(
    () => factory.activate({ platform: "darwin", workingDirectory: root }),
    /NEXA_MACOS_CERTIFICATE_P12.*base64/u,
  );
  assert.equal(calls.length, 0);
  assert.equal(existsSync(path.join(root, "credentials")), false);
});

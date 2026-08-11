import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./typescript-test-hooks.mjs";

const systemHost = await import("../packages/system-host/src/index.ts");
const systemErrors = await import("../packages/system-host/src/errors.ts");

const systemManifest = JSON.parse(
  readFileSync(new URL("../protocol/system-host.json", import.meta.url), "utf8"),
);
const activeErrors = systemManifest.errors.filter((entry) => entry.lifecycle.status === "active");
const errorsByName = new Map(activeErrors.map((entry) => [entry.name, entry]));
const errorsByCode = new Map(activeErrors.map((entry) => [entry.code, entry]));
const ERROR_CODES = {
  InvalidArgument: errorsByName.get("INVALID_ARGUMENT").code,
  NotFound: errorsByName.get("NOT_FOUND").code,
  PermissionDenied: errorsByName.get("PERMISSION_DENIED").code,
  Cancelled: errorsByName.get("CANCELLED").code,
  PlatformFailure: errorsByName.get("PLATFORM_FAILURE").code,
};

function errorDetail({
  domain = "system",
  code = ERROR_CODES.NotFound,
  name = "NOT_FOUND",
  operation = "readTextFile",
  context,
  platformCode,
  cause,
} = {}) {
  const metadata = errorsByCode.get(code);
  name ??= metadata?.name ?? "UNKNOWN_SYSTEM_ERROR";
  return {
    domain,
    code,
    name,
    severity: metadata?.severity ?? "RecoverableOperation",
    operation,
    retryable: metadata?.retryable ?? false,
    message: `${name} diagnostic`,
    runtimeVersion: "0.1.0",
    ...(context === undefined ? {} : { context }),
    ...(platformCode === undefined ? {} : { platformCode }),
    ...(cause === undefined ? {} : { cause }),
  };
}

test("System command result decodes typed success values", () => {
  const result = systemHost.decodeCommandResult(
    JSON.stringify({ ok: true, value: { answer: 42 } }),
    (value) => {
      assert.equal(typeof value, "object");
      assert.notEqual(value, null);
      assert.equal(value.answer, 42);
      return value.answer;
    },
    "contractProbe",
  );

  assert.deepEqual(result, { ok: true, value: 42 });
  assert.equal(systemHost.unwrapCommandResult(result), 42);
});

test("System errors remain distinct by stable numeric code", () => {
  for (const { code, name } of activeErrors) {
    const result = systemHost.decodeCommandResult(
      JSON.stringify({ ok: false, error: errorDetail({ code, name }) }),
      (value) => value,
      "contractProbe",
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.name, name);
    assert.equal(systemHost.isSystemError(result.error, code), true);
  }
});

test("System error metadata is complete and matches the manifest", () => {
  assert.equal(systemErrors.SYSTEM_ERROR_METADATA.size, activeErrors.length);
  for (const { code, name, severity, retryable } of activeErrors) {
    assert.deepEqual(systemErrors.SYSTEM_ERROR_METADATA.get(code), {
      name,
      severity,
      retryable,
    });
  }
});

test("NexaSystemError preserves context, platform code, and recursive cause", () => {
  const cause = errorDetail({
    code: ERROR_CODES.NotFound,
    name: "NOT_FOUND",
    operation: "openFile",
    context: { resource: "file", identifier: "/missing.txt", attempt: 2, cached: false },
  });
  const detail = errorDetail({
    code: ERROR_CODES.PlatformFailure,
    name: "PLATFORM_FAILURE",
    platformCode: "ERROR_FILE_NOT_FOUND",
    context: { platform: "windows", operation: "readTextFile" },
    cause,
  });
  const result = systemHost.decodeCommandResult(
    JSON.stringify({ ok: false, error: detail }),
    (value) => value,
    "readTextFile",
  );

  assert.equal(result.ok, false);
  assert.throws(
    () => systemHost.unwrapCommandResult(result),
    (error) => {
      assert.equal(error instanceof systemHost.NexaSystemError, true);
      assert.equal(error.code, ERROR_CODES.PlatformFailure);
      assert.equal(error.platformCode, "ERROR_FILE_NOT_FOUND");
      assert.deepEqual(error.context, detail.context);
      assert.equal(error.cause instanceof systemHost.NexaSystemError, true);
      assert.equal(error.cause.code, ERROR_CODES.NotFound);
      assert.equal(error.cause.context.identifier, "/missing.txt");
      return true;
    },
  );
});

test("malformed JSON, sentinels, tagged context, and bad success values fail closed", () => {
  const inputs = [
    "",
    "false",
    "-1",
    JSON.stringify({ ok: true, value: 1, extra: true }),
    JSON.stringify({ ok: false, error: errorDetail(), extra: true }),
    JSON.stringify({
      ok: false,
      error: errorDetail({ context: { resource: { String: "file" } } }),
    }),
    JSON.stringify({
      ok: false,
      error: errorDetail({ code: 1.5 }),
    }),
    JSON.stringify({
      ok: false,
      error: errorDetail({ domain: "ui", code: ERROR_CODES.NotFound }),
    }),
    JSON.stringify({
      ok: false,
      error: errorDetail({ code: 0x0100_0006 }),
    }),
  ];

  for (const raw of inputs) {
    const result = systemHost.decodeCommandResult(raw, (value) => value, "contractProbe");
    assert.equal(result.ok, false);
    assert.equal(result.error.domain, "protocol");
    assert.equal(result.error.name, "PROTOCOL_MISMATCH");
  }

  const invalidValue = systemHost.decodeCommandResult(
    JSON.stringify({ ok: true, value: "not-a-number" }),
    () => {
      throw new TypeError("number required");
    },
    "contractProbe",
  );
  assert.equal(invalidValue.ok, false);
  assert.equal(invalidValue.error.name, "PROTOCOL_MISMATCH");
});

test("nested causes accept 32 nodes and reject the 33rd", () => {
  function causeChain(length) {
    let cause;
    for (let index = length - 1; index >= 0; index -= 1) {
      cause = errorDetail({ operation: `cause${index}`, cause });
    }
    return cause;
  }

  const accepted = systemHost.decodeCommandResult(
    JSON.stringify({ ok: false, error: causeChain(32) }),
    (value) => value,
    "contractProbe",
  );
  assert.equal(accepted.error.domain, "system");

  const rejected = systemHost.decodeCommandResult(
    JSON.stringify({ ok: false, error: causeChain(33) }),
    (value) => value,
    "contractProbe",
  );
  assert.equal(rejected.error.domain, "protocol");
  assert.equal(rejected.error.name, "PROTOCOL_MISMATCH");
});

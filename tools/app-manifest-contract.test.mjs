import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

function readJson(path) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

const schema = readJson("protocol/schema/app-manifest.schema.json");
const developmentManifest = readJson("protocol/fixtures/app-manifest.development.json");
const releaseManifest = readJson("protocol/fixtures/app-manifest.release.json");
const notesManifest = readJson("examples/reference-notes/app.manifest.json");
const contractCases = readJson("protocol/fixtures/app-manifest-contract-cases.json");
const commonManifest = readJson("protocol/common.json");
const systemManifest = readJson("protocol/system-host.json");
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function assertAccepts(candidate, label) {
  assert.equal(validate(candidate), true, `${label}: ${JSON.stringify(validate.errors, null, 2)}`);
}

function assertRejects(candidate, label) {
  assert.equal(validate(candidate), false, label);
}

test("app manifest schema accepts development and release inputs", () => {
  assert.equal(schema.$id, "https://nexa-ui.dev/schema/app-manifest-v1.json");
  assertAccepts(developmentManifest, "development manifest");
  assertAccepts(releaseManifest, "release manifest");
  assertAccepts(notesManifest, "Notes manifest");
  assert.deepEqual(notesManifest.permissions, [
    "system.ClipboardRead",
    "system.ClipboardWrite",
    "system.FsRead",
    "system.FsWrite",
    "system.DialogOpen",
    "system.DialogSave",
  ]);
});

test("app manifest schema rejects unknown fields and malformed identity", () => {
  const cases = [
    ["unknown field", { ...developmentManifest, extra: true }],
    ["wrong schema URI", { ...developmentManifest, $schema: "https://example.invalid/app.json" }],
    ["wrong schema version", { ...developmentManifest, schemaVersion: 2 }],
    ["invalid app id", { ...developmentManifest, id: "Nexa Notes" }],
    ["invalid SemVer", { ...developmentManifest, version: "v1" }],
    ["invalid numeric prerelease", { ...developmentManifest, version: "1.0.0-01" }],
    ["control character in name", { ...developmentManifest, name: "Nexa\nNotes" }],
    ["C1 control character in name", { ...developmentManifest, name: "Nexa\u0085Notes" }],
    [
      "unknown required protocol field",
      { ...developmentManifest, requiredProtocol: { major: 1, minor: 0, patch: 0 } },
    ],
    [
      "duplicate permission",
      {
        ...developmentManifest,
        permissions: ["system.ClipboardRead", "system.ClipboardRead"],
      },
    ],
    ["unknown permission", { ...developmentManifest, permissions: ["system.Unknown"] }],
  ];

  for (const [label, candidate] of cases) assertRejects(candidate, label);
});

test("raw contract cases have the same schema acceptance as the Rust loader", () => {
  for (const contractCase of contractCases) {
    const candidate = JSON.parse(contractCase.json);
    if (contractCase.accepted) {
      assertAccepts(candidate, contractCase.label);
    } else {
      assertRejects(candidate, contractCase.label);
    }
  }
});

test("app manifest permission enum matches every active System permission", () => {
  const activePermissions = systemManifest.permissions
    .filter((permission) => permission.lifecycle.status === "active")
    .map((permission) => `system.${permission.name}`)
    .sort();
  assert.deepEqual([...schema.properties.permissions.items.enum].sort(), activePermissions);
});

test("app manifest protocol bounds match the active runtime protocol", () => {
  assert.equal(
    schema.properties.requiredProtocol.properties.major.const,
    commonManifest.protocol.major,
  );
  assert.equal(
    schema.properties.requiredProtocol.properties.minor.maximum,
    commonManifest.protocol.minor,
  );
});

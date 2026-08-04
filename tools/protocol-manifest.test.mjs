import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import {
  COMMON_OWNERSHIP_KEYS,
  COMMON_SCHEMA_ID,
  UINT16_MAX,
  UINT32_MAX,
  assertAbiLayout,
  assertCounts,
  assertSchemaAccepts,
  assertSchemaRejects,
  assertSemanticRejects,
  common,
  contracts,
  toMap,
  validateCombinedAbiLayouts,
  validateCommonSemantics,
  validateNamespaceSemantics,
} from "./protocol-contract.mjs";

test("common schema and manifest define the shared protocol contract", () => {
  assert.equal(common.schema.$id, COMMON_SCHEMA_ID);
  assertSchemaAccepts(common.validateSchema, common.manifest, "common manifest");
  validateCommonSemantics(common.manifest);

  const fixture = common.fixture.expected;
  assertCounts(common.manifest, common.fixture, "common");
  assert.equal(common.manifest.namespace, fixture.namespace);
  assert.equal(common.manifest.featureNamespace, fixture.featureNamespace);
  assert.deepEqual(toMap(common.manifest.features, "bit"), fixture.featureBits);
  assert.deepEqual(toMap(common.manifest.handleKinds), fixture.handleKindIds);
  assert.deepEqual(toMap(common.manifest.commands), fixture.commandIds);
  assert.deepEqual(toMap(common.manifest.ffiFunctions, "abiIndex"), fixture.ffiAbiIndexes);
  assert.deepEqual(toMap(common.manifest.errors, "code"), fixture.errorCodes);

  assert.equal(common.manifest.handleValidation.slotMinimum, 0);
  assert.equal(common.manifest.handleValidation.generationMinimum, 1);
  assert.equal(common.manifest.handleTransport.result.perryType, "string");
  assert.deepEqual(common.manifest.handleTransport.input.perryTypes, ["u32", "u32"]);
  assert.deepEqual(common.manifest.handleTransport.optionalInput.perryTypes, ["u32", "u32", "u32"]);
  assert.deepEqual(fixture.maxHandleRef, {
    slot: UINT32_MAX,
    generation: UINT32_MAX,
    token: "h1/ffffffff/ffffffff",
  });
  assert.deepEqual(common.manifest.resultEnvelope, {
    tagField: "ok",
    successTag: true,
    valueField: "value",
    failureTag: false,
    errorField: "error",
    errorType: "common.NexaError",
    unitValue: null,
    rejectUnknownFields: true,
  });
});

for (const [namespace, contract] of Object.entries(contracts)) {
  test(namespace + " schema compiles with common and accepts its namespace-only manifest", () => {
    assert.equal(contract.schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(contract.schema.$id, contract.schemaId);
    assert.equal(contract.schema.additionalProperties, false);
    assert.deepEqual(new Set(contract.schema.required), new Set(Object.keys(contract.manifest)));
    assert.deepEqual(
      new Set(Object.keys(contract.schema.properties)),
      new Set(Object.keys(contract.manifest)),
    );
    assertSchemaAccepts(contract.validateSchema, contract.manifest, namespace + " manifest");
    validateNamespaceSemantics(contract.manifest, contract);
  });

  test(namespace + " manifest matches its checked-in fixture", () => {
    const { manifest, fixture } = contract;
    assertCounts(manifest, fixture, namespace);
    assert.equal(manifest.namespace, fixture.expected.namespace);
    assert.equal(manifest.featureNamespace, fixture.expected.featureNamespace);
    assert.deepEqual(toMap(manifest.features, "bit"), fixture.expected.featureBits);
    for (const [registry, expectedIds] of Object.entries(fixture.expected.ids)) {
      assert.deepEqual(toMap(manifest[registry]), expectedIds, namespace + " " + registry + " IDs");
    }
    assert.deepEqual(toMap(manifest.errors, "code"), fixture.expected.errorCodes);

    const legacyFfi = manifest.ffiFunctions.filter((ffi) => ffi.status === "legacy");
    const v1Ffi = [
      ...(namespace === "ui" ? common.manifest.ffiFunctions : []),
      ...manifest.ffiFunctions,
    ].filter((ffi) => ffi.status === "v1");
    assert.deepEqual(
      toMap(legacyFfi, "abiIndex"),
      fixture.expected.legacyFfiAbiIndexes,
      namespace + " legacy ABI",
    );
    assert.deepEqual(
      toMap(v1Ffi, "abiIndex"),
      fixture.expected.v1FfiAbiIndexes,
      namespace + " v1 ABI",
    );

    if (namespace === "ui") {
      assert.deepEqual(
        toMap(manifest.properties, "valueType"),
        fixture.expected.propertyValueTypes,
      );
      assert.deepEqual(
        Object.fromEntries(
          manifest.events.map((event) => [
            event.name,
            event.payload.fields.map((field) => field.name),
          ]),
        ),
        fixture.expected.eventPayloadFields,
      );
    } else {
      assert.deepEqual(toMap(manifest.taskKinds, "resultType"), fixture.expected.taskResultTypes);
    }
  });
}

test("namespace manifests do not duplicate common-owned protocol state", () => {
  assert.equal(existsSync(new URL("../protocol/common.json", import.meta.url)), true);
  assert.equal(existsSync(new URL("../protocol/schema/common.schema.json", import.meta.url)), true);

  for (const contract of Object.values(contracts)) {
    for (const key of COMMON_OWNERSHIP_KEYS) {
      assert.equal(key in contract.manifest, false, contract.manifest.namespace + " owns " + key);
      assert.equal(
        key in contract.schema.properties,
        false,
        contract.manifest.namespace + " schema owns " + key,
      );
    }
    assert.equal(
      contract.manifest.commands.some((command) => command.name === "Handshake"),
      false,
    );
    assert.equal(
      contract.manifest.errors.some((error) => error.domain === "protocol"),
      false,
    );
  }
});

test("semantic commands and native FFI functions remain separate complete registries", () => {
  for (const manifest of [
    common.manifest,
    ...Object.values(contracts).map(({ manifest }) => manifest),
  ]) {
    for (const command of manifest.commands) {
      assert.equal("nativeSymbol" in command, false, manifest.namespace + "." + command.name);
    }
    for (const ffi of manifest.ffiFunctions) {
      assert.equal(typeof ffi.name, "string", ffi.command + " native symbol");
      assert.equal(typeof ffi.abiIndex, "number", ffi.name + " ABI slot");
      assert.ok(Array.isArray(ffi.params), ffi.name + " Perry params");
    }
  }

  const listenerFunctions = contracts.ui.manifest.ffiFunctions.filter(
    (ffi) => ffi.command === "ui.AddEventListener",
  );
  assert.equal(listenerFunctions.length, 4, "AddEventListener must preserve its 1:N FFI mapping");

  const uiCommands = new Map(
    contracts.ui.manifest.commands.map((command) => [command.name, command]),
  );
  assert.equal(uiCommands.get("AddEventListener").returns.handleKind, "common.Callback");
  assert.equal(uiCommands.get("RemoveEventListener").params[0].handleKind, "common.Callback");
  assert.equal(uiCommands.get("Commit").returns.type, "ui.CommitReceipt");

  const systemCommands = new Map(
    contracts.system.manifest.commands.map((command) => [command.name, command]),
  );
  assert.equal(systemCommands.get("ClipboardReadText").returns.handleKind, "common.Task");
  assert.equal(systemCommands.get("ClipboardWriteText").returns.handleKind, "common.Task");
});

test("semantic guards require a v1 FFI mapping for every namespace command", () => {
  for (const [namespace, contract] of Object.entries(contracts)) {
    const missingV1 = structuredClone(contract.manifest);
    const legacyCommand = missingV1.ffiFunctions.find((ffi) => ffi.status === "legacy").command;
    missingV1.ffiFunctions = missingV1.ffiFunctions.filter(
      (ffi) => ffi.status !== "v1" || ffi.command !== legacyCommand,
    );

    assertSemanticRejects(
      missingV1,
      contract,
      /must have a v1 FFI function/,
      namespace + " missing v1 FFI coverage",
    );
  }
});

test("semantic guards require a v1 FFI mapping for the common bootstrap command", () => {
  const missingHandshake = structuredClone(common.manifest);
  missingHandshake.ffiFunctions = [];

  assertSchemaAccepts(common.validateSchema, missingHandshake, "common missing handshake schema");
  assert.throws(
    () => validateCommonSemantics(missingHandshake),
    /common\.Handshake must have a v1 FFI function/,
  );
});

test("system task and resource metadata form a consistent command contract", () => {
  const missingTaskKind = structuredClone(contracts.system.manifest);
  missingTaskKind.commands[0].createsTaskKind = null;
  assertSemanticRejects(
    missingTaskKind,
    contracts.system,
    /Task return must declare createsTaskKind/,
    "system task return without task kind",
  );

  const mismatchedPermission = structuredClone(contracts.system.manifest);
  mismatchedPermission.commands[0].requiredPermissions = ["system.ClipboardWrite"];
  assertSemanticRejects(
    mismatchedPermission,
    contracts.system,
    /must require system\.ClipboardRead/,
    "system task permission mismatch",
  );

  const invalidCloseCommand = structuredClone(contracts.system.manifest);
  invalidCloseCommand.resourceKinds[0].closeCommand = "system.ResetSession";
  assertSemanticRejects(
    invalidCloseCommand,
    contracts.system,
    /must accept a common\.NativeResource HandleRef/,
    "system resource close command mismatch",
  );
});

test("ABI slots are unique, contiguous, and v1 functions use guarded string results", () => {
  const uiAbi = [
    ...common.manifest.ffiFunctions.filter((ffi) => ffi.library === "ui"),
    ...contracts.ui.manifest.ffiFunctions,
  ];
  assertAbiLayout(
    uiAbi,
    Array.from({ length: 29 }, (_, index) => index),
    "UI",
  );
  assertAbiLayout(
    [
      ...common.manifest.ffiFunctions.filter((ffi) => ffi.library === "system"),
      ...contracts.system.manifest.ffiFunctions,
    ],
    Array.from({ length: 7 }, (_, index) => index),
    "System",
  );

  for (const ffi of [
    ...common.manifest.ffiFunctions,
    ...contracts.ui.manifest.ffiFunctions,
    ...contracts.system.manifest.ffiFunctions,
  ].filter((entry) => entry.status === "v1")) {
    assert.equal(ffi.returns, "string", ffi.name + " v1 return");
    assert.equal(ffi.resultCodec, "nexa_result_json_v1", ffi.name + " v1 codec");
  }
});

test("combined Perry library ABI rejects common and namespace collisions", () => {
  const duplicateSlot = structuredClone(common.manifest);
  duplicateSlot.ffiFunctions.push({
    ...structuredClone(duplicateSlot.ffiFunctions[0]),
    library: "system",
    abiIndex: 0,
    name: "js_nexa_handshake_v1",
  });
  assert.doesNotThrow(() => validateCommonSemantics(duplicateSlot));
  assert.throws(
    () => validateCombinedAbiLayouts(duplicateSlot, contracts),
    /System duplicate ABI slot 0/,
  );

  const duplicateSymbol = structuredClone(common.manifest);
  duplicateSymbol.ffiFunctions.push({
    ...structuredClone(duplicateSymbol.ffiFunctions[0]),
    library: "system",
    abiIndex: 7,
    name: contracts.system.manifest.ffiFunctions[0].name,
  });
  assert.doesNotThrow(() => validateCommonSemantics(duplicateSymbol));
  assert.throws(
    () => validateCombinedAbiLayouts(duplicateSymbol, contracts),
    /System duplicate native symbol/,
  );
});

test("schemas reject u32 and u16 overflow", () => {
  const commonMutations = [
    ["protocol version", (manifest) => (manifest.protocol.major = UINT32_MAX + 1)],
    ["ABI version", (manifest) => (manifest.abi.minor = UINT32_MAX + 1)],
    [
      "lifecycle version",
      (manifest) => (manifest.features[0].lifecycle.introduced.minor = UINT32_MAX + 1),
    ],
    ["handle kind ID", (manifest) => (manifest.handleKinds[0].id = UINT16_MAX + 1)],
    ["FFI ABI index", (manifest) => (manifest.ffiFunctions[0].abiIndex = UINT32_MAX + 1)],
    ["error code", (manifest) => (manifest.errors[0].code = UINT32_MAX + 1)],
  ];
  for (const [label, mutate] of commonMutations) {
    const invalid = structuredClone(common.manifest);
    mutate(invalid);
    assertSchemaRejects(common.validateSchema, invalid, "common " + label + " overflow");
  }

  for (const [namespace, contract] of Object.entries(contracts)) {
    const mutations = [
      [
        "lifecycle version",
        (manifest) => (manifest.features[0].lifecycle.introduced.major = UINT32_MAX + 1),
      ],
      ["command ID", (manifest) => (manifest.commands[0].id = UINT16_MAX + 1)],
      ["FFI ABI index", (manifest) => (manifest.ffiFunctions[0].abiIndex = UINT32_MAX + 1)],
      ["error code", (manifest) => (manifest.errors[0].code = UINT32_MAX + 1)],
    ];
    for (const [label, mutate] of mutations) {
      const invalid = structuredClone(contract.manifest);
      mutate(invalid);
      assertSchemaRejects(contract.validateSchema, invalid, namespace + " " + label + " overflow");
    }
  }
});

test("namespace schemas reject wrong ownership, domains, and lifecycle shapes", () => {
  for (const [namespace, contract] of Object.entries(contracts)) {
    const wrongNamespace = structuredClone(contract.manifest);
    wrongNamespace.namespace = namespace === "ui" ? "system" : "ui";
    assertSchemaRejects(contract.validateSchema, wrongNamespace, namespace + " namespace");

    const duplicatedProtocol = structuredClone(contract.manifest);
    duplicatedProtocol.protocol = structuredClone(common.manifest.protocol);
    assertSchemaRejects(
      contract.validateSchema,
      duplicatedProtocol,
      namespace + " common ownership",
    );

    const wrongDomain = structuredClone(contract.manifest);
    wrongDomain.errors[0].domain = "protocol";
    assertSchemaRejects(contract.validateSchema, wrongDomain, namespace + " error domain");

    const invalidStatus = structuredClone(contract.manifest);
    invalidStatus.features[0].lifecycle.status = "retired";
    assertSchemaRejects(contract.validateSchema, invalidStatus, namespace + " lifecycle status");

    const commandWithNativeSymbol = structuredClone(contract.manifest);
    commandWithNativeSymbol.commands[0].nativeSymbol = "must_live_in_ffiFunctions";
    assertSchemaRejects(
      contract.validateSchema,
      commandWithNativeSymbol,
      namespace + " command nativeSymbol",
    );
  }
});

test("semantic guards reject duplicate IDs, names, ABI slots, and invalid lifecycle order", () => {
  for (const [namespace, contract] of Object.entries(contracts)) {
    const duplicateId = structuredClone(contract.manifest);
    duplicateId.commands[1].id = duplicateId.commands[0].id;
    assertSemanticRejects(duplicateId, contract, /duplicate id/, namespace + " duplicate ID");

    const duplicateName = structuredClone(contract.manifest);
    duplicateName.commands[1].name = duplicateName.commands[0].name;
    assertSemanticRejects(duplicateName, contract, /duplicate name/, namespace + " duplicate name");

    const duplicateAbiSlot = structuredClone(contract.manifest);
    duplicateAbiSlot.ffiFunctions[1].abiIndex = duplicateAbiSlot.ffiFunctions[0].abiIndex;
    assertSemanticRejects(
      duplicateAbiSlot,
      contract,
      /duplicate abiIndex/,
      namespace + " duplicate ABI slot",
    );

    const removedActiveEntry = structuredClone(contract.manifest);
    removedActiveEntry.features[0].lifecycle.deprecated = { major: 1, minor: 0 };
    removedActiveEntry.features[0].lifecycle.removed = { major: 1, minor: 1 };
    assertSemanticRejects(
      removedActiveEntry,
      contract,
      /non-tombstone cannot be removed/,
      namespace + " active removed lifecycle",
    );

    const reversedLifecycle = structuredClone(contract.manifest);
    reversedLifecycle.ffiFunctions[0].lifecycle.deprecated = { major: 0, minor: 9 };
    assertSemanticRejects(
      reversedLifecycle,
      contract,
      /deprecated before introduced/,
      namespace + " reversed lifecycle",
    );
  }
});

test("semantic guards reject dangling qualified references and FFI mapping roots", () => {
  for (const [namespace, contract] of Object.entries(contracts)) {
    const danglingFeature = structuredClone(contract.manifest);
    danglingFeature.commands[0].requiresFeatures[0] = namespace + ".missing_feature";
    assertSemanticRejects(
      danglingFeature,
      contract,
      /unknown reference/,
      namespace + " dangling feature",
    );

    const danglingType = structuredClone(contract.manifest);
    const typedCommand = danglingType.commands.find((command) => command.params.length > 0);
    typedCommand.params[0].type = namespace + ".MissingType";
    delete typedCommand.params[0].handleKind;
    assertSemanticRejects(
      danglingType,
      contract,
      /unknown reference/,
      namespace + " dangling type",
    );

    const danglingHandleKind = structuredClone(contract.manifest);
    const handleCommand = danglingHandleKind.commands.find((command) =>
      command.params.some((param) => param.type === "common.HandleRef"),
    );
    handleCommand.params.find((param) => param.type === "common.HandleRef").handleKind =
      "common.MissingHandle";
    assertSemanticRejects(
      danglingHandleKind,
      contract,
      /unknown reference/,
      namespace + " dangling handle kind",
    );

    const danglingCommand = structuredClone(contract.manifest);
    danglingCommand.ffiFunctions[0].command = namespace + ".MissingCommand";
    assertSemanticRejects(
      danglingCommand,
      contract,
      /unknown reference|unknown command/,
      namespace + " dangling FFI command",
    );

    const invalidMapping = structuredClone(contract.manifest);
    const ffiWithParams = invalidMapping.ffiFunctions.find((ffi) => ffi.params.length > 0);
    ffiWithParams.params[0].mapping = "missing.value";
    assertSemanticRejects(
      invalidMapping,
      contract,
      /mapping root/,
      namespace + " invalid mapping root",
    );

    const danglingReplacement = structuredClone(contract.manifest);
    const deprecatedFfi = danglingReplacement.ffiFunctions.find(
      (ffi) => ffi.lifecycle.replacement !== null,
    );
    deprecatedFfi.lifecycle.replacement = namespace + ".MissingReplacement";
    assertSemanticRejects(
      danglingReplacement,
      contract,
      /unknown reference/,
      namespace + " dangling lifecycle replacement",
    );
  }

  const danglingPermission = structuredClone(contracts.system.manifest);
  danglingPermission.commands[0].requiredPermissions[0] = "system.MissingPermission";
  assertSemanticRejects(
    danglingPermission,
    contracts.system,
    /unknown reference/,
    "system dangling permission",
  );

  const danglingTaskKind = structuredClone(contracts.system.manifest);
  danglingTaskKind.commands[0].createsTaskKind = "system.MissingTask";
  assertSemanticRejects(
    danglingTaskKind,
    contracts.system,
    /unknown reference/,
    "system dangling task kind",
  );

  const danglingCloseCommand = structuredClone(contracts.system.manifest);
  danglingCloseCommand.resourceKinds[0].closeCommand = "system.MissingCommand";
  assertSemanticRejects(
    danglingCloseCommand,
    contracts.system,
    /unknown reference/,
    "system dangling resource close command",
  );
});

test("semantic guards reject unsafe HandleRef encodings in v1 FFI inputs", () => {
  for (const [namespace, contract] of Object.entries(contracts)) {
    const unsafe = structuredClone(contract.manifest);
    const ffi = unsafe.ffiFunctions.find(
      (entry) =>
        entry.status === "v1" && entry.params.some((param) => param.mapping.endsWith(".slot")),
    );
    ffi.params.find((param) => param.mapping.endsWith(".slot")).type = "jsvalue";
    assertSchemaAccepts(contract.validateSchema, unsafe, namespace + " unsafe HandleRef schema");
    assert.throws(
      () => validateNamespaceSemantics(unsafe, contract),
      /unsafe HandleRef input|HandleRef transport/,
      namespace + " unsafe HandleRef input",
    );
  }
});

test("semantic contracts reject u64 while legacy FFI transport remains allowed", () => {
  const commonU64 = structuredClone(common.manifest);
  commonU64.types[0].fields[0].type = "u64";
  assertSchemaAccepts(common.validateSchema, commonU64, "common semantic u64 schema");
  assert.throws(() => validateCommonSemantics(commonU64), /must not use u64/);

  const mutations = [
    ["ui command", contracts.ui, (manifest) => (manifest.commands[0].params[0].type = "u64")],
    ["ui property", contracts.ui, (manifest) => (manifest.properties[0].valueType = "u64")],
    ["ui event", contracts.ui, (manifest) => (manifest.events[1].payload.fields[0].type = "u64")],
    ["system task", contracts.system, (manifest) => (manifest.taskKinds[0].resultType = "u64")],
  ];
  for (const [label, contract, mutate] of mutations) {
    const invalid = structuredClone(contract.manifest);
    mutate(invalid);
    assertSchemaAccepts(contract.validateSchema, invalid, label + " semantic u64 schema");
    assertSemanticRejects(invalid, contract, /must not use u64/, label + " semantic u64");
  }

  assert.equal(
    contracts.ui.manifest.ffiFunctions.some(
      (ffi) =>
        ffi.status === "legacy" &&
        (ffi.returns === "u64" || ffi.params.some((param) => param.type === "u64")),
    ),
    true,
  );
  assert.doesNotThrow(() => validateNamespaceSemantics(contracts.ui.manifest, contracts.ui));
});

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

function readJson(path) {
  return JSON.parse(readFileSync(new URL("../" + path, import.meta.url), "utf8"));
}

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const COMMON_SCHEMA_ID = "https://nexa-ui.dev/schema/common-v1.json";
const PRIMITIVE_TYPES = new Set(["bool", "f64", "i32", "string", "u32", "u64", "void"]);
const COMMON_OWNERSHIP_KEYS = [
  "protocol",
  "abi",
  "resultTransport",
  "resultEnvelope",
  "handleValidation",
  "handleTransport",
  "handleKinds",
];

const common = {
  manifest: readJson("protocol/common.json"),
  schema: readJson("protocol/schema/common.schema.json"),
  fixture: readJson("protocol/fixtures/common.expected.json"),
};

const contracts = {
  ui: {
    manifest: readJson("protocol/nui-host.json"),
    schema: readJson("protocol/schema/nui-host.schema.json"),
    fixture: readJson("protocol/fixtures/nui-host.expected.json"),
    schemaId: "https://nexa-ui.dev/schema/nui-host-v1.json",
    idRegistries: ["nodeTypes", "properties", "events", "commands"],
    derivedTypes: ["NodeType", "PropertyId", "PropertyValue", "EventId", "EventCallback"],
    errorPrefix: 0x0100,
  },
  system: {
    manifest: readJson("protocol/system-host.json"),
    schema: readJson("protocol/schema/system-host.schema.json"),
    fixture: readJson("protocol/fixtures/system-host.expected.json"),
    schemaId: "https://nexa-ui.dev/schema/system-host-v1.json",
    idRegistries: ["commands", "permissions", "taskKinds", "resourceKinds"],
    derivedTypes: [],
    errorPrefix: 0x0200,
  },
};

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});

ajv.addSchema(common.schema);
common.validateSchema = ajv.getSchema(COMMON_SCHEMA_ID);
assert.ok(common.validateSchema, "common schema must be registered before namespace schemas");

for (const contract of Object.values(contracts)) {
  contract.validateSchema = ajv.compile(contract.schema);
}

function assertSchemaAccepts(validate, candidate, label) {
  assert.equal(validate(candidate), true, label + ": " + JSON.stringify(validate.errors, null, 2));
}

function assertSchemaRejects(validate, candidate, label) {
  assert.equal(validate(candidate), false, label);
}

function compareVersion(left, right) {
  return left.major === right.major ? left.minor - right.minor : left.major - right.major;
}

function assertVersion(version, label) {
  assert.ok(version && typeof version === "object", label);
  for (const key of ["major", "minor"]) {
    assert.ok(Number.isInteger(version[key]), label + "." + key + " integer");
    assert.ok(version[key] >= 0 && version[key] <= UINT32_MAX, label + "." + key + " u32");
  }
}

function assertLifecycle(entry, label) {
  const { lifecycle } = entry;
  assert.ok(lifecycle && typeof lifecycle === "object", label + " lifecycle");
  assert.ok(
    ["active", "reserved", "tombstone"].includes(lifecycle.status),
    label + " lifecycle status",
  );
  assertVersion(lifecycle.introduced, label + " introduced");

  for (const key of ["deprecated", "removed"]) {
    if (lifecycle[key] !== null) {
      assertVersion(lifecycle[key], label + " " + key);
    }
  }

  if (lifecycle.deprecated !== null) {
    assert.ok(
      compareVersion(lifecycle.introduced, lifecycle.deprecated) <= 0,
      label + " deprecated before introduced",
    );
  }
  if (lifecycle.removed !== null) {
    assert.notEqual(lifecycle.deprecated, null, label + " removed entry must be deprecated");
    assert.ok(
      compareVersion(lifecycle.deprecated, lifecycle.removed) <= 0,
      label + " removed before deprecated",
    );
  }

  if (lifecycle.status === "tombstone") {
    assert.notEqual(lifecycle.deprecated, null, label + " tombstone must be deprecated");
    assert.notEqual(lifecycle.removed, null, label + " tombstone must be removed");
  } else {
    assert.equal(lifecycle.removed, null, label + " non-tombstone cannot be removed");
  }
}

function assertUniqueNamed(entries, label) {
  const names = new Set();
  for (const entry of entries) {
    assertLifecycle(entry, label + "/" + entry.name);
    assert.equal(names.has(entry.name), false, label + " duplicate name " + entry.name);
    names.add(entry.name);
  }
}

function assertUniqueRegistry(entries, label, idKey = "id", maximum = UINT16_MAX) {
  assert.ok(Array.isArray(entries), label + " must be an array");
  assertUniqueNamed(entries, label);

  const ids = new Set();
  for (const entry of entries) {
    assert.ok(Number.isInteger(entry[idKey]), label + "/" + entry.name + " " + idKey);
    assert.ok(
      entry[idKey] >= 0 && entry[idKey] <= maximum,
      label + "/" + entry.name + " " + idKey + " range",
    );
    assert.equal(ids.has(entry[idKey]), false, label + " duplicate " + idKey + " " + entry[idKey]);
    ids.add(entry[idKey]);
  }
}

function assertUniqueFields(fields, label) {
  const names = new Set();
  for (const field of fields) {
    assert.equal(names.has(field.name), false, label + " duplicate field " + field.name);
    names.add(field.name);
  }
}

function toMap(entries, idKey = "id") {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry[idKey]]));
}

function qualify(namespace, name) {
  return name.includes(".") ? name : namespace + "." + name;
}

function collectTypeSymbols(commonManifest, manifest, contract) {
  return new Set([
    ...PRIMITIVE_TYPES,
    ...commonManifest.types.map((type) => qualify("common", type.name)),
    ...manifest.types.map((type) => qualify(manifest.namespace, type.name)),
    ...contract.derivedTypes.map((name) => manifest.namespace + "." + name),
  ]);
}

function collectFeatureSymbols(commonManifest, manifest) {
  return new Set([
    ...commonManifest.features.map(
      (feature) => commonManifest.featureNamespace + "." + feature.name,
    ),
    ...manifest.features.map((feature) => manifest.featureNamespace + "." + feature.name),
  ]);
}

function collectHandleKindSymbols(commonManifest) {
  return new Set(commonManifest.handleKinds.map((kind) => "common." + kind.name));
}

function assertKnownReference(reference, symbols, label) {
  assert.equal(symbols.has(reference), true, label + " unknown reference " + reference);
}

function assertTypeReference(reference, namespace, symbols, label) {
  if (PRIMITIVE_TYPES.has(reference)) return;
  assertKnownReference(qualify(namespace, reference), symbols, label + " type");
}

function assertHandleBinding(value, typeSymbols, handleKinds, namespace, label) {
  assertTypeReference(value.type, namespace, typeSymbols, label);
  if (value.type === "common.HandleRef") {
    assert.equal(typeof value.handleKind, "string", label + " HandleRef handleKind");
    assertKnownReference(value.handleKind, handleKinds, label + " handleKind");
  } else {
    assert.equal(value.handleKind, undefined, label + " non-HandleRef handleKind");
  }
}

function assertFeatureReferences(entries, featureSymbols, label) {
  for (const entry of entries) {
    for (const reference of entry.requiresFeatures) {
      assertKnownReference(reference, featureSymbols, label + "/" + entry.name + " feature");
    }
  }
}

function collectCommandMap(commonManifest, manifest = null) {
  const commands = commonManifest.commands.map((command) => ["common." + command.name, command]);
  if (manifest !== null) {
    commands.push(
      ...manifest.commands.map((command) => [manifest.namespace + "." + command.name, command]),
    );
  }
  return new Map(commands);
}

function assertV1CommandCoverage(commands, ffiFunctions, namespace) {
  const v1Commands = new Set(
    ffiFunctions.filter((ffi) => ffi.status === "v1").map((ffi) => ffi.command),
  );
  for (const command of commands) {
    const qualifiedCommand = namespace + "." + command.name;
    assert.equal(
      v1Commands.has(qualifiedCommand),
      true,
      qualifiedCommand + " must have a v1 FFI function",
    );
  }
}

function assertCommandMetadata(commands, namespace, typeSymbols, handleKinds, featureSymbols) {
  for (const command of commands) {
    const label = namespace + "/commands/" + command.name;
    assert.equal("nativeSymbol" in command, false, label + " must not own a native symbol");
    assert.ok(Array.isArray(command.params), label + " params");
    assertUniqueFields(command.params, label + " params");
    for (const param of command.params) {
      assertHandleBinding(param, typeSymbols, handleKinds, namespace, label + "/" + param.name);
    }
    assertHandleBinding(command.returns, typeSymbols, handleKinds, namespace, label + " returns");
    assert.ok(Array.isArray(command.requiresFeatures), label + " requiresFeatures");
    assertFeatureReferences([command], featureSymbols, namespace + "/commands");
  }
}

function mappingRoot(mapping) {
  return mapping.slice(0, mapping.indexOf("."));
}

function assertFfiMappings(ffiFunctions, commandMap, label) {
  for (const ffi of ffiFunctions) {
    const command = commandMap.get(ffi.command);
    assert.ok(command, label + "/" + ffi.name + " unknown command " + ffi.command);
    assertUniqueFields(ffi.params, label + "/" + ffi.name + " params");

    const commandParams = new Map(command.params.map((param) => [param.name, param]));
    const mappedRoots = new Set();
    for (const param of ffi.params) {
      const root = mappingRoot(param.mapping);
      assert.equal(commandParams.has(root), true, label + "/" + ffi.name + " mapping root " + root);
      mappedRoots.add(root);
    }
    for (const fixed of ffi.fixedMappings) {
      assert.equal(
        commandParams.has(fixed.target),
        true,
        label + "/" + ffi.name + " fixed mapping root " + fixed.target,
      );
      mappedRoots.add(fixed.target);
    }
    assert.deepEqual(
      [...mappedRoots].sort(),
      [...commandParams.keys()].sort(),
      label + "/" + ffi.name + " must map every command parameter",
    );

    if (ffi.status !== "v1") continue;
    assert.equal(ffi.returns, "string", label + "/" + ffi.name + " v1 return");
    assert.equal(
      ffi.resultCodec,
      "nexa_result_json_v1",
      label + "/" + ffi.name + " v1 result codec",
    );

    for (const commandParam of command.params.filter(
      (param) => param.type === "common.HandleRef",
    )) {
      const handleMappings = ffi.params.filter(
        (param) => mappingRoot(param.mapping) === commandParam.name,
      );
      assert.equal(
        handleMappings.some((param) => ["jsvalue", "u64"].includes(param.type)),
        false,
        label + "/" + ffi.name + "/" + commandParam.name + " unsafe HandleRef input",
      );

      const expectedParts = commandParam.optional
        ? ["presence:u32", "slot:u32", "generation:u32"]
        : ["slot:u32", "generation:u32"];
      assert.deepEqual(
        handleMappings.map(
          (param) => param.mapping.slice(commandParam.name.length + 1) + ":" + param.type,
        ),
        expectedParts,
        label + "/" + ffi.name + "/" + commandParam.name + " HandleRef transport",
      );
    }
  }
}

function collectLifecycleEntries(manifest, registryKeys) {
  return registryKeys.flatMap((key) => manifest[key]);
}

function collectReferenceSymbols(commonManifest, manifest = null, contract = null) {
  const symbols = new Set([
    ...commonManifest.features.map(
      (feature) => commonManifest.featureNamespace + "." + feature.name,
    ),
    ...commonManifest.handleKinds.map((kind) => "common." + kind.name),
    ...commonManifest.types.map((type) => qualify("common", type.name)),
    ...commonManifest.commands.map((command) => "common." + command.name),
    ...commonManifest.errors.map((error) => error.domain + "." + error.name),
  ]);

  if (manifest === null) return symbols;
  for (const feature of manifest.features) {
    symbols.add(manifest.featureNamespace + "." + feature.name);
  }
  for (const type of manifest.types) symbols.add(qualify(manifest.namespace, type.name));
  for (const derivedType of contract.derivedTypes) {
    symbols.add(manifest.namespace + "." + derivedType);
  }
  for (const key of contract.idRegistries) {
    for (const entry of manifest[key]) symbols.add(manifest.namespace + "." + entry.name);
  }
  for (const error of manifest.errors) symbols.add(error.domain + "." + error.name);
  return symbols;
}

function assertLifecycleReplacementReferences(entries, symbols, label) {
  for (const entry of entries) {
    if (entry.lifecycle.replacement !== null) {
      assertKnownReference(entry.lifecycle.replacement, symbols, label + "/" + entry.name);
    }
  }
}

function assertTypeDefinitions(types, namespace, typeSymbols, handleKinds, label) {
  assertUniqueNamed(types, label);
  for (const type of types) {
    if (type.kind === "record") {
      assertUniqueFields(type.fields, label + "/" + type.name + " fields");
      for (const field of type.fields) {
        assertHandleBinding(
          field,
          typeSymbols,
          handleKinds,
          namespace,
          label + "/" + type.name + "/" + field.name,
        );
      }
    } else if (type.kind === "map") {
      for (const valueType of type.valueTypes) {
        assertTypeReference(valueType, namespace, typeSymbols, label + "/" + type.name);
      }
    }
  }
}

function assertErrorRegistry(errors, domain, prefix, label) {
  assertUniqueRegistry(errors, label, "code", UINT32_MAX);
  for (const error of errors) {
    assert.equal(error.domain, domain, label + "/" + error.name + " domain");
    assert.equal(Math.floor(error.code / 0x10000), prefix, label + "/" + error.name + " prefix");
  }
}

function validateCommonSemantics(manifest) {
  assertUniqueRegistry(manifest.features, "common/features", "bit", 63);
  assertUniqueRegistry(manifest.handleKinds, "common/handleKinds");
  assertUniqueRegistry(manifest.commands, "common/commands");
  assertUniqueRegistry(manifest.ffiFunctions, "common/ffiFunctions", "abiIndex", UINT32_MAX);
  assertErrorRegistry(manifest.errors, "protocol", 0x0001, "common/errors");

  const typeSymbols = collectTypeSymbols(
    manifest,
    { namespace: "common", types: [] },
    {
      derivedTypes: [],
    },
  );
  const featureSymbols = collectFeatureSymbols(manifest, {
    featureNamespace: "common",
    features: [],
  });
  const handleKinds = collectHandleKindSymbols(manifest);
  assertTypeDefinitions(manifest.types, "common", typeSymbols, handleKinds, "common/types");
  assertCommandMetadata(manifest.commands, "common", typeSymbols, handleKinds, featureSymbols);
  assertKnownReference(
    manifest.handleTransport.requiredFeature,
    featureSymbols,
    "common/handleTransport feature",
  );
  assertFfiMappings(manifest.ffiFunctions, collectCommandMap(manifest), "common/ffiFunctions");
  assertV1CommandCoverage(manifest.commands, manifest.ffiFunctions, "common");

  const entries = collectLifecycleEntries(manifest, [
    "features",
    "handleKinds",
    "types",
    "commands",
    "ffiFunctions",
    "errors",
  ]);
  assertLifecycleReplacementReferences(
    entries,
    collectReferenceSymbols(manifest),
    "common lifecycle",
  );
}

function validateNamespaceSemantics(manifest, contract, commonManifest = common.manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.namespace, contract.fixture.expected.namespace);
  assert.equal(manifest.featureNamespace, contract.fixture.expected.featureNamespace);
  for (const key of COMMON_OWNERSHIP_KEYS) {
    assert.equal(key in manifest, false, manifest.namespace + " must not own common." + key);
  }
  assert.equal(
    manifest.commands.some((command) => command.name === "Handshake"),
    false,
    manifest.namespace + " must not duplicate common.Handshake",
  );

  assertUniqueRegistry(manifest.features, manifest.namespace + "/features", "bit", 63);
  assertUniqueNamed(manifest.types, manifest.namespace + "/types");
  for (const key of contract.idRegistries) {
    assertUniqueRegistry(manifest[key], manifest.namespace + "/" + key);
  }
  assertUniqueRegistry(
    manifest.ffiFunctions,
    manifest.namespace + "/ffiFunctions",
    "abiIndex",
    UINT32_MAX,
  );
  assertErrorRegistry(
    manifest.errors,
    manifest.namespace,
    contract.errorPrefix,
    manifest.namespace + "/errors",
  );

  const typeSymbols = collectTypeSymbols(commonManifest, manifest, contract);
  const featureSymbols = collectFeatureSymbols(commonManifest, manifest);
  const handleKinds = collectHandleKindSymbols(commonManifest);
  const commandMap = collectCommandMap(commonManifest, manifest);
  const localCommandSymbols = new Set(
    manifest.commands.map((command) => manifest.namespace + "." + command.name),
  );

  assertTypeDefinitions(
    manifest.types,
    manifest.namespace,
    typeSymbols,
    handleKinds,
    manifest.namespace + "/types",
  );
  assertCommandMetadata(
    manifest.commands,
    manifest.namespace,
    typeSymbols,
    handleKinds,
    featureSymbols,
  );

  for (const ffi of manifest.ffiFunctions) {
    assert.equal(ffi.library, manifest.namespace, manifest.namespace + "/" + ffi.name + " library");
    assertKnownReference(
      ffi.command,
      localCommandSymbols,
      manifest.namespace + "/" + ffi.name + " command",
    );
  }
  assertFfiMappings(manifest.ffiFunctions, commandMap, manifest.namespace + "/ffiFunctions");

  assertV1CommandCoverage(manifest.commands, manifest.ffiFunctions, manifest.namespace);

  if (manifest.namespace === "ui") {
    assertFeatureReferences(manifest.nodeTypes, featureSymbols, "ui/nodeTypes");
    assertFeatureReferences(manifest.properties, featureSymbols, "ui/properties");
    assertFeatureReferences(manifest.events, featureSymbols, "ui/events");
    for (const nodeType of manifest.nodeTypes) {
      assertKnownReference(nodeType.handleKind, handleKinds, "ui/nodeTypes/" + nodeType.name);
    }
    for (const property of manifest.properties) {
      assertTypeReference(property.valueType, "ui", typeSymbols, "ui/properties/" + property.name);
      assert.equal(
        typeof property.nullable,
        "boolean",
        "ui/properties/" + property.name + " nullable",
      );
      assert.ok(property.clear && typeof property.clear === "object", "ui/properties clear");
    }
    for (const event of manifest.events) {
      assertUniqueFields(event.payload.fields, "ui/events/" + event.name + " payload");
      for (const field of event.payload.fields) {
        assertHandleBinding(
          field,
          typeSymbols,
          handleKinds,
          "ui",
          "ui/events/" + event.name + "/" + field.name,
        );
      }
    }
  } else {
    const permissionSymbols = new Set(
      manifest.permissions.map((permission) => "system." + permission.name),
    );
    const taskKinds = new Map(manifest.taskKinds.map((kind) => ["system." + kind.name, kind]));
    const taskKindSymbols = new Set(taskKinds.keys());
    const resourceKindSymbols = new Set(
      manifest.resourceKinds.map((kind) => "system." + kind.name),
    );

    for (const command of manifest.commands) {
      for (const permission of command.requiredPermissions) {
        assertKnownReference(permission, permissionSymbols, "system/commands/" + command.name);
      }
      if (command.createsTaskKind !== null) {
        assertKnownReference(
          command.createsTaskKind,
          taskKindSymbols,
          "system/commands/" + command.name,
        );
        assert.equal(command.returns.handleKind, "common.Task", command.name + " task return kind");
        const requiredPermission = taskKinds.get(command.createsTaskKind).requiredPermission;
        assert.equal(
          command.requiredPermissions.includes(requiredPermission),
          true,
          command.name + " must require " + requiredPermission,
        );
      }
      if (command.createsResourceKind !== null) {
        assertKnownReference(
          command.createsResourceKind,
          resourceKindSymbols,
          "system/commands/" + command.name,
        );
        assert.equal(
          command.returns.handleKind,
          "common.NativeResource",
          command.name + " resource return kind",
        );
      }
      if (command.returns.handleKind === "common.Task") {
        assert.notEqual(
          command.createsTaskKind,
          null,
          command.name + " Task return must declare createsTaskKind",
        );
      }
      if (command.returns.handleKind === "common.NativeResource") {
        assert.notEqual(
          command.createsResourceKind,
          null,
          command.name + " NativeResource return must declare createsResourceKind",
        );
      }
    }
    for (const taskKind of manifest.taskKinds) {
      assertKnownReference(taskKind.handleKind, handleKinds, "system/taskKinds/" + taskKind.name);
      assert.equal(taskKind.handleKind, "common.Task", taskKind.name + " task handle kind");
      assertTypeReference(
        taskKind.resultType,
        "system",
        typeSymbols,
        taskKind.name + " resultType",
      );
      assertKnownReference(
        taskKind.requiredPermission,
        permissionSymbols,
        "system/taskKinds/" + taskKind.name,
      );
    }
    for (const resourceKind of manifest.resourceKinds) {
      assertKnownReference(
        resourceKind.handleKind,
        handleKinds,
        "system/resourceKinds/" + resourceKind.name,
      );
      assert.equal(
        resourceKind.handleKind,
        "common.NativeResource",
        resourceKind.name + " resource handle kind",
      );
      assertKnownReference(
        resourceKind.closeCommand,
        localCommandSymbols,
        "system/resourceKinds/" + resourceKind.name,
      );
      const closeCommand = commandMap.get(resourceKind.closeCommand);
      assert.equal(
        closeCommand.params.some(
          (param) =>
            param.type === "common.HandleRef" &&
            param.handleKind === "common.NativeResource" &&
            param.optional === false,
        ),
        true,
        resourceKind.closeCommand + " must accept a common.NativeResource HandleRef",
      );
    }
  }

  const lifecycleEntries = collectLifecycleEntries(manifest, [
    "features",
    "types",
    ...contract.idRegistries.filter((key) => key !== "commands"),
    "commands",
    "ffiFunctions",
    "errors",
  ]);
  assertLifecycleReplacementReferences(
    lifecycleEntries,
    collectReferenceSymbols(commonManifest, manifest, contract),
    manifest.namespace + " lifecycle",
  );
}

function assertAbiLayout(entries, expectedIndexes, label) {
  const indexes = new Set();
  const names = new Set();
  for (const entry of entries) {
    assert.equal(
      indexes.has(entry.abiIndex),
      false,
      label + " duplicate ABI slot " + entry.abiIndex,
    );
    assert.equal(names.has(entry.name), false, label + " duplicate native symbol " + entry.name);
    indexes.add(entry.abiIndex);
    names.add(entry.name);
  }
  assert.deepEqual(
    [...indexes].sort((left, right) => left - right),
    expectedIndexes,
    label + " ABI slots",
  );
}

function assertCounts(manifest, fixture, label) {
  for (const [key, expectedCount] of Object.entries(fixture.expected.counts)) {
    assert.equal(manifest[key].length, expectedCount, label + " " + key + " count");
  }
}

function assertSemanticRejects(candidate, contract, expected, label) {
  assertSchemaAccepts(contract.validateSchema, candidate, label + " must be schema-valid");
  assert.throws(() => validateNamespaceSemantics(candidate, contract), expected, label);
}

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
    contracts.system.manifest.ffiFunctions,
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

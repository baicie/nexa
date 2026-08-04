const TYPESCRIPT_PRIMITIVES = new Map([
  ["bool", "boolean"],
  ["f64", "number"],
  ["i32", "number"],
  ["string", "string"],
  ["u32", "number"],
  ["void", "void"],
]);

function toPascalCase(value) {
  if (!value.includes("_") && /^[A-Z][A-Za-z0-9]*$/.test(value) && /[a-z]/.test(value)) {
    return value;
  }
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function namespaceName(namespace) {
  return namespace[0].toUpperCase() + namespace.slice(1);
}

function typescriptType(type, namespace) {
  if (type === "u64") {
    throw new Error("TypeScript protocol must not render semantic u64 as a JS number");
  }
  const primitive = TYPESCRIPT_PRIMITIVES.get(type);
  if (primitive) return primitive;

  const qualified = type.includes(".") ? type : namespace + "." + type;
  const separator = qualified.indexOf(".");
  const owner = qualified.slice(0, separator);
  const name = qualified.slice(separator + 1);
  return owner === namespace ? name : namespaceName(owner) + "." + name;
}

function isOptionalHandle(value) {
  return value.optional && value.type === "common.HandleRef";
}

function optionalMarker(value) {
  return value.optional && !isOptionalHandle(value) ? "?" : "";
}

function withOptionalHandleNull(value, renderedType) {
  return renderedType + (isOptionalHandle(value) ? " | null" : "");
}

function renderRecord(type, namespace) {
  if (namespace === "common" && type.name === "HandleRef") {
    return [
      "  export type HandleRef = Readonly<{",
      "    readonly slot: number;",
      "    readonly generation: number;",
      "  }> & { readonly [handleRefBrand]: true };",
    ].join("\n");
  }

  if (type.fields.length === 0) return "  export interface " + type.name + " {}";

  const fields = type.fields
    .map((field) => {
      const baseType =
        namespace === "common" && type.name === "NexaError" && field.name === "domain"
          ? '"protocol" | "ui" | "system"'
          : typescriptType(field.type, namespace);
      const fieldType = withOptionalHandleNull(field, baseType);
      return "    readonly " + field.name + optionalMarker(field) + ": " + fieldType + ";";
    })
    .join("\n");
  return ["  export interface " + type.name + " {", fields, "  }"].join("\n");
}

function renderStringEnum(type) {
  const variants = type.values.map((value) => "    " + value + ' = "' + value + '",').join("\n");
  return ["  export enum " + type.name + " {", variants, "  }"].join("\n");
}

function renderMap(type, namespace) {
  const valueTypes = [
    ...new Set(type.valueTypes.map((valueType) => typescriptType(valueType, namespace))),
  ];
  return (
    "  export type " + type.name + " = Readonly<Record<string, " + valueTypes.join(" | ") + ">>;"
  );
}

function renderTypes(types, namespace) {
  return types
    .map((type) => {
      if (type.kind === "record") return renderRecord(type, namespace);
      if (type.kind === "enum") return renderStringEnum(type);
      return renderMap(type, namespace);
    })
    .join("\n\n");
}

function renderNumericEnum(name, entries, idKey) {
  if (entries.length === 0) return "";
  const variants = [...entries]
    .sort((left, right) => left[idKey] - right[idKey])
    .map((entry) => "    " + toPascalCase(entry.name) + " = " + entry[idKey] + ",")
    .join("\n");
  return ["  export enum " + name + " {", variants, "  }"].join("\n");
}

function renderCommandMaps(commands, namespace) {
  const params = commands
    .map((command) => {
      const tuple = command.params.map((param) => {
        const type = withOptionalHandleNull(param, typescriptType(param.type, namespace));
        return param.name + optionalMarker(param) + ": " + type;
      });
      const prefix = "    readonly [CommandId." + command.name + "]: readonly [";
      const singleLine = prefix + tuple.join(", ") + "];";
      if (singleLine.length <= 100) return singleLine;
      return [prefix, ...tuple.map((item) => "      " + item + ","), "    ];"].join("\n");
    })
    .join("\n");
  const results = commands
    .map(
      (command) =>
        "    readonly [CommandId." +
        command.name +
        "]: " +
        typescriptType(command.returns.type, namespace) +
        ";",
    )
    .join("\n");
  return [
    "  export interface CommandParams {",
    params,
    "  }",
    "",
    "  export interface CommandResults {",
    results,
    "  }",
  ].join("\n");
}

function renderFeatureBits(features) {
  return renderNumericEnum("FeatureBit", features, "bit");
}

function renderEventPayloads(events) {
  return events.map((event) => renderRecord(event.payload, "ui")).join("\n\n");
}

function renderCommon(manifest) {
  const version = manifest.protocol;
  const abi = manifest.abi;
  const wire = manifest.handleTransport.wireToken;
  return [
    "export namespace Common {",
    renderTypes(manifest.types, "common"),
    "",
    "  export type NexaResult<T> =",
    "    | Readonly<{ readonly ok: true; readonly value: T }>",
    "    | Readonly<{ readonly ok: false; readonly error: NexaError }>;",
    "",
    "  export const schemaVersion = " + manifest.schemaVersion + " as const;",
    "  export const protocolVersion = {",
    "    major: " + version.major + ",",
    "    minor: " + version.minor + ",",
    "    patch: " + version.patch + ",",
    "  } as const;",
    "  export const abiVersion = { major: " + abi.major + ", minor: " + abi.minor + " } as const;",
    "  export const handleValidation = {",
    "    slotMinimum: " + manifest.handleValidation.slotMinimum + ",",
    "    slotMaximum: " + manifest.handleValidation.slotMaximum + ",",
    "    generationMinimum: " + manifest.handleValidation.generationMinimum + ",",
    "    generationMaximum: " + manifest.handleValidation.generationMaximum + ",",
    "  } as const;",
    "  export const handleTokenPattern = /^" +
      wire.prefix +
      "\\/[0-9a-f]{" +
      wire.slotHexWidth +
      "}\\/[0-9a-f]{" +
      wire.generationHexWidth +
      "}$/;",
    '  export const resultCodec = "' + manifest.handleTransport.result.codec + '" as const;',
    "",
    renderFeatureBits(manifest.features),
    "",
    renderNumericEnum("HandleKind", manifest.handleKinds, "id"),
    "",
    renderNumericEnum("CommandId", manifest.commands, "id"),
    "",
    renderNumericEnum("ErrorCode", manifest.errors, "code"),
    "",
    renderCommandMaps(manifest.commands, "common"),
    "}",
  ].join("\n");
}

function renderUi(manifest) {
  const propertyTypes = [
    ...new Set(manifest.properties.map((property) => typescriptType(property.valueType, "ui"))),
  ];
  const payloadMap = manifest.events
    .map((event) => "    readonly [EventId." + event.name + "]: " + event.payload.name + ";")
    .join("\n");
  return [
    "export namespace Ui {",
    renderTypes(manifest.types, "ui"),
    "",
    renderEventPayloads(manifest.events),
    "",
    "  export type PropertyValue = " + propertyTypes.join(" | ") + ";",
    "",
    renderFeatureBits(manifest.features),
    "",
    renderNumericEnum("NodeType", manifest.nodeTypes, "id"),
    "",
    renderNumericEnum("PropertyId", manifest.properties, "id"),
    "",
    renderNumericEnum("EventId", manifest.events, "id"),
    "",
    "  export interface EventPayloadMap {",
    payloadMap,
    "  }",
    "  export type EventPayload = EventPayloadMap[keyof EventPayloadMap];",
    "  export type EventCallback = (payload: EventPayload) => void;",
    "",
    renderNumericEnum("CommandId", manifest.commands, "id"),
    "",
    renderNumericEnum("ErrorCode", manifest.errors, "code"),
    "",
    renderCommandMaps(manifest.commands, "ui"),
    "}",
  ].join("\n");
}

function renderSystem(manifest) {
  const taskResults = manifest.taskKinds
    .map(
      (task) =>
        "    readonly [TaskKind." +
        task.name +
        "]: " +
        typescriptType(task.resultType, "system") +
        ";",
    )
    .join("\n");
  return [
    "export namespace System {",
    ...(manifest.types.length > 0 ? [renderTypes(manifest.types, "system"), ""] : []),
    renderFeatureBits(manifest.features),
    "",
    renderNumericEnum("CommandId", manifest.commands, "id"),
    "",
    renderNumericEnum("PermissionId", manifest.permissions, "id"),
    "",
    renderNumericEnum("TaskKind", manifest.taskKinds, "id"),
    "",
    "  export interface TaskResultMap {",
    taskResults,
    "  }",
    "",
    renderNumericEnum("ResourceKind", manifest.resourceKinds, "id"),
    "",
    renderNumericEnum("ErrorCode", manifest.errors, "code"),
    "",
    renderCommandMaps(manifest.commands, "system"),
    "}",
  ].join("\n");
}

export function renderTypeScriptProtocol({ common, ui, system }) {
  return [
    "// @generated by tools/protocol-codegen.mjs; DO NOT EDIT.",
    "// Source: protocol/common.json, protocol/nui-host.json, protocol/system-host.json.",
    "",
    "declare const handleRefBrand: unique symbol;",
    "",
    renderCommon(common),
    "",
    renderUi(ui),
    "",
    renderSystem(system),
    "",
  ].join("\n");
}

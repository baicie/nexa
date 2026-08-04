const RUST_PRIMITIVES = new Map([
  ["bool", "bool"],
  ["f64", "f64"],
  ["i32", "i32"],
  ["string", "String"],
  ["u32", "u32"],
  ["u64", "u64"],
  ["void", "()"],
]);

const RUST_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "union",
  "unsafe",
  "use",
  "where",
  "while",
]);

function toSnakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function toScreamingSnakeCase(value) {
  return toSnakeCase(value).toUpperCase();
}

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

function rustFieldName(value) {
  const name = toSnakeCase(value);
  return RUST_KEYWORDS.has(name) ? "r#" + name : name;
}

function rustType(type, namespace, currentType = null) {
  const primitive = RUST_PRIMITIVES.get(type);
  if (primitive) return primitive;

  const qualified = type.includes(".") ? type : namespace + "." + type;
  const separator = qualified.indexOf(".");
  const owner = qualified.slice(0, separator);
  const name = qualified.slice(separator + 1);
  if (owner === namespace && name === currentType) return "Box<" + name + ">";
  return owner === namespace ? name : "super::" + owner + "::" + name;
}

function rustFieldType(field, namespace, currentType) {
  const base = rustType(field.type, namespace, currentType);
  return field.optional ? "Option<" + base + ">" : base;
}

function renderRecord(type, namespace) {
  if (type.fields.length === 0) {
    return ["    #[derive(Debug, Clone, PartialEq)]", "    pub struct " + type.name + " {}"].join(
      "\n",
    );
  }
  const fields = type.fields
    .map(
      (field) =>
        "        pub " +
        rustFieldName(field.name) +
        ": " +
        rustFieldType(field, namespace, type.name) +
        ",",
    )
    .join("\n");
  return [
    "    #[derive(Debug, Clone, PartialEq)]",
    "    pub struct " + type.name + " {",
    fields,
    "    }",
  ].join("\n");
}

function renderStringEnum(type) {
  const variants = type.values.map((value) => "        " + value + ",").join("\n");
  return [
    "    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]",
    "    pub enum " + type.name + " {",
    variants,
    "    }",
  ].join("\n");
}

function renderMap(type, namespace) {
  const valueName = type.name + "Value";
  const variants = type.valueTypes
    .map((valueType) => {
      const variant = toPascalCase(valueType.replace(".", "_"));
      return "        " + variant + "(" + rustType(valueType, namespace) + "),";
    })
    .join("\n");
  return [
    "    #[derive(Debug, Clone, PartialEq)]",
    "    pub enum " + valueName + " {",
    variants,
    "    }",
    "",
    "    pub type " + type.name + " = BTreeMap<String, " + valueName + ">;",
  ].join("\n");
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

function renderNumericEnum(name, entries, idKey, repr) {
  if (entries.length === 0) return "";
  const variants = [...entries]
    .sort((left, right) => left[idKey] - right[idKey])
    .map((entry) => "        " + toPascalCase(entry.name) + " = " + entry[idKey] + ",")
    .join("\n");
  return [
    "    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]",
    "    #[repr(" + repr + ")]",
    "    pub enum " + name + " {",
    variants,
    "    }",
  ].join("\n");
}

function renderFeatureBits(features) {
  const constants = [...features]
    .sort((left, right) => left.bit - right.bit)
    .map(
      (feature) =>
        "        pub const " + toScreamingSnakeCase(feature.name) + ": u8 = " + feature.bit + ";",
    )
    .join("\n");
  return ["    pub mod feature_bits {", constants, "    }"].join("\n");
}

function renderEventPayloads(events) {
  return events.map((event) => renderRecord(event.payload, "ui")).join("\n\n");
}

function renderCommon(manifest) {
  const imports = manifest.types.some((type) => type.kind === "map")
    ? "    use std::collections::BTreeMap;\n\n"
    : "";
  const version = manifest.protocol;
  const abi = manifest.abi;
  return [
    "pub mod common {",
    imports + renderTypes(manifest.types, "common"),
    "",
    "    #[derive(Debug, Clone, PartialEq)]",
    "    pub enum NexaResult<T> {",
    "        Ok(T),",
    "        Err(NexaError),",
    "    }",
    "",
    "    pub const SCHEMA_VERSION: u32 = " + manifest.schemaVersion + ";",
    "    pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion {",
    "        major: " + version.major + ",",
    "        minor: " + version.minor + ",",
    "        patch: " + version.patch + ",",
    "    };",
    "    pub const ABI_VERSION: AbiVersion = AbiVersion { major: " +
      abi.major +
      ", minor: " +
      abi.minor +
      " };",
    "    pub const HANDLE_SLOT_MIN: u32 = " + manifest.handleValidation.slotMinimum + ";",
    "    pub const HANDLE_SLOT_MAX: u32 = " + manifest.handleValidation.slotMaximum + ";",
    "    pub const HANDLE_GENERATION_MIN: u32 = " +
      manifest.handleValidation.generationMinimum +
      ";",
    "    pub const HANDLE_GENERATION_MAX: u32 = " +
      manifest.handleValidation.generationMaximum +
      ";",
    '    pub const HANDLE_TOKEN_PREFIX: &str = "' +
      manifest.handleTransport.wireToken.prefix +
      '";',
    '    pub const RESULT_CODEC: &str = "' + manifest.handleTransport.result.codec + '";',
    "",
    renderFeatureBits(manifest.features),
    "",
    renderNumericEnum("HandleKind", manifest.handleKinds, "id", "u16"),
    "",
    renderNumericEnum("CommandId", manifest.commands, "id", "u16"),
    "",
    renderNumericEnum("ErrorCode", manifest.errors, "code", "u32"),
    "}",
  ].join("\n");
}

function renderUi(manifest) {
  return [
    "pub mod ui {",
    renderTypes(manifest.types, "ui"),
    "",
    renderEventPayloads(manifest.events),
    "",
    renderFeatureBits(manifest.features),
    "",
    renderNumericEnum("NodeType", manifest.nodeTypes, "id", "u16"),
    "",
    renderNumericEnum("PropertyId", manifest.properties, "id", "u16"),
    "",
    renderNumericEnum("EventId", manifest.events, "id", "u16"),
    "",
    renderNumericEnum("CommandId", manifest.commands, "id", "u16"),
    "",
    renderNumericEnum("ErrorCode", manifest.errors, "code", "u32"),
    "}",
  ].join("\n");
}

function renderSystem(manifest) {
  return [
    "pub mod system {",
    renderTypes(manifest.types, "system"),
    manifest.types.length > 0 ? "" : null,
    renderFeatureBits(manifest.features),
    "",
    renderNumericEnum("CommandId", manifest.commands, "id", "u16"),
    "",
    renderNumericEnum("PermissionId", manifest.permissions, "id", "u16"),
    "",
    renderNumericEnum("TaskKind", manifest.taskKinds, "id", "u16"),
    "",
    renderNumericEnum("ResourceKind", manifest.resourceKinds, "id", "u16"),
    "",
    renderNumericEnum("ErrorCode", manifest.errors, "code", "u32"),
    "}",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function renderRustProtocol({ common, ui, system }) {
  return [
    "// @generated by tools/protocol-codegen.mjs; DO NOT EDIT.",
    "// Source: protocol/common.json, protocol/nui-host.json, protocol/system-host.json.",
    "",
    renderCommon(common),
    "",
    renderUi(ui),
    "",
    renderSystem(system),
    "",
  ].join("\n");
}

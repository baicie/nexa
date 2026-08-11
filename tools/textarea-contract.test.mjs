import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

const host = await import("../packages/nui-host/src/index.ts");
const minimalUi = await import("../packages/ui/src/index.ts");
const minimalMaterialize = await import("../packages/ui/src/mount/materialize.ts");

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const TEXT_AREA_DEFAULTS = {
  width: 320,
  height: 160,
  padding: 10,
  backgroundColor: 0xffff_ffff,
};

function compileTypeScriptContract(source) {
  const virtualFile = path.join(workspaceRoot, "textarea-public-contract.ts");
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const fallback = ts.createCompilerHost(options);
  const compilerHost = {
    ...fallback,
    fileExists: (fileName) => fileName === virtualFile || fallback.fileExists(fileName),
    readFile: (fileName) => (fileName === virtualFile ? source : fallback.readFile(fileName)),
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      return fileName === virtualFile
        ? ts.createSourceFile(fileName, source, languageVersion, true)
        : fallback.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
  };
  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram([virtualFile], options, compilerHost),
  );
  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    return `TS${diagnostic.code}: ${message}`;
  });
}

function numericProperties(trace, node) {
  return new Map(
    trace
      .filter((entry) => entry.op === "setNumber" && entry.node === node)
      .map((entry) => [entry.property, entry.value]),
  );
}

function compositeCreations(trace) {
  return trace
    .filter(({ op }) => op === "createNode" || op === "createText")
    .map(({ op, node, nodeType, text }) =>
      op === "createNode" ? { op, node, nodeType } : { op, node, text },
    );
}

test("minimal UI exports TextArea without extending the native NodeType registry", () => {
  assert.equal("TextArea" in host.NodeType, false);
  assert.equal(typeof minimalUi.TextArea, "function");

  const element = minimalUi.TextArea({ value: "first\nsecond" });
  assert.equal(element.kind, "textarea");
});

test("TextAreaProps exposes the controlled multiline public type contract", () => {
  const diagnostics = compileTypeScriptContract(`
    import {
      TextArea,
      signal,
      type PrimitiveElement,
      type TextAreaProps,
    } from "./packages/ui/src/index.js";

    const body = signal("first\\nsecond");
    const props: TextAreaProps = {
      value: body,
      placeholder: "Body",
      width: 480,
      height: 240,
      onChange: (next: string) => {
        body.value = next;
      },
    };
    const element: PrimitiveElement = TextArea(props);
    void element;
  `);

  assert.deepEqual(diagnostics, []);
});

test("Host TextArea is a Scroll plus Text composite with stable defaults and clear behavior", () => {
  hostFfiHarness.resetTrace();
  const area = host.createHostElement("textarea");

  host.applyHostProp(area, "placeholder", "Body");
  host.applyHostProp(area, "value", "first\nsecond");
  host.applyHostProp(area, "placeholder", null);
  host.applyHostProp(area, "value", null);

  const trace = hostFfiHarness.normalizedTrace();
  const properties = numericProperties(trace, "n1");
  const registrations = trace.filter(({ op }) => op === "registerInput");
  const textWrites = trace
    .filter(({ op, node }) => op === "setText" && node === "n2")
    .map(({ text }) => text);
  const summary = {
    tag: area.tag,
    childCount: area.children.length,
    creations: compositeCreations(trace),
    insertsTextChild: trace.some(
      ({ op, child, parent }) => op === "insert" && child === "n2" && parent === "n1",
    ),
    defaults: {
      width: properties.get(host.PropertyId.Width),
      height: properties.get(host.PropertyId.Height),
      padding: properties.get(host.PropertyId.Padding),
      backgroundColor: properties.get(host.PropertyId.BackgroundColor),
    },
    registersInput: registrations.some(({ node, textNode }) => node === "n1" && textNode === "n2"),
    appliesPlaceholder: registrations.some(({ placeholder }) => placeholder === "Body"),
    clearsPlaceholder: registrations.some(({ placeholder }) => placeholder === ""),
    appliesValue: textWrites.includes("first\nsecond"),
    clearsValue: textWrites.at(-1) === "",
    clearsHostProps: !("placeholder" in area.hostProps) && !("value" in area.hostProps),
  };
  host.remove(area.id);

  assert.deepEqual(summary, {
    tag: "textarea",
    childCount: 1,
    creations: [
      { op: "createNode", node: "n1", nodeType: host.NodeType.Scroll },
      { op: "createText", node: "n2", text: "" },
    ],
    insertsTextChild: true,
    defaults: TEXT_AREA_DEFAULTS,
    registersInput: true,
    appliesPlaceholder: true,
    clearsPlaceholder: true,
    appliesValue: true,
    clearsValue: true,
    clearsHostProps: true,
  });
});

test("TextArea materializer binds a controlled signal and onChange through registerInput", () => {
  hostFfiHarness.resetTrace();
  const body = minimalUi.signal("first\nsecond");
  const changes = [];
  const root = minimalMaterialize.mountNode({
    $$nexa: true,
    kind: "textarea",
    props: {
      value: body,
      placeholder: "Body",
      onChange: (next) => changes.push(next),
    },
  });

  if (root !== null) {
    hostFfiHarness.dispatch(root, host.EventId.Change, "user\nedit");
  }
  const valueAfterUserEdit = body.value;
  body.value = "external\nupdate";
  body.value = "";

  const trace = hostFfiHarness.normalizedTrace();
  const properties = numericProperties(trace, "n1");
  const textWrites = trace
    .filter(({ op, node }) => op === "setText" && node === "n2")
    .map(({ text }) => text);
  const summary = {
    mounted: root !== null,
    creations: compositeCreations(trace),
    defaults: {
      width: properties.get(host.PropertyId.Width),
      height: properties.get(host.PropertyId.Height),
      padding: properties.get(host.PropertyId.Padding),
      backgroundColor: properties.get(host.PropertyId.BackgroundColor),
    },
    registered: trace.some(
      ({ op, node, textNode, placeholder }) =>
        op === "registerInput" && node === "n1" && textNode === "n2" && placeholder === "Body",
    ),
    listensForChange: trace.some(
      ({ op, node, event }) =>
        op === "addListener" && node === "n1" && event === host.EventId.Change,
    ),
    valueAfterUserEdit,
    changes,
    writesInitialValue: textWrites.includes("first\nsecond"),
    writesUserValue: textWrites.includes("user\nedit"),
    writesExternalValue: textWrites.includes("external\nupdate"),
    clearsControlledValue: textWrites.at(-1) === "",
  };
  if (root !== null) {
    host.remove(root);
  }

  assert.deepEqual(summary, {
    mounted: true,
    creations: [
      { op: "createNode", node: "n1", nodeType: host.NodeType.Scroll },
      { op: "createText", node: "n2", text: "" },
    ],
    defaults: TEXT_AREA_DEFAULTS,
    registered: true,
    listensForChange: true,
    valueAfterUserEdit: "user\nedit",
    changes: ["user\nedit"],
    writesInitialValue: true,
    writesUserValue: true,
    writesExternalValue: true,
    clearsControlledValue: true,
  });
});

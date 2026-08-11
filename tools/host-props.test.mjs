import assert from "node:assert/strict";
import test from "node:test";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

const { diffPropRecord } = await import("../packages/nui-host/src/props-state.ts");
const host = await import("../packages/nui-host/src/index.ts");

test("NexaHostError preserves structured error identity and source chain", () => {
  const cause = {
    domain: "system",
    code: 0x0200_0009,
    name: "PLATFORM_FAILURE",
    severity: "RecoverableOperation",
    operation: "readFile",
    retryable: true,
    message: "disk unavailable",
    runtimeVersion: "0.1.0",
    platformCode: "EIO",
  };
  const detail = {
    domain: "ui",
    code: 0x0100_0009,
    name: "INTERNAL_FAILURE",
    severity: "FatalRuntime",
    operation: "run",
    retryable: false,
    message: "runtime stopped",
    runtimeVersion: "0.1.0",
    context: { owner: 7 },
    cause,
  };

  const error = new host.NexaHostError(detail);

  assert.equal(error.detail, detail);
  assert.equal(error.code, detail.code);
  assert.equal(error.severity, detail.severity);
  assert.deepEqual(error.context, detail.context);
  assert.ok(error.cause instanceof host.NexaHostError);
  assert.equal(error.cause.detail, cause);
});

test("framework callback throws are contained and routed to the observable handler", () => {
  hostFfiHarness.resetTrace();
  host.clearErrorHistory();
  const observed = [];
  host.setErrorHandler((error) => observed.push(error));
  const button = host.createHostElement("view");
  host.applyHostProp(button, "onClick", () => {
    throw new Error("listener failed");
  });

  assert.doesNotThrow(() => hostFfiHarness.dispatchRecorded(host.EventId.Click));

  assert.equal(observed.length, 1);
  assert.ok(observed[0] instanceof host.NexaHostError);
  assert.equal(observed[0].operation, "dispatchEvent");
  assert.equal(observed[0].severity, "RecoverableOperation");
  assert.match(observed[0].message, /listener failed/);
  assert.equal(host.getErrorHistory().length, 1);
  host.setErrorHandler(null);
});

test("onComposition registers EventId 8 and decodes the normalized JSON payload", () => {
  hostFfiHarness.resetTrace();
  const input = host.createHostElement("input");
  const received = [];
  host.applyHostProp(input, "onComposition", (event) => received.push(event));
  const event = {
    kind: "Update",
    text: "A😀B",
    selectionStart: 1,
    selectionEnd: 3,
    context: {
      windowId: 1,
      target: { slot: 0, generation: 1 },
      timestamp: "2",
      modifiers: {
        shift: false,
        control: false,
        alt: false,
        meta: false,
        capsLock: false,
        numLock: false,
      },
      propagation: {
        phase: "Target",
        defaultPrevented: false,
        propagationStopped: false,
        immediatePropagationStopped: false,
      },
    },
  };

  assert.equal(
    hostFfiHarness.dispatchRecorded(host.EventId.Composition, JSON.stringify(event)),
    true,
  );

  assert.deepEqual(received, [event]);
  assert.ok(
    hostFfiHarness
      .normalizedTrace()
      .some(({ op, event }) => op === "addListener" && event === host.EventId.Composition),
  );
});

test("onLifecycle registers EventId 10 and decodes every window lifecycle payload", () => {
  hostFfiHarness.resetTrace();
  const windowNode = host.createHostElement("window");
  const received = [];

  host.applyHostProp(windowNode, "onLifecycle", (event) => received.push(event));

  assert.equal(host.EventId.WindowLifecycle, 10);
  assert.ok(
    hostFfiHarness.normalizedTrace().some(({ op, event }) => op === "addListener" && event === 10),
  );

  const events = [
    { kind: "Ready", surfaceGeneration: 1 },
    { kind: "Suspended" },
    { kind: "Resumed", surfaceGeneration: Number.MAX_SAFE_INTEGER },
    { kind: "CloseRequested" },
  ];
  for (const event of events) {
    assert.equal(hostFfiHarness.dispatchRecorded(10, JSON.stringify(event)), true);
  }

  assert.deepEqual(received, events);
});

test("onLifecycle rejects malformed payloads without invoking the application callback", () => {
  hostFfiHarness.resetTrace();
  host.clearErrorHistory();
  const observed = [];
  const received = [];
  host.setErrorHandler((error) => observed.push(error));

  try {
    const windowNode = host.createHostElement("window");
    host.applyHostProp(windowNode, "onLifecycle", (event) => received.push(event));

    const invalidPayloads = [
      ["invalid JSON", "{"],
      ["null", "null"],
      ["array", "[]"],
      ["missing kind", "{}"],
      ["unknown kind", '{"kind":"ready"}'],
      ["non-string kind", '{"kind":1}'],
      ["extra field", '{"kind":"Ready","unexpected":true}'],
      ["null generation", '{"kind":"Ready","surfaceGeneration":null}'],
      ["zero generation", '{"kind":"Ready","surfaceGeneration":0}'],
      ["negative generation", '{"kind":"Ready","surfaceGeneration":-1}'],
      ["fractional generation", '{"kind":"Ready","surfaceGeneration":1.5}'],
      ["unsafe generation", '{"kind":"Ready","surfaceGeneration":9007199254740992}'],
    ];

    for (const [label, payload] of invalidPayloads) {
      const previousErrorCount = observed.length;
      assert.equal(hostFfiHarness.dispatchRecorded(10, payload), true, label);
      assert.equal(received.length, 0, label);
      assert.equal(observed.length, previousErrorCount + 1, label);
      assert.equal(observed.at(-1).detail.context?.errorName, "TypeError", label);
      assert.match(observed.at(-1).message, /window lifecycle payload/i, label);
    }
  } finally {
    host.setErrorHandler(null);
  }
});

test("host prop diff emits null for a removed top-level property", () => {
  assert.deepEqual(diffPropRecord({ padding: 8, width: 320 }, { width: 320 }), [["padding", null]]);
});

test("host prop diff clears removed style entries and preserves explicit null", () => {
  assert.deepEqual(
    diffPropRecord({ padding: 8, opacity: 0.5, fontWeight: 700 }, { opacity: 1, fontWeight: null }),
    [
      ["padding", null],
      ["opacity", 1],
      ["fontWeight", null],
    ],
  );
});

test("Button disabled encodes boolean values and clears explicit or removed props", () => {
  hostFfiHarness.resetTrace();
  const button = host.createHostElement("button");

  host.applyHostProp(button, "disabled", true);
  host.applyHostProp(button, "disabled", false);
  host.applyHostProp(button, "disabled", null);
  host.applyHostProp(button, "disabled", true);
  host.applyHostProps(button, {});

  assert.deepEqual(
    hostFfiHarness
      .normalizedTrace()
      .filter(
        ({ op, property }) => (op === "setNumber" || op === "clearProperty") && property === 18,
      ),
    [
      { op: "setNumber", node: "n1", property: 18, value: 1 },
      { op: "setNumber", node: "n1", property: 18, value: 0 },
      { op: "clearProperty", node: "n1", property: 18 },
      { op: "setNumber", node: "n1", property: 18, value: 1 },
      { op: "clearProperty", node: "n1", property: 18 },
    ],
  );
});

test("Button defaults provide the native interaction resolver base style", () => {
  hostFfiHarness.resetTrace();

  host.createHostElement("button");

  assert.deepEqual(
    hostFfiHarness
      .normalizedTrace()
      .filter(
        ({ op, property }) =>
          op === "setNumber" &&
          [
            host.PropertyId.Padding,
            host.PropertyId.BackgroundColor,
            host.PropertyId.BorderRadius,
          ].includes(property),
      ),
    [
      { op: "setNumber", node: "n1", property: host.PropertyId.Padding, value: 12 },
      {
        op: "setNumber",
        node: "n1",
        property: host.PropertyId.BorderRadius,
        value: 12,
      },
      {
        op: "setNumber",
        node: "n1",
        property: host.PropertyId.BackgroundColor,
        value: host.rgba(0x1f, 0x6f, 0xeb),
      },
    ],
  );
});

test("Button creation registers semantic identity without installing a click listener", () => {
  hostFfiHarness.resetTrace();

  host.createHostElement("button");
  host.createHostElement("view");

  const trace = hostFfiHarness.normalizedTrace();
  assert.deepEqual(
    trace.filter(({ op }) => op === "registerButton"),
    [{ op: "registerButton", node: "n1" }],
  );
  assert.equal(trace.filter(({ op }) => op === "addListener").length, 0);
});

test("Host props explicitly undo non-numeric values and every numeric mapping", () => {
  hostFfiHarness.resetTrace();
  host.resetWindowTitle();

  const windowNode = host.createHostElement("window");
  host.applyHostProp(windowNode, "title", "Custom title");
  host.applyHostProp(windowNode, "title", null);
  assert.equal(host.getWindowTitle(), "Nexa UI");
  assert.equal("title" in windowNode.hostProps, false);

  const textNode = host.createHostElement("text");
  host.applyHostProp(textNode, "textContent", "content");
  host.applyHostProp(textNode, "textContent", null);
  assert.equal(textNode.text, "");
  assert.equal("textContent" in textNode.hostProps, false);

  const inputNode = host.createHostElement("input");
  host.applyHostProp(inputNode, "placeholder", "Type here");
  host.applyHostProp(inputNode, "value", "draft");
  host.applyHostProp(inputNode, "placeholder", null);
  host.applyHostProp(inputNode, "value", null);
  assert.equal(inputNode.children[0]?.text, "");
  assert.equal("placeholder" in inputNode.hostProps, false);
  assert.equal("value" in inputNode.hostProps, false);

  const imageNode = host.createHostElement("image");
  host.applyHostProp(imageNode, "src", "/tmp/example.png");
  host.applyHostProp(imageNode, "src", null);
  assert.equal("src" in imageNode.hostProps, false);

  const viewNode = host.createHostElement("view");
  host.applyHostProp(viewNode, "flexDirection", 1);
  host.applyHostProp(viewNode, "scrollOffsetY", 24);
  host.applyHostProp(viewNode, "flexDirection", null);
  host.applyHostProp(viewNode, "scrollOffsetY", null);

  const trace = hostFfiHarness.normalizedTrace();
  assert.ok(trace.some(({ op, text }) => op === "setText" && text === ""));
  assert.ok(trace.some(({ op, placeholder }) => op === "registerInput" && placeholder === ""));
  assert.ok(trace.some(({ op, path }) => op === "setImage" && path === ""));
  assert.ok(trace.some(({ op, property }) => op === "setNumber" && property === 7));
  assert.ok(trace.some(({ op, property }) => op === "setNumber" && property === 16));
  assert.ok(trace.some(({ op, property }) => op === "clearProperty" && property === 7));
  assert.ok(trace.some(({ op, property }) => op === "clearProperty" && property === 16));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

import {
  CONTRACT_SCENARIOS,
  createMockAdapter,
  runAdapterConformance,
} from "./adapter-contracts.mjs";

const host = await import("../packages/nui-host/src/index.ts");
const solid = await import("../packages/adapter-solid/src/index.ts");
const vue = await import("../packages/adapter-vue/src/index.ts");
const react = await import("../packages/adapter-react/src/index.ts");
const svelteCompiler = await import("../packages/compiler-svelte/src/compile.ts");
const svelteRuntime = await import("../packages/compiler-svelte/src/runtime/index.ts");
const minimalUi = await import("../packages/ui/src/index.ts");
const minimalMaterialize = await import("../packages/ui/src/mount/materialize.ts");

const EXPECTED_SOLID_VUE_TRACE = [
  { op: "createNode", node: "n1", nodeType: 1 },
  { op: "createText", node: "n2", text: "" },
  { op: "setNumber", node: "n2", property: 15, value: 286795775 },
  { op: "setNumber", node: "n2", property: 13, value: 16 },
  { op: "createText", node: "n3", text: "" },
  { op: "setNumber", node: "n3", property: 15, value: 286795775 },
  { op: "setNumber", node: "n3", property: 13, value: 16 },
  { op: "createText", node: "n4", text: "" },
  { op: "setNumber", node: "n4", property: 15, value: 286795775 },
  { op: "setNumber", node: "n4", property: 13, value: 16 },
  { op: "insert", child: "n2", parent: "n1", before: null },
  { op: "insert", child: "n3", parent: "n1", before: null },
  { op: "insert", child: "n4", parent: "n1", before: null },
  { op: "insert", child: "n4", parent: "n1", before: "n2" },
  { op: "createNode", node: "n5", nodeType: 1 },
  { op: "setNumber", node: "n5", property: 1, value: 320 },
  { op: "setNumber", node: "n5", property: 5, value: 12 },
  { op: "setNumber", node: "n5", property: 6, value: 8 },
  { op: "clearProperty", node: "n5", property: 1 },
  { op: "clearProperty", node: "n5", property: 6 },
  { op: "createNode", node: "n6", nodeType: 1 },
  { op: "setNumber", node: "n6", property: 5, value: 12 },
  { op: "setNumber", node: "n6", property: 11, value: 12 },
  { op: "setNumber", node: "n6", property: 10, value: 527428607 },
  { op: "registerButton", node: "n6" },
  { op: "addListener", node: "n6", event: 1, listener: "l1" },
  { op: "removeListener", listener: "l1" },
  { op: "addListener", node: "n6", event: 1, listener: "l2" },
  { op: "removeListener", listener: "l2" },
  { op: "createNode", node: "n7", nodeType: 1 },
  { op: "createNode", node: "n8", nodeType: 1 },
  { op: "createNode", node: "n9", nodeType: 1 },
  { op: "insert", child: "n8", parent: "n7", before: null },
  { op: "insert", child: "n9", parent: "n7", before: null },
  { op: "remove", node: "n8" },
  { op: "remove", node: "n7" },
  { op: "remove", node: "n7" },
];

function exposeContractProps(node) {
  if (!("props" in node)) {
    Object.defineProperty(node, "props", { get: () => node.hostProps });
  }
  return node;
}

function createSolidConformanceAdapter() {
  const ops = solid.solidHostConfig;
  return {
    createElement: (tag) => exposeContractProps(ops.createElement(tag)),
    insert: (node, parent, anchor) => ops.insertNode(parent, node, anchor),
    setProp(node, name, value) {
      const previous = node.hostProps[name];
      ops.setProperty(node, name, value, previous);
    },
    dispatch: (node, event) => hostFfiHarness.dispatch(node.id, event === "click" ? 1 : event),
    registerCleanup: (node, cleanup) => host.registerNodeCleanup(node.id, cleanup),
    remove: (node) => ops.removeNode(node.parent, node),
  };
}

function createVueConformanceAdapter() {
  const ops = vue.nodeOps;
  return {
    createElement: (tag) => exposeContractProps(ops.createElement(tag)),
    insert: (node, parent, anchor) => ops.insert(node, parent, anchor ?? null),
    setProp(node, name, value) {
      const previous = node.hostProps[name];
      ops.patchProp(node, name, previous, value);
    },
    dispatch: (node, event) => hostFfiHarness.dispatch(node.id, event === "click" ? 1 : event),
    registerCleanup: (node, cleanup) => host.registerNodeCleanup(node.id, cleanup),
    remove: (node) => ops.remove(node),
  };
}

test("reference Host adapter passes every shared conformance scenario", () => {
  const passed = runAdapterConformance("mock", createMockAdapter);
  assert.equal(passed.length, CONTRACT_SCENARIOS.length);
  assert.deepEqual(
    passed,
    CONTRACT_SCENARIOS.map(({ name }) => `mock/${name}`),
  );
});

test("Solid and Vue adapters produce the same Host mutation trace", () => {
  hostFfiHarness.resetTrace();
  const solidPassed = runAdapterConformance("solid", createSolidConformanceAdapter);
  const solidTrace = hostFfiHarness.normalizedTrace();

  hostFfiHarness.resetTrace();
  const vuePassed = runAdapterConformance("vue", createVueConformanceAdapter);
  const vueTrace = hostFfiHarness.normalizedTrace();

  assert.equal(solidPassed.length, CONTRACT_SCENARIOS.length);
  assert.equal(vuePassed.length, CONTRACT_SCENARIOS.length);
  assert.deepEqual(solidTrace, EXPECTED_SOLID_VUE_TRACE);
  assert.deepEqual(vueTrace, solidTrace);
});

function assertAdapterWindowRoot(name, container) {
  const trace = hostFfiHarness.rawTrace();
  const creations = trace.filter(({ op }) => op === "createNode");
  const windowNode = container.children[0];
  const sameNode = (actual, expected) => actual !== undefined && BigInt(actual) === expected;

  assert.ok(windowNode, `${name} must attach its Window to the implicit container`);
  assert.equal(windowNode.tag, "window", `${name} must preserve the Window mirror node`);
  assert.equal(windowNode.parent, container, `${name} must parent Window under the Host root`);
  assert.ok(sameNode(creations[0]?.node, container.id), `${name} must create its Host root first`);
  assert.equal(
    creations[0]?.nodeType,
    host.NodeType.Root,
    `${name} implicit container must own viewport Root semantics`,
  );
  assert.equal(
    creations.filter(({ nodeType }) => nodeType === host.NodeType.Root).length,
    1,
    `${name} must materialize exactly one native Root`,
  );
  assert.equal(
    creations.find(({ node }) => sameNode(node, windowNode.id))?.nodeType,
    host.NodeType.View,
    `${name} Window content must not nest a second native Root`,
  );
  assert.ok(
    trace.some(
      ({ op, node, property, value }) =>
        op === "setNumber" &&
        sameNode(node, container.id) &&
        property === host.PropertyId.AlignItems &&
        value === 3,
    ),
    `${name} viewport Root must stretch Window content across the cross axis`,
  );
  assert.ok(
    trace.some(
      ({ op, node, property, value }) =>
        op === "setNumber" &&
        sameNode(node, windowNode.id) &&
        property === host.PropertyId.FlexGrow &&
        value === 1,
    ),
    `${name} Window content must grow across the viewport main axis`,
  );
  assert.ok(
    trace.some(
      ({ op, child, parent }) =>
        op === "insert" && sameNode(child, windowNode.id) && sameNode(parent, container.id),
    ),
    `${name} mutation trace must attach Window content to the viewport Root`,
  );
}

test("framework adapters materialize one viewport Root around Window content", async (t) => {
  await t.test("React", () => {
    host.resetSession();
    hostFfiHarness.resetTrace();
    const root = react.createRoot();
    root.render(
      react.React.createElement(
        "window",
        { title: "React Root" },
        react.React.createElement("view"),
      ),
    );

    assertAdapterWindowRoot("React", root.container);
    root.unmount();
    host.resetSession();
  });

  await t.test("Solid", () => {
    host.resetSession();
    hostFfiHarness.resetTrace();
    const container = host.createHostRoot();
    solid.render(() => solid.createElement("window"), container);

    assertAdapterWindowRoot("Solid", container);
    host.resetSession();
  });

  await t.test("Vue", () => {
    host.resetSession();
    hostFfiHarness.resetTrace();
    const container = host.createHostRoot();
    vue.render(vue.h("window", { title: "Vue Root" }, [vue.h("view")]), container);

    assertAdapterWindowRoot("Vue", container);
    vue.render(null, container);
    host.resetSession();
  });

  await t.test("Svelte", async () => {
    host.resetSession();
    hostFfiHarness.resetTrace();
    const source = readFileSync(
      new URL("../examples/svelte-counter/Counter.svelte", import.meta.url),
      "utf8",
    );
    const compiled = svelteCompiler.compileToHost(source, { filename: "Counter.svelte" });
    const runtimeUrl = new URL("../packages/compiler-svelte/src/runtime/index.ts", import.meta.url)
      .href;
    const runnable = compiled.replace(
      '"@nexa/compiler-svelte/runtime"',
      JSON.stringify(runtimeUrl),
    );
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(runnable).toString("base64")}`;
    const { default: Counter } = await import(moduleUrl);
    const container = host.createHostRoot();
    const component = new Counter({ target: container });

    assertAdapterWindowRoot("Svelte", container);
    component.$destroy();
    host.resetSession();
  });
});

test("Minimal TSX materializer mounts and releases production effects/listeners", () => {
  hostFfiHarness.resetTrace();
  host.resetWindowTitle();
  const activeBefore = host.activeNodeCount();
  const count = minimalUi.signal(0);
  const calls = [];
  const root = minimalMaterialize.mountNode(
    minimalUi.Window({
      title: "Minimal conformance",
      children: minimalUi.Column({
        children: [
          minimalUi.Text({ children: count }),
          minimalUi.Button({
            onClick: () => calls.push("clicked"),
            children: "Increment",
          }),
        ],
      }),
    }),
  );
  assert.ok(root);
  host.commit();
  assert.equal(host.getWindowTitle(), "Minimal conformance");

  assert.equal(hostFfiHarness.dispatchRecorded(1), true);
  assert.deepEqual(calls, ["clicked"]);
  count.value = 1;
  assert.ok(
    hostFfiHarness.normalizedTrace().some(({ op, text }) => op === "setText" && text === "1"),
  );

  host.remove(root);
  host.commit();
  count.value = 2;
  assert.equal(hostFfiHarness.dispatchRecorded(1), false);
  assert.deepEqual(calls, ["clicked"]);
  assert.equal(host.activeNodeCount(), activeBefore);
});

test("React root mounts, updates, and unmounts through Host lifecycle", () => {
  hostFfiHarness.resetTrace();
  const calls = [];
  const first = () => calls.push("first");
  const second = () => calls.push("second");
  const root = react.createRoot();

  root.render(
    react.React.createElement(
      "view",
      { width: 320, style: { padding: 12, gap: 8 }, onClick: first },
      react.React.createElement("text", { key: "first" }, "First"),
      react.React.createElement("text", { key: "second" }, "Second"),
    ),
  );
  const view = root.container.children[0];
  assert.ok(view);
  let cleanups = 0;
  host.registerNodeCleanup(view.id, () => {
    cleanups += 1;
  });
  hostFfiHarness.dispatch(view.id, 1);

  root.render(
    react.React.createElement(
      "view",
      { style: { padding: 12 }, onClick: second },
      react.React.createElement("text", { key: "second" }, "Second"),
      react.React.createElement("text", { key: "first" }, "First"),
    ),
  );
  hostFfiHarness.dispatch(view.id, 1);
  assert.deepEqual(calls, ["first", "second"]);

  root.unmount();
  root.unmount();
  hostFfiHarness.dispatch(view.id, 1);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(cleanups, 1);
  assert.deepEqual(root.container.children, []);

  const trace = hostFfiHarness.normalizedTrace();
  assert.ok(trace.some(({ op, property }) => op === "clearProperty" && property === 1));
  assert.ok(trace.some(({ op, property }) => op === "clearProperty" && property === 6));
  assert.equal(trace.filter(({ op }) => op === "addListener").length, 2);
  assert.equal(trace.filter(({ op }) => op === "removeListener").length, 1);
  assert.ok(trace.some(({ op }) => op === "remove"));
});

test("React adapter uses a Perry-compatible microtask bridge", () => {
  const source = readFileSync(
    new URL("../packages/adapter-react/src/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /Promise\.resolve\(\)\.then\(fn\)/);
  assert.doesNotMatch(source, /declare function queueMicrotask/);
  assert.doesNotMatch(source, /flushSync\(\(\) => \{\s*handler/);
});

test("React event updates flush through the runtime microtask boundary", async () => {
  host.resetSession();
  hostFfiHarness.resetTrace();
  const phases = [];
  let updateCount;
  function Counter() {
    const [count, setCount] = react.React.useState(0);
    updateCount = () => {
      phases.push("event");
      queueMicrotask(() => phases.push("microtask"));
      setTimeout(() => phases.push("timer"), 0);
      setCount((value) => value + 1);
    };
    return react.React.createElement(
      "button",
      { onClick: updateCount },
      react.React.createElement("text", null, `Count: ${count}`),
    );
  }

  const root = react.createRoot();
  root.render(react.React.createElement(Counter));
  const button = root.container.children[0];
  const text = button?.children[0]?.children[0];
  assert.ok(button);
  assert.ok(text);
  assert.equal(text.text, "Count: 0");

  hostFfiHarness.dispatch(button.id, 1);
  assert.equal(text.text, "Count: 0");
  assert.deepEqual(phases, ["event"]);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(phases, ["event", "microtask"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(phases, ["event", "microtask", "timer"]);
  assert.equal(text.text, "Count: 1");

  root.unmount();
  host.resetSession();
});

test("real Svelte compiler fixture executes against Host runtime", async () => {
  hostFfiHarness.resetTrace();
  host.resetWindowTitle();
  const fixtureUrl = new URL("../examples/svelte-counter/Counter.svelte", import.meta.url);
  const source = readFileSync(fixtureUrl, "utf8");
  const compiled = svelteCompiler.compileToHost(source, { filename: "Counter.svelte" });
  assert.doesNotMatch(compiled, /svelte\/internal/);

  const runtimeUrl = new URL("../packages/compiler-svelte/src/runtime/index.ts", import.meta.url)
    .href;
  const runnable = compiled.replace('"@nexa/compiler-svelte/runtime"', JSON.stringify(runtimeUrl));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(runnable).toString("base64")}`;
  const { default: Counter } = await import(moduleUrl);
  const target = host.createHostRoot();
  const component = new Counter({ target });
  const windowNode = target.children[0];
  const column = windowNode?.children[0];
  const button = column?.children.find((node) => node.tag === "button");
  assert.ok(windowNode);
  assert.ok(column);
  assert.ok(button);
  assert.equal(host.getWindowTitle(), "Nexa UI — Svelte Counter");

  hostFfiHarness.dispatch(button.id, 1);
  const textValues = column.children.flatMap((node) => node.children.map((child) => child.text));
  assert.ok(textValues.includes("1"));
  assert.ok(
    column.children.some((node) => node.children.some((child) => child.text.includes("Clicked"))),
  );

  component.$destroy();
  component.$destroy();
  assert.deepEqual(target.children, []);
  const trace = hostFfiHarness.normalizedTrace();
  assert.ok(trace.some(({ op }) => op === "setText"));
  assert.ok(trace.some(({ op }) => op === "removeListener"));
  assert.ok(trace.some(({ op }) => op === "remove"));
});

test("Svelte set_text replaces the complete dynamic value", () => {
  host.resetSession();
  hostFfiHarness.resetTrace();
  const root = host.createHostRoot();
  const text = host.createHostElement("text");
  const leaf = host.createHostText(" ");
  host.insertBefore(root, text);
  host.insertBefore(text, leaf);

  svelteRuntime.set_text(leaf, "Value: first: second");
  assert.equal(text.children.map((child) => child.text).join(""), "Value: first: second");
  svelteRuntime.set_text(leaf, "Value: next");
  assert.equal(text.children.map((child) => child.text).join(""), "Value: next");
  svelteRuntime.set_text(leaf, "Standalone");
  assert.equal(text.children.map((child) => child.text).join(""), "Standalone");

  host.resetSession();
});

test("resetSession clears native and TypeScript ownership before id reuse", () => {
  hostFfiHarness.resetTrace();
  host.resetSession();
  const root = host.createHostRoot();
  const button = host.createHostElement("button");
  host.insertBefore(root, button);
  let callbacks = 0;
  let cleanups = 0;
  host.applyHostProp(button, "onClick", () => {
    callbacks += 1;
  });
  host.registerNodeCleanup(button.id, () => {
    cleanups += 1;
  });
  host.setWindowTitle("First session");
  host.commit();
  hostFfiHarness.dispatch(button.id, 1);
  assert.equal(callbacks, 1);

  host.resetSession();

  assert.equal(cleanups, 1);
  assert.equal(host.activeNodeCount(), 0);
  assert.equal(host.getWindowTitle(), "Nexa UI");
  hostFfiHarness.dispatch(button.id, 1);
  assert.equal(callbacks, 1);
  const reusedRoot = host.createHostRoot();
  assert.equal(Number(reusedRoot.id % 0x1_0000_0000n), Number(root.id % 0x1_0000_0000n));
  assert.notEqual(reusedRoot.id, root.id);
  host.registerNodeCleanup(reusedRoot.id, () => {
    cleanups += 1;
  });
  assert.equal(host.activeNodeCount(), 1);
  host.resetSession();
  assert.equal(cleanups, 2);
});

test("default framework entry points reset the session before creating nodes", () => {
  const entries = [
    [
      "Minimal",
      () => minimalUi.mount(minimalUi.Window({ children: minimalUi.Text({ children: "M" }) })),
    ],
    ["React", () => react.render(react.React.createElement("view", null, "R"))],
    ["Solid", () => solid.render(() => solid.createElement("view"))],
    ["Vue", () => vue.createApp({ render: () => vue.h("view") }).mount()],
    ["Svelte", () => svelteRuntime.createRoot()],
  ];

  for (const [name, start] of entries) {
    host.resetSession();
    hostFfiHarness.resetTrace();
    start();
    const trace = hostFfiHarness.normalizedTrace();
    assert.equal(trace[0]?.op, "resetSession", name);
    assert.equal(trace.filter(({ op }) => op === "resetSession").length, 1, name);
  }
  host.resetSession();
});

test("React createRoot owns only its implicit Host container", () => {
  host.resetSession();
  hostFfiHarness.resetTrace();
  react.createRoot();
  assert.equal(
    hostFfiHarness.normalizedTrace().filter(({ op }) => op === "resetSession").length,
    1,
  );

  host.resetSession();
  const container = host.createHostRoot();
  hostFfiHarness.resetTrace();
  const root = react.createRoot(container);
  root.render(react.React.createElement("view", null, "external"));
  assert.equal(
    hostFfiHarness.normalizedTrace().filter(({ op }) => op === "resetSession").length,
    0,
  );
  root.unmount();
  host.resetSession();
});

test("Solid preserves an explicitly supplied Host container", () => {
  host.resetSession();
  const container = host.createHostRoot();
  hostFfiHarness.resetTrace();
  solid.render(() => solid.createElement("view"), container);
  assert.equal(
    hostFfiHarness.normalizedTrace().filter(({ op }) => op === "resetSession").length,
    0,
  );
  host.resetSession();
});

test("Minimal remount restores the default title", () => {
  hostFfiHarness.resetTrace();
  minimalUi.mount(
    minimalUi.Window({ title: "First title", children: minimalUi.Text({ children: "one" }) }),
  );
  minimalUi.mount(minimalUi.Window({ children: minimalUi.Text({ children: "two" }) }));

  assert.deepEqual(
    hostFfiHarness
      .normalizedTrace()
      .filter(({ op }) => op === "run")
      .map(({ title }) => title),
    ["First title", "Nexa UI"],
  );
  host.resetSession();
});

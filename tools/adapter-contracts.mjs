import assert from "node:assert/strict";

/**
 * The smallest adapter surface needed by the shared Host contract tests.
 * Framework-specific renderers can wrap their nodeOps/renderer into this
 * shape without duplicating the scenarios below.
 */
export const CONTRACT_SCENARIOS = [
  {
    name: "create-insert-move-reorder",
    run(adapter) {
      const root = adapter.createElement("view");
      const first = adapter.createElement("text");
      const second = adapter.createElement("text");
      const third = adapter.createElement("text");
      adapter.insert(first, root);
      adapter.insert(second, root);
      adapter.insert(third, root);
      adapter.insert(third, root, first);
      assert.deepEqual(root.children, [third, first, second]);
      assert.equal(third.parent, root);
    },
  },
  {
    name: "clear-property",
    run(adapter) {
      const node = adapter.createElement("view");
      adapter.setProp(node, "width", 320);
      adapter.setProp(node, "style", { padding: 12, gap: 8 });
      adapter.setProp(node, "width", null);
      adapter.setProp(node, "style", { padding: 12 });
      assert.equal("width" in node.props, false);
      assert.deepEqual(node.props.style, { padding: 12 });
    },
  },
  {
    name: "listener-replace-remove",
    run(adapter) {
      const node = adapter.createElement("button");
      let calls = [];
      const first = () => calls.push("first");
      const second = () => calls.push("second");
      adapter.setProp(node, "onClick", first);
      adapter.setProp(node, "onClick", second);
      adapter.dispatch(node, "click");
      assert.deepEqual(calls, ["second"]);
      adapter.setProp(node, "onClick", null);
      adapter.dispatch(node, "click");
      assert.deepEqual(calls, ["second"]);
    },
  },
  {
    name: "subtree-dispose-locality",
    run(adapter) {
      const root = adapter.createElement("view");
      const child = adapter.createElement("view");
      const sibling = adapter.createElement("view");
      adapter.insert(child, root);
      adapter.insert(sibling, root);
      let cleanups = 0;
      adapter.registerCleanup(child, () => {
        cleanups += 1;
      });
      adapter.registerCleanup(sibling, () => {
        cleanups += 1;
      });
      adapter.remove(child);
      assert.equal(cleanups, 1);
      adapter.remove(root);
      assert.equal(cleanups, 2);
      adapter.remove(root);
      assert.equal(cleanups, 2);
    },
  },
];

export function runAdapterConformance(adapterName, adapter) {
  for (const scenario of CONTRACT_SCENARIOS) {
    try {
      scenario.run(adapter());
    } catch (error) {
      throw new Error(`${adapterName}/${scenario.name}: ${String(error)}`, { cause: error });
    }
  }
  return CONTRACT_SCENARIOS.map(({ name }) => `${adapterName}/${name}`);
}

/** A deterministic in-memory Host adapter used as the reference contract. */
export function createMockAdapter() {
  let nextId = 1;
  const makeNode = (tag) => ({
    id: nextId++,
    tag,
    parent: null,
    children: [],
    props: Object.create(null),
    listeners: Object.create(null),
    cleanups: new Set(),
    disposed: false,
  });

  function createElement(tag) {
    return makeNode(tag);
  }

  function detach(node) {
    if (!node.parent) return;
    node.parent.children = node.parent.children.filter((child) => child !== node);
    node.parent = null;
  }

  function insert(node, parent, anchor = null) {
    detach(node);
    node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, node);
    else parent.children.push(node);
  }

  function setProp(node, name, value) {
    if (value == null) {
      delete node.props[name];
      if (name.startsWith("on")) delete node.listeners[name];
      return;
    }
    node.props[name] = value;
    if (name.startsWith("on") && typeof value === "function") {
      node.listeners[name] = value;
    }
  }

  function dispatch(node, event) {
    node.listeners[`on${event[0].toUpperCase()}${event.slice(1)}`]?.();
  }

  function registerCleanup(node, cleanup) {
    if (node.disposed) {
      cleanup();
      return;
    }
    node.cleanups.add(cleanup);
  }

  function remove(node) {
    if (node.disposed) return;
    node.disposed = true;
    while (node.children.length > 0) remove(node.children[0]);
    while (node.cleanups.size > 0) {
      const cleanup = node.cleanups.values().next().value;
      node.cleanups.delete(cleanup);
      cleanup();
    }
    node.listeners = Object.create(null);
    node.props = Object.create(null);
    detach(node);
  }

  return {
    createElement,
    createText: (text) => {
      const node = makeNode("#text");
      node.text = String(text ?? "");
      return node;
    },
    insert,
    setProp,
    dispatch,
    registerCleanup,
    remove,
  };
}

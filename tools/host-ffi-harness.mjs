const U32_RANGE = 0x1_0000_0000;

let nextNodeSlot = 0;
let nodeGeneration = 1;
let nextListenerSlot = 0;
let nextSequence = 0;
let trace = [];
const listenersByKey = new Map();
const listenerKeysByToken = new Map();
const childrenByNode = new Map();
const textByNode = new Map();
const inputTextNodeByContainer = new Map();
const inputSelectionByContainer = new Map();
const inputRevisionByContainer = new Map();
const compositionByContainer = new Map();
const semanticsByNode = new Map();
let focusedSemanticNode = null;

function packedHandle(slot, generation = 1) {
  return generation * U32_RANGE + slot;
}

function handleToken(slot, generation = 1) {
  return `h1/${slot.toString(16).padStart(8, "0")}/${generation.toString(16).padStart(8, "0")}`;
}

function record(entry) {
  trace.push(entry);
}

function ok(value) {
  return JSON.stringify({ ok: true, value });
}

function createNode(nodeType, text) {
  const node = packedHandle(nextNodeSlot++, nodeGeneration);
  if (text !== undefined) textByNode.set(node, String(text));
  record(
    text === undefined ? { op: "createNode", node, nodeType } : { op: "createText", node, text },
  );
  return node;
}

globalThis.js_nui_create_node = (nodeType) => createNode(nodeType);
globalThis.js_nui_create_text = (text) => createNode(undefined, String(text));
globalThis.js_nui_insert = (child, parent, before) => {
  const previousChildren = childrenByNode.get(parent) ?? new Set();
  previousChildren.add(child);
  childrenByNode.set(parent, previousChildren);
  record({ op: "insert", child, parent, before: before === 0 ? null : before });
};
globalThis.js_nui_remove = (node) => {
  record({ op: "remove", node });
  const removed = new Set();
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || removed.has(current)) continue;
    removed.add(current);
    for (const child of childrenByNode.get(current) ?? []) pending.push(child);
    childrenByNode.delete(current);
    textByNode.delete(current);
    inputTextNodeByContainer.delete(current);
    inputSelectionByContainer.delete(current);
    inputRevisionByContainer.delete(current);
    compositionByContainer.delete(current);
    semanticsByNode.delete(current);
    if (focusedSemanticNode === current) focusedSemanticNode = null;
    for (const [container, textNode] of inputTextNodeByContainer) {
      if (textNode !== current) continue;
      inputTextNodeByContainer.delete(container);
      inputSelectionByContainer.delete(container);
      inputRevisionByContainer.delete(container);
      compositionByContainer.delete(container);
    }
    for (const key of listenersByKey.keys()) {
      if (key.startsWith(`${current}:`)) listenersByKey.delete(key);
    }
  }
};
globalThis.js_nui_set_text = (node, text) => {
  const value = String(text);
  textByNode.set(node, value);
  for (const [container, textNode] of inputTextNodeByContainer) {
    if (textNode !== node) continue;
    inputSelectionByContainer.set(container, value.length);
    inputRevisionByContainer.set(container, 0);
  }
  record({ op: "setText", node, text: value });
};
globalThis.js_nui_set_number = (node, property, value) =>
  record({ op: "setNumber", node, property, value });
globalThis.js_nui_add_click_listener = (node, callback) => {
  listenersByKey.set(`${node}:1`, callback);
  record({ op: "addLegacyListener", node, event: 1 });
};
globalThis.js_nui_register_input = (node, textNode, placeholder) => {
  inputTextNodeByContainer.set(node, textNode);
  inputSelectionByContainer.set(node, (textByNode.get(textNode) ?? "").length);
  inputRevisionByContainer.set(node, 0);
  record({ op: "registerInput", node, textNode, placeholder });
};
globalThis.js_nui_add_change_listener = (node, callback) => {
  listenersByKey.set(`${node}:2`, callback);
  record({ op: "addLegacyListener", node, event: 2 });
};
globalThis.js_nui_add_submit_listener = (node, callback) => {
  listenersByKey.set(`${node}:3`, callback);
  record({ op: "addLegacyListener", node, event: 3 });
};
globalThis.js_nui_set_image = (node, path) => record({ op: "setImage", node, path });
globalThis.js_nui_commit = () => record({ op: "commit" });
function clearNativeSessionState() {
  nextNodeSlot = 0;
  nodeGeneration += 1;
  nextSequence = 0;
  listenersByKey.clear();
  listenerKeysByToken.clear();
  childrenByNode.clear();
  textByNode.clear();
  inputTextNodeByContainer.clear();
  inputSelectionByContainer.clear();
  inputRevisionByContainer.clear();
  compositionByContainer.clear();
  semanticsByNode.clear();
  focusedSemanticNode = null;
}

globalThis.js_nui_run = (title) => {
  record({ op: "run", title });
  clearNativeSessionState();
};
globalThis.js_nui_handshake_v1 = () => ok(null);
globalThis.js_nui_create_node_v1 = (nodeType) => {
  const node = createNode(nodeType);
  const slot = node % U32_RANGE;
  return ok(handleToken(slot, nodeGeneration));
};
globalThis.js_nui_clear_property_v1 = (slot, generation, property) => {
  record({ op: "clearProperty", node: packedHandle(slot, generation), property });
  return ok(null);
};
globalThis.js_nui_set_semantics_v1 = (slot, generation, semanticsJson) => {
  const node = packedHandle(slot, generation);
  const semantics = JSON.parse(semanticsJson);
  semanticsByNode.set(node, semantics);
  record({
    op: "setSemantics",
    node,
    semantics,
  });
  return ok(null);
};
globalThis.js_nui_clear_semantics_v1 = (slot, generation) => {
  const node = packedHandle(slot, generation);
  semanticsByNode.delete(node);
  record({ op: "clearSemantics", node });
  return ok(null);
};
globalThis.js_nui_register_button_v1 = (slot, generation) => {
  record({ op: "registerButton", node: packedHandle(slot, generation) });
  return ok(null);
};
globalThis.js_nui_add_event_listener_v1 = (slot, generation, event, callback) => {
  const node = packedHandle(slot, generation);
  const listenerSlot = nextListenerSlot++;
  const listener = handleToken(listenerSlot);
  const key = `${node}:${event}`;
  const replaced = listenersByKey.get(key);
  if (replaced !== undefined) listenersByKey.delete(key);
  listenersByKey.set(key, callback);
  listenerKeysByToken.set(listener, key);
  record({ op: "addListener", node, event, listener });
  return ok(listener);
};
globalThis.js_nui_remove_event_listener_v1 = (slot, generation) => {
  const listener = handleToken(slot, generation);
  const key = listenerKeysByToken.get(listener);
  if (key !== undefined) {
    listenersByKey.delete(key);
    listenerKeysByToken.delete(listener);
  }
  record({ op: "removeListener", listener });
  return ok(null);
};
globalThis.js_nui_commit_v1 = () => {
  nextSequence += 1;
  record({ op: "commitV1", sequence: nextSequence });
  return ok({ sequence: nextSequence, dirtyFlags: 1 });
};
globalThis.js_nui_run_v1 = (title) => {
  record({ op: "run", title });
  clearNativeSessionState();
  return ok(null);
};
globalThis.js_nui_reset_session_v1 = () => {
  record({ op: "resetSession" });
  clearNativeSessionState();
  return ok(null);
};
globalThis.js_nui_get_text_input_state_v1 = (slot, generation) => {
  const node = packedHandle(slot, generation);
  const textNode = inputTextNodeByContainer.get(node);
  const text = textNode === undefined ? "" : (textByNode.get(textNode) ?? "");
  const selection = inputSelectionByContainer.get(node) ?? text.length;
  record({ op: "getTextInputState", node });
  return ok({
    text,
    surroundingText: { start: 0, end: text.length },
    selection: { anchor: selection, focus: selection },
    composition: null,
    compositionBounds: { x: 0, y: 0, width: 1, height: 16 },
    revision: String(inputRevisionByContainer.get(node) ?? 0),
  });
};
globalThis.js_nui_replace_text_input_v1 = (slot, generation, rangeStart, rangeEnd, replacement) => {
  const node = packedHandle(slot, generation);
  const textNode = inputTextNodeByContainer.get(node);
  const text = textNode === undefined ? "" : (textByNode.get(textNode) ?? "");
  const value = String(replacement);
  if (textNode !== undefined) {
    textByNode.set(textNode, `${text.slice(0, rangeStart)}${value}${text.slice(rangeEnd)}`);
  }
  inputSelectionByContainer.set(node, rangeStart + value.length);
  inputRevisionByContainer.set(node, (inputRevisionByContainer.get(node) ?? 0) + 1);
  record({ op: "replaceTextInput", node, rangeStart, rangeEnd, text: value });
  return ok(null);
};
globalThis.js_nui_get_composition_bounds_v1 = (slot, generation) => {
  const node = packedHandle(slot, generation);
  record({ op: "getCompositionBounds", node });
  return ok({ x: 0, y: 0, width: 1, height: 16 });
};

function normalizeTrace(entries) {
  const nodes = new Map();
  const listenerTokens = new Map();
  const nodeKeys = ["node", "child", "parent", "before", "textNode"];
  const normalizeNode = (value) => {
    if (value === null || value === undefined) return value;
    if (!nodes.has(value)) nodes.set(value, `n${nodes.size + 1}`);
    return nodes.get(value);
  };
  const normalizeListener = (value) => {
    if (!listenerTokens.has(value)) listenerTokens.set(value, `l${listenerTokens.size + 1}`);
    return listenerTokens.get(value);
  };
  return entries.map((entry) => {
    const normalized = { ...entry };
    for (const key of nodeKeys) {
      if (key in normalized) normalized[key] = normalizeNode(normalized[key]);
    }
    if ("listener" in normalized) normalized.listener = normalizeListener(normalized.listener);
    return normalized;
  });
}

export const hostFfiHarness = {
  resetTrace() {
    trace = [];
    listenersByKey.clear();
    listenerKeysByToken.clear();
    childrenByNode.clear();
    textByNode.clear();
    inputTextNodeByContainer.clear();
    inputSelectionByContainer.clear();
    inputRevisionByContainer.clear();
    compositionByContainer.clear();
    semanticsByNode.clear();
    focusedSemanticNode = null;
  },
  normalizedTrace() {
    return normalizeTrace(trace);
  },
  rawTrace() {
    return trace.map((entry) => ({ ...entry }));
  },
  dispatch(node, event, value = "") {
    listenersByKey.get(`${Number(node)}:${event}`)?.(value);
  },
  dispatchRecorded(event, value = "") {
    const listener = trace.find((entry) => entry.op === "addListener" && entry.event === event);
    if (!listener) return false;
    this.dispatch(listener.node, event, value);
    return listenersByKey.has(`${Number(listener.node)}:${event}`);
  },
  dispatchSemanticAction(node, action, value) {
    const target = Number(node);
    const semantics = semanticsByNode.get(target);
    if (
      semantics === undefined ||
      semantics.disabled === true ||
      !Array.isArray(semantics.actions) ||
      !semantics.actions.includes(action)
    ) {
      return false;
    }

    if (action === "Focus") {
      if (!inputTextNodeByContainer.has(target)) return false;
      focusedSemanticNode = target;
      record({ op: "dispatchSemanticAction", node: target, action });
      return true;
    }

    if (action === "SetValue") {
      const textNode = inputTextNodeByContainer.get(target);
      if (textNode === undefined || typeof value !== "string") return false;
      textByNode.set(textNode, value);
      inputSelectionByContainer.set(target, value.length);
      inputRevisionByContainer.set(target, (inputRevisionByContainer.get(target) ?? 0) + 1);
      compositionByContainer.delete(target);
      record({ op: "dispatchSemanticAction", node: target, action, value });
      listenersByKey.get(`${target}:2`)?.(value);
      return true;
    }

    if (action === "Invoke") {
      const listener = listenersByKey.get(`${target}:1`);
      if (listener === undefined) return false;
      record({ op: "dispatchSemanticAction", node: target, action });
      listener("");
      return true;
    }

    return false;
  },
  beginComposition(node) {
    const target = Number(node);
    const textNode = inputTextNodeByContainer.get(target);
    if (textNode === undefined || compositionByContainer.has(target)) return false;
    const text = textByNode.get(textNode) ?? "";
    const selection = inputSelectionByContainer.get(target) ?? text.length;
    compositionByContainer.set(target, {
      rangeStart: selection,
      rangeEnd: selection,
      preedit: "",
    });
    record({ op: "compositionStart", node: target, rangeStart: selection, rangeEnd: selection });
    return true;
  },
  updateComposition(node, preedit) {
    const target = Number(node);
    const composition = compositionByContainer.get(target);
    if (composition === undefined || typeof preedit !== "string") return false;
    composition.preedit = preedit;
    record({ op: "compositionUpdate", node: target, preedit });
    return true;
  },
  commitComposition(node, committedText) {
    const target = Number(node);
    const composition = compositionByContainer.get(target);
    const textNode = inputTextNodeByContainer.get(target);
    if (composition === undefined || textNode === undefined) return false;
    if (committedText !== undefined && typeof committedText !== "string") return false;
    const replacement = committedText ?? composition.preedit;
    const text = textByNode.get(textNode) ?? "";
    const next = `${text.slice(0, composition.rangeStart)}${replacement}${text.slice(composition.rangeEnd)}`;
    textByNode.set(textNode, next);
    inputSelectionByContainer.set(target, composition.rangeStart + replacement.length);
    inputRevisionByContainer.set(target, (inputRevisionByContainer.get(target) ?? 0) + 1);
    compositionByContainer.delete(target);
    record({
      op: "compositionCommit",
      node: target,
      text: replacement,
      value: next,
    });
    listenersByKey.get(`${target}:2`)?.(next);
    return true;
  },
  cancelComposition(node) {
    const target = Number(node);
    if (!compositionByContainer.delete(target)) return false;
    record({ op: "compositionCancel", node: target });
    return true;
  },
  textInputDisplayValue(node) {
    const target = Number(node);
    const textNode = inputTextNodeByContainer.get(target);
    if (textNode === undefined) return null;
    const text = textByNode.get(textNode) ?? "";
    const composition = compositionByContainer.get(target);
    if (composition === undefined) return text;
    return `${text.slice(0, composition.rangeStart)}${composition.preedit}${text.slice(composition.rangeEnd)}`;
  },
  focusedSemanticNode() {
    return focusedSemanticNode;
  },
};

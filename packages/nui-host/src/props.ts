import { EventId, PropertyId, registerInput, setImage, setNumber, setText } from "./ffi";
import type { NuiNode } from "./types";
import { handleRefFromLegacyPacked } from "./handle";
import { addEventListenerV1, clearPropertyV1, removeEventListenerV1 } from "./protocol";
import type { Common } from "@nexa/protocol";
import { diffPropRecord, type HostPropRecord } from "./props-state";
import { setWindowTitle } from "./title";

export { applyElementDefaults } from "./defaults";

function propertyForName(name: string): PropertyId | null {
  switch (name) {
    case "width":
      return PropertyId.Width;
    case "height":
      return PropertyId.Height;
    case "minWidth":
      return PropertyId.MinWidth;
    case "minHeight":
      return PropertyId.MinHeight;
    case "padding":
      return PropertyId.Padding;
    case "gap":
      return PropertyId.Gap;
    case "fontSize":
      return PropertyId.FontSize;
    case "fontWeight":
      return PropertyId.FontWeight;
    case "opacity":
      return PropertyId.Opacity;
    case "borderRadius":
      return PropertyId.BorderRadius;
    case "color":
      return PropertyId.TextColor;
    case "backgroundColor":
      return PropertyId.BackgroundColor;
    case "flexGrow":
      return PropertyId.FlexGrow;
    case "alignItems":
      return PropertyId.AlignItems;
    case "justifyContent":
      return PropertyId.JustifyContent;
    default:
      return null;
  }
}

export function applyNumericProp(node: NuiNode, name: string, value: unknown): boolean {
  if (typeof value !== "number") return false;
  const property = propertyForName(name);
  if (property === null) return false;
  setNumber(node.id, property, value);
  return true;
}

export function clearNumericProp(node: NuiNode, name: string): void {
  const property = propertyForName(name);
  if (property !== null) {
    const result = clearPropertyV1(handleRefFromLegacyPacked(node.id), property);
    if (!result.ok) {
      throw new Error(`${result.error.name}: ${result.error.message}`);
    }
  }
}

function asPropRecord(value: unknown): HostPropRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as HostPropRecord)
    : {};
}

function inputTextChild(node: NuiNode): NuiNode | null {
  return node.children.find((c) => c.isText) ?? null;
}

function eventForName(name: string): EventId | null {
  switch (name.toLowerCase()) {
    case "onclick":
      return EventId.Click;
    case "onchange":
    case "oninput":
      return EventId.Change;
    case "onsubmit":
      return EventId.Submit;
    default:
      return null;
  }
}

function removeListener(node: NuiNode, event: EventId): void {
  const handle = node.hostListeners[event];
  if (handle === undefined) return;
  const result = removeEventListenerV1(handle);
  if (!result.ok) {
    throw new Error(`${result.error.name}: ${result.error.message}`);
  }
  delete node.hostListeners[event];
}

function setListener(node: NuiNode, event: EventId, callback: unknown): void {
  removeListener(node, event);
  const result = addEventListenerV1(nodeIdToHandle(node.id), event, callback);
  if (!result.ok) {
    throw new Error(`${result.error.name}: ${result.error.message}`);
  }
  node.hostListeners[event] = result.value;
}

function nodeIdToHandle(id: bigint): Common.HandleRef {
  return handleRefFromLegacyPacked(id);
}

/**
 * Apply a single framework prop onto a Host mirror node.
 * Handles title / style / click / input / numeric / text content.
 */
export function applyHostProp(node: NuiNode, name: string, value: unknown): void {
  if (name === "children" || name === "ref") {
    return;
  }

  const previous = node.hostProps[name];

  if (name === "style") {
    const nextStyle = asPropRecord(value);
    for (const [styleName, styleValue] of diffPropRecord(asPropRecord(previous), nextStyle)) {
      if (styleValue == null) clearNumericProp(node, styleName);
      else applyNumericProp(node, styleName, styleValue);
    }
    if (value == null) delete node.hostProps[name];
    else node.hostProps[name] = { ...nextStyle };
    return;
  }

  if (name === "title" && typeof value === "string") {
    setWindowTitle(value);
    node.hostProps[name] = value;
    return;
  }

  const event = eventForName(name);
  if (event !== null) {
    if (typeof value === "function") {
      setListener(node, event, value);
      node.hostProps[name] = value;
    } else {
      removeListener(node, event);
      delete node.hostProps[name];
    }
    return;
  }

  if (value == null) {
    clearNumericProp(node, name);
    delete node.hostProps[name];
    return;
  }

  if (node.tag === "image") {
    if (name === "src" && typeof value === "string") {
      setImage(node.id, value);
      node.hostProps[name] = value;
      return;
    }
  }

  if (node.tag === "input") {
    if (name === "placeholder" && typeof value === "string") {
      const text = inputTextChild(node);
      if (text) {
        registerInput(node.id, text.id, value);
      }
      node.hostProps[name] = value;
      return;
    }
    if (name === "value" && (typeof value === "string" || typeof value === "number")) {
      const text = inputTextChild(node);
      if (text) {
        text.text = String(value);
        setText(text.id, text.text);
      }
      node.hostProps[name] = value;
      return;
    }
  }

  const applied = applyNumericProp(node, name, value);

  if (node.isText && (name === "textContent" || name === "text")) {
    node.text = String(value ?? "");
    setText(node.id, node.text);
  }
  if (applied || (node.isText && (name === "textContent" || name === "text"))) {
    node.hostProps[name] = value;
  }
}

export function applyHostProps(node: NuiNode, props: Record<string, unknown>): void {
  for (const [key, value] of diffPropRecord(node.hostProps, props)) {
    applyHostProp(node, key, value);
  }
}

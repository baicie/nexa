import {
  addClickListener,
  PropertyId,
  setNumber,
  setText,
} from "./ffi";
import type { NuiNode } from "./types";
import { setWindowTitle } from "./title";

export { applyElementDefaults } from "./defaults";

export function applyNumericProp(node: NuiNode, name: string, value: unknown): void {
  if (typeof value !== "number") {
    return;
  }
  switch (name) {
    case "width":
      setNumber(node.id, PropertyId.Width, value);
      break;
    case "height":
      setNumber(node.id, PropertyId.Height, value);
      break;
    case "padding":
      setNumber(node.id, PropertyId.Padding, value);
      break;
    case "gap":
      setNumber(node.id, PropertyId.Gap, value);
      break;
    case "fontSize":
      setNumber(node.id, PropertyId.FontSize, value);
      break;
    case "borderRadius":
      setNumber(node.id, PropertyId.BorderRadius, value);
      break;
    case "color":
      setNumber(node.id, PropertyId.TextColor, value);
      break;
    case "backgroundColor":
      setNumber(node.id, PropertyId.BackgroundColor, value);
      break;
    default:
      break;
  }
}

/**
 * Apply a single framework prop onto a Host mirror node.
 * Handles title / style / click / numeric / text content.
 */
export function applyHostProp(node: NuiNode, name: string, value: unknown): void {
  if (name === "children" || name === "ref") {
    return;
  }

  if (name === "title" && typeof value === "string") {
    setWindowTitle(value);
    return;
  }

  if (name === "style" && value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      applyNumericProp(node, k, v);
    }
    return;
  }

  const lower = name.toLowerCase();
  if (
    (lower === "onclick" || name === "onClick") &&
    typeof value === "function"
  ) {
    addClickListener(node.id, value as () => void);
    return;
  }

  if (name.startsWith("on") && typeof value === "function") {
    if (lower === "onclick") {
      addClickListener(node.id, value as () => void);
    }
    return;
  }

  applyNumericProp(node, name, value);

  if (node.isText && (name === "textContent" || name === "text")) {
    node.text = String(value ?? "");
    setText(node.id, node.text);
  }
}

export function applyHostProps(
  node: NuiNode,
  props: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(props)) {
    if (value == null && key !== "children") {
      continue;
    }
    applyHostProp(node, key, value);
  }
}

import {
  addChangeListener,
  addClickListener,
  addSubmitListener,
  PropertyId,
  registerInput,
  setImage,
  setNumber,
  setText,
} from "./ffi";
import type { NuiNode } from "./types";
import { clearPropertyV1 } from "./protocol";
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

export function applyNumericProp(node: NuiNode, name: string, value: unknown): void {
  if (typeof value !== "number") return;
  const property = propertyForName(name);
  if (property !== null) setNumber(node.id, property, value);
}

export function clearNumericProp(node: NuiNode, name: string): void {
  const property = propertyForName(name);
  if (property !== null) {
    clearPropertyV1(node.id, property);
  }
}

function inputTextChild(node: NuiNode): NuiNode | null {
  return node.children.find((c) => c.isText) ?? null;
}

/**
 * Apply a single framework prop onto a Host mirror node.
 * Handles title / style / click / input / numeric / text content.
 */
export function applyHostProp(node: NuiNode, name: string, value: unknown): void {
  if (name === "children" || name === "ref") {
    return;
  }

  if (value == null) {
    clearNumericProp(node, name);
    return;
  }

  if (name === "title" && typeof value === "string") {
    setWindowTitle(value);
    return;
  }

  if (name === "style" && value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      applyHostProp(node, k, v);
    }
    return;
  }

  const lower = name.toLowerCase();
  if ((lower === "onclick" || name === "onClick") && typeof value === "function") {
    addClickListener(node.id, value as () => void);
    return;
  }

  if (
    (lower === "onchange" || name === "onChange" || name === "onInput") &&
    typeof value === "function"
  ) {
    addChangeListener(node.id, value as (v: string) => void);
    return;
  }

  if ((lower === "onsubmit" || name === "onSubmit") && typeof value === "function") {
    addSubmitListener(node.id, value as (v: string) => void);
    return;
  }

  if (name.startsWith("on") && typeof value === "function") {
    if (lower === "onclick") {
      addClickListener(node.id, value as () => void);
    }
    return;
  }

  if (node.tag === "image") {
    if (name === "src" && typeof value === "string") {
      setImage(node.id, value);
      return;
    }
  }

  if (node.tag === "input") {
    if (name === "placeholder" && typeof value === "string") {
      const text = inputTextChild(node);
      if (text) {
        registerInput(node.id, text.id, value);
      }
      return;
    }
    if (name === "value" && (typeof value === "string" || typeof value === "number")) {
      const text = inputTextChild(node);
      if (text) {
        text.text = String(value);
        setText(text.id, text.text);
      }
      return;
    }
  }

  applyNumericProp(node, name, value);

  if (node.isText && (name === "textContent" || name === "text")) {
    node.text = String(value ?? "");
    setText(node.id, node.text);
  }
}

export function applyHostProps(node: NuiNode, props: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(props)) {
    applyHostProp(node, key, value);
  }
}

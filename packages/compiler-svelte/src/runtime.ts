/**
 * Minimal Svelte-like runtime that maps to NUI Host.
 *
 * Build scripts compile `.svelte` with `svelte/compiler`, then rewrite
 * imports from `svelte/internal` to `@nexa/compiler-svelte/runtime`.
 */

import {
  addClickListener,
  commit,
  createNode,
  createText,
  insert as hostInsert,
  NodeType,
  PropertyId,
  rgba,
  run,
  setNumber,
  setText,
} from "@nexa/nui-host";

export type NuiNode = {
  id: bigint;
  tag: string;
  isText: boolean;
  parent: NuiNode | null;
  children: NuiNode[];
  text: string;
};

let windowTitle = "Nexa UI";

function normalizeTag(tag: string): string {
  return String(tag).trim().toLowerCase();
}

function applyDefaults(node: NuiNode): void {
  switch (normalizeTag(node.tag)) {
    case "window":
      setNumber(node.id, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));
      setNumber(node.id, PropertyId.FlexDirection, 0);
      break;
    case "column":
      setNumber(node.id, PropertyId.FlexDirection, 0);
      break;
    case "row":
      setNumber(node.id, PropertyId.FlexDirection, 1);
      break;
    case "button":
      setNumber(node.id, PropertyId.Padding, 12);
      setNumber(node.id, PropertyId.BorderRadius, 12);
      setNumber(node.id, PropertyId.BackgroundColor, rgba(0x1f, 0x6f, 0xeb));
      break;
    case "text":
      setNumber(node.id, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
      setNumber(node.id, PropertyId.FontSize, 16);
      break;
    default:
      break;
  }
}

export function element(tag: string): NuiNode {
  const t = normalizeTag(tag);
  const nodeType = t === "text" ? NodeType.Text : NodeType.View;
  const id = nodeType === NodeType.Text ? createText("") : createNode(nodeType);
  const node: NuiNode = {
    id,
    tag: t,
    isText: nodeType === NodeType.Text,
    parent: null,
    children: [],
    text: "",
  };
  applyDefaults(node);
  return node;
}

export function text(data: string): NuiNode {
  const id = createText(String(data ?? ""));
  setNumber(id, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
  return {
    id,
    tag: "#text",
    isText: true,
    parent: null,
    children: [],
    text: String(data ?? ""),
  };
}

export function space(): NuiNode {
  return text(" ");
}

export function empty(): NuiNode {
  return text("");
}

export function claim_element(node: NuiNode): NuiNode {
  return node;
}

export function claim_text(node: NuiNode, data: string): NuiNode {
  set_data(node, data);
  return node;
}

export function set_data(textNode: NuiNode, data: string): void {
  textNode.text = String(data ?? "");
  setText(textNode.id, textNode.text);
}

export function attr(node: NuiNode, name: string, value: unknown): void {
  if (name === "title" && typeof value === "string") {
    windowTitle = value;
    return;
  }
  if (typeof value !== "number") return;
  const map: Record<string, PropertyId> = {
    width: PropertyId.Width,
    height: PropertyId.Height,
    padding: PropertyId.Padding,
    gap: PropertyId.Gap,
    fontsize: PropertyId.FontSize,
    fontSize: PropertyId.FontSize,
  };
  const key = name.toLowerCase() === "fontsize" ? "fontSize" : name;
  const prop = map[key] ?? map[name.toLowerCase()];
  if (prop !== undefined) setNumber(node.id, prop, value);
}

export function set_style(node: NuiNode, _key: string, value: unknown): void {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      attr(node, k, v);
    }
  }
}

export function append(target: NuiNode, node: NuiNode): void {
  node.parent = target;
  target.children.push(node);
  hostInsert(node.id, target.id);
}

export function insert(target: NuiNode, node: NuiNode, anchor?: NuiNode | null): void {
  node.parent = target;
  if (anchor) {
    const idx = target.children.indexOf(anchor);
    if (idx >= 0) target.children.splice(idx, 0, node);
    else target.children.push(node);
    hostInsert(node.id, target.id, anchor.id);
  } else {
    target.children.push(node);
    hostInsert(node.id, target.id);
  }
}

export function listen(node: NuiNode, event: string, handler: () => void): () => void {
  if (event === "click" || event === "Click") {
    addClickListener(node.id, handler);
  }
  return () => {};
}

export function detach(node: NuiNode): void {
  if (node.parent) {
    node.parent.children = node.parent.children.filter((c) => c !== node);
    node.parent = null;
  }
}

export function destroy_block(fn: (() => void) | null | undefined): void {
  fn?.();
}

export function init(
  component: { $$: { fragment?: { c?: () => void; m?: (t: NuiNode, a: NuiNode | null) => void }; ctx?: unknown[] } },
  options: { target?: NuiNode; props?: Record<string, unknown> },
): void {
  const fragment = component.$$.fragment;
  fragment?.c?.();
  const target = options.target!;
  fragment?.m?.(target, null);
}

export function mount_component(component: { $$: { fragment?: { m?: (t: NuiNode, a: NuiNode | null) => void } } }, target: NuiNode, anchor: NuiNode | null): void {
  component.$$.fragment?.m?.(target, anchor);
}

export function create_component(component: { $$: { fragment?: { c?: () => void } } }): void {
  component.$$.fragment?.c?.();
}

export function noop(): void {}

export function safe_not_equal(a: unknown, b: unknown): boolean {
  return a != a ? b == b : a !== b || (a !== null && typeof a === "object") || typeof a === "function";
}

export function runHost(title?: string): void {
  commit();
  run(title ?? windowTitle);
}

export function getWindowTitle(): string {
  return windowTitle;
}

export function setWindowTitle(title: string): void {
  windowTitle = title;
}

/** Create a mount root View for Svelte components. */
export function createRoot(): NuiNode {
  const id = createNode(NodeType.View);
  setNumber(id, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));
  setNumber(id, PropertyId.FlexDirection, 0);
  return {
    id,
    tag: "view",
    isText: false,
    parent: null,
    children: [],
    text: "",
  };
}

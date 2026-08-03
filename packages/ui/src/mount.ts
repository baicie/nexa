/**
 * Mount a Minimal TSX tree onto the NUI Host and run the native window.
 */

import {
  addClickListener,
  commit,
  createNode,
  createText,
  insert,
  NodeType,
  PropertyId,
  rgba,
  run,
  setNumber,
  setText,
} from "@nexa/nui-host";

import type { NexaElement } from "./jsx-runtime";
import { Fragment } from "./jsx-runtime";
import { isPrimitive, type PrimitiveElement } from "./primitives";
import { effect, isSignal } from "./signal";

type Component = (props: Record<string, unknown>) => unknown;

let windowTitle = "Nexa UI";

function normalizeChildren(children: unknown): unknown[] {
  if (children == null || children === false || children === true) {
    return [];
  }
  if (Array.isArray(children)) {
    return children.flatMap((child) => normalizeChildren(child));
  }
  return [children];
}

function resolveChildText(children: unknown): string {
  return normalizeChildren(children)
    .map((child) => {
      if (child == null || child === false || child === true) {
        return "";
      }
      if (isSignal(child)) {
        return String(child.value);
      }
      if (typeof child === "function") {
        return String((child as () => unknown)());
      }
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return "";
    })
    .join("");
}

function childrenAreReactive(children: unknown): boolean {
  return normalizeChildren(children).some(
    (child) => isSignal(child) || typeof child === "function",
  );
}

function applyBoxProps(node: bigint, props: Record<string, unknown>, direction?: 0 | 1): void {
  if (direction !== undefined) {
    setNumber(node, PropertyId.FlexDirection, direction);
  }
  if (typeof props.width === "number") {
    setNumber(node, PropertyId.Width, props.width);
  }
  if (typeof props.height === "number") {
    setNumber(node, PropertyId.Height, props.height);
  }
  if (typeof props.padding === "number") {
    setNumber(node, PropertyId.Padding, props.padding);
  }
  if (typeof props.gap === "number") {
    setNumber(node, PropertyId.Gap, props.gap);
  }
}

function expandForMount(node: unknown): unknown[] {
  if (node == null || node === false || node === true) {
    return [];
  }

  if (typeof node === "object" && node !== null && "type" in node) {
    const el = node as NexaElement;
    if (el.type === Fragment || el.type === "Fragment") {
      return normalizeChildren(el.props.children).flatMap(expandForMount);
    }
    if (typeof el.type === "function") {
      return expandForMount((el.type as Component)(el.props));
    }
  }

  return [node];
}

function mountChildren(parent: bigint, children: unknown): void {
  for (const child of normalizeChildren(children).flatMap(expandForMount)) {
    const id = mountNode(child);
    if (id !== null) {
      insert(id, parent);
    }
  }
}

function mountPrimitive(el: PrimitiveElement): bigint | null {
  const { kind, props } = el;

  switch (kind) {
    case "window": {
      if (typeof props.title === "string") {
        windowTitle = props.title;
      }
      const root = createNode(NodeType.View);
      setNumber(root, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));
      setNumber(root, PropertyId.FlexDirection, 0);
      mountChildren(root, props.children);
      return root;
    }
    case "column": {
      const node = createNode(NodeType.View);
      applyBoxProps(node, props, 0);
      mountChildren(node, props.children);
      return node;
    }
    case "row": {
      const node = createNode(NodeType.View);
      applyBoxProps(node, props, 1);
      mountChildren(node, props.children);
      return node;
    }
    case "view": {
      const node = createNode(NodeType.View);
      applyBoxProps(node, props);
      mountChildren(node, props.children);
      return node;
    }
    case "text": {
      const node = createText("");
      if (typeof props.fontSize === "number") {
        setNumber(node, PropertyId.FontSize, props.fontSize);
      }
      if (typeof props.color === "number") {
        setNumber(node, PropertyId.TextColor, props.color);
      } else {
        setNumber(node, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
      }

      const children = props.children;
      if (childrenAreReactive(children)) {
        effect(() => {
          setText(node, resolveChildText(children));
        });
      } else {
        setText(node, resolveChildText(children));
      }
      return node;
    }
    case "button": {
      const node = createNode(NodeType.View);
      setNumber(node, PropertyId.Padding, 12);
      setNumber(node, PropertyId.BorderRadius, 12);
      setNumber(node, PropertyId.BackgroundColor, rgba(0x1f, 0x6f, 0xeb));
      if (typeof props.onClick === "function") {
        addClickListener(node, props.onClick as () => void);
      }

      const label = createText("");
      setNumber(label, PropertyId.FontSize, 18);
      setNumber(label, PropertyId.TextColor, rgba(0xff, 0xff, 0xff));
      const children = props.children;
      if (childrenAreReactive(children)) {
        effect(() => {
          setText(label, resolveChildText(children) || "Button");
        });
      } else {
        setText(label, resolveChildText(children) || "Button");
      }
      insert(label, node);
      return node;
    }
    default:
      return null;
  }
}

function mountNode(node: unknown): bigint | null {
  if (node == null || node === false || node === true) {
    return null;
  }

  if (isPrimitive(node)) {
    return mountPrimitive(node);
  }

  if (typeof node === "object" && node !== null && "type" in node) {
    const el = node as NexaElement;
    if (el.type === Fragment || el.type === "Fragment") {
      return null;
    }
    if (typeof el.type === "function") {
      return mountNode((el.type as Component)(el.props));
    }
    return null;
  }

  if (typeof node === "string" || typeof node === "number") {
    const text = createText(String(node));
    return text;
  }

  if (isSignal(node)) {
    const text = createText("");
    effect(() => {
      setText(text, String(node.value));
    });
    return text;
  }

  if (typeof node === "function") {
    const text = createText("");
    effect(() => {
      setText(text, String((node as () => unknown)()));
    });
    return text;
  }

  return null;
}

/**
 * Mount a root component or element, then block on the native event loop.
 *
 * Reactive text: pass a `signal` (not `.value`) or `() => string` as children
 * so updates call `setText` without rebuilding the native tree.
 *
 * ```tsx
 * <Text>Count: {count}</Text>
 * <Text>{() => `Count: ${count.value}`}</Text>
 * ```
 */
export function mount(root: Component | NexaElement | PrimitiveElement): void {
  windowTitle = "Nexa UI";
  const tree = typeof root === "function" ? root({}) : root;
  const hostRoot = mountNode(tree);
  if (hostRoot === null) {
    throw new Error("@nexa/ui mount() produced no root node — wrap the app in <Window>");
  }
  commit();
  run(windowTitle);
}

import {
  addClickListener,
  createNode,
  createText,
  insert,
  NodeType,
  PropertyId,
  remove,
  rgba,
  setNumber,
  setText,
  setWindowTitle,
} from "@nexa/nui-host";

import type { NexaElement } from "../jsx-runtime";
import { Fragment } from "../jsx-runtime";
import { isPrimitive, type PrimitiveElement } from "../primitives";
import { effect, isSignal } from "../signal";
import {
  childrenAreReactive,
  expandForMount,
  normalizeChildren,
  resolveChildText,
} from "./children";

type Component = (props: Record<string, unknown>) => unknown;

function applyBoxProps(
  node: bigint,
  props: Record<string, unknown>,
  direction?: 0 | 1,
): void {
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

function listItemKey(item: unknown, index: number): string {
  if (typeof item === "object" && item !== null && "id" in item) {
    return String((item as { id: unknown }).id);
  }
  return String(index);
}

function mountChildren(parent: bigint, children: unknown): void {
  for (const child of normalizeChildren(children).flatMap(expandForMount)) {
    const id = mountNode(child);
    if (id !== null) {
      insert(id, parent);
    }
  }
}

function mountForList(props: Record<string, unknown>): bigint {
  const container = createNode(NodeType.View);
  setNumber(container, PropertyId.FlexDirection, 0);
  if (typeof props.gap === "number") {
    setNumber(container, PropertyId.Gap, props.gap);
  } else {
    setNumber(container, PropertyId.Gap, 8);
  }

  const each = props.each;
  const render = props.children;
  const mounted = new Map<string, bigint>();

  if (typeof render !== "function") {
    return container;
  }

  effect(() => {
    const list = (isSignal(each) ? each.value : each) as unknown;
    if (!Array.isArray(list)) {
      return;
    }

    const nextKeys = new Set(list.map((item, index) => listItemKey(item, index)));

    for (const [key, node] of [...mounted.entries()]) {
      if (!nextKeys.has(key)) {
        remove(node);
        mounted.delete(key);
      }
    }

    list.forEach((item, index) => {
      const key = listItemKey(item, index);
      if (mounted.has(key)) {
        return;
      }
      const child = (render as (item: unknown, index: number) => unknown)(item, index);
      const id = mountNode(child);
      if (id !== null) {
        insert(id, container);
        mounted.set(key, id);
      }
    });
  });

  return container;
}

function mountPrimitive(el: PrimitiveElement): bigint | null {
  const { kind, props } = el;

  switch (kind) {
    case "window": {
      if (typeof props.title === "string") {
        setWindowTitle(props.title);
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
    case "scroll": {
      const node = createNode(NodeType.Scroll);
      applyBoxProps(node, props, 0);
      mountChildren(node, props.children);
      return node;
    }
    case "for": {
      return mountForList(props);
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

export function mountNode(node: unknown): bigint | null {
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
    return createText(String(node));
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

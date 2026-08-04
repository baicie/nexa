import {
  applyHostProps,
  createHostElement,
  createHostText,
  insert,
  insertBefore,
  registerNodeCleanup,
  remove,
  rgba,
  setText,
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

function bindEffect(node: bigint, fn: () => void): void {
  registerNodeCleanup(node, effect(fn));
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

function mountHostElement(tag: string, props: Record<string, unknown>): bigint {
  const node = createHostElement(tag);
  applyHostProps(node, props);
  mountChildren(node.id, props.children);
  return node.id;
}

function mountForList(props: Record<string, unknown>): bigint {
  const container = createHostElement("view");
  applyHostProps(container, {
    ...props,
    flexDirection: 0,
    gap: typeof props.gap === "number" ? props.gap : 8,
  });

  const each = props.each;
  const render = props.children;
  const mounted = new Map<string, bigint>();

  if (typeof render !== "function") {
    return container.id;
  }

  bindEffect(container.id, () => {
    const list = (isSignal(each) ? each.value : each) as unknown;
    if (!Array.isArray(list)) {
      return;
    }

    const nextKeys = new Set(list.map((item, index) => listItemKey(item, index)));

    for (const [key, node] of mounted.entries()) {
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
        insert(id, container.id);
        mounted.set(key, id);
      }
    });
  });

  return container.id;
}

function mountPrimitive(el: PrimitiveElement): bigint | null {
  const { kind, props } = el;

  switch (kind) {
    case "window":
    case "column":
    case "row":
    case "stack":
    case "card":
    case "view":
    case "scroll":
    case "image":
      return mountHostElement(kind, props);
    case "spacer": {
      const nextProps =
        typeof props.size === "number"
          ? { ...props, width: props.size, height: props.size }
          : props;
      return mountHostElement("spacer", nextProps);
    }
    case "for":
      return mountForList(props);
    case "text": {
      const node = createHostElement("text");
      applyHostProps(node, props);
      const children = props.children;
      if (childrenAreReactive(children)) {
        bindEffect(node.id, () => {
          setText(node.id, resolveChildText(children));
        });
      } else {
        setText(node.id, resolveChildText(children));
      }
      return node.id;
    }
    case "button": {
      const node = createHostElement("button");
      applyHostProps(node, props);
      const label = createHostText("");
      applyHostProps(label, { fontSize: 18, color: rgba(0xff, 0xff, 0xff) });
      const children = props.children;
      if (childrenAreReactive(children)) {
        bindEffect(label.id, () => {
          setText(label.id, resolveChildText(children) || "Button");
        });
      } else {
        setText(label.id, resolveChildText(children) || "Button");
      }
      insertBefore(node, label, null);
      return node.id;
    }
    case "input": {
      const container = createHostElement("input");
      const textNode = container.children[0];
      const initial = isSignal(props.value)
        ? String(props.value.value ?? "")
        : props.value != null
          ? String(props.value)
          : "";
      if (textNode) {
        textNode.text = initial;
        setText(textNode.id, initial);
      }

      if (isSignal(props.value) && textNode) {
        const signalValue = props.value;
        bindEffect(textNode.id, () => {
          setText(textNode.id, String(signalValue.value ?? ""));
        });
      }

      const nextProps: Record<string, unknown> = {
        ...props,
        ...(isSignal(props.value) ? { value: initial } : {}),
      };
      if (typeof props.onChange === "function" || isSignal(props.value)) {
        const onChange = props.onChange as ((value: string) => void) | undefined;
        nextProps.onChange = (value: string) => {
          if (isSignal(props.value)) {
            props.value.value = value;
          }
          onChange?.(value);
        };
      }
      applyHostProps(container, nextProps);
      return container.id;
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
    return createHostText(String(node)).id;
  }

  if (isSignal(node)) {
    const text = createHostText("");
    bindEffect(text.id, () => {
      setText(text.id, String(node.value));
    });
    return text.id;
  }

  if (typeof node === "function") {
    const text = createHostText("");
    bindEffect(text.id, () => {
      setText(text.id, String((node as () => unknown)()));
    });
    return text.id;
  }

  return null;
}

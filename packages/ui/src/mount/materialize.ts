import {
  addChangeListener,
  addClickListener,
  addSubmitListener,
  createNode,
  createText,
  insert,
  NodeType,
  PropertyId,
  registerInput,
  remove,
  rgba,
  setImage,
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
  if (typeof props.alignItems === "number") {
    setNumber(node, PropertyId.AlignItems, props.alignItems);
  }
  if (typeof props.justifyContent === "number") {
    setNumber(node, PropertyId.JustifyContent, props.justifyContent);
  }
  if (typeof props.backgroundColor === "number") {
    setNumber(node, PropertyId.BackgroundColor, props.backgroundColor);
  }
  if (typeof props.borderRadius === "number") {
    setNumber(node, PropertyId.BorderRadius, props.borderRadius);
  }
  if (typeof props.flexGrow === "number") {
    setNumber(node, PropertyId.FlexGrow, props.flexGrow);
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

    const mountedEntries = [...mounted.entries()];
    for (const [key, node] of mountedEntries) {
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
    case "stack": {
      const node = createNode(NodeType.View);
      applyBoxProps(node, props, 0);
      if (typeof props.alignItems !== "number") {
        setNumber(node, PropertyId.AlignItems, 1);
      }
      if (typeof props.justifyContent !== "number") {
        setNumber(node, PropertyId.JustifyContent, 1);
      }
      mountChildren(node, props.children);
      return node;
    }
    case "card": {
      const node = createNode(NodeType.View);
      applyBoxProps(node, props, 0);
      if (typeof props.padding !== "number") {
        setNumber(node, PropertyId.Padding, 16);
      }
      if (typeof props.borderRadius !== "number") {
        setNumber(node, PropertyId.BorderRadius, 12);
      }
      if (typeof props.backgroundColor !== "number") {
        setNumber(node, PropertyId.BackgroundColor, rgba(0xff, 0xff, 0xff));
      }
      if (typeof props.gap !== "number") {
        setNumber(node, PropertyId.Gap, 8);
      }
      mountChildren(node, props.children);
      return node;
    }
    case "spacer": {
      const node = createNode(NodeType.View);
      if (typeof props.size === "number") {
        setNumber(node, PropertyId.Height, props.size);
        setNumber(node, PropertyId.Width, props.size);
      } else if (typeof props.height === "number" || typeof props.width === "number") {
        if (typeof props.height === "number") {
          setNumber(node, PropertyId.Height, props.height);
        }
        if (typeof props.width === "number") {
          setNumber(node, PropertyId.Width, props.width);
        }
      } else {
        setNumber(node, PropertyId.FlexGrow, 1);
      }
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
    case "image": {
      const node = createNode(NodeType.Image);
      applyBoxProps(node, props);
      if (typeof props.src === "string") {
        setImage(node, props.src);
      }
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
    case "input": {
      const container = createNode(NodeType.View);
      setNumber(container, PropertyId.Padding, 10);
      setNumber(container, PropertyId.BorderRadius, 8);
      setNumber(container, PropertyId.BackgroundColor, rgba(0xff, 0xff, 0xff));
      setNumber(container, PropertyId.Height, 36);
      if (typeof props.width === "number") {
        setNumber(container, PropertyId.Width, props.width);
      } else {
        setNumber(container, PropertyId.Width, 220);
      }

      const initial = isSignal(props.value)
        ? String(props.value.value ?? "")
        : props.value != null
          ? String(props.value)
          : "";
      const textNode = createText(initial);
      setNumber(textNode, PropertyId.FontSize, 16);
      setNumber(textNode, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
      insert(textNode, container);

      const placeholder = typeof props.placeholder === "string" ? props.placeholder : "";
      registerInput(container, textNode, placeholder);

      if (isSignal(props.value)) {
        const signalValue = props.value;
        effect(() => {
          setText(textNode, String(signalValue.value ?? ""));
        });
      }

      if (typeof props.onChange === "function") {
        const onChange = props.onChange as (value: string) => void;
        addChangeListener(container, (value) => {
          if (isSignal(props.value)) {
            props.value.value = value;
          }
          onChange(value);
        });
      } else if (isSignal(props.value)) {
        const signalValue = props.value;
        addChangeListener(container, (value) => {
          signalValue.value = value;
        });
      }

      if (typeof props.onSubmit === "function") {
        addSubmitListener(container, props.onSubmit as (value: string) => void);
      }

      return container;
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

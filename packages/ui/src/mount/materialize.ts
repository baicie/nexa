import {
  applyHostProp,
  applyHostProps,
  createHostElement,
  createHostText,
  insert,
  insertBefore,
  registerNodeCleanup,
  remove,
  setText,
} from "@nexa/nui-host";

import type { NexaElement } from "../jsx-runtime";
import { Fragment } from "../jsx-runtime";
import { isPrimitive, type PrimitiveElement } from "../primitives";
import { effect, isSignal } from "../signal";
import { defaultTheme, type Style, type Theme } from "../theme";
import {
  childrenAreReactive,
  expandForMount,
  normalizeChildren,
  resolveChildText,
} from "./children";

type Component = (props: Record<string, unknown>) => unknown;

function styleRecord(value: unknown): Style {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Style)
    : {};
}

function themedProps(props: Record<string, unknown>, baseStyle?: Style): Record<string, unknown> {
  const {
    theme: _theme,
    style,
    labelStyle: _labelStyle,
    textStyle: _textStyle,
    ...hostProps
  } = props;
  if (baseStyle === undefined && style === undefined) return hostProps;
  return { style: { ...baseStyle, ...styleRecord(style) }, ...hostProps };
}

function inheritedTheme(props: Record<string, unknown>, fallback: Theme): Theme {
  return props.theme !== null && typeof props.theme === "object"
    ? (props.theme as Theme)
    : fallback;
}

function bindEffect(node: bigint, fn: () => void): void {
  registerNodeCleanup(node, effect(fn));
}

function applyPropsWithReactiveValues(
  node: ReturnType<typeof createHostElement>,
  props: Record<string, unknown>,
): void {
  const disabled = isSignal(props.disabled) ? props.disabled : null;
  const semantics = isSignal(props.semantics) ? props.semantics : null;
  if (disabled === null && semantics === null) {
    applyHostProps(node, props);
    return;
  }

  const staticProps = { ...props };
  if (disabled !== null) delete staticProps.disabled;
  if (semantics !== null) delete staticProps.semantics;
  applyHostProps(node, staticProps);
  if (disabled !== null) {
    bindEffect(node.id, () => {
      applyHostProp(node, "disabled", Boolean(disabled.value));
    });
  }
  if (semantics !== null) {
    bindEffect(node.id, () => {
      applyHostProp(node, "semantics", semantics.value);
    });
  }
}

function listItemKey(item: unknown, index: number): string {
  if (typeof item === "object" && item !== null && "id" in item) {
    return String((item as { id: unknown }).id);
  }
  return String(index);
}

function mountChildren(parent: bigint, children: unknown, theme: Theme): void {
  for (const child of normalizeChildren(children).flatMap(expandForMount)) {
    const id = mountNode(child, theme);
    if (id !== null) {
      insert(id, parent);
    }
  }
}

function mountHostElement(
  tag: string,
  props: Record<string, unknown>,
  theme: Theme,
  baseStyle?: Style,
): bigint {
  const node = createHostElement(tag);
  applyPropsWithReactiveValues(node, themedProps(props, baseStyle));
  mountChildren(node.id, props.children, theme);
  return node.id;
}

function mountForList(props: Record<string, unknown>, theme: Theme): bigint {
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
      const id = mountNode(child, theme);
      if (id !== null) {
        insert(id, container.id);
        mounted.set(key, id);
      }
    });
  });

  return container.id;
}

function mountPrimitive(el: PrimitiveElement, parentTheme: Theme): bigint | null {
  const { kind, props } = el;
  const theme = kind === "window" ? inheritedTheme(props, parentTheme) : parentTheme;

  switch (kind) {
    case "window":
      return mountHostElement(kind, props, theme, theme.components.window);
    case "card":
      return mountHostElement(kind, props, theme, theme.components.card);
    case "column":
    case "row":
    case "stack":
    case "view":
    case "scroll":
    case "image":
      return mountHostElement(kind, props, theme);
    case "spacer": {
      const nextProps =
        typeof props.size === "number"
          ? { ...props, width: props.size, height: props.size }
          : props;
      return mountHostElement("spacer", nextProps, theme);
    }
    case "for":
      return mountForList(props, theme);
    case "text": {
      const node = createHostElement("text");
      applyPropsWithReactiveValues(node, themedProps(props, theme.components.text));
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
      applyPropsWithReactiveValues(node, themedProps(props, theme.components.button.container));
      const label = createHostText("");
      applyHostProps(label, {
        style: {
          ...theme.components.button.label,
          ...styleRecord(props.labelStyle),
        },
      });
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
    case "input":
    case "textarea": {
      const container = createHostElement(kind);
      const textNode = container.children[0];
      const initial = isSignal(props.value)
        ? String(props.value.value ?? "")
        : props.value != null
          ? String(props.value)
          : "";
      if (textNode) {
        const textTheme =
          kind === "input" ? theme.components.input.text : theme.components.textArea.text;
        applyHostProps(textNode, {
          style: { ...textTheme, ...styleRecord(props.textStyle) },
        });
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
        ...(props.width === "stretch" ? { width: null } : {}),
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
      const containerTheme =
        kind === "input" ? theme.components.input.container : theme.components.textArea.container;
      applyPropsWithReactiveValues(container, themedProps(nextProps, containerTheme));
      return container.id;
    }
    default:
      return null;
  }
}

export function mountNode(node: unknown, theme: Theme = defaultTheme): bigint | null {
  if (node == null || node === false || node === true) {
    return null;
  }

  if (isPrimitive(node)) {
    return mountPrimitive(node, theme);
  }

  if (typeof node === "object" && node !== null && "type" in node) {
    const el = node as NexaElement;
    if (el.type === Fragment || el.type === "Fragment") {
      return null;
    }
    if (typeof el.type === "function") {
      return mountNode((el.type as Component)(el.props), theme);
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

import type { NexaElement } from "../jsx-runtime";
import { Fragment } from "../jsx-runtime";
import { isSignal } from "../signal";

type Component = (props: Record<string, unknown>) => unknown;

export function normalizeChildren(children: unknown): unknown[] {
  if (children == null || children === false || children === true) {
    return [];
  }
  if (Array.isArray(children)) {
    return children.flatMap((child) => normalizeChildren(child));
  }
  return [children];
}

export function resolveChildText(children: unknown): string {
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

export function childrenAreReactive(children: unknown): boolean {
  return normalizeChildren(children).some(
    (child) => isSignal(child) || typeof child === "function",
  );
}

export function expandForMount(node: unknown): unknown[] {
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

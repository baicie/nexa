/**
 * First-party primitives — descriptors resolved by mount() into HostOps.
 */

import type { Signal } from "./signal";

export type HostKind =
  | "window"
  | "column"
  | "row"
  | "view"
  | "text"
  | "button"
  | "input"
  | "scroll"
  | "for";

export type PrimitiveElement = {
  $$nexa: true;
  kind: HostKind;
  props: Record<string, unknown>;
};

function primitive(kind: HostKind, props: Record<string, unknown> = {}): PrimitiveElement {
  return { $$nexa: true, kind, props };
}

export function isPrimitive(value: unknown): value is PrimitiveElement {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PrimitiveElement).$$nexa === true &&
    typeof (value as PrimitiveElement).kind === "string"
  );
}

export type WindowProps = {
  title?: string;
  children?: unknown;
};

export function Window(props: WindowProps): PrimitiveElement {
  return primitive("window", props as Record<string, unknown>);
}

export type BoxProps = {
  width?: number;
  height?: number;
  padding?: number;
  gap?: number;
  children?: unknown;
};

export function Column(props: BoxProps = {}): PrimitiveElement {
  return primitive("column", props as Record<string, unknown>);
}

export function Row(props: BoxProps = {}): PrimitiveElement {
  return primitive("row", props as Record<string, unknown>);
}

export function View(props: BoxProps = {}): PrimitiveElement {
  return primitive("view", props as Record<string, unknown>);
}

export type ScrollProps = BoxProps;

export function Scroll(props: ScrollProps = {}): PrimitiveElement {
  return primitive("scroll", props as Record<string, unknown>);
}

export type TextProps = {
  fontSize?: number;
  color?: number;
  children?: unknown;
};

export function Text(props: TextProps = {}): PrimitiveElement {
  return primitive("text", props as Record<string, unknown>);
}

export type ButtonProps = {
  onClick?: () => void;
  children?: unknown;
};

export function Button(props: ButtonProps = {}): PrimitiveElement {
  return primitive("button", props as Record<string, unknown>);
}

export type InputProps = {
  value?: Signal<string> | string;
  placeholder?: string;
  width?: number;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
};

export function Input(props: InputProps = {}): PrimitiveElement {
  return primitive("input", props as Record<string, unknown>);
}

export type ForProps<T> = {
  each: Signal<T[]> | T[];
  children?: (item: T, index: number) => unknown;
};

/** Keyed list — mount adds/removes Host nodes without rebuilding the window. */
export function For<T>(props: ForProps<T>): PrimitiveElement {
  return primitive("for", props as Record<string, unknown>);
}

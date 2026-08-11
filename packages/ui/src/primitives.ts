/**
 * First-party primitives — descriptors resolved by mount() into HostOps.
 */

import type { Signal } from "./signal";
import type { Style, TextStyle, Theme } from "./theme";
import type { Ui } from "@nexa/protocol";

export const SemanticRole = {
  None: "None" as Ui.SemanticRole.None,
  Button: "Button" as Ui.SemanticRole.Button,
  Text: "Text" as Ui.SemanticRole.Text,
  Image: "Image" as Ui.SemanticRole.Image,
  TextInput: "TextInput" as Ui.SemanticRole.TextInput,
  Scroll: "Scroll" as Ui.SemanticRole.Scroll,
  Header: "Header" as Ui.SemanticRole.Header,
} as const;
export const SemanticAction = {
  Invoke: "Invoke" as Ui.SemanticAction.Invoke,
  Focus: "Focus" as Ui.SemanticAction.Focus,
  SetValue: "SetValue" as Ui.SemanticAction.SetValue,
} as const;
export type Semantics = Ui.Semantics;
export type SemanticsProp = Ui.Semantics | Signal<Ui.Semantics>;

export type HostKind =
  | "window"
  | "column"
  | "row"
  | "stack"
  | "view"
  | "text"
  | "button"
  | "input"
  | "textarea"
  | "scroll"
  | "card"
  | "spacer"
  | "image"
  | "for";

export type PrimitiveElement = {
  $$nexa: true;
  kind: HostKind;
  props: Record<string, unknown>;
};

function primitive(
  kind: HostKind,
  props: Record<string, unknown> | null | undefined = {},
): PrimitiveElement {
  return { $$nexa: true, kind, props: props ?? {} };
}

export function isPrimitive(value: unknown): value is PrimitiveElement {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PrimitiveElement).$$nexa === true &&
    typeof (value as PrimitiveElement).kind === "string"
  );
}

export type WindowLifecycleEvent = Ui.WindowLifecycleEvent;

export type WindowProps = {
  title?: string;
  onLifecycle?: (event: WindowLifecycleEvent) => void;
  theme?: Theme;
  style?: Style;
  children?: unknown;
};

export function Window(props: WindowProps): PrimitiveElement {
  return primitive("window", props as Record<string, unknown>);
}

export type BoxProps = {
  width?: number;
  height?: number;
  flexGrow?: number;
  padding?: number;
  gap?: number;
  /** 0=start 1=center 2=end 3=stretch */
  alignItems?: number;
  /** 0=start 1=center 2=end */
  justifyContent?: number;
  backgroundColor?: number;
  borderRadius?: number;
  style?: Style;
  semantics?: SemanticsProp;
  children?: unknown;
};

export function Column(props: BoxProps = {}): PrimitiveElement {
  return primitive("column", props as Record<string, unknown>);
}

export function Row(props: BoxProps = {}): PrimitiveElement {
  return primitive("row", props as Record<string, unknown>);
}

/** Centered flex stack (column + align/justify center). */
export function Stack(props: BoxProps = {}): PrimitiveElement {
  return primitive("stack", props as Record<string, unknown>);
}

export function View(props: BoxProps = {}): PrimitiveElement {
  return primitive("view", props as Record<string, unknown>);
}

export type ScrollProps = BoxProps;

export function Scroll(props: ScrollProps = {}): PrimitiveElement {
  return primitive("scroll", props as Record<string, unknown>);
}

export type CardProps = BoxProps;

/** Padded rounded panel (composite View). */
export function Card(props: CardProps = {}): PrimitiveElement {
  return primitive("card", props as Record<string, unknown>);
}

export type SpacerProps = {
  /** Fixed main-axis size; omit to flex-grow and fill remaining space. */
  size?: number;
  width?: number;
  height?: number;
};

/** Flexible or fixed gap in a Column/Row. */
export function Spacer(props: SpacerProps = {}): PrimitiveElement {
  return primitive("spacer", props as Record<string, unknown>);
}

export type TextProps = {
  fontSize?: number;
  color?: number;
  style?: TextStyle;
  semantics?: SemanticsProp;
  children?: unknown;
};

export function Text(props: TextProps = {}): PrimitiveElement {
  return primitive("text", props as Record<string, unknown>);
}

export type ButtonProps = {
  disabled?: boolean | Signal<boolean>;
  style?: Style;
  labelStyle?: TextStyle;
  semantics?: SemanticsProp;
  onClick?: () => void;
  children?: unknown;
};

export function Button(props: ButtonProps = {}): PrimitiveElement {
  return primitive("button", props as Record<string, unknown>);
}

export type InputProps = {
  value?: Signal<string> | string;
  placeholder?: string;
  width?: number | "stretch";
  flexGrow?: number;
  disabled?: boolean | Signal<boolean>;
  style?: Style;
  textStyle?: TextStyle;
  semantics?: SemanticsProp;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onComposition?: (event: Ui.CompositionEvent) => void;
};

export function Input(props: InputProps = {}): PrimitiveElement {
  return primitive("input", props as Record<string, unknown>);
}

export type TextAreaProps = {
  value?: Signal<string> | string;
  placeholder?: string;
  width?: number | "stretch";
  height?: number;
  flexGrow?: number;
  disabled?: boolean | Signal<boolean>;
  style?: Style;
  textStyle?: TextStyle;
  semantics?: SemanticsProp;
  onChange?: (value: string) => void;
  onComposition?: (event: Ui.CompositionEvent) => void;
};

export function TextArea(props: TextAreaProps = {}): PrimitiveElement {
  return primitive("textarea", props as Record<string, unknown>);
}

export type ImageProps = {
  /** Local filesystem path (PNG/JPEG/…). */
  src: string;
  width?: number;
  height?: number;
  semantics?: SemanticsProp;
};

export function Image(props: ImageProps): PrimitiveElement {
  return primitive("image", props as Record<string, unknown>);
}

export type ForProps<T> = {
  each: Signal<T[]> | T[];
  children?: (item: T, index: number) => unknown;
};

/** Keyed list — mount adds/removes Host nodes without rebuilding the window. */
export function For<T>(props: ForProps<T>): PrimitiveElement {
  return primitive("for", props as Record<string, unknown>);
}

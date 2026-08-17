/**
 * @nexa/ui — Minimal TSX surface (Slice 3–4 + ADR §11 composites).
 *
 * First-party: Window / Column / Row / Stack / View / Scroll / Card / Spacer /
 * Text / Button / Input / Image / For / signal / mount.
 */

export { signal, effect, onCleanup, isSignal } from "./signal";
export type { Signal } from "./signal";

export { createTheme, defaultTheme, rgba } from "./theme";
export type {
  ColorToken,
  ViewStyle,
  TextStyle,
  Style,
  ThemeTokens,
  ThemeOverrides,
  Theme,
} from "./theme";

export {
  Window,
  Column,
  Row,
  Stack,
  View,
  Scroll,
  Card,
  Spacer,
  Text,
  Button,
  For,
  Input,
  TextArea,
  Image,
  isPrimitive,
  SemanticAction,
  SemanticRole,
} from "./primitives";
export type {
  WindowLifecycleEvent,
  WindowProps,
  BoxProps,
  ScrollProps,
  CardProps,
  SpacerProps,
  TextProps,
  ButtonProps,
  InputProps,
  TextAreaProps,
  ImageProps,
  ForProps,
  PrimitiveElement,
  HostKind,
  Semantics,
  SemanticsProp,
} from "./primitives";

export { mount } from "./mount";

export type { HostOps, NodeId } from "./host";
export { NodeType, PropertyId, EventType } from "./host";

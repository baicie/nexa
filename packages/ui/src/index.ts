/**
 * @nexa/ui — Minimal TSX surface (Slice 3–4 + ADR §11 composites).
 *
 * First-party: Window / Column / Row / Stack / View / Scroll / Card / Spacer /
 * Text / Button / Input / For / signal / mount.
 */

export { signal, effect, onCleanup, isSignal } from "./signal";
export type { Signal } from "./signal";

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
  isPrimitive,
} from "./primitives";
export type {
  WindowProps,
  BoxProps,
  ScrollProps,
  CardProps,
  SpacerProps,
  TextProps,
  ButtonProps,
  InputProps,
  ForProps,
  PrimitiveElement,
  HostKind,
} from "./primitives";

export { mount } from "./mount";

export type { HostOps, NodeId } from "./host";
export { NodeType, PropertyId, EventType } from "./host";

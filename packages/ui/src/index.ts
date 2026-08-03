/**
 * @nexa/ui — Minimal TSX surface (Slice 3).
 *
 * First-party: Window / Column / Row / View / Text / Button / signal / mount.
 * No Fiber / VDOM — mount materializes HostOps; signals drive setText.
 */

export { signal, effect, onCleanup, isSignal } from "./signal";
export type { Signal } from "./signal";

export {
  Window,
  Column,
  Row,
  View,
  Text,
  Button,
  isPrimitive,
} from "./primitives";
export type {
  WindowProps,
  BoxProps,
  TextProps,
  ButtonProps,
  PrimitiveElement,
  HostKind,
} from "./primitives";

export { mount } from "./mount";

export type { HostOps, NodeId } from "./host";
export { NodeType, PropertyId, EventType } from "./host";
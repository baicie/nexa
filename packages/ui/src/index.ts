/**
 * @nexa/ui — Minimal TSX surface (Slice 3–4).
 *
 * First-party: Window / Column / Row / View / Scroll / Text / Button / For /
 * signal / mount. No Fiber / VDOM — mount materializes HostOps.
 */

export { signal, effect, onCleanup, isSignal } from "./signal";
export type { Signal } from "./signal";

export {
  Window,
  Column,
  Row,
  View,
  Scroll,
  Text,
  Button,
  For,
  isPrimitive,
} from "./primitives";
export type {
  WindowProps,
  BoxProps,
  ScrollProps,
  TextProps,
  ButtonProps,
  ForProps,
  PrimitiveElement,
  HostKind,
} from "./primitives";

export { mount } from "./mount";

export type { HostOps, NodeId } from "./host";
export { NodeType, PropertyId, EventType } from "./host";

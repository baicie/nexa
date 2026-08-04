import { Ui } from "@nexa/protocol";
import type { Common } from "@nexa/protocol";

/**
 * Minimal NUI Host Protocol — Counter vertical slice (ADR-004 §5.1).
 *
 * Do not expand to animation / a11y / async / multi-thread / plugin until needed.
 */

export type NodeId = Common.HandleRef;
export const NodeType = Ui.NodeType;
export type NodeType = Ui.NodeType;
export const PropertyId = Ui.PropertyId;
export type PropertyId = Ui.PropertyId;
export const EventType = Ui.EventId;
export type EventType = Ui.EventId;

export interface HostOps {
  createNode(type: NodeType): NodeId;
  createText(text: string): NodeId;
  insert(child: NodeId, parent: NodeId, before?: NodeId): void;
  remove(node: NodeId): void;
  setProperty(node: NodeId, property: PropertyId, value: Ui.PropertyValue): void;
  setText(node: NodeId, text: string): void;
  addEventListener(node: NodeId, event: EventType, callbackId: number): void;
  removeEventListener(node: NodeId, event: EventType, callbackId: number): void;
  commit(): void;
}

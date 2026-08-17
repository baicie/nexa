import {
  EventId as GeneratedEventId,
  NodeType as GeneratedNodeType,
  PropertyId as GeneratedPropertyId,
  Ui,
} from "@nexa/protocol";
import type { Common } from "@nexa/protocol";

/**
 * Minimal NUI Host Protocol — Counter vertical slice (ADR-004 §5.1).
 *
 * Do not expand to animation / a11y / async / multi-thread / plugin until needed.
 */

export type NodeId = Common.HandleRef;
export const NodeType = GeneratedNodeType;
export type NodeType = (typeof GeneratedNodeType)[keyof typeof GeneratedNodeType];
export const PropertyId = GeneratedPropertyId;
export type PropertyId = (typeof GeneratedPropertyId)[keyof typeof GeneratedPropertyId];
export const EventType = GeneratedEventId;
export type EventType = (typeof GeneratedEventId)[keyof typeof GeneratedEventId];

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

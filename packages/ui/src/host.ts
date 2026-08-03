/**
 * Minimal NUI Host Protocol — Counter vertical slice (ADR-004 §5.1).
 *
 * Do not expand to animation / a11y / async / multi-thread / plugin until needed.
 */

export type NodeId = bigint;

export enum NodeType {
  Root = 0,
  View = 1,
  Text = 2,
  Image = 3,
  Scroll = 4,
}

export enum PropertyId {
  Width = 1,
  Height = 2,
  MinWidth = 3,
  MinHeight = 4,
  Padding = 5,
  Gap = 6,
  FlexDirection = 7,
  AlignItems = 8,
  JustifyContent = 9,
  BackgroundColor = 10,
  BorderRadius = 11,
  Opacity = 12,
  FontSize = 13,
  FontWeight = 14,
  TextColor = 15,
  ScrollOffsetY = 16,
  FlexGrow = 17,
}

export enum EventType {
  Click = 1,
  Change = 2,
  Submit = 3,
}

export interface HostOps {
  createNode(type: NodeType): NodeId;
  createText(text: string): NodeId;
  insert(child: NodeId, parent: NodeId, before?: NodeId): void;
  remove(node: NodeId): void;
  setProperty(node: NodeId, property: PropertyId, value: number): void;
  setText(node: NodeId, text: string): void;
  addEventListener(node: NodeId, event: EventType, callbackId: number): void;
  removeEventListener(node: NodeId, event: EventType, callbackId: number): void;
  commit(): void;
}

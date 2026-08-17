import {
  EventId as GeneratedEventId,
  NodeType as GeneratedNodeType,
  PropertyId as GeneratedPropertyId,
} from "@nexa/protocol";
import { attachNode, disposeNode, resetNodeLifecycle } from "./lifecycle";
import { resetWindowTitle } from "./title";
import { guardFrameworkCallback } from "./errors";

/**
 * Perry native-library FFI wrappers.
 *
 * Each wrapper must call the `js_*` symbol named in package.json so Perry
 * can bind the nativeLibrary dispatch table.
 */

declare function js_nui_create_node(type: number): bigint | number;
declare function js_nui_create_node_v1(type: number): string;
declare function js_nui_clear_property_v1(
  nodeSlot: number,
  nodeGeneration: number,
  property: number,
): string;
declare function js_nui_set_semantics_v1(
  nodeSlot: number,
  nodeGeneration: number,
  semanticsJson: string,
): string;
declare function js_nui_clear_semantics_v1(nodeSlot: number, nodeGeneration: number): string;
declare function js_nui_register_button_v1(nodeSlot: number, nodeGeneration: number): string;
declare function js_nui_add_event_listener_v1(
  nodeSlot: number,
  nodeGeneration: number,
  event: number,
  callback: (value: string) => void,
): string;
declare function js_nui_remove_event_listener_v1(
  listenerSlot: number,
  listenerGeneration: number,
): string;
declare function js_nui_handshake_v1(helloJson: string): string;
declare function js_nui_create_text(text: string): bigint | number;
declare function js_nui_insert(
  child: bigint | number,
  parent: bigint | number,
  before: bigint | number,
): void;
declare function js_nui_remove(node: bigint | number): void;
declare function js_nui_set_text(node: bigint | number, text: string): void;
declare function js_nui_set_number(node: bigint | number, property: number, value: number): void;
declare function js_nui_add_click_listener(node: bigint | number, callback: () => void): void;
declare function js_nui_register_input(
  container: bigint | number,
  textNode: bigint | number,
  placeholder: string,
): void;
declare function js_nui_add_change_listener(
  node: bigint | number,
  callback: (value: string) => void,
): void;
declare function js_nui_add_submit_listener(
  node: bigint | number,
  callback: (value: string) => void,
): void;
declare function js_nui_set_image(node: bigint | number, path: string): void;
declare function js_nui_commit(): void;
declare function js_nui_commit_v1(): string;
declare function js_nui_reset_session_v1(): string;
declare function js_nui_get_text_input_state_v1(nodeSlot: number, nodeGeneration: number): string;
declare function js_nui_replace_text_input_v1(
  nodeSlot: number,
  nodeGeneration: number,
  rangeStart: number,
  rangeEnd: number,
  text: string,
): string;
declare function js_nui_get_composition_bounds_v1(nodeSlot: number, nodeGeneration: number): string;
declare function js_nui_run(title: string): void;
declare function js_nui_run_v1(title: string): string;

/** Perry u64 params expect JS safe integers (Number), not BigInt. */
function asU64(id: bigint | number): number {
  if (typeof id === "number") {
    return id;
  }
  return Number(id);
}

/** Normalize Host node ids to BigInt for the TS surface. */
function asNodeId(id: bigint | number): bigint {
  return typeof id === "bigint" ? id : BigInt(id);
}

export const NodeType = GeneratedNodeType;
export type NodeType = (typeof GeneratedNodeType)[keyof typeof GeneratedNodeType];
export const PropertyId = GeneratedPropertyId;
export type PropertyId = (typeof GeneratedPropertyId)[keyof typeof GeneratedPropertyId];
export const EventId = GeneratedEventId;
export type EventId = (typeof GeneratedEventId)[keyof typeof GeneratedEventId];

export function handshakeRaw(helloJson: string): string {
  return js_nui_handshake_v1(helloJson);
}

export function createNodeV1Raw(type: number): string {
  return js_nui_create_node_v1(type);
}

export function clearPropertyV1Raw(
  nodeSlot: number,
  nodeGeneration: number,
  property: number,
): string {
  return js_nui_clear_property_v1(nodeSlot, nodeGeneration, property);
}

export function setSemanticsV1Raw(
  nodeSlot: number,
  nodeGeneration: number,
  semanticsJson: string,
): string {
  return js_nui_set_semantics_v1(nodeSlot, nodeGeneration, semanticsJson);
}

export function clearSemanticsV1Raw(nodeSlot: number, nodeGeneration: number): string {
  return js_nui_clear_semantics_v1(nodeSlot, nodeGeneration);
}

export function registerButtonV1Raw(nodeSlot: number, nodeGeneration: number): string {
  return js_nui_register_button_v1(nodeSlot, nodeGeneration);
}

export function addEventListenerV1Raw(
  nodeSlot: number,
  nodeGeneration: number,
  event: EventId,
  callback: (value: string) => void,
): string {
  return js_nui_add_event_listener_v1(nodeSlot, nodeGeneration, event, callback);
}

export function removeEventListenerV1Raw(listenerSlot: number, listenerGeneration: number): string {
  return js_nui_remove_event_listener_v1(listenerSlot, listenerGeneration);
}

/** Pack RGBA into the Host color number (`0xRRGGBBAA`). */
export function rgba(r: number, g: number, b: number, a = 255): number {
  return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;
}

export function createNode(type: NodeType): bigint {
  return asNodeId(js_nui_create_node(type));
}

export function createText(text: string): bigint {
  return asNodeId(js_nui_create_text(text));
}

export function insert(child: bigint, parent: bigint, before?: bigint): void {
  attachNode(child, parent);
  js_nui_insert(asU64(child), asU64(parent), asU64(before ?? 0n));
}

export function remove(node: bigint): void {
  disposeNode(node);
  js_nui_remove(asU64(node));
}

export function setText(node: bigint, text: string): void {
  js_nui_set_text(asU64(node), text);
}

export function setNumber(node: bigint, property: PropertyId, value: number): void {
  js_nui_set_number(asU64(node), property, value);
}

export function addClickListener(node: bigint, callback: () => void): void {
  js_nui_add_click_listener(asU64(node), guardFrameworkCallback(callback));
}

/** Register a View+Text composite as a focusable single-line Input. */
export function registerInput(container: bigint, textNode: bigint, placeholder = ""): void {
  js_nui_register_input(asU64(container), asU64(textNode), placeholder);
}

export function addChangeListener(node: bigint, callback: (value: string) => void): void {
  js_nui_add_change_listener(asU64(node), guardFrameworkCallback(callback));
}

export function addSubmitListener(node: bigint, callback: (value: string) => void): void {
  js_nui_add_submit_listener(asU64(node), guardFrameworkCallback(callback));
}

/** Load a local PNG/JPEG (etc.) onto an Image node. */
export function setImage(node: bigint, path: string): void {
  js_nui_set_image(asU64(node), path);
}

export function commit(): void {
  js_nui_commit();
}

export function commitV1Raw(): string {
  return js_nui_commit_v1();
}

export function resetSessionV1Raw(): string {
  return js_nui_reset_session_v1();
}

export function getTextInputStateV1Raw(nodeSlot: number, nodeGeneration: number): string {
  return js_nui_get_text_input_state_v1(nodeSlot, nodeGeneration);
}

export function replaceTextInputV1Raw(
  nodeSlot: number,
  nodeGeneration: number,
  rangeStart: number,
  rangeEnd: number,
  text: string,
): string {
  return js_nui_replace_text_input_v1(nodeSlot, nodeGeneration, rangeStart, rangeEnd, text);
}

export function getCompositionBoundsV1Raw(nodeSlot: number, nodeGeneration: number): string {
  return js_nui_get_composition_bounds_v1(nodeSlot, nodeGeneration);
}

export function runV1Raw(title: string): string {
  return js_nui_run_v1(title);
}

/** Block on the native window event loop until the window closes. */
export function run(title: string): void {
  try {
    js_nui_run(title);
  } finally {
    resetNodeLifecycle();
    resetWindowTitle();
  }
}

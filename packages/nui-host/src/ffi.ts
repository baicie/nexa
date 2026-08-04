import { Ui } from "@nexa/protocol";

/**
 * Perry native-library FFI wrappers.
 *
 * Each wrapper must call the `js_*` symbol named in package.json so Perry
 * can bind the nativeLibrary dispatch table.
 */

declare function js_nui_create_node(type: number): bigint | number;
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
declare function js_nui_run(title: string): void;

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

export const NodeType = Ui.NodeType;
export type NodeType = Ui.NodeType;
export const PropertyId = Ui.PropertyId;
export type PropertyId = Ui.PropertyId;

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
  js_nui_insert(asU64(child), asU64(parent), asU64(before ?? 0n));
}

export function remove(node: bigint): void {
  js_nui_remove(asU64(node));
}

export function setText(node: bigint, text: string): void {
  js_nui_set_text(asU64(node), text);
}

export function setNumber(node: bigint, property: PropertyId, value: number): void {
  js_nui_set_number(asU64(node), property, value);
}

export function addClickListener(node: bigint, callback: () => void): void {
  js_nui_add_click_listener(asU64(node), callback);
}

/** Register a View+Text composite as a focusable single-line Input. */
export function registerInput(container: bigint, textNode: bigint, placeholder = ""): void {
  js_nui_register_input(asU64(container), asU64(textNode), placeholder);
}

export function addChangeListener(node: bigint, callback: (value: string) => void): void {
  js_nui_add_change_listener(asU64(node), callback);
}

export function addSubmitListener(node: bigint, callback: (value: string) => void): void {
  js_nui_add_submit_listener(asU64(node), callback);
}

/** Load a local PNG/JPEG (etc.) onto an Image node. */
export function setImage(node: bigint, path: string): void {
  js_nui_set_image(asU64(node), path);
}

export function commit(): void {
  js_nui_commit();
}

/** Block on the native window event loop until the window closes. */
export function run(title: string): void {
  js_nui_run(title);
}

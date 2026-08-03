/**
 * TypeScript surface for `import { ... } from "@nexa/nui-host"`.
 *
 * Each wrapper must call the `js_*` symbol named in package.json so Perry
 * can bind the nativeLibrary dispatch table.
 */

declare function js_nui_create_node(type: number): bigint;
declare function js_nui_create_text(text: string): bigint;
declare function js_nui_insert(child: bigint, parent: bigint, before: bigint): void;
declare function js_nui_remove(node: bigint): void;
declare function js_nui_set_text(node: bigint, text: string): void;
declare function js_nui_set_number(node: bigint, property: number, value: number): void;
declare function js_nui_add_click_listener(node: bigint, callback: () => void): void;
declare function js_nui_commit(): void;
declare function js_nui_run(title: string): void;

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
}

/** Pack RGBA into the Host color number (`0xRRGGBBAA`). */
export function rgba(r: number, g: number, b: number, a = 255): number {
  return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;
}

export function createNode(type: NodeType): bigint {
  return js_nui_create_node(type);
}

export function createText(text: string): bigint {
  return js_nui_create_text(text);
}

export function insert(child: bigint, parent: bigint, before?: bigint): void {
  js_nui_insert(child, parent, before ?? 0n);
}

export function remove(node: bigint): void {
  js_nui_remove(node);
}

export function setText(node: bigint, text: string): void {
  js_nui_set_text(node, text);
}

export function setNumber(node: bigint, property: PropertyId, value: number): void {
  js_nui_set_number(node, property, value);
}

export function addClickListener(node: bigint, callback: () => void): void {
  js_nui_add_click_listener(node, callback);
}

export function commit(): void {
  js_nui_commit();
}

/** Block on the native window event loop until the window closes. */
export function run(title: string): void {
  js_nui_run(title);
}

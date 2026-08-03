import {
  createHostElement,
  createHostRoot,
  createHostText,
  type NuiNode,
  setText,
} from "@nexa/nui-host";

export type { NuiNode };

export function element(tag: string): NuiNode {
  return createHostElement(tag);
}

export function text(data: string): NuiNode {
  return createHostText(data);
}

export function space(): NuiNode {
  return text(" ");
}

export function empty(): NuiNode {
  return text("");
}

export function claim_element(node: NuiNode): NuiNode {
  return node;
}

export function claim_text(node: NuiNode, data: string): NuiNode {
  set_data(node, data);
  return node;
}

export function set_data(textNode: NuiNode, data: string): void {
  textNode.text = String(data ?? "");
  setText(textNode.id, textNode.text);
}

export { createHostRoot as createRoot };

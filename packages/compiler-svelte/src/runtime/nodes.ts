import {
  clearChildren,
  createAdapterHostElement,
  createHostRoot,
  createHostText,
  insertBefore,
  resetSession,
  type NuiNode,
  setText,
} from "@nexa/nui-host";

export type { NuiNode };

function withTextContent(node: NuiNode): NuiNode {
  Object.defineProperty(node, "textContent", {
    configurable: true,
    get: () => node.children.map((child) => child.text).join(""),
    set: (value: unknown) => {
      clearChildren(node);
      const textValue = String(value ?? "");
      if (textValue.length > 0) insertBefore(node, createHostText(textValue), null);
    },
  });
  return node;
}

export function element(tag: string): NuiNode {
  return withTextContent(createAdapterHostElement(tag));
}

export const svg_element = element;

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

export function createRoot(): NuiNode {
  resetSession();
  return createHostRoot();
}

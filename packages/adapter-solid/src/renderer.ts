/**
 * Solid Universal Renderer host ops → NUI Host.
 */

import { createRenderer } from "solid-js/universal";
import {
  applyHostProp,
  createAdapterHostElement,
  createHostText,
  getFirstChild,
  getNextSibling,
  getParent,
  insertBefore,
  type NuiNode,
  removeNode as hostRemoveNode,
  setText,
} from "@nexa/nui-host";

export type { NuiNode };

export const solidHostConfig = {
  createElement(tag: string): NuiNode {
    return createAdapterHostElement(tag);
  },

  createTextNode(value: string): NuiNode {
    return createHostText(value);
  },

  replaceText(textNode: NuiNode, value: string): void {
    textNode.text = String(value ?? "");
    setText(textNode.id, textNode.text);
  },

  setProperty(node: NuiNode, name: string, value: unknown): void {
    if (name === "ref") {
      if (typeof value === "function") (value as (node: NuiNode) => void)(node);
      return;
    }
    applyHostProp(node, name, value);
  },

  insertNode(parent: NuiNode, node: NuiNode, anchor?: NuiNode): void {
    insertBefore(parent, node, anchor);
  },

  isTextNode(node: NuiNode): boolean {
    return node.isText;
  },

  removeNode(_parent: NuiNode, node: NuiNode): void {
    hostRemoveNode(node);
  },

  getParentNode(node: NuiNode): NuiNode | undefined {
    return getParent(node) ?? undefined;
  },

  getFirstChild(node: NuiNode): NuiNode | undefined {
    return getFirstChild(node) ?? undefined;
  },

  getNextSibling(node: NuiNode): NuiNode | undefined {
    return getNextSibling(node) ?? undefined;
  },
};

export const renderer = createRenderer<NuiNode>(solidHostConfig);

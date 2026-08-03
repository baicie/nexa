/**
 * Vue 3 custom renderer nodeOps → NUI Host.
 */

import type { RendererOptions } from "@vue/runtime-core";
import {
  applyHostProp,
  applyNumericProp,
  clearChildren,
  createHostComment,
  createHostElement,
  createHostText,
  getNextSibling,
  getParent,
  insertBefore,
  normalizeTag,
  type NuiNode,
  removeNode,
  setText,
} from "@nexa/nui-host";

export type { NuiNode };

export const nodeOps: RendererOptions<NuiNode, NuiNode> = {
  createElement(type: string): NuiNode {
    return createHostElement(type);
  },

  createText(text: string): NuiNode {
    return createHostText(text);
  },

  createComment(text: string): NuiNode {
    return createHostComment(text);
  },

  insert(child: NuiNode, parent: NuiNode, anchor: NuiNode | null = null): void {
    insertBefore(parent, child, anchor);
  },

  remove(child: NuiNode): void {
    removeNode(child);
  },

  setText(node: NuiNode, text: string): void {
    node.text = String(text ?? "");
    if (!node.isComment) {
      setText(node.id, node.text);
    }
  },

  setElementText(el: NuiNode, text: string): void {
    clearChildren(el);
    if (el.isText || normalizeTag(el.tag) === "text") {
      el.text = String(text ?? "");
      setText(el.id, el.text);
      return;
    }
    const textNode = createHostText(text);
    insertBefore(el, textNode, null);
  },

  parentNode(node: NuiNode): NuiNode | null {
    return getParent(node);
  },

  nextSibling(node: NuiNode): NuiNode | null {
    return getNextSibling(node);
  },

  patchProp(el: NuiNode, key: string, _prev: unknown, next: unknown): void {
    if (key === "style" && next && typeof next === "object") {
      for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
        applyNumericProp(el, k, v);
      }
      return;
    }
    applyHostProp(el, key, next);
  },
};

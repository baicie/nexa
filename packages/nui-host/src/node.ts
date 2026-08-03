import {
  createNode,
  createText,
  NodeType,
  PropertyId,
  rgba,
  setNumber,
} from "./ffi";
import { applyElementDefaults } from "./defaults";
import { normalizeTag } from "./tag";
import type { NuiNode } from "./types";

export type { NuiNode };
export { normalizeTag };

function blankNode(
  id: bigint,
  tag: string,
  opts: { isText?: boolean; isComment?: boolean; text?: string } = {},
): NuiNode {
  return {
    id,
    tag,
    isText: opts.isText ?? false,
    ...(opts.isComment !== undefined ? { isComment: opts.isComment } : {}),
    parent: null,
    children: [],
    text: opts.text ?? "",
  };
}

export function createHostElement(tag: string): NuiNode {
  const normalized = normalizeTag(tag);
  const nodeType =
    normalized === "scroll"
      ? NodeType.Scroll
      : normalized === "text"
        ? NodeType.Text
        : NodeType.View;
  const id =
    nodeType === NodeType.Text ? createText("") : createNode(nodeType);
  const node = blankNode(id, normalized, {
    isText: nodeType === NodeType.Text,
    isComment: false,
  });
  applyElementDefaults(node);
  return node;
}

export function createHostText(value: string): NuiNode {
  const text = String(value ?? "");
  const id = createText(text);
  setNumber(id, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
  return blankNode(id, "#text", { isText: true, isComment: false, text });
}

export function createHostComment(value = ""): NuiNode {
  const id = createText("");
  return blankNode(id, "#comment", {
    isText: true,
    isComment: true,
    text: String(value ?? ""),
  });
}

export function createHostRoot(): NuiNode {
  const id = createNode(NodeType.View);
  setNumber(id, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));
  setNumber(id, PropertyId.FlexDirection, 0);
  return blankNode(id, "view", { isComment: false });
}

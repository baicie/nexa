import {
  createNode,
  createText,
  insert,
  NodeType,
  PropertyId,
  registerInput,
  rgba,
  setNumber,
} from "./ffi";
import { applyElementDefaults } from "./defaults";
import { NexaHostError } from "./errors";
import { handleRefFromLegacyPacked } from "./handle";
import { registerButtonV1 } from "./protocol";
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
    hostProps: {},
    hostListeners: {},
  };
}

function createHostElementWithWindowType(tag: string, windowType: NodeType): NuiNode {
  const normalized = normalizeTag(tag);
  if (normalized === "input") {
    return createHostInput();
  }
  if (normalized === "textarea") {
    return createHostTextArea();
  }
  const nodeType =
    normalized === "window"
      ? windowType
      : normalized === "scroll"
        ? NodeType.Scroll
        : normalized === "text"
          ? NodeType.Text
          : normalized === "image"
            ? NodeType.Image
            : NodeType.View;
  const id = nodeType === NodeType.Text ? createText("") : createNode(nodeType);
  const node = blankNode(id, normalized, {
    isText: nodeType === NodeType.Text,
    isComment: false,
  });
  applyElementDefaults(node);
  if (normalized === "button") {
    const result = registerButtonV1(handleRefFromLegacyPacked(node.id));
    if (!result.ok) throw new NexaHostError(result.error);
  }
  return node;
}

export function createHostElement(tag: string): NuiNode {
  return createHostElementWithWindowType(tag, NodeType.Root);
}

/** Adapter Window content mounted below the renderer-owned viewport Root. */
export function createAdapterHostElement(tag: string): NuiNode {
  const normalized = normalizeTag(tag);
  const node = createHostElementWithWindowType(normalized, NodeType.View);
  if (normalized === "window") {
    setNumber(node.id, PropertyId.FlexGrow, 1);
  }
  return node;
}

/** Composite single-line Input: View chrome + Text child. */
export function createHostInput(placeholder = ""): NuiNode {
  const id = createNode(NodeType.View);
  const node = blankNode(id, "input", { isComment: false });
  setNumber(id, PropertyId.Padding, 10);
  setNumber(id, PropertyId.BorderRadius, 8);
  setNumber(id, PropertyId.BackgroundColor, rgba(0xff, 0xff, 0xff));
  setNumber(id, PropertyId.Height, 36);
  setNumber(id, PropertyId.Width, 220);

  const text = createHostText("");
  text.parent = node;
  node.children.push(text);
  insert(text.id, id);
  registerInput(id, text.id, placeholder);
  return node;
}

/** Composite multiline TextArea: Scroll viewport + Text child. */
export function createHostTextArea(placeholder = ""): NuiNode {
  const id = createNode(NodeType.Scroll);
  const node = blankNode(id, "textarea", { isComment: false });
  setNumber(id, PropertyId.FlexDirection, 0);
  setNumber(id, PropertyId.Padding, 10);
  setNumber(id, PropertyId.BorderRadius, 8);
  setNumber(id, PropertyId.BackgroundColor, rgba(0xff, 0xff, 0xff));
  setNumber(id, PropertyId.Height, 160);
  setNumber(id, PropertyId.Width, 320);

  const text = createHostText("");
  text.parent = node;
  node.children.push(text);
  insert(text.id, id);
  registerInput(id, text.id, placeholder);
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
  const id = createNode(NodeType.Root);
  setNumber(id, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));
  setNumber(id, PropertyId.FlexDirection, 0);
  setNumber(id, PropertyId.AlignItems, 3);
  return blankNode(id, "view", { isComment: false });
}

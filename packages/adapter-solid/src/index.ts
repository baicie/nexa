/**
 * Solid Universal Renderer → NUI Host (Slice 5).
 *
 * Babel must compile JSX with:
 *   babel-preset-solid { generate: "universal", moduleName: "@nexa/adapter-solid" }
 */

import { createRenderer } from "solid-js/universal";
import {
  addClickListener,
  commit,
  createNode,
  createText,
  insert as hostInsert,
  NodeType,
  PropertyId,
  remove as hostRemove,
  rgba,
  run,
  setNumber,
  setText,
} from "@nexa/nui-host";

export type NuiNode = {
  id: bigint;
  tag: string;
  isText: boolean;
  parent: NuiNode | null;
  children: NuiNode[];
  text: string;
};

let windowTitle = "Nexa UI";

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function applyElementDefaults(node: NuiNode): void {
  const tag = normalizeTag(node.tag);
  switch (tag) {
    case "window":
      setNumber(node.id, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));
      setNumber(node.id, PropertyId.FlexDirection, 0);
      break;
    case "column":
      setNumber(node.id, PropertyId.FlexDirection, 0);
      break;
    case "row":
      setNumber(node.id, PropertyId.FlexDirection, 1);
      break;
    case "button":
      setNumber(node.id, PropertyId.Padding, 12);
      setNumber(node.id, PropertyId.BorderRadius, 12);
      setNumber(node.id, PropertyId.BackgroundColor, rgba(0x1f, 0x6f, 0xeb));
      break;
    case "text":
      setNumber(node.id, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
      setNumber(node.id, PropertyId.FontSize, 16);
      break;
    case "scroll":
      setNumber(node.id, PropertyId.FlexDirection, 0);
      break;
    default:
      break;
  }
}

function applyNumericProp(node: NuiNode, name: string, value: unknown): void {
  if (typeof value !== "number") {
    return;
  }
  switch (name) {
    case "width":
      setNumber(node.id, PropertyId.Width, value);
      break;
    case "height":
      setNumber(node.id, PropertyId.Height, value);
      break;
    case "padding":
      setNumber(node.id, PropertyId.Padding, value);
      break;
    case "gap":
      setNumber(node.id, PropertyId.Gap, value);
      break;
    case "fontSize":
      setNumber(node.id, PropertyId.FontSize, value);
      break;
    case "borderRadius":
      setNumber(node.id, PropertyId.BorderRadius, value);
      break;
    case "color":
      setNumber(node.id, PropertyId.TextColor, value);
      break;
    case "backgroundColor":
      setNumber(node.id, PropertyId.BackgroundColor, value);
      break;
    default:
      break;
  }
}

const renderer = createRenderer<NuiNode>({
  createElement(tag: string): NuiNode {
    const normalized = normalizeTag(tag);
    const nodeType =
      normalized === "scroll"
        ? NodeType.Scroll
        : normalized === "text"
          ? NodeType.Text
          : NodeType.View;

    const id =
      nodeType === NodeType.Text ? createText("") : createNode(nodeType);

    const node: NuiNode = {
      id,
      tag: normalized,
      isText: nodeType === NodeType.Text,
      parent: null,
      children: [],
      text: "",
    };
    applyElementDefaults(node);
    return node;
  },

  createTextNode(value: string): NuiNode {
    const id = createText(String(value ?? ""));
    setNumber(id, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
    return {
      id,
      tag: "#text",
      isText: true,
      parent: null,
      children: [],
      text: String(value ?? ""),
    };
  },

  replaceText(textNode: NuiNode, value: string): void {
    textNode.text = String(value ?? "");
    setText(textNode.id, textNode.text);
  },

  setProperty(node: NuiNode, name: string, value: unknown): void {
    if (name === "children" || name === "ref") {
      return;
    }

    if (name === "title" && typeof value === "string") {
      windowTitle = value;
      return;
    }

    if (name === "style" && value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        applyNumericProp(node, k, v);
      }
      return;
    }

    const lower = name.toLowerCase();
    if (lower === "onclick" || name === "onClick") {
      if (typeof value === "function") {
        addClickListener(node.id, value as () => void);
      }
      return;
    }

    if (name.startsWith("on") && typeof value === "function") {
      // Only click is wired in Slice 5 Host.
      if (lower === "onclick") {
        addClickListener(node.id, value as () => void);
      }
      return;
    }

    applyNumericProp(node, name, value);

    if (node.isText && (name === "textContent" || name === "text")) {
      node.text = String(value ?? "");
      setText(node.id, node.text);
    }
  },

  insertNode(parent: NuiNode, node: NuiNode, anchor: NuiNode | null): void {
    if (node.parent) {
      node.parent.children = node.parent.children.filter((c) => c !== node);
      // Host reparent handled by insert_before.
    }

    node.parent = parent;
    const beforeId = anchor?.id;
    if (anchor) {
      const idx = parent.children.indexOf(anchor);
      if (idx >= 0) {
        parent.children.splice(idx, 0, node);
      } else {
        parent.children.push(node);
      }
    } else {
      parent.children.push(node);
    }
    hostInsert(node.id, parent.id, beforeId);
  },

  isTextNode(node: NuiNode): boolean {
    return node.isText;
  },

  removeNode(parent: NuiNode, node: NuiNode): void {
    parent.children = parent.children.filter((c) => c !== node);
    if (node.parent === parent) {
      node.parent = null;
    }
    hostRemove(node.id);
  },

  getParentNode(node: NuiNode): NuiNode | null {
    return node.parent;
  },

  getFirstChild(node: NuiNode): NuiNode | null {
    return node.children[0] ?? null;
  },

  getNextSibling(node: NuiNode): NuiNode | null {
    const parent = node.parent;
    if (!parent) {
      return null;
    }
    const idx = parent.children.indexOf(node);
    if (idx < 0) {
      return null;
    }
    return parent.children[idx + 1] ?? null;
  },
});

const {
  render: solidRender,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
} = renderer;

/**
 * Mount a Solid root and block on the native window event loop.
 * The app tree should include a `<window title="...">` root element.
 */
export function render(code: () => unknown, mount?: NuiNode): void {
  windowTitle = "Nexa UI";
  const root =
    mount ??
    (() => {
      const id = createNode(NodeType.View);
      setNumber(id, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));
      setNumber(id, PropertyId.FlexDirection, 0);
      return {
        id,
        tag: "view",
        isText: false,
        parent: null,
        children: [],
        text: "",
      } satisfies NuiNode;
    })();

  solidRender(code, root);
  commit();
  run(windowTitle);
}

export {
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
  use,
};

export {
  For,
  Show,
  Index,
  Switch,
  Match,
  ErrorBoundary,
  Suspense,
  SuspenseList,
} from "solid-js";

export {
  createSignal,
  createEffect,
  createMemo,
  createResource,
  onCleanup,
  onMount,
  batch,
  untrack,
} from "solid-js";

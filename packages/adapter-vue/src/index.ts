/**
 * Vue 3 custom renderer → NUI Host (Slice 6 / ADR-004 M4).
 *
 * Prefer `@vue/runtime-core` (no DOM). Apps should use `h()` / render
 * functions so Perry can AOT without `@vue/compiler-dom`.
 */

import {
  createRenderer,
  type RendererOptions,
} from "@vue/runtime-core";
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
  isComment: boolean;
  parent: NuiNode | null;
  children: NuiNode[];
  text: string;
};

let windowTitle = "Nexa UI";

function normalizeTag(tag: string): string {
  return String(tag).trim().toLowerCase();
}

function applyElementDefaults(node: NuiNode): void {
  switch (normalizeTag(node.tag)) {
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

function unlink(node: NuiNode): void {
  if (!node.parent) {
    return;
  }
  node.parent.children = node.parent.children.filter((c) => c !== node);
  node.parent = null;
}

function linkBefore(parent: NuiNode, node: NuiNode, anchor: NuiNode | null): void {
  unlink(node);
  node.parent = parent;
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
}

const nodeOps: RendererOptions<NuiNode, NuiNode> = {
  createElement(type: string): NuiNode {
    const tag = normalizeTag(type);
    const nodeType =
      tag === "scroll" ? NodeType.Scroll : tag === "text" ? NodeType.Text : NodeType.View;
    const id = nodeType === NodeType.Text ? createText("") : createNode(nodeType);
    const node: NuiNode = {
      id,
      tag,
      isText: nodeType === NodeType.Text,
      isComment: false,
      parent: null,
      children: [],
      text: "",
    };
    applyElementDefaults(node);
    return node;
  },

  createText(text: string): NuiNode {
    const id = createText(String(text ?? ""));
    setNumber(id, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
    return {
      id,
      tag: "#text",
      isText: true,
      isComment: false,
      parent: null,
      children: [],
      text: String(text ?? ""),
    };
  },

  createComment(text: string): NuiNode {
    // Invisible anchor for Fragment / v-if; keep a Host text so insertBefore works.
    const id = createText("");
    return {
      id,
      tag: "#comment",
      isText: true,
      isComment: true,
      parent: null,
      children: [],
      text: String(text ?? ""),
    };
  },

  insert(child: NuiNode, parent: NuiNode, anchor: NuiNode | null = null): void {
    linkBefore(parent, child, anchor);
    hostInsert(child.id, parent.id, anchor?.id);
  },

  remove(child: NuiNode): void {
    unlink(child);
    hostRemove(child.id);
  },

  setText(node: NuiNode, text: string): void {
    node.text = String(text ?? "");
    if (!node.isComment) {
      setText(node.id, node.text);
    }
  },

  setElementText(el: NuiNode, text: string): void {
    // Replace element children with a single text content on Text-like nodes.
    for (const child of [...el.children]) {
      unlink(child);
      hostRemove(child.id);
    }
    if (el.isText || normalizeTag(el.tag) === "text") {
      el.text = String(text ?? "");
      setText(el.id, el.text);
      return;
    }
    const textNode = nodeOps.createText(text);
    linkBefore(el, textNode, null);
    hostInsert(textNode.id, el.id);
  },

  parentNode(node: NuiNode): NuiNode | null {
    return node.parent;
  },

  nextSibling(node: NuiNode): NuiNode | null {
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

  patchProp(
    el: NuiNode,
    key: string,
    _prev: unknown,
    next: unknown,
  ): void {
    if (key === "title" && typeof next === "string") {
      windowTitle = next;
      return;
    }

    if (key === "style" && next && typeof next === "object") {
      for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
        applyNumericProp(el, k, v);
      }
      return;
    }

    const lower = key.toLowerCase();
    if (lower === "onclick" || key === "onClick") {
      if (typeof next === "function") {
        addClickListener(el.id, next as () => void);
      }
      return;
    }

    if (key.startsWith("on") && typeof next === "function") {
      if (lower === "onclick") {
        addClickListener(el.id, next as () => void);
      }
      return;
    }

    applyNumericProp(el, key, next);
  },
};

const { createApp: baseCreateApp, render } = createRenderer(nodeOps);

function createMountRoot(): NuiNode {
  const id = createNode(NodeType.View);
  setNumber(id, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));
  setNumber(id, PropertyId.FlexDirection, 0);
  return {
    id,
    tag: "view",
    isText: false,
    isComment: false,
    parent: null,
    children: [],
    text: "",
  };
}

/** createApp that mounts onto Host and blocks on the native event loop. */
export function createApp(...args: Parameters<typeof baseCreateApp>) {
  const app = baseCreateApp(...args);
  const originalMount = app.mount.bind(app);
  app.mount = ((_rootContainer?: unknown) => {
    windowTitle = "Nexa UI";
    const root = createMountRoot();
    originalMount(root);
    commit();
    run(windowTitle);
    return app as never;
  }) as typeof app.mount;
  return app;
}

export { render };

export {
  h,
  Fragment,
  Text,
  Comment,
  ref,
  reactive,
  computed,
  watch,
  watchEffect,
  onMounted,
  onUnmounted,
  defineComponent,
  nextTick,
} from "@vue/runtime-core";

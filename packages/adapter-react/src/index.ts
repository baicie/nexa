/**
 * React reconciler → NUI Host (Slice 7 / ADR-004 M5).
 *
 * Locked: react@18.3 + react-reconciler@0.29 (mutation mode).
 */

import React from "react";
import Reconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";
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

type Props = Record<string, unknown>;

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
  if (typeof value !== "number") return;
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

function applyProps(node: NuiNode, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || value == null) continue;
    if (key === "title" && typeof value === "string") {
      windowTitle = value;
      continue;
    }
    if (key === "style" && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        applyNumericProp(node, k, v);
      }
      continue;
    }
    const lower = key.toLowerCase();
    if ((lower === "onclick" || key === "onClick") && typeof value === "function") {
      addClickListener(node.id, value as () => void);
      continue;
    }
    applyNumericProp(node, key, value);
  }
}

function unlink(node: NuiNode): void {
  if (!node.parent) return;
  node.parent.children = node.parent.children.filter((c) => c !== node);
  node.parent = null;
}

function linkAppend(parent: NuiNode, child: NuiNode): void {
  unlink(child);
  child.parent = parent;
  parent.children.push(child);
  hostInsert(child.id, parent.id);
}

function linkBefore(parent: NuiNode, child: NuiNode, before: NuiNode | null): void {
  unlink(child);
  child.parent = parent;
  if (before) {
    const idx = parent.children.indexOf(before);
    if (idx >= 0) parent.children.splice(idx, 0, child);
    else parent.children.push(child);
    hostInsert(child.id, parent.id, before.id);
  } else {
    parent.children.push(child);
    hostInsert(child.id, parent.id);
  }
}

const reconciler = Reconciler({
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,
  supportsMicrotasks: false,

  getRootHostContext() {
    return {};
  },
  getChildHostContext(parent: object) {
    return parent;
  },
  getPublicInstance(instance: NuiNode) {
    return instance;
  },
  prepareForCommit() {
    return null;
  },
  resetAfterCommit() {},
  createInstance(type: string, props: Props): NuiNode {
    const tag = normalizeTag(type);
    const nodeType =
      tag === "scroll" ? NodeType.Scroll : tag === "text" ? NodeType.Text : NodeType.View;
    const id = nodeType === NodeType.Text ? createText("") : createNode(nodeType);
    const node: NuiNode = {
      id,
      tag,
      isText: nodeType === NodeType.Text,
      parent: null,
      children: [],
      text: "",
    };
    applyElementDefaults(node);
    applyProps(node, props);
    return node;
  },
  appendInitialChild(parent: NuiNode, child: NuiNode) {
    linkAppend(parent, child);
  },
  finalizeInitialChildren() {
    return false;
  },
  prepareUpdate(_instance: NuiNode, _type: string, oldProps: Props, newProps: Props) {
    return { oldProps, newProps };
  },
  shouldSetTextContent() {
    return false;
  },
  createTextInstance(text: string): NuiNode {
    const id = createText(String(text ?? ""));
    setNumber(id, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
    return {
      id,
      tag: "#text",
      isText: true,
      parent: null,
      children: [],
      text: String(text ?? ""),
    };
  },
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  getCurrentUpdatePriority() {
    return DefaultEventPriority;
  },
  resolveUpdatePriority() {
    return DefaultEventPriority;
  },
  setCurrentUpdatePriority() {},
  now: Date.now,
  scheduleMicrotask(fn: () => void) {
    queueMicrotask(fn);
  },

  appendChild(parent: NuiNode, child: NuiNode) {
    linkAppend(parent, child);
  },
  appendChildToContainer(container: NuiNode, child: NuiNode) {
    linkAppend(container, child);
  },
  insertBefore(parent: NuiNode, child: NuiNode, before: NuiNode) {
    linkBefore(parent, child, before);
  },
  insertInContainerBefore(container: NuiNode, child: NuiNode, before: NuiNode) {
    linkBefore(container, child, before);
  },
  removeChild(parent: NuiNode, child: NuiNode) {
    unlink(child);
    hostRemove(child.id);
  },
  removeChildFromContainer(container: NuiNode, child: NuiNode) {
    unlink(child);
    hostRemove(child.id);
  },
  commitUpdate(instance: NuiNode, _payload: unknown, _type: string, _old: Props, newProps: Props) {
    applyProps(instance, newProps);
  },
  commitTextUpdate(textInstance: NuiNode, _old: string, newText: string) {
    textInstance.text = newText;
    setText(textInstance.id, newText);
  },
  clearContainer(container: NuiNode) {
    for (const child of [...container.children]) {
      unlink(child);
      hostRemove(child.id);
    }
  },
  hideInstance() {},
  unhideInstance() {},
  hideTextInstance() {},
  unhideTextInstance() {},
  resetTextContent() {},
  detachDeletedInstance() {},
  maySuspendCommit() {
    return false;
  },
  preloadInstance() {
    return true;
  },
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady() {
    return null;
  },
} as never);

function createRootContainer(): NuiNode {
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
  };
}

/** Render a React element tree and block on the native window loop. */
export function render(element: React.ReactNode): void {
  windowTitle = "Nexa UI";
  const container = createRootContainer();
  const root = reconciler.createContainer(
    container,
    0,
    null,
    false,
    null,
    "",
    () => {},
    null,
  );
  reconciler.updateContainer(element, root, null, () => {});
  commit();
  run(windowTitle);
}

export { React };
export default React;
export {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useContext,
  createContext,
  createElement,
  Fragment,
  Component,
} from "react";

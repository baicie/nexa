/**
 * React reconciler → NUI Host (Slice 7 / ADR-004 M5).
 *
 * Locked: react@18.3 + react-reconciler@0.29 (mutation mode).
 */

import React from "react";
import Reconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";
import {
  applyHostProps,
  clearChildren,
  commit,
  createHostElement,
  createHostRoot,
  createHostText,
  getWindowTitle,
  insertBefore as hostInsertBefore,
  type NuiNode,
  removeNode,
  resetWindowTitle,
  run,
  setText,
} from "@nexa/nui-host";

export type { NuiNode };

type Props = Record<string, unknown>;

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare const console: { error(...args: unknown[]): void; log(...args: unknown[]): void };

function scheduleTimeout(fn: (...args: unknown[]) => void, delay?: number): number {
  return setTimeout(fn, delay ?? 0) as unknown as number;
}

function cancelTimeout(id: number): void {
  clearTimeout(id);
}

function scheduleMicrotask(fn: () => void): void {
  scheduleTimeout(fn, 0);
}

function linkAppend(parent: NuiNode, child: NuiNode): void {
  hostInsertBefore(parent, child, null);
}

/**
 * Perry + winit does not pump JS timers while the native loop runs.
 * Flush React updates synchronously inside Host event callbacks.
 */
function wrapHostProps(props: Props): Props {
  const next: Props = { ...props };
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== "function" || !/^on[A-Z]/.test(key)) {
      continue;
    }
    const handler = value as (...args: unknown[]) => void;
    next[key] = (...args: unknown[]) => {
      reconciler.flushSync(() => {
        handler(...args);
      });
    };
  }
  return next;
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
    const node = createHostElement(type);
    applyHostProps(node, wrapHostProps(props));
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
    return createHostText(text);
  },
  scheduleTimeout,
  cancelTimeout,
  getCurrentEventPriority() {
    return DefaultEventPriority;
  },
  getCurrentUpdatePriority() {
    return DefaultEventPriority;
  },
  resolveUpdatePriority() {
    return DefaultEventPriority;
  },
  setCurrentUpdatePriority() {},
  now() {
    return 0;
  },
  scheduleMicrotask,

  appendChild(parent: NuiNode, child: NuiNode) {
    linkAppend(parent, child);
  },
  appendChildToContainer(container: NuiNode, child: NuiNode) {
    linkAppend(container, child);
  },
  insertBefore(parent: NuiNode, child: NuiNode, before: NuiNode) {
    hostInsertBefore(parent, child, before);
  },
  insertInContainerBefore(container: NuiNode, child: NuiNode, before: NuiNode) {
    hostInsertBefore(container, child, before);
  },
  removeChild(_parent: NuiNode, child: NuiNode) {
    removeNode(child);
  },
  removeChildFromContainer(_container: NuiNode, child: NuiNode) {
    removeNode(child);
  },
  commitUpdate(instance: NuiNode, _payload: unknown, _type: string, _old: Props, newProps: Props) {
    applyHostProps(instance, wrapHostProps(newProps));
  },
  commitTextUpdate(textInstance: NuiNode, _old: string, newText: string) {
    textInstance.text = newText;
    setText(textInstance.id, newText);
  },
  clearContainer(container: NuiNode) {
    clearChildren(container);
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

export function render(element: React.ReactNode): void {
  resetWindowTitle();
  const container = createHostRoot();
  const root = reconciler.createContainer(
    container,
    0,
    null,
    false,
    null,
    "",
    (error: unknown) => {
      console.error("react-reconciler recoverable error:", error);
    },
    null,
  );
  reconciler.flushSync(() => {
    reconciler.updateContainer(element, root, null, () => {});
  });
  commit();
  run(getWindowTitle());
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

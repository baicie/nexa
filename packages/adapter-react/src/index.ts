/**
 * React reconciler → NUI Host (Slice 7 / ADR-004 M5).
 *
 * Locked: react@18.3 + react-reconciler@0.29 (mutation mode).
 */

import React from "react";
import Reconciler from "react-reconciler";
import { DiscreteEventPriority, DefaultEventPriority } from "react-reconciler/constants.js";
import {
  applyHostProps,
  clearChildren,
  commit,
  createAdapterHostElement,
  createHostRoot,
  createHostText,
  getWindowTitle,
  insertBefore as hostInsertBefore,
  type NuiNode,
  removeNode,
  resetSession,
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
  // Perry exports Promise continuations, while queueMicrotask is not part of
  // its global native symbol set. Promise callbacks still run at the same
  // microtask boundary expected by the reconciler.
  void Promise.resolve().then(fn);
}

function linkAppend(parent: NuiNode, child: NuiNode): void {
  hostInsertBefore(parent, child, null);
}

const reconciler = Reconciler({
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,
  supportsMicrotasks: true,

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
    const node = createAdapterHostElement(type);
    applyHostProps(node, props);
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
    return DiscreteEventPriority;
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
    applyHostProps(instance, newProps);
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

export type ReactHostRoot = {
  readonly container: NuiNode;
  render(element: React.ReactNode): void;
  unmount(): void;
};

export function createRoot(container?: NuiNode): ReactHostRoot {
  if (container === undefined) resetSession();
  const hostContainer = container ?? createHostRoot();
  const reconcilerRoot = reconciler.createContainer(
    hostContainer,
    1,
    null,
    false,
    null,
    "",
    (error: unknown) => {
      console.error("react-reconciler recoverable error:", error);
    },
    null,
  );
  const update = (element: React.ReactNode): void => {
    reconciler.flushSync(() => {
      reconciler.updateContainer(element, reconcilerRoot, null, () => {});
    });
  };
  return {
    container: hostContainer,
    render: update,
    unmount: () => update(null),
  };
}

export function render(element: React.ReactNode): void {
  const root = createRoot();
  root.render(element);
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

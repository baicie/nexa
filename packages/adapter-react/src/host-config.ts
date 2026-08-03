/**
 * React reconciler HostConfig → NUI Host.
 */

import Reconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants.js";
import {
  applyHostProps,
  clearChildren,
  createHostElement,
  createHostText,
  insertBefore as hostInsertBefore,
  type NuiNode,
  removeNode,
  setText,
} from "@nexa/nui-host";

export type { NuiNode };

type Props = Record<string, unknown>;

/** Ambient timers (runtime provides these; avoid requiring DOM lib). */
declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function queueMicrotask(callback: () => void): void;

function scheduleTimeout(fn: (...args: unknown[]) => void, delay?: number): number {
  return setTimeout(fn, delay ?? 0) as unknown as number;
}

function cancelTimeout(id: number): void {
  clearTimeout(id);
}

function linkAppend(parent: NuiNode, child: NuiNode): void {
  hostInsertBefore(parent, child, null);
}

export const reconciler = Reconciler({
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

/**
 * Mount a Minimal TSX tree onto the NUI Host and run the native window.
 */

import {
  commit,
  getWindowTitle,
  resetWindowTitle,
  run,
} from "@nexa/nui-host";

import type { NexaElement } from "../jsx-runtime";
import type { PrimitiveElement } from "../primitives";
import { mountNode } from "./materialize";

type Component = (props: Record<string, unknown>) => unknown;

/**
 * Mount a root component or element, then block on the native event loop.
 *
 * Reactive text: pass a `signal` (not `.value`) or `() => string` as children
 * so updates call `setText` without rebuilding the native tree.
 */
export function mount(root: Component | NexaElement | PrimitiveElement): void {
  resetWindowTitle();
  const tree = typeof root === "function" ? root({}) : root;
  const hostRoot = mountNode(tree);
  if (hostRoot === null) {
    throw new Error("@nexa/ui mount() produced no root node — wrap the app in <Window>");
  }
  commit();
  run(getWindowTitle());
}

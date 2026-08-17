/**
 * Solid Universal Renderer → NUI Host (Slice 5).
 *
 * Babel must compile JSX with:
 *   babel-preset-solid { generate: "universal", moduleName: "@nexa/adapter-solid" }
 */

export type { NuiNode } from "./renderer";
export { mount, render } from "./render";

import { renderer } from "./renderer";

export { solidHostConfig } from "./renderer";

export const {
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

export { For, Show, Index, Switch, Match, ErrorBoundary, Suspense, SuspenseList } from "solid-js";

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

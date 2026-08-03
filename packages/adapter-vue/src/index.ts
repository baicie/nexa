/**
 * Vue 3 custom renderer → NUI Host (Slice 6 / ADR-004 M4).
 *
 * Prefer `@vue/runtime-core` (no DOM). Apps should use `h()` / render
 * functions so Perry can AOT without `@vue/compiler-dom`.
 */

export type { NuiNode } from "./node-ops";
export { createApp, render } from "./create-app";

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

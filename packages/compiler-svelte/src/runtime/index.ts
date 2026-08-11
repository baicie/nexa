/**
 * Minimal Svelte-like runtime that maps to NUI Host.
 *
 * Build scripts compile `.svelte` with `svelte/compiler`, then rewrite
 * imports from `svelte/internal` to `@nexa/compiler-svelte/runtime`.
 */

import { commit, getWindowTitle, run, setWindowTitle } from "@nexa/nui-host";

export type { NuiNode } from "./nodes";
export {
  element,
  svg_element,
  text,
  space,
  empty,
  claim_element,
  claim_text,
  set_data,
  createRoot,
} from "./nodes";
export { attr, set_style } from "./attrs";
export { append, insert, listen, detach } from "./tree";
export {
  add_legacy_event_listener,
  child,
  createClassComponent,
  event,
  from_html,
  from_svg,
  get,
  if_block as if,
  mutable_source,
  pop,
  push,
  reset,
  set,
  set_attribute,
  set_text,
  sibling,
  template_effect,
  update_legacy_props,
} from "./client";
export {
  destroy_block,
  SvelteComponent,
  init,
  mount_component,
  create_component,
  noop,
  safe_not_equal,
} from "./component";

export function runHost(title?: string): void {
  commit();
  run(title ?? getWindowTitle());
}

export { getWindowTitle, setWindowTitle };

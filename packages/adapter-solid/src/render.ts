import {
  commit,
  clearChildren,
  createHostRoot,
  getWindowTitle,
  resetSession,
  resetWindowTitle,
  run,
  type NuiNode,
} from "@nexa/nui-host";

import { renderer } from "./renderer";

/**
 * Mount a Solid root and block on the native window event loop.
 * The app tree should include a `<window title="...">` root element.
 */
export function render(code: () => unknown, mount?: NuiNode): void {
  if (mount === undefined) resetSession();
  else resetWindowTitle();
  const root = mount ?? createHostRoot();
  renderer.render(code as () => NuiNode, root);
  commit();
  run(getWindowTitle());
}

/** Mount without entering the native event loop and return an idempotent disposer. */
export function mount(
  code: () => unknown,
  container = createHostRoot(),
): { readonly container: NuiNode; dispose(): void } {
  resetWindowTitle();
  const dispose = renderer.render(code as () => NuiNode, container);
  commit();
  let disposed = false;
  return {
    container,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      dispose();
      clearChildren(container);
      commit();
    },
  };
}

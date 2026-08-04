import {
  commit,
  createHostRoot,
  getWindowTitle,
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
  resetWindowTitle();
  const root = mount ?? createHostRoot();
  renderer.render(code as () => NuiNode, root);
  commit();
  run(getWindowTitle());
}

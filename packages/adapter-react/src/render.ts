import type React from "react";
import {
  commit,
  createHostRoot,
  getWindowTitle,
  resetWindowTitle,
  run,
} from "@nexa/nui-host";

import { reconciler } from "./host-config";

/** Render a React element tree and block on the native window loop. */
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
    () => {},
    null,
  );
  reconciler.updateContainer(element, root, null, () => {});
  commit();
  run(getWindowTitle());
}

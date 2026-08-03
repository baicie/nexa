import {
  commit,
  createHostRoot,
  getWindowTitle,
  resetWindowTitle,
  run,
} from "@nexa/nui-host";
import { createRenderer, type App } from "@vue/runtime-core";

import { nodeOps } from "./node-ops";

const { createApp: baseCreateApp, render } = createRenderer(nodeOps);

export type HostApp = App & {
  /** Mount onto Host; container arg is ignored (Host creates the root). */
  mount: (rootContainer?: unknown) => HostApp;
};

/** createApp that mounts onto Host and blocks on the native event loop. */
export function createApp(...args: Parameters<typeof baseCreateApp>): HostApp {
  const app = baseCreateApp(...args) as HostApp;
  const originalMount = app.mount.bind(app);
  app.mount = ((_rootContainer?: unknown) => {
    resetWindowTitle();
    const root = createHostRoot();
    originalMount(root);
    commit();
    run(getWindowTitle());
    return app;
  }) as HostApp["mount"];
  return app;
}

export { render };

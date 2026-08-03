import type { NuiNode } from "@nexa/nui-host";

type Fragment = {
  c?: () => void;
  m?: (t: NuiNode, a: NuiNode | null) => void;
};

type ComponentBag = {
  $$: {
    fragment?: Fragment;
    ctx?: unknown[];
  };
};

export function destroy_block(fn: (() => void) | null | undefined): void {
  fn?.();
}

export function init(
  component: ComponentBag,
  options: { target?: NuiNode; props?: Record<string, unknown> },
): void {
  const fragment = component.$$.fragment;
  fragment?.c?.();
  const target = options.target!;
  fragment?.m?.(target, null);
}

export function mount_component(
  component: ComponentBag,
  target: NuiNode,
  anchor: NuiNode | null,
): void {
  component.$$.fragment?.m?.(target, anchor);
}

export function create_component(component: ComponentBag): void {
  component.$$.fragment?.c?.();
}

export function noop(): void {}

export function safe_not_equal(a: unknown, b: unknown): boolean {
  return a != a ? b == b : a !== b || (a !== null && typeof a === "object") || typeof a === "function";
}

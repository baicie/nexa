import type { NuiNode } from "@nexa/nui-host";

type Fragment = {
  c?: () => void;
  m?: (t: NuiNode, a: NuiNode | null) => void;
  p?: (ctx: unknown[], dirty: number[]) => void;
  d?: (detaching: number) => void;
};

type ComponentBag = {
  $$: ComponentState;
};

type ComponentState = {
  fragment: Fragment | undefined;
  ctx: unknown[];
  destroyed: boolean;
};

type Instance = (
  component: ComponentBag,
  props: Record<string, unknown>,
  invalidate: (index: number, value: unknown) => unknown,
) => unknown[];

type CreateFragment = (ctx: unknown[]) => Fragment;

export class SvelteComponent implements ComponentBag {
  $$: ComponentState = { fragment: undefined, ctx: [], destroyed: false };

  $destroy(): void {
    if (this.$$.destroyed) return;
    this.$$.destroyed = true;
    this.$$.fragment?.d?.(1);
    this.$$.fragment = undefined;
    this.$$.ctx = [];
  }

  $on(): () => void {
    return () => {};
  }

  $set(): void {}
}

export function destroy_block(fn: (() => void) | null | undefined): void {
  fn?.();
}

export function init(
  component: ComponentBag,
  options: { target?: NuiNode; props?: Record<string, unknown> },
  instance: Instance,
  createFragment: CreateFragment,
  notEqual: (left: unknown, right: unknown) => boolean,
): void {
  const state: ComponentState = { fragment: undefined, ctx: [], destroyed: false };
  component.$$ = state;
  let mounted = false;
  const invalidate = (index: number, value: unknown): unknown => {
    if (!notEqual(state.ctx[index], value)) return value;
    state.ctx[index] = value;
    if (mounted) state.fragment?.p?.(state.ctx, [1 << index]);
    return value;
  };
  state.ctx = instance(component, options.props ?? {}, invalidate);
  state.fragment = createFragment(state.ctx);
  state.fragment.c?.();
  if (options.target !== undefined) state.fragment.m?.(options.target, null);
  mounted = true;
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
  return a != a
    ? b == b
    : a !== b || (a !== null && typeof a === "object") || typeof a === "function";
}

/**
 * JSX runtime for Solid Universal → NUI Host (typecheck + Babel target).
 *
 * Runtime transform is done by babel-preset-solid (universal); these exports
 * satisfy TypeScript `react-jsx` / `jsxImportSource`.
 */

export function Fragment(props: { children?: unknown }): unknown {
  return props.children;
}

export function jsx(
  type: unknown,
  props: Record<string, unknown> | null,
  _key?: unknown,
): unknown {
  return { type, props: props ?? {} };
}

export function jsxs(
  type: unknown,
  props: Record<string, unknown> | null,
  key?: unknown,
): unknown {
  return jsx(type, props, key);
}

export function jsxDEV(
  type: unknown,
  props: Record<string, unknown> | null,
  key?: unknown,
): unknown {
  return jsx(type, props, key);
}

export namespace JSX {
  export type Element = unknown;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  export interface IntrinsicElements {
    window: Record<string, unknown>;
    column: Record<string, unknown>;
    row: Record<string, unknown>;
    view: Record<string, unknown>;
    scroll: Record<string, unknown>;
    text: Record<string, unknown>;
    button: Record<string, unknown>;
    [elemName: string]: Record<string, unknown>;
  }
}

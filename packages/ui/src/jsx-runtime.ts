/**
 * JSX factory — builds light descriptors; Host mutations happen in mount().
 *
 * Automatic runtime (`jsx` / `jsxs`): children live on `props`; the optional
 * third argument is `key`, not a child (react-jsx convention).
 */

export type NexaChild = unknown;

export type NexaElement = {
  type: string | ((props: Record<string, unknown>) => unknown);
  props: Record<string, unknown>;
};

export function jsx(
  type: NexaElement["type"],
  props: Record<string, unknown> | null,
  key?: unknown,
): NexaElement {
  const nextProps: Record<string, unknown> = props ? { ...props } : {};
  if (key !== undefined) {
    nextProps.key = key;
  }
  return { type, props: nextProps };
}

export function jsxs(
  type: NexaElement["type"],
  props: Record<string, unknown> | null,
  key?: unknown,
): NexaElement {
  return jsx(type, props, key);
}

export const Fragment = "Fragment";

/** react-jsx / jsxDEV compat */
export function jsxDEV(
  type: NexaElement["type"],
  props: Record<string, unknown> | null,
  key?: unknown,
  _isStatic?: boolean,
  _source?: unknown,
  _self?: unknown,
): NexaElement {
  return jsx(type, props, key);
}

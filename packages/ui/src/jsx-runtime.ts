/**
 * JSX factory stubs — become HostOps mutations in Slice 3.
 */

export type NexaElement = {
  type: string | ((props: Record<string, unknown>) => NexaElement);
  props: Record<string, unknown>;
  children: unknown[];
};

export function jsx(
  type: NexaElement["type"],
  props: Record<string, unknown> | null,
  ...children: unknown[]
): NexaElement {
  return {
    type,
    props: props ?? {},
    children,
  };
}

export const jsxs = jsx;
export const Fragment = "Fragment";

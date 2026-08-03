/**
 * Fine-grained signal primitive (Slice 3).
 * Prefer effect-driven Host mutations over Virtual DOM.
 */

export interface Signal<T> {
  value: T;
}

export function signal<T>(initial: T): Signal<T> {
  return { value: initial };
}

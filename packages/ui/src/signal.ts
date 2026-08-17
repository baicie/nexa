/**
 * Fine-grained signal / effect primitives (Slice 3).
 * Prefer effect-driven Host mutations over Virtual DOM.
 */

type Cleanup = () => void;

interface EffectNode {
  run: () => void;
  cleanups: Cleanup[];
  deps: Set<SignalImpl<unknown>>;
}

let activeEffect: EffectNode | null = null;

class SignalImpl<T> {
  private _value: T;
  private readonly subs = new Set<EffectNode>();

  constructor(initial: T) {
    this._value = initial;
  }

  get value(): T {
    if (activeEffect) {
      this.subs.add(activeEffect);
      activeEffect.deps.add(this as SignalImpl<unknown>);
    }
    return this._value;
  }

  set value(next: T) {
    if (Object.is(next, this._value)) {
      return;
    }
    this._value = next;
    const subscribers = [...this.subs];
    for (const effect of subscribers) {
      effect.run();
    }
  }

  /** @internal */
  unsubscribe(effect: EffectNode): void {
    this.subs.delete(effect);
  }
}

export type Signal<T> = {
  value: T;
};

export function signal<T>(initial: T): Signal<T> {
  return new SignalImpl(initial);
}

export function isSignal(value: unknown): value is Signal<unknown> {
  return value instanceof SignalImpl;
}

/** Register a reactive effect. Re-runs when any read signal changes. */
export function effect(fn: () => void): Cleanup {
  const node: EffectNode = {
    deps: new Set(),
    cleanups: [],
    run() {
      for (const cleanup of node.cleanups.splice(0)) {
        cleanup();
      }
      for (const dep of node.deps) {
        dep.unsubscribe(node);
      }
      node.deps.clear();

      const prev = activeEffect;
      activeEffect = node;
      try {
        fn();
      } finally {
        activeEffect = prev;
      }
    },
  };

  node.run();

  return () => {
    for (const cleanup of node.cleanups.splice(0)) {
      cleanup();
    }
    for (const dep of node.deps) {
      dep.unsubscribe(node);
    }
    node.deps.clear();
  };
}

/** Schedule cleanup for the currently running effect (or no-op). */
export function onCleanup(fn: Cleanup): void {
  if (activeEffect) {
    activeEffect.cleanups.push(fn);
  }
}

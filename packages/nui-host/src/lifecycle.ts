/**
 * Session-local ownership for JavaScript work associated with Host nodes.
 *
 * The native Host already removes callback/input/image state recursively. This
 * registry covers the other half of the contract: effects and subscriptions
 * created by TypeScript must stop when their owning node or ancestor goes away.
 */

export type NodeCleanup = () => void;

type NodeState = {
  parent: bigint | null;
  children: Set<bigint>;
  cleanups: Set<NodeCleanup>;
  disposed: boolean;
};

const nodes = new Map<bigint, NodeState>();
const disposedIds = new Set<bigint>();

function stateFor(id: bigint): NodeState {
  const existing = nodes.get(id);
  if (existing) return existing;
  const created: NodeState = {
    parent: null,
    children: new Set(),
    cleanups: new Set(),
    disposed: false,
  };
  nodes.set(id, created);
  return created;
}

/** Link a Host node into the ownership tree used for recursive disposal. */
export function attachNode(child: bigint, parent: bigint): void {
  if (disposedIds.has(child) || disposedIds.has(parent)) return;
  const childState = stateFor(child);
  const parentState = stateFor(parent);
  if (childState.parent !== null) {
    nodes.get(childState.parent)?.children.delete(child);
  }
  childState.parent = parent;
  parentState.children.add(child);
}

/** Register cleanup work owned by one node. Registration is idempotent by identity. */
export function registerNodeCleanup(id: bigint, cleanup: NodeCleanup): NodeCleanup {
  if (disposedIds.has(id)) {
    cleanup();
    return () => {};
  }
  const state = stateFor(id);
  if (state.disposed) {
    cleanup();
    return () => {};
  }
  state.cleanups.add(cleanup);
  return () => {
    state.cleanups.delete(cleanup);
  };
}

/**
 * Dispose a node and every known descendant exactly once.
 * Cleanup is run before the state entry is removed, so re-entrant disposal is
 * harmless and late signal writes cannot re-register work for a dead node.
 */
function disposeNodeCollectingErrors(id: bigint, errors: unknown[]): void {
  if (disposedIds.has(id)) return;
  const state = nodes.get(id);
  if (!state || state.disposed) {
    disposedIds.add(id);
    return;
  }
  state.disposed = true;

  while (state.children.size > 0) {
    const child = state.children.values().next().value as bigint | undefined;
    if (child === undefined) break;
    disposeNodeCollectingErrors(child, errors);
  }
  while (state.cleanups.size > 0) {
    const cleanup = state.cleanups.values().next().value as NodeCleanup | undefined;
    if (cleanup === undefined) break;
    state.cleanups.delete(cleanup);
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }

  if (state.parent !== null) {
    nodes.get(state.parent)?.children.delete(id);
  }
  state.children.clear();
  state.cleanups.clear();
  nodes.delete(id);
  disposedIds.add(id);
}

export function disposeNode(id: bigint): void {
  const errors: unknown[] = [];
  disposeNodeCollectingErrors(id, errors);
  if (errors.length > 0) throw errors[0];
}

/** End the current JS ownership scope and prepare an empty scope for remount. */
export function resetNodeLifecycle(): void {
  const errors: unknown[] = [];
  for (const id of Array.from(nodes.keys())) {
    disposeNodeCollectingErrors(id, errors);
  }
  nodes.clear();
  disposedIds.clear();
  if (errors.length > 0) throw errors[0];
}

/** Visible only for focused lifecycle tests and diagnostics. */
export function activeNodeCount(): number {
  return nodes.size;
}

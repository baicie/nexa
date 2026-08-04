import { insert as hostInsert, remove as hostRemove } from "./ffi";
import type { NuiNode } from "./types";

export function unlink(node: NuiNode): void {
  if (!node.parent) {
    return;
  }
  node.parent.children = node.parent.children.filter((c) => c !== node);
  node.parent = null;
}

/** Insert `node` under `parent` before `anchor` (or append when omitted/null). */
export function insertBefore(parent: NuiNode, node: NuiNode, anchor?: NuiNode | null): void {
  unlink(node);
  node.parent = parent;
  if (anchor) {
    const idx = parent.children.indexOf(anchor);
    if (idx >= 0) {
      parent.children.splice(idx, 0, node);
    } else {
      parent.children.push(node);
    }
    hostInsert(node.id, parent.id, anchor.id);
  } else {
    parent.children.push(node);
    hostInsert(node.id, parent.id);
  }
}

export function removeNode(node: NuiNode): void {
  unlink(node);
  hostRemove(node.id);
}

export function clearChildren(parent: NuiNode): void {
  for (const child of [...parent.children]) {
    removeNode(child);
  }
}

export function getParent(node: NuiNode): NuiNode | null {
  return node.parent;
}

export function getFirstChild(node: NuiNode): NuiNode | null {
  return node.children[0] ?? null;
}

export function getNextSibling(node: NuiNode): NuiNode | null {
  const parent = node.parent;
  if (!parent) {
    return null;
  }
  const idx = parent.children.indexOf(node);
  if (idx < 0) {
    return null;
  }
  return parent.children[idx + 1] ?? null;
}

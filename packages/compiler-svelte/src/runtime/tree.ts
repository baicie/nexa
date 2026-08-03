import { addClickListener, type NuiNode, insertBefore, unlink } from "@nexa/nui-host";

export function append(target: NuiNode, node: NuiNode): void {
  insertBefore(target, node, null);
}

export function insert(target: NuiNode, node: NuiNode, anchor?: NuiNode | null): void {
  insertBefore(target, node, anchor);
}

export function listen(node: NuiNode, event: string, handler: () => void): () => void {
  if (event === "click" || event === "Click") {
    addClickListener(node.id, handler);
  }
  return () => {};
}

export function detach(node: NuiNode): void {
  unlink(node);
}

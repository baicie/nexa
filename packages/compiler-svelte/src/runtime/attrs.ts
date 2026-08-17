import { applyHostProp, type NuiNode } from "@nexa/nui-host";

export function attr(node: NuiNode, name: string, value: unknown): void {
  applyHostProp(node, name, value);
  if (name.toLowerCase() === "fontsize" && typeof value === "number") {
    applyHostProp(node, "fontSize", value);
  }
}

export function set_style(node: NuiNode, key: string, value: unknown): void {
  applyHostProp(node, key, value);
}

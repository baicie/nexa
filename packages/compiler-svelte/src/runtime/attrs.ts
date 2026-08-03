import { applyNumericProp, type NuiNode, setWindowTitle } from "@nexa/nui-host";

export function attr(node: NuiNode, name: string, value: unknown): void {
  if (name === "title" && typeof value === "string") {
    setWindowTitle(value);
    return;
  }
  applyNumericProp(node, name, value);
  if (name.toLowerCase() === "fontsize" && typeof value === "number") {
    applyNumericProp(node, "fontSize", value);
  }
}

export function set_style(node: NuiNode, _key: string, value: unknown): void {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      attr(node, k, v);
    }
  }
}

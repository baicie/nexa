import { PropertyId, rgba, setNumber } from "./ffi";
import type { NuiNode } from "./types";
import { normalizeTag } from "./tag";

export function applyElementDefaults(node: NuiNode): void {
  switch (normalizeTag(node.tag)) {
    case "window":
      setNumber(node.id, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));
      setNumber(node.id, PropertyId.FlexDirection, 0);
      break;
    case "column":
      setNumber(node.id, PropertyId.FlexDirection, 0);
      break;
    case "row":
      setNumber(node.id, PropertyId.FlexDirection, 1);
      break;
    case "stack":
      setNumber(node.id, PropertyId.FlexDirection, 0);
      setNumber(node.id, PropertyId.AlignItems, 1);
      setNumber(node.id, PropertyId.JustifyContent, 1);
      break;
    case "card":
      setNumber(node.id, PropertyId.FlexDirection, 0);
      setNumber(node.id, PropertyId.Padding, 16);
      setNumber(node.id, PropertyId.BorderRadius, 12);
      setNumber(node.id, PropertyId.BackgroundColor, rgba(0xff, 0xff, 0xff));
      setNumber(node.id, PropertyId.Gap, 8);
      break;
    case "spacer":
      setNumber(node.id, PropertyId.FlexGrow, 1);
      break;
    case "button":
      setNumber(node.id, PropertyId.Padding, 12);
      setNumber(node.id, PropertyId.BorderRadius, 12);
      setNumber(node.id, PropertyId.BackgroundColor, rgba(0x1f, 0x6f, 0xeb));
      break;
    case "text":
      setNumber(node.id, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
      setNumber(node.id, PropertyId.FontSize, 16);
      break;
    case "scroll":
      setNumber(node.id, PropertyId.FlexDirection, 0);
      break;
    default:
      break;
  }
}

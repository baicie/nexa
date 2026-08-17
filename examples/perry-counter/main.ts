/**
 * Slice 2 acceptance: Perry TypeScript drives NUI Host via FFI.
 *
 * ```bash
 * pnpm install
 * cd examples/perry-counter
 * perry compile main.ts -o perry-counter && ./perry-counter
 * ```
 */

import {
  addClickListener,
  commit,
  createNode,
  createText,
  insert,
  NodeType,
  PropertyId,
  rgba,
  run,
  setNumber,
  setText,
} from "@nexa/nui-host";

const root = createNode(NodeType.View);
setNumber(root, PropertyId.Padding, 24);
setNumber(root, PropertyId.Gap, 16);
setNumber(root, PropertyId.BackgroundColor, rgba(0xf4, 0xf6, 0xf8));

const label = createText("Count: 0");
setNumber(label, PropertyId.FontSize, 28);
setNumber(label, PropertyId.TextColor, rgba(0x11, 0x18, 0x27));
insert(label, root);

const button = createNode(NodeType.View);
setNumber(button, PropertyId.Padding, 12);
setNumber(button, PropertyId.BorderRadius, 12);
setNumber(button, PropertyId.BackgroundColor, rgba(0x1f, 0x6f, 0xeb));
insert(button, root);

const buttonLabel = createText("Increment");
setNumber(buttonLabel, PropertyId.FontSize, 18);
setNumber(buttonLabel, PropertyId.TextColor, rgba(0xff, 0xff, 0xff));
insert(buttonLabel, button);

let count = 0;
addClickListener(button, () => {
  count += 1;
  setText(label, `Count: ${count}`);
  commit();
});

commit();
run("Nexa UI — Perry Counter");

import assert from "node:assert/strict";
import test from "node:test";

import "./typescript-test-hooks.mjs";
import { hostFfiHarness } from "./host-ffi-harness.mjs";

const ui = await import("../packages/ui/src/index.ts");
const { mountNode } = await import("../packages/ui/src/mount/materialize.ts");
const host = await import("../packages/nui-host/src/index.ts");

function lastNumber(node, property) {
  return hostFfiHarness
    .normalizedTrace()
    .filter(
      (entry) => entry.op === "setNumber" && entry.node === node && entry.property === property,
    )
    .at(-1)?.value;
}

test("Window theme reaches Button, Input, and TextArea Host styles", () => {
  hostFfiHarness.resetTrace();
  const accent = ui.rgba(0x0f, 0x76, 0x6e);
  const surface = ui.rgba(0xfa, 0xfa, 0xfa);
  const text = ui.rgba(0x17, 0x17, 0x17);
  const theme = ui.createTheme({
    colors: { accent, surface, text },
    spacing: { md: 9, lg: 13 },
    radii: { field: 5, control: 7 },
    typography: { bodySize: 15, controlSize: 17, controlWeight: 600 },
  });

  const root = mountNode(
    ui.Window({
      theme,
      children: [
        ui.Button({ children: "Save" }),
        ui.Input({ value: "Title" }),
        ui.TextArea({ value: "Body" }),
      ],
    }),
  );

  assert.equal(typeof root, "bigint");
  assert.equal(lastNumber("n2", host.PropertyId.BackgroundColor), accent);
  assert.equal(lastNumber("n2", host.PropertyId.Padding), 13);
  assert.equal(lastNumber("n2", host.PropertyId.BorderRadius), 7);
  assert.equal(lastNumber("n3", host.PropertyId.TextColor), theme.tokens.colors.onAccent);
  assert.equal(lastNumber("n3", host.PropertyId.FontSize), 17);
  assert.equal(lastNumber("n3", host.PropertyId.FontWeight), 600);
  assert.equal(lastNumber("n4", host.PropertyId.BackgroundColor), surface);
  assert.equal(lastNumber("n4", host.PropertyId.Padding), 9);
  assert.equal(lastNumber("n4", host.PropertyId.BorderRadius), 5);
  assert.equal(lastNumber("n5", host.PropertyId.TextColor), text);
  assert.equal(lastNumber("n5", host.PropertyId.FontSize), 15);
  assert.equal(lastNumber("n6", host.PropertyId.BackgroundColor), surface);
  assert.equal(lastNumber("n7", host.PropertyId.TextColor), text);
});

test("component style overrides win over inherited theme values", () => {
  hostFfiHarness.resetTrace();
  const background = ui.rgba(0x7c, 0x3a, 0xed);
  const foreground = ui.rgba(0xff, 0xfb, 0xeb);

  mountNode(
    ui.Window({
      children: [
        ui.Button({
          style: { backgroundColor: background, borderRadius: 3 },
          labelStyle: { color: foreground, fontSize: 14 },
          children: "Override",
        }),
      ],
    }),
  );

  assert.equal(lastNumber("n2", host.PropertyId.BackgroundColor), background);
  assert.equal(lastNumber("n2", host.PropertyId.BorderRadius), 3);
  assert.equal(lastNumber("n3", host.PropertyId.TextColor), foreground);
  assert.equal(lastNumber("n3", host.PropertyId.FontSize), 14);
});

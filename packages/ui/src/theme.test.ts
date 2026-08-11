import assert from "node:assert/strict";
import test from "node:test";

import { createTheme, defaultTheme, rgba } from "./theme.ts";

test("createTheme derives component styles from typed semantic tokens", () => {
  const accent = rgba(0x0f, 0x76, 0x6e);
  const theme = createTheme({
    colors: { accent },
    radii: { control: 6 },
    typography: { controlWeight: 600 },
  });

  assert.equal(theme.tokens.colors.accent, accent);
  assert.equal(theme.components.button.container.backgroundColor, accent);
  assert.equal(theme.components.button.container.borderRadius, 6);
  assert.equal(theme.components.button.label.fontWeight, 600);
  assert.equal(theme.components.input.container.borderRadius, defaultTheme.tokens.radii.field);
  assert.equal(defaultTheme.tokens.colors.accent, rgba(0x1f, 0x6f, 0xeb));
});

test("createTheme rejects invalid numeric tokens before they reach the Host", () => {
  assert.throws(() => createTheme({ spacing: { md: -1 } }), /spacing\.md/u);
  assert.throws(() => createTheme({ typography: { bodySize: Number.NaN } }), /bodySize/u);
  assert.throws(() => createTheme({ colors: { accent: 0x1_0000_0000 } }), /colors\.accent/u);
});

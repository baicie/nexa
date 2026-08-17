/** Host color encoded as `0xRRGGBBAA`. */
export type ColorToken = number;

/** Pack byte channels into the Host color representation. */
export function rgba(r: number, g: number, b: number, a = 255): ColorToken {
  return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;
}

export type ViewStyle = Readonly<{
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  padding?: number;
  gap?: number;
  flexDirection?: 0 | 1;
  alignItems?: 0 | 1 | 2 | 3;
  justifyContent?: 0 | 1 | 2;
  flexGrow?: number;
  backgroundColor?: ColorToken;
  borderRadius?: number;
  opacity?: number;
}>;

export type TextStyle = Readonly<{
  color?: ColorToken;
  fontSize?: number;
  fontWeight?: number;
  opacity?: number;
}>;

/** Typed numeric style sent directly to the native Host; no CSS parsing. */
export type Style = ViewStyle & TextStyle;

export type ThemeTokens = Readonly<{
  colors: Readonly<{
    canvas: ColorToken;
    surface: ColorToken;
    accent: ColorToken;
    onAccent: ColorToken;
    text: ColorToken;
  }>;
  spacing: Readonly<{
    sm: number;
    md: number;
    lg: number;
    xl: number;
  }>;
  radii: Readonly<{
    field: number;
    control: number;
    panel: number;
  }>;
  typography: Readonly<{
    bodySize: number;
    controlSize: number;
    controlWeight: number;
  }>;
}>;

export type Theme = Readonly<{
  tokens: ThemeTokens;
  components: Readonly<{
    window: Style;
    card: Style;
    text: TextStyle;
    button: Readonly<{ container: Style; label: TextStyle }>;
    input: Readonly<{ container: Style; text: TextStyle }>;
    textArea: Readonly<{ container: Style; text: TextStyle }>;
  }>;
}>;

export type ThemeOverrides = Readonly<{
  colors?: Partial<ThemeTokens["colors"]>;
  spacing?: Partial<ThemeTokens["spacing"]>;
  radii?: Partial<ThemeTokens["radii"]>;
  typography?: Partial<ThemeTokens["typography"]>;
}>;

const baseTokens: ThemeTokens = {
  colors: {
    canvas: rgba(0xf4, 0xf6, 0xf8),
    surface: rgba(0xff, 0xff, 0xff),
    accent: rgba(0x1f, 0x6f, 0xeb),
    onAccent: rgba(0xff, 0xff, 0xff),
    text: rgba(0x11, 0x18, 0x27),
  },
  spacing: { sm: 8, md: 10, lg: 12, xl: 16 },
  radii: { field: 8, control: 12, panel: 12 },
  typography: { bodySize: 16, controlSize: 18, controlWeight: 400 },
};

function requireColor(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an encoded uint32 RGBA color`);
  }
}

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function validateTokens(tokens: ThemeTokens): void {
  requireColor(tokens.colors.canvas, "colors.canvas");
  requireColor(tokens.colors.surface, "colors.surface");
  requireColor(tokens.colors.accent, "colors.accent");
  requireColor(tokens.colors.onAccent, "colors.onAccent");
  requireColor(tokens.colors.text, "colors.text");
  requireFiniteNonNegative(tokens.spacing.sm, "spacing.sm");
  requireFiniteNonNegative(tokens.spacing.md, "spacing.md");
  requireFiniteNonNegative(tokens.spacing.lg, "spacing.lg");
  requireFiniteNonNegative(tokens.spacing.xl, "spacing.xl");
  requireFiniteNonNegative(tokens.radii.field, "radii.field");
  requireFiniteNonNegative(tokens.radii.control, "radii.control");
  requireFiniteNonNegative(tokens.radii.panel, "radii.panel");
  requireFiniteNonNegative(tokens.typography.bodySize, "typography.bodySize");
  requireFiniteNonNegative(tokens.typography.controlSize, "typography.controlSize");
  requireFiniteNonNegative(tokens.typography.controlWeight, "typography.controlWeight");
}

/** Create one immutable-by-convention theme from semantic token overrides. */
export function createTheme(overrides: ThemeOverrides = {}): Theme {
  const tokens: ThemeTokens = {
    colors: { ...baseTokens.colors, ...overrides.colors },
    spacing: { ...baseTokens.spacing, ...overrides.spacing },
    radii: { ...baseTokens.radii, ...overrides.radii },
    typography: { ...baseTokens.typography, ...overrides.typography },
  };
  validateTokens(tokens);

  const fieldContainer: Style = {
    padding: tokens.spacing.md,
    borderRadius: tokens.radii.field,
    backgroundColor: tokens.colors.surface,
  };
  const fieldText: TextStyle = {
    color: tokens.colors.text,
    fontSize: tokens.typography.bodySize,
  };

  return {
    tokens,
    components: {
      window: { backgroundColor: tokens.colors.canvas },
      card: {
        padding: tokens.spacing.xl,
        gap: tokens.spacing.sm,
        borderRadius: tokens.radii.panel,
        backgroundColor: tokens.colors.surface,
      },
      text: fieldText,
      button: {
        container: {
          padding: tokens.spacing.lg,
          borderRadius: tokens.radii.control,
          backgroundColor: tokens.colors.accent,
        },
        label: {
          color: tokens.colors.onAccent,
          fontSize: tokens.typography.controlSize,
          fontWeight: tokens.typography.controlWeight,
        },
      },
      input: { container: fieldContainer, text: fieldText },
      textArea: { container: fieldContainer, text: fieldText },
    },
  };
}

export const defaultTheme = createTheme();

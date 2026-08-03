/**
 * Acceptance target for Slice 3 (ADR-004 / vertical-slice plan).
 *
 * This file is the product contract — not runnable until:
 *   Slice 0: Rust window + Skia
 *   Slice 1: Rust Counter
 *   Slice 2: Perry → Host FFI
 *   Slice 3: Minimal TSX runtime
 *
 * First-party surface only:
 *   Window | Column | Row | View | Text | Button | signal | onClick
 */

import { signal } from "@nexa/ui";

// Primitives will be exported from @nexa/ui in Slice 3.
declare function Window(props: { title?: string; children?: unknown }): unknown;
declare function Column(props: {
  width?: number;
  padding?: number;
  gap?: number;
  children?: unknown;
}): unknown;
declare function Text(props: { fontSize?: number; children?: unknown }): unknown;
declare function Button(props: { onClick?: () => void; children?: unknown }): unknown;

export function App() {
  const count = signal(0);

  return (
    <Window title="Nexa UI">
      <Column width={320} padding={24} gap={16}>
        <Text fontSize={28}>Count: {count.value}</Text>
        <Button onClick={() => count.value++}>Increment</Button>
      </Column>
    </Window>
  );
}

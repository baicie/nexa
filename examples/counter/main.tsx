/**
 * Slice 3 acceptance: Minimal TSX Counter (~30 lines).
 *
 * Pass the signal object into JSX (`{count}`) so mount binds a setText effect.
 *
 * ```bash
 * perry compile main.tsx -o counter && ./counter
 * ```
 */

import { Button, Column, Text, Window, mount, signal } from "@nexa/ui";

function App() {
  const count = signal(0);

  return (
    <Window title="Nexa UI — TSX Counter">
      <Column width={320} padding={24} gap={16}>
        <Text fontSize={28}>Count: {count}</Text>
        <Button onClick={() => count.value++}>Increment</Button>
      </Column>
    </Window>
  );
}

mount(App);

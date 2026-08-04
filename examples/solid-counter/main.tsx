/**
 * Slice 5 acceptance: Solid Counter via universal renderer → NUI Host.
 *
 * Build: babel (universal) → perry compile
 */

import { For, Show, createSignal, render } from "@nexa/adapter-solid";

function App() {
  const [count, setCount] = createSignal(0);
  const hints = () => Array.from({ length: Math.min(count(), 5) }, (_, i) => `tick-${i + 1}`);

  return (
    <window title="Nexa UI — Solid Counter">
      <column width={320} padding={24} gap={16}>
        <text fontSize={28}>Count: {count()}</text>
        <button onClick={() => setCount((c) => c + 1)}>Increment</button>
        <Show when={count() > 0}>
          <text fontSize={16}>Clicked at least once</text>
        </Show>
        <For each={hints()}>{(label) => <text fontSize={14}>{label}</text>}</For>
      </column>
    </window>
  );
}

render(() => <App />);

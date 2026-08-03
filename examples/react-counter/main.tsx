/**
 * Slice 7: React Counter via react-reconciler → NUI Host.
 */

import React, { useState, render } from "@nexa/adapter-react";

function App() {
  const [count, setCount] = useState(0);
  const hints = Array.from({ length: Math.min(count, 5) }, (_, i) => `tick-${i + 1}`);

  return (
    <window title="Nexa UI — React Counter">
      <column width={320} padding={24} gap={16}>
        <text fontSize={28}>{`Count: ${count}`}</text>
        <button onClick={() => setCount((c) => c + 1)}>Increment</button>
        {count > 0 ? <text fontSize={16}>Clicked at least once</text> : null}
        {hints.map((label) => (
          <text key={label} fontSize={14}>
            {label}
          </text>
        ))}
      </column>
    </window>
  );
}

render(<App />);

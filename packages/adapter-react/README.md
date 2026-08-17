# @nexa/adapter-react

React 18 + `react-reconciler@0.29` mutation renderer → NUI Host (no DOM).

```ts
import React, { useState, render } from "@nexa/adapter-react";

function App() {
  const [count, setCount] = useState(0);
  return (
    <window title="Nexa UI">
      <column padding={24}>
        <text fontSize={28}>{`Count: ${count}`}</text>
        <button onClick={() => setCount(count + 1)}>Increment</button>
      </column>
    </window>
  );
}

render(<App />);
```

Add `react` and `react-reconciler` to `perry.compilePackages`.

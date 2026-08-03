# Slice 3 counter example

Minimal TSX → `@nexa/ui` mount → NUI Host.

```bash
perry compile main.tsx -o counter
./counter
```

Pass the **signal object** into text children (`Count: {count}`), not `count.value`, so mount can bind a fine-grained `setText` effect.

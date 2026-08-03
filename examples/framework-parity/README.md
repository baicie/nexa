# Framework Parity

Same Counter shape across frameworks, all targeting the NUI Host:

| Framework | Example | Build |
|-----------|---------|-------|
| Minimal TSX | `examples/counter` | `perry compile main.tsx -o counter` |
| Solid | `examples/solid-counter` | `pnpm build` |
| Vue 3 | `examples/vue-counter` | `perry compile main.ts -o vue-counter` |
| React | `examples/react-counter` | `perry compile main.tsx -o react-counter` |
| Svelte | `examples/svelte-counter` | `perry compile main.ts -o svelte-counter` |

## Checklist

- [ ] Window opens with title
- [ ] Increment updates text only (no full tree rebuild)
- [ ] Conditional hint appears after first click
- [ ] No DOM / WebView

```bash
# From repo root — compile each counter (requires Perry + deps)
pnpm --filter @nexa/example-counter build
pnpm --filter @nexa/example-solid-counter build
pnpm --filter @nexa/example-vue-counter build
pnpm --filter @nexa/example-react-counter build
pnpm --filter @nexa/example-svelte-counter build
```

# Svelte Counter (Slice 8)

```bash
pnpm build && ./svelte-counter
```

The build compiles `Counter.svelte` with the real Svelte compiler, rewrites its runtime import
to `@nexa/compiler-svelte/runtime`, and then AOT-compiles the generated component with Perry.

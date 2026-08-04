# Framework Parity

Counter examples targeting the same NUI Host. A successful AOT build proves that
the source graph compiles and links; it does not prove runtime or lifecycle parity.

| Framework   | AOT input                    | Required CI rows    | Runtime/conformance |
| ----------- | ---------------------------- | ------------------- | ------------------- |
| Minimal TSX | `examples/counter/smoke.tsx` | FFI runtime smoke   | Smoke only          |
| Solid       | generated `dist/main.js`     | macOS + Windows AOT | Unverified          |
| Vue 3       | `main.ts`                    | macOS + Windows AOT | Unverified          |
| React       | `main.tsx`                   | macOS + Windows AOT | Unverified          |
| Svelte      | `main.ts` host-driver subset | macOS + Windows AOT | Unverified          |

The required [Perry frameworks workflow](../../.github/workflows/perry-frameworks.yml)
generates one clean, cache-disabled job per framework and platform. Any failed row
fails `CI / result`; no row uses `continue-on-error`.

The Svelte row does not compile `Counter.svelte` into the executable. The real
generated `.svelte` pipeline and React/Svelte lifecycle conformance remain G1-16
work and cannot be inferred from this matrix.

## Runtime Checklist (Unverified)

- [ ] Window opens with title
- [ ] Increment updates text only (no full tree rebuild)
- [ ] Conditional hint appears after first click
- [ ] No DOM / WebView

```bash
# From repo root — compile each counter (requires Perry + deps)
pnpm test:perry
pnpm --filter @nexa/example-counter build
pnpm --filter @nexa/example-solid-counter build
pnpm --filter @nexa/example-vue-counter build
pnpm --filter @nexa/example-react-counter build
pnpm --filter @nexa/example-svelte-counter build
```

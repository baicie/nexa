# @nexa/compiler-svelte

Svelte → NUI Host compiler backend (ADR-004 §4.5).

- `compileToHost(source)` uses `svelte/compiler` then rewrites `svelte/internal` imports to `@nexa/compiler-svelte/runtime`
- Runtime maps element/text/append/listen onto HostOps

This is a **subset** runtime (enough for Counter), not full Svelte DOM parity.

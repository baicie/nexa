# Solid Counter (Slice 5)

Solid Universal Renderer → `@nexa/adapter-solid` → NUI Host.

```bash
pnpm install
pnpm build   # babel-preset-solid → perry compile
./solid-counter
```

Perry does not run `babel-preset-solid`; JSX must be precompiled with `generate: "universal"`.

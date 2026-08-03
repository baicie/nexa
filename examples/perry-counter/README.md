# Perry Counter (Slice 2)

```bash
# Prerequisites: Perry on PATH (`npm i -g @perryts/perry` + platform package)
cd ../../packages/nui-host && cargo build --release
cd ../../examples/perry-counter
perry compile main.ts -o perry-counter
./perry-counter
```

Click **Increment** — count updates via Rust → Perry closure callback.

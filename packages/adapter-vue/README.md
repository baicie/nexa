# @nexa/adapter-vue

Vue 3 `createRenderer` mapped onto the NUI Host Protocol (no DOM).

## Usage

```ts
import { createApp, h, ref } from "@nexa/adapter-vue";

createApp({
  setup() {
    const count = ref(0);
    return () =>
      h("window", { title: "Nexa UI" }, [
        h("column", { padding: 24 }, [
          h("text", { fontSize: 28 }, [`Count: ${count.value}`]),
          h("button", { onClick: () => count.value++ }, ["Increment"]),
        ]),
      ]);
  },
}).mount();
```

Prefer **render functions** (`h`) so Perry can AOT without `@vue/compiler-dom`.
Add `@vue/runtime-core`, `@vue/reactivity`, and `@vue/shared` to `perry.compilePackages`.

## Host tags

`window` | `column` | `row` | `view` | `text` | `button` | `scroll`

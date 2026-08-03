/**
 * Slice 6 acceptance: Vue 3 Counter via createRenderer → NUI Host.
 *
 * Uses render functions (no SFC / compiler-dom) for Perry AOT.
 *
 * ```bash
 * perry compile main.ts -o vue-counter && ./vue-counter
 * ```
 */

import { createApp, h, ref } from "@nexa/adapter-vue";

createApp({
  setup() {
    const count = ref(0);
    const hints = () =>
      Array.from({ length: Math.min(count.value, 5) }, (_, i) => `tick-${i + 1}`);

    return () =>
      h("window", { title: "Nexa UI — Vue Counter" }, [
        h("column", { width: 320, padding: 24, gap: 16 }, [
          h("text", { fontSize: 28 }, [`Count: ${count.value}`]),
          h("button", { onClick: () => count.value++ }, ["Increment"]),
          count.value > 0
            ? h("text", { fontSize: 16 }, ["Clicked at least once"])
            : null,
          ...hints().map((label) => h("text", { fontSize: 14 }, [label])),
        ]),
      ]);
  },
}).mount();

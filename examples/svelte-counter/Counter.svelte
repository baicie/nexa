<!-- Source contract for Slice 8. Build emits Host runtime JS via compileToHost. -->
<script>
  let count = 0;
  function increment() {
    count += 1;
  }
</script>

<window title="Nexa UI — Svelte Counter">
  <column width={320} padding={24} gap={16}>
    <text fontSize={28}>Count: {count}</text>
    <button on:click={increment}>Increment</button>
    {#if count > 0}
      <text fontSize={16}>Clicked at least once</text>
    {/if}
  </column>
</window>

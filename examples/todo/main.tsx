/**
 * Slice 4+9 acceptance: Todo list with Input + For + Scroll.
 *
 * Type in the Input, press Enter or Add to append; Toggle / Remove mutate
 * the list signal. For only insert/remove Host nodes for membership changes.
 *
 * ```bash
 * perry compile main.tsx -o todo && ./todo
 * ```
 */

import { Button, Column, For, Input, Row, Scroll, Text, Window, mount, signal } from "@nexa/ui";

type Todo = { id: number; text: string; done: boolean };

function App() {
  const items = signal<Todo[]>([{ id: 1, text: "Ship Slice 4", done: false }]);
  const draft = signal("");
  let nextId = 2;

  const add = () => {
    const text = draft.value.trim();
    if (!text) {
      return;
    }
    const id = nextId++;
    items.value = [...items.value, { id, text, done: false }];
    draft.value = "";
  };

  const toggle = (id: number) => {
    items.value = items.value.map((item) =>
      item.id === id ? { ...item, done: !item.done } : item,
    );
  };

  const removeItem = (id: number) => {
    items.value = items.value.filter((item) => item.id !== id);
  };

  return (
    <Window title="Nexa UI — Todo">
      <Column width={360} padding={24} gap={16}>
        <Text fontSize={24}>Todo</Text>
        <Row gap={8}>
          <Input width={220} placeholder="New task" value={draft} onSubmit={add} />
          <Button onClick={add}>Add</Button>
        </Row>
        <Scroll height={260} width={320}>
          <Column gap={8}>
            <For each={items}>
              {(item) => (
                <Row gap={8}>
                  <Text fontSize={16}>
                    {() => {
                      const cur = items.value.find((t) => t.id === item.id);
                      if (!cur) {
                        return "";
                      }
                      return cur.done ? `[x] ${cur.text}` : `[ ] ${cur.text}`;
                    }}
                  </Text>
                  <Button onClick={() => toggle(item.id)}>
                    {() => {
                      const cur = items.value.find((t) => t.id === item.id);
                      return cur?.done ? "Undo" : "Done";
                    }}
                  </Button>
                  <Button onClick={() => removeItem(item.id)}>Remove</Button>
                </Row>
              )}
            </For>
          </Column>
        </Scroll>
      </Column>
    </Window>
  );
}

mount(App);

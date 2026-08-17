/** @jsxImportSource @nexa/ui */

import { Button, Column, Input, Text, TextArea, Window, signal } from "@nexa/ui";

export function App() {
  const title = signal("Draft");
  const body = signal("First note");
  const status = signal("Not saved");

  return (
    <Window title="Nexa UI - Semantic E2E">
      <Column width={560} height={420} padding={24} gap={12}>
        <Text fontSize={22}>Desktop Notes</Text>
        <Input
          value={title}
          placeholder="Title"
          width={512}
          onChange={(value) => {
            title.value = value;
          }}
        />
        <TextArea
          value={body}
          placeholder="Body"
          width={512}
          height={220}
          onChange={(value) => {
            body.value = value;
          }}
        />
        <Button
          onClick={() => {
            status.value = `Saved: ${title.value}`;
          }}
        >
          Save
        </Button>
        <Text>{status}</Text>
      </Column>
    </Window>
  );
}

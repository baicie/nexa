import type { Ui } from "@nexa/protocol";
import { Column, Input, Text, TextArea, Window, mount, signal } from "@nexa/ui";

function App() {
  const title = signal("你");
  const body = signal("你們\n✍🏽‍✍️e\u{301}你");
  const composition = signal("Idle");
  const changes = signal(0);

  const trackComposition = (editor: string, event: Ui.CompositionEvent) => {
    composition.value = `${editor}: ${event.kind} ${event.selectionStart}:${event.selectionEnd}`;
  };

  return (
    <Window title="Nexa UI - Input E2E">
      <Column width={560} height={420} padding={24} gap={12}>
        <Text fontSize={22}>Multilingual input fixture</Text>
        <Input
          value={title}
          placeholder="Title"
          width={512}
          onChange={(value) => {
            title.value = value;
            changes.value++;
          }}
          onComposition={(event) => trackComposition("Input", event)}
        />
        <TextArea
          value={body}
          placeholder="Body"
          width={512}
          height={220}
          onChange={(value) => {
            body.value = value;
            changes.value++;
          }}
          onComposition={(event) => trackComposition("TextArea", event)}
        />
        <Text fontSize={14}>{composition}</Text>
        <Text fontSize={14}>Changes: {changes}</Text>
      </Column>
    </Window>
  );
}

mount(App);

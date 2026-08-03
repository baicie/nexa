/**
 * Layout Playground — exercise Taffy Flexbox subset (row/column/gap/padding/scroll).
 */

import { Button, Column, Row, Scroll, Text, Window, mount } from "@nexa/ui";

function App() {
  return (
    <Window title="Nexa UI — Layout Playground">
      <Column width={420} padding={20} gap={16}>
        <Text fontSize={22}>Flexbox playground</Text>
        <Row gap={12}>
          <Button>A</Button>
          <Button>B</Button>
          <Button>C</Button>
        </Row>
        <Column padding={12} gap={8}>
          <Text fontSize={16}>Scroll region (wheel)</Text>
          <Scroll height={180} width={380}>
            <Column gap={8}>
              {Array.from({ length: 12 }, (_, i) => (
                <Text fontSize={14}>{`Row item ${i + 1}`}</Text>
              ))}
            </Column>
          </Scroll>
        </Column>
      </Column>
    </Window>
  );
}

mount(App);

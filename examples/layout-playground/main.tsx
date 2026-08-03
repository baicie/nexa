/**
 * Layout Playground — Flexbox subset + ADR §11 composites (Stack / Card / Spacer).
 */

import {
  Button,
  Card,
  Column,
  Row,
  Scroll,
  Spacer,
  Stack,
  Text,
  Window,
  mount,
} from "@nexa/ui";

function App() {
  return (
    <Window title="Nexa UI — Layout Playground">
      <Column width={420} height={520} padding={20} gap={16}>
        <Text fontSize={22}>Flexbox playground</Text>
        <Row gap={12}>
          <Button>A</Button>
          <Button>B</Button>
          <Button>C</Button>
        </Row>
        <Card width={380}>
          <Text fontSize={16}>Card + Stack</Text>
          <Stack height={72} gap={4}>
            <Text fontSize={14}>centered stack</Text>
            <Text fontSize={12}>align / justify center</Text>
          </Stack>
        </Card>
        <Column height={120} gap={0}>
          <Text fontSize={14}>Spacer grows</Text>
          <Spacer />
          <Text fontSize={14}>fixed below</Text>
        </Column>
        <Column padding={12} gap={8}>
          <Text fontSize={16}>Scroll region (wheel)</Text>
          <Scroll height={140} width={380}>
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

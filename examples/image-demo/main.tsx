/**
 * Slice 11: Native Image — local PNG decode + Skia paint.
 *
 * Run from this directory so `assets/nexa-mark.png` resolves:
 *   pnpm start
 */

import { Card, Column, Image, Row, Text, Window, mount } from "@nexa/ui";

function App() {
  return (
    <Window title="Nexa UI — Image Demo">
      <Column width={420} padding={24} gap={16}>
        <Text fontSize={22}>Local Image</Text>
        <Card width={372} gap={12}>
          <Text fontSize={14}>PNG fixture (96×64, stretched to 240×120)</Text>
          <Image src="assets/nexa-mark.png" width={240} height={120} />
        </Card>
        <Row gap={16}>
          <Column gap={8}>
            <Text fontSize={14}>Intrinsic size</Text>
            <Image src="assets/nexa-mark.png" />
          </Column>
          <Column gap={8}>
            <Text fontSize={14}>Missing → placeholder</Text>
            <Image src="assets/missing-fixture.png" width={96} height={64} />
          </Column>
        </Row>
      </Column>
    </Window>
  );
}

mount(App);

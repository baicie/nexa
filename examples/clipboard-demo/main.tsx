/**
 * Slice 12: System Host clipboard (ADR-005).
 *
 * Write → read round-trip, then show result in the NUI window.
 */

import { readText, writeText } from "@nexa/clipboard";
import { Button, Column, Text, Window, mount, signal } from "@nexa/ui";

function App() {
  const status = signal("Ready");

  return (
    <Window title="Nexa UI — Clipboard">
      <Column width={400} padding={24} gap={16}>
        <Text fontSize={22}>Clipboard</Text>
        <Text fontSize={16}>{status}</Text>
        <Button
          onClick={async () => {
            const marker = `nexa-clipboard-${Date.now()}`;
            await writeText(marker);
            const got = await readText();
            status.value = got === marker ? `OK: ${got}` : `Mismatch: wrote=${marker} read=${got}`;
          }}
        >
          Round-trip write/read
        </Button>
        <Button
          onClick={async () => {
            const got = await readText();
            status.value = got ? `Clipboard: ${got}` : "Clipboard empty / unavailable";
          }}
        >
          Read clipboard
        </Button>
      </Column>
    </Window>
  );
}

mount(App);

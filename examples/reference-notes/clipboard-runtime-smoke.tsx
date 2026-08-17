/** @jsxImportSource @nexa/ui */

import { readText, writeText } from "@nexa/clipboard";
import { Column, Text, Window, mount, type WindowLifecycleEvent } from "@nexa/ui";

const VALUE = "Nexa UI Clipboard Promise: 你好, مرحبا, 😀";
const SUCCESS = "nexa-ui reference notes clipboard runtime smoke ok";
const FAILURE = "nexa-ui reference notes clipboard runtime smoke failed";
const PROOF_PREFIX = "nexa-ui reference notes clipboard round-trip: ";

let started = false;

async function runSmoke(): Promise<void> {
  try {
    // Preserve a text clipboard when the platform exposes one. Empty or
    // non-text clipboards are still valid inputs for the write/read proof.
    let original: string | null = null;
    try {
      original = await readText().result;
    } catch {
      original = null;
    }

    await writeText(VALUE).result;
    const read = await readText().result;
    if (read !== VALUE) {
      throw new Error(`clipboard round-trip mismatch: ${read}`);
    }

    let restoreAttempted = false;
    let restoreVerified = false;
    if (original !== null) {
      restoreAttempted = true;
      await writeText(original).result;
      restoreVerified = (await readText().result) === original;
      if (!restoreVerified) {
        throw new Error("clipboard restoration mismatch");
      }
    }

    console.log(
      `${PROOF_PREFIX}${JSON.stringify({
        written: VALUE,
        read,
        restoreAttempted,
        restoreVerified,
      })}`,
    );
    console.log(SUCCESS);
  } catch (error) {
    console.log(`${FAILURE}: ${String(error)}`);
  }
}

function handleLifecycle(event: WindowLifecycleEvent): void {
  if (event.kind !== "Ready" || started) return;
  started = true;
  void runSmoke();
}

mount(() => (
  <Window title="Nexa Notes Clipboard Smoke" onLifecycle={handleLifecycle}>
    <Column padding={16}>
      <Text>Clipboard Promise smoke</Text>
    </Column>
  </Window>
));

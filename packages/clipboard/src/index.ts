/**
 * @nexa/clipboard — typed System Host clipboard surface (ADR-005).
 *
 * Promise-shaped for future async Executor; Slice 12 settles synchronously.
 */

import { clipboardReadText as hostRead, clipboardWriteText as hostWrite } from "@nexa/system-host";

/** Read UTF-8 text from the system clipboard. */
export async function readText(): Promise<string> {
  return hostRead();
}

/** Write UTF-8 text to the system clipboard. */
export async function writeText(text: string): Promise<void> {
  if (!hostWrite(text)) {
    throw new Error("@nexa/clipboard writeText failed");
  }
}

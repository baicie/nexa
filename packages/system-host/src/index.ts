/**
 * Perry System Host FFI wrappers (ADR-005).
 *
 * Each wrapper must call the `js_*` symbol named in package.json.
 */

declare function js_nexa_clipboard_read_text(): string;
declare function js_nexa_clipboard_write_text(text: string): number;

/** Read UTF-8 text from the system clipboard (empty string on failure). */
export function clipboardReadText(): string {
  return js_nexa_clipboard_read_text();
}

/** Write UTF-8 text to the system clipboard. Returns true on success. */
export function clipboardWriteText(text: string): boolean {
  return js_nexa_clipboard_write_text(String(text ?? "")) === 0;
}

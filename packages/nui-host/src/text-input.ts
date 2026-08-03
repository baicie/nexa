/**
 * Text input client contract (ADR-006 §3.2).
 *
 * Slice 9 Input uses a simpler Host path today; future IME / selection work
 * must target this interface so the event protocol is not rewritten.
 */

export type TextRange = {
  start: number;
  end: number;
};

export type TextSelection = {
  anchor: number;
  focus: number;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Editable surface driven by the platform IME / keyboard.
 * Native code must not treat composition as plain key events.
 */
export interface TextInputClient {
  surroundingText(): TextRange;
  selection(): TextSelection;
  replace(range: TextRange, text: string): void;
  compositionBounds(): Rect;
}

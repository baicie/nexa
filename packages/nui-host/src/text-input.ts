import type { Common, Ui } from "@nexa/protocol";

import { NexaHostError } from "./errors";
import { getCompositionBoundsV1, getTextInputStateV1, replaceTextInputV1 } from "./protocol";

/**
 * Text input client contract (ADR-006 §3.2).
 *
 * Every offset in this file is a UTF-16 code-unit offset. JavaScript strings,
 * winit IME cursor ranges, and the Perry boundary all use this unit; the Rust
 * editor converts it to grapheme-safe UTF-8 offsets before mutation.
 */

export type TextRange = Ui.TextRange;
export type TextSelection = Ui.TextSelection;
export type Rect = Ui.Rect;

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

function valueOrThrow<T>(result: Common.NexaResult<T>): T {
  if (!result.ok) throw new NexaHostError(result.error);
  return result.value;
}

/** Bind the typed client contract to one stable Host node handle. */
export function createTextInputClient(node: Common.HandleRef): TextInputClient {
  return {
    surroundingText(): TextRange {
      return valueOrThrow(getTextInputStateV1(node)).surroundingText;
    },
    selection(): TextSelection {
      return valueOrThrow(getTextInputStateV1(node)).selection;
    },
    replace(range: TextRange, text: string): void {
      valueOrThrow(replaceTextInputV1(node, range, text));
    },
    compositionBounds(): Rect {
      return valueOrThrow(getCompositionBoundsV1(node));
    },
  };
}

/**
 * Slice 8: Svelte-style Counter mapped through @nexa/compiler-svelte runtime.
 *
 * Hand-authored Host driver matching Counter.svelte (compiler output shape).
 * Full svelte/internal emit is optional via `pnpm compile:svelte`.
 */

import {
  append,
  attr,
  createRoot,
  element,
  listen,
  runHost,
  set_data,
  text,
} from "@nexa/compiler-svelte/runtime";

let count = 0;

const root = createRoot();
const win = element("window");
attr(win, "title", "Nexa UI — Svelte Counter");
append(root, win);

const column = element("column");
attr(column, "width", 320);
attr(column, "padding", 24);
attr(column, "gap", 16);
append(win, column);

const label = element("text");
attr(label, "fontSize", 28);
const labelText = text(`Count: ${count}`);
append(label, labelText);
append(column, label);

const button = element("button");
const buttonLabel = text("Increment");
append(button, buttonLabel);
append(column, button);

const hint = element("text");
attr(hint, "fontSize", 16);
const hintText = text("Clicked at least once");
append(hint, hintText);
// Start hidden by not inserting until count > 0
let hintMounted = false;

listen(button, "click", () => {
  count += 1;
  set_data(labelText, `Count: ${count}`);
  if (count > 0 && !hintMounted) {
    append(column, hint);
    hintMounted = true;
  }
});

runHost("Nexa UI — Svelte Counter");

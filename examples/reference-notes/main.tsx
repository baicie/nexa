/**
 * Desktop Notes MVP reference application.
 *
 * This first vertical slice keeps the document model deliberately small while
 * exercising the real input, typed file, and typed dialog surfaces.
 */

import { openFile, saveFile } from "@nexa/dialog";
import { readTextFile, writeTextFile } from "@nexa/fs";
import { mount } from "@nexa/ui";

import { NotesApp } from "./app";
import { createNotesController } from "./state";

const controller = createNotesController({
  open: () =>
    openFile({
      title: "打开笔记",
      filters: [{ name: "Text", extensions: ["txt", "md"] }],
    }),
  save: () =>
    saveFile({
      title: "保存笔记",
      filters: [{ name: "Text", extensions: ["txt", "md"] }],
    }),
  read: readTextFile,
  write: writeTextFile,
  reportError(error): void {
    console.log(`Nexa Notes operation failed: ${String(error)}`);
  },
});

mount(() => <NotesApp controller={controller} />);

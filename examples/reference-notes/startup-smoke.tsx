/** @jsxImportSource @nexa/ui */

import { commit } from "../../packages/nui-host/src/ffi";
import { mountNode } from "../../packages/ui/src/mount/materialize";

import { NotesApp } from "./app";
import { createNotesController, type NotesTask } from "./state";

const completedTask = <T,>(value: T): NotesTask<T> => ({
  result: Promise.resolve(value),
  cancel() {},
});

const controller = createNotesController({
  open: () => completedTask(null),
  save: () => completedTask(null),
  read: () => completedTask(""),
  write: () => completedTask(undefined),
});
const root = mountNode(<NotesApp controller={controller} />);
if (root === null) {
  throw new Error("Notes startup smoke produced no root node");
}
commit();
console.log("nexa-ui reference notes startup smoke ok");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(path.join(workspaceRoot, "protocol/nui-host.json"), "utf8"),
);
const generated = readFileSync(path.join(workspaceRoot, "packages/protocol/src/index.ts"), "utf8");

test("normalized event registry reserves stable ids and shared context", () => {
  const expected = new Map([
    ["Pointer", 4],
    ["Wheel", 5],
    ["Keyboard", 6],
    ["TextInput", 7],
    ["Composition", 8],
    ["Focus", 9],
  ]);
  const events = new Map(manifest.events.map((event) => [event.name, event]));
  for (const [name, id] of expected) {
    assert.equal(events.get(name)?.id, id);
    assert.equal(events.get(name)?.payload.fields.at(-1)?.name, "context");
    assert.equal(events.get(name)?.payload.fields.at(-1)?.type, "EventContext");
  }
  const context = manifest.types.find((type) => type.name === "EventContext");
  assert.equal(context?.fields.find((field) => field.name === "timestamp")?.type, "string");
  const composition = events.get("Composition");
  assert.equal(
    composition?.payload.fields.find((field) => field.name === "selectionStart")?.type,
    "u32",
  );
  assert.equal(
    composition?.payload.fields.find((field) => field.name === "selectionEnd")?.type,
    "u32",
  );
  assert.match(generated, /export enum EventId[\s\S]*Pointer = 4/);
  assert.match(generated, /export interface EventContext[\s\S]*timestamp: string/);
  assert.match(generated, /export interface EventPayloadMap[\s\S]*\[EventId\.Composition\]/);
});

test("normalized event JSON preserves decimal-string timestamps and UTF-16 ranges", () => {
  const event = {
    kind: "Update",
    text: "かな",
    selectionStart: 2,
    selectionEnd: 4,
    context: {
      windowId: 7,
      target: null,
      timestamp: "9007199254740993",
      modifiers: {
        shift: false,
        control: false,
        alt: false,
        meta: false,
        capsLock: false,
        numLock: false,
      },
      propagation: {
        phase: "Target",
        defaultPrevented: false,
        propagationStopped: false,
        immediatePropagationStopped: false,
      },
    },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
  assert.equal(Number(event.context.timestamp), 9007199254740992);
  assert.notEqual(Number(event.context.timestamp).toString(), event.context.timestamp);
});

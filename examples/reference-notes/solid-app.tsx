/** @jsxImportSource @nexa/adapter-solid */

import { onCleanup, setProp, type NuiNode } from "@nexa/adapter-solid";
import { setText } from "@nexa/nui-host";

import { openFile, saveFile } from "@nexa/dialog";
import { readTextFile, writeTextFile } from "@nexa/fs";

import { createNotesController, type NotesController, type NotesSnapshot } from "./state.js";

export type SolidNotesAppProps = Readonly<{
  controller: NotesController;
}>;

function buttonSemantics(label: string, value: string, disabled: boolean) {
  return { role: "Button", label, value, disabled, actions: ["Invoke"] };
}

function textInputSemantics(label: string, value: string) {
  return {
    role: "TextInput",
    label,
    value,
    disabled: false,
    actions: ["Focus", "SetValue"],
  };
}

function statusSemantics(value: string) {
  return { role: "Text", label: "当前状态", value, disabled: false, actions: [] };
}

/** Tier-1 Solid slice sharing the Notes controller and Host semantic contract. */
export function SolidNotesApp({ controller }: SolidNotesAppProps): NuiNode {
  let latest = controller.snapshot();
  let saveNode: NuiNode | undefined;
  let titleNode: NuiNode | undefined;
  let bodyNode: NuiNode | undefined;
  let statusNode: NuiNode | undefined;

  const update = (next: NotesSnapshot): void => {
    latest = next;
    if (saveNode !== undefined) {
      setProp(saveNode, "disabled", next.busy);
      setProp(
        saveNode,
        "semantics",
        buttonSemantics("保存", next.busy ? "保存中" : "保存", next.busy),
      );
      const label = saveNode.children.find((child) => child.isText);
      if (label !== undefined) setText(label.id, next.busy ? "保存中" : "保存");
    }
    if (titleNode !== undefined) {
      setProp(titleNode, "value", next.title);
      setProp(titleNode, "semantics", textInputSemantics("标题", next.title));
    }
    if (bodyNode !== undefined) {
      setProp(bodyNode, "value", next.body);
      setProp(bodyNode, "semantics", textInputSemantics("正文", next.body));
    }
    if (statusNode !== undefined) {
      setText(statusNode.id, next.status);
      setProp(statusNode, "semantics", statusSemantics(next.status));
    }
  };

  const unsubscribe = controller.subscribe(update);
  onCleanup(unsubscribe);

  const lifecycle = (event: { kind: string }): void => {
    if (event.kind === "Suspended") controller.suspend();
    else if (event.kind === "Resumed") controller.resume();
    else if (event.kind === "CloseRequested") controller.close();
  };

  const tree = (
    <window title="Nexa Notes" onLifecycle={lifecycle}>
      <column flexGrow={1} padding={16} gap={10} alignItems={3}>
        <row gap={8} alignItems={1}>
          <button onClick={() => void controller.open()}>打开</button>
          <button
            ref={(node: NuiNode) => {
              saveNode = node;
            }}
            disabled={latest.busy}
            semantics={buttonSemantics("保存", latest.busy ? "保存中" : "保存", latest.busy)}
            onClick={() => void controller.save()}
          >
            {latest.busy ? "保存中" : "保存"}
          </button>
          <input
            ref={(node: NuiNode) => {
              titleNode = node;
            }}
            value={latest.title}
            placeholder="标题"
            semantics={textInputSemantics("标题", latest.title)}
            onChange={(value: string) => controller.editTitle(value)}
          />
        </row>
        <textarea
          ref={(node: NuiNode) => {
            bodyNode = node;
          }}
          value={latest.body}
          placeholder="正文"
          semantics={textInputSemantics("正文", latest.body)}
          flexGrow={1}
          onChange={(value: string) => controller.editBody(value)}
        />
        <row gap={8} alignItems={1}>
          <text
            ref={(node: NuiNode) => {
              statusNode = node;
            }}
            semantics={statusSemantics(latest.status)}
          >
            {latest.status}
          </text>
          <text>{latest.path ?? "未命名"}</text>
        </row>
      </column>
    </window>
  );

  update(latest);
  return tree as NuiNode;
}

export function createSolidNotesController(): NotesController {
  return createNotesController({
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
  });
}

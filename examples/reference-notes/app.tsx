/** @jsxImportSource @nexa/ui */

import {
  Button,
  Column,
  Input,
  Row,
  SemanticAction,
  SemanticRole,
  Spacer,
  Text,
  TextArea,
  Window,
  signal,
  type Semantics,
  type WindowLifecycleEvent,
} from "@nexa/ui";

import type { NotesController } from "./state";

export type NotesAppProps = Readonly<{
  controller: NotesController;
  onLifecycle?: (event: WindowLifecycleEvent) => void;
}>;

function buttonSemantics(name: string, busyName: string, busy: boolean): Semantics {
  return {
    role: SemanticRole.Button,
    label: name,
    value: busy ? busyName : name,
    disabled: busy,
    actions: [SemanticAction.Invoke],
  };
}

function textInputSemantics(name: string, value: string): Semantics {
  return {
    role: SemanticRole.TextInput,
    label: name,
    value,
    disabled: false,
    actions: [SemanticAction.Focus, SemanticAction.SetValue],
  };
}

function statusSemantics(value: string): Semantics {
  return {
    role: SemanticRole.Text,
    label: "当前状态",
    value,
    disabled: false,
    actions: [],
  };
}

export function NotesApp({ controller, onLifecycle }: NotesAppProps) {
  const initial = controller.snapshot();
  const path = signal<string | null>(initial.path);
  const title = signal(initial.title);
  const body = signal(initial.body);
  const status = signal(initial.status);
  const busy = signal(initial.busy);
  const openSemantics = signal(buttonSemantics("打开", "打开中", initial.busy));
  const saveSemantics = signal(buttonSemantics("保存", "保存中", initial.busy));
  const titleSemantics = signal(textInputSemantics("标题", initial.title));
  const bodySemantics = signal(textInputSemantics("正文", initial.body));
  const currentStatusSemantics = signal(statusSemantics(initial.status));

  const handleLifecycle = (event: WindowLifecycleEvent): void => {
    switch (event.kind) {
      case "Suspended":
        controller.suspend();
        break;
      case "Resumed":
        controller.resume();
        break;
      case "CloseRequested":
        controller.close();
        break;
      case "Ready":
        break;
    }
    onLifecycle?.(event);
  };

  controller.subscribe((next) => {
    path.value = next.path;
    title.value = next.title;
    body.value = next.body;
    status.value = next.status;
    busy.value = next.busy;
    openSemantics.value = buttonSemantics("打开", "打开中", next.busy);
    saveSemantics.value = buttonSemantics("保存", "保存中", next.busy);
    titleSemantics.value = textInputSemantics("标题", next.title);
    bodySemantics.value = textInputSemantics("正文", next.body);
    currentStatusSemantics.value = statusSemantics(next.status);
  });

  return (
    <Window title="Nexa Notes" onLifecycle={handleLifecycle}>
      <Column flexGrow={1} padding={16} gap={10} alignItems={3}>
        <Row gap={8} alignItems={1}>
          <Button disabled={busy} semantics={openSemantics} onClick={() => controller.open()}>
            {() => (busy.value ? "打开中" : "打开")}
          </Button>
          <Button disabled={busy} semantics={saveSemantics} onClick={() => controller.save()}>
            {() => (busy.value ? "保存中" : "保存")}
          </Button>
          <Input
            value={title}
            placeholder="标题"
            semantics={titleSemantics}
            width="stretch"
            flexGrow={1}
            onChange={(value) => controller.editTitle(value)}
          />
        </Row>
        <TextArea
          value={body}
          placeholder="正文"
          semantics={bodySemantics}
          width="stretch"
          flexGrow={1}
          onChange={(value) => controller.editBody(value)}
        />
        <Row gap={8} alignItems={1}>
          <Text semantics={currentStatusSemantics}>{() => status.value}</Text>
          <Spacer />
          <Text>{() => path.value ?? "未命名"}</Text>
        </Row>
      </Column>
    </Window>
  );
}

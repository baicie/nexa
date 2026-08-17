export type NotesTask<T> = Readonly<{
  readonly result: Promise<T>;
  cancel(): void;
}>;

export type NotesDependencies = Readonly<{
  open(): NotesTask<string | null>;
  save(): NotesTask<string | null>;
  read(path: string): NotesTask<string>;
  write(path: string, body: string): NotesTask<void>;
  reportError?(error: unknown): void;
}>;

export type NotesSnapshot = Readonly<{
  path: string | null;
  title: string;
  body: string;
  revision: number;
  savedRevision: number;
  dirty: boolean;
  status: string;
  busy: boolean;
  operation: "idle" | "opening" | "saving";
  window: "active" | "suspended" | "closing" | "closed";
}>;

export type NotesListener = (snapshot: NotesSnapshot) => void;

export type NotesController = Readonly<{
  snapshot(): NotesSnapshot;
  subscribe(listener: NotesListener): () => void;
  editTitle(title: string): void;
  editBody(body: string): void;
  open(): Promise<void>;
  save(): Promise<void>;
  suspend(): void;
  resume(): void;
  close(): void;
}>;

function fileName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(separator + 1) || "未命名";
}

function errorLabel(error: unknown, operation: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${operation}失败: ${detail}`;
}

export function createNotesController(dependencies: NotesDependencies): NotesController {
  const listeners = new Set<NotesListener>();
  const state = {
    path: null as string | null,
    title: "未命名",
    body: "",
    revision: 1,
    savedRevision: 0,
    status: "未保存",
    busy: false,
    operation: "idle" as NotesSnapshot["operation"],
    window: "active" as NotesSnapshot["window"],
  };
  let operationSerial = 0;
  let activeTask: NotesTask<unknown> | null = null;

  const snapshot = (): NotesSnapshot => ({
    path: state.path,
    title: state.title,
    body: state.body,
    revision: state.revision,
    savedRevision: state.savedRevision,
    dirty: state.revision !== state.savedRevision,
    status: state.status,
    busy: state.busy,
    operation: state.operation,
    window: state.window,
  });

  const emit = (): void => {
    const next = snapshot();
    for (const listener of listeners) {
      listener(next);
    }
  };

  const restoreDocumentStatus = (): void => {
    state.status = state.revision !== state.savedRevision ? "未保存" : "已保存";
  };

  const reportError = (error: unknown): void => {
    try {
      dependencies.reportError?.(error);
    } catch {
      // Diagnostics must not replace the original operation result.
    }
  };

  const edit = (field: "title" | "body", value: string): void => {
    if (state.window !== "active" || state[field] === value) return;
    state[field] = value;
    state.revision += 1;
    restoreDocumentStatus();
    emit();
  };

  const begin = (operation: "opening" | "saving"): number | null => {
    if (state.window !== "active" || state.busy) return null;
    const serial = ++operationSerial;
    state.busy = true;
    state.operation = operation;
    state.status = operation === "opening" ? "打开中" : "保存中";
    emit();
    return serial;
  };

  const isCurrent = (serial: number): boolean =>
    serial === operationSerial && (state.window === "active" || state.window === "suspended");

  const finish = (serial: number): void => {
    if (!isCurrent(serial)) return;
    activeTask = null;
    state.busy = false;
    state.operation = "idle";
    emit();
  };

  const open = async (): Promise<void> => {
    const serial = begin("opening");
    if (serial === null) return;

    try {
      const dialog = dependencies.open();
      activeTask = dialog;
      const selected = await dialog.result;
      if (!isCurrent(serial)) return;
      if (selected === null) {
        restoreDocumentStatus();
        return;
      }

      const read = dependencies.read(selected);
      activeTask = read;
      const body = await read.result;
      if (!isCurrent(serial)) return;

      state.path = selected;
      state.title = fileName(selected);
      state.body = body;
      state.revision += 1;
      state.savedRevision = state.revision;
      state.status = "已保存";
      emit();
    } catch (error) {
      if (isCurrent(serial)) {
        reportError(error);
        state.status = errorLabel(error, "打开");
        emit();
      }
    } finally {
      finish(serial);
    }
  };

  const save = async (): Promise<void> => {
    const serial = begin("saving");
    if (serial === null) return;

    try {
      let target = state.path;
      if (target === null) {
        const dialog = dependencies.save();
        activeTask = dialog;
        target = await dialog.result;
        if (!isCurrent(serial)) return;
        if (target === null) {
          restoreDocumentStatus();
          return;
        }
      }

      if (!isCurrent(serial) || target === null) return;
      const body = state.body;
      const writtenRevision = state.revision;
      const write = dependencies.write(target, body);
      activeTask = write;
      await write.result;
      if (!isCurrent(serial)) return;

      state.path = target;
      state.title = fileName(target);
      state.savedRevision = writtenRevision;
      restoreDocumentStatus();
      emit();
    } catch (error) {
      if (isCurrent(serial)) {
        reportError(error);
        state.status = errorLabel(error, "保存");
        emit();
      }
    } finally {
      finish(serial);
    }
  };

  return {
    snapshot,
    subscribe(listener): () => void {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    editTitle(title): void {
      edit("title", title);
    },
    editBody(body): void {
      edit("body", body);
    },
    open,
    save,
    suspend(): void {
      if (state.window !== "active") return;
      state.window = "suspended";
      emit();
    },
    resume(): void {
      if (state.window !== "suspended") return;
      state.window = "active";
      emit();
    },
    close(): void {
      if (state.window === "closing" || state.window === "closed") return;
      ++operationSerial;
      state.window = "closing";
      const task = activeTask;
      activeTask = null;
      state.busy = false;
      state.operation = "idle";
      try {
        task?.cancel();
      } catch {
        // The native owner fence still wins if a stale Task rejects cancellation.
      } finally {
        state.window = "closed";
        state.status = "已关闭";
        emit();
      }
    },
  };
}

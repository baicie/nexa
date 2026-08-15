//! System Task orchestration for file commands and Perry awaiters.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use nui_app_runtime::{
    CancellationToken, OwnerId, OwnerInvalidationError, Scheduler, TaskDrainError, TaskHandle,
    TaskRuntime, TaskSettlementDisposition, TaskSpawnError, TaskTransition,
    WorkerExecutorCreateError, WorkerOutcome,
};
#[cfg(test)]
use nui_app_runtime::{DEFAULT_WORKER_COUNT, DEFAULT_WORK_QUEUE_CAPACITY};
use nui_system_core::protocol::common::{HandleRef, NexaError};
use nui_system_core::protocol::system::TaskKind;
use nui_system_core::{
    cancelled, clipboard_read_text_with, clipboard_write_text_with, internal_failure,
    invalid_argument, invalid_data, invalid_state, not_found, platform_failure,
    read_text_file_with, write_text_file_with, ClipboardBackend, ClipboardError, CommandResult,
    DesktopClipboard, DialogBackend, DialogError, DialogRequest, FileSystemBackend,
    FileSystemError, NativeFileSystem,
};
use serde_json::Value;

use crate::{command_result_json, task_registry_nexa_error, worker_failure_nexa_error};

#[derive(Debug, Clone, PartialEq, Eq)]
enum SystemTaskValue {
    Text(String),
    Unit,
    OptionalText(Option<String>),
}

struct TaskRecord<A> {
    owner: OwnerId,
    kind: TaskKind,
    operation: &'static str,
    awaiter: Option<A>,
    result: Option<String>,
}

pub(crate) struct TaskResolution<A> {
    pub owner: OwnerId,
    pub awaiter: A,
    pub encoded: String,
}

/// UI-thread coordinator. `A` is an opaque awaiter owned by the caller; no
/// Perry value is touched by a worker thread.
pub(crate) struct SystemTaskRuntime<A: Send + 'static> {
    runtime: TaskRuntime<CommandResult<SystemTaskValue>>,
    records: HashMap<TaskHandle, TaskRecord<A>>,
    ready: Vec<TaskResolution<A>>,
}

// `NexaError` is the stable value type returned by System protocol commands.
#[allow(clippy::result_large_err)]
impl<A: Send + 'static> SystemTaskRuntime<A> {
    #[cfg(test)]
    pub fn new() -> Result<Self, WorkerExecutorCreateError> {
        Self::with_config(DEFAULT_WORKER_COUNT, DEFAULT_WORK_QUEUE_CAPACITY, || {})
    }

    pub fn with_config(
        worker_count: usize,
        queue_capacity: usize,
        wakeup: impl Fn() + Send + Sync + 'static,
    ) -> Result<Self, WorkerExecutorCreateError> {
        Ok(Self {
            runtime: TaskRuntime::with_wakeup(worker_count, queue_capacity, wakeup)?,
            records: HashMap::new(),
            ready: Vec::new(),
        })
    }

    pub fn spawn_read(&mut self, owner: OwnerId, path: PathBuf) -> CommandResult<HandleRef> {
        self.spawn_read_with(owner, path, Arc::new(NativeFileSystem))
    }

    pub fn spawn_clipboard_read(&mut self, owner: OwnerId) -> CommandResult<HandleRef> {
        self.spawn_clipboard_read_with(owner, DesktopClipboard)
    }

    fn spawn_clipboard_read_with<B>(
        &mut self,
        owner: OwnerId,
        mut backend: B,
    ) -> CommandResult<HandleRef>
    where
        B: ClipboardBackend + Send + 'static,
    {
        self.spawn(
            owner,
            TaskKind::ClipboardReadText,
            "clipboardReadText",
            move |cancellation| {
                if cancellation.is_cancelled() {
                    return Err(cancelled(
                        "clipboardReadText",
                        "cooperativeCancellation",
                        owner.raw(),
                        TaskKind::ClipboardReadText,
                    ));
                }
                clipboard_read_text_with(&mut backend)
                    .map(SystemTaskValue::Text)
                    .map_err(|error| clipboard_nexa_error(error, "clipboardReadText"))
            },
        )
    }

    pub fn spawn_clipboard_write(
        &mut self,
        owner: OwnerId,
        text: String,
    ) -> CommandResult<HandleRef> {
        self.spawn_clipboard_write_with(owner, text, DesktopClipboard)
    }

    fn spawn_clipboard_write_with<B>(
        &mut self,
        owner: OwnerId,
        text: String,
        mut backend: B,
    ) -> CommandResult<HandleRef>
    where
        B: ClipboardBackend + Send + 'static,
    {
        self.spawn(
            owner,
            TaskKind::ClipboardWriteText,
            "clipboardWriteText",
            move |cancellation| {
                if cancellation.is_cancelled() {
                    return Err(cancelled(
                        "clipboardWriteText",
                        "cooperativeCancellation",
                        owner.raw(),
                        TaskKind::ClipboardWriteText,
                    ));
                }
                clipboard_write_text_with(&mut backend, &text)
                    .map(|()| SystemTaskValue::Unit)
                    .map_err(|error| clipboard_nexa_error(error, "clipboardWriteText"))
            },
        )
    }

    fn spawn_read_with<B>(
        &mut self,
        owner: OwnerId,
        path: PathBuf,
        backend: Arc<B>,
    ) -> CommandResult<HandleRef>
    where
        B: FileSystemBackend + Send + Sync + 'static,
    {
        let error_path = path.clone();
        self.spawn(
            owner,
            TaskKind::ReadTextFile,
            "readTextFile",
            move |cancellation| {
                read_text_file_with(backend.as_ref(), &path, || cancellation.is_cancelled())
                    .map(SystemTaskValue::Text)
                    .map_err(|error| {
                        filesystem_nexa_error(
                            error,
                            "readTextFile",
                            owner,
                            TaskKind::ReadTextFile,
                            &error_path,
                        )
                    })
            },
        )
    }

    pub fn spawn_write(
        &mut self,
        owner: OwnerId,
        path: PathBuf,
        text: String,
    ) -> CommandResult<HandleRef> {
        self.spawn_write_with(owner, path, text, Arc::new(NativeFileSystem))
    }

    pub fn spawn_open<B>(
        &mut self,
        owner: OwnerId,
        request: DialogRequest,
        backend: Arc<B>,
    ) -> CommandResult<HandleRef>
    where
        B: DialogBackend,
    {
        self.spawn_dialog(
            owner,
            TaskKind::OpenFileDialog,
            "openFileDialog",
            request,
            backend,
            |backend, request| backend.open_file(request),
        )
    }

    pub fn spawn_save<B>(
        &mut self,
        owner: OwnerId,
        request: DialogRequest,
        backend: Arc<B>,
    ) -> CommandResult<HandleRef>
    where
        B: DialogBackend,
    {
        self.spawn_dialog(
            owner,
            TaskKind::SaveFileDialog,
            "saveFileDialog",
            request,
            backend,
            |backend, request| backend.save_file(request),
        )
    }

    fn spawn_dialog<B>(
        &mut self,
        owner: OwnerId,
        kind: TaskKind,
        operation: &'static str,
        request: DialogRequest,
        backend: Arc<B>,
        invoke: fn(&B, &DialogRequest) -> Result<Option<PathBuf>, DialogError>,
    ) -> CommandResult<HandleRef>
    where
        B: DialogBackend,
    {
        request
            .validate()
            .map_err(|error| dialog_nexa_error(error, operation))?;
        self.spawn(owner, kind, operation, move |_cancellation| {
            invoke(backend.as_ref(), &request)
                .map(|path| {
                    SystemTaskValue::OptionalText(
                        path.map(|path| path.to_string_lossy().into_owned()),
                    )
                })
                .map_err(|error| dialog_nexa_error(error, operation))
        })
    }

    fn spawn_write_with<B>(
        &mut self,
        owner: OwnerId,
        path: PathBuf,
        text: String,
        backend: Arc<B>,
    ) -> CommandResult<HandleRef>
    where
        B: FileSystemBackend + Send + Sync + 'static,
    {
        let error_path = path.clone();
        self.spawn(
            owner,
            TaskKind::WriteTextFile,
            "writeTextFile",
            move |cancellation| {
                let cancel_check = cancellation.clone();
                let commit = cancellation.clone();
                write_text_file_with(
                    backend.as_ref(),
                    &path,
                    &text,
                    move || cancel_check.is_cancelled(),
                    move || commit.try_begin_commit(),
                )
                .map(|()| SystemTaskValue::Unit)
                .map_err(|error| {
                    filesystem_nexa_error(
                        error,
                        "writeTextFile",
                        owner,
                        TaskKind::WriteTextFile,
                        &error_path,
                    )
                })
            },
        )
    }

    fn spawn(
        &mut self,
        owner: OwnerId,
        kind: TaskKind,
        operation: &'static str,
        work: impl FnOnce(CancellationToken) -> CommandResult<SystemTaskValue> + Send + 'static,
    ) -> CommandResult<HandleRef> {
        let task = self
            .runtime
            .spawn(owner, work)
            .map_err(|error| task_spawn_nexa_error(error, operation, owner))?;
        self.records.insert(
            task,
            TaskRecord {
                owner,
                kind,
                operation,
                awaiter: None,
                result: None,
            },
        );
        Ok(handle_ref(task))
    }

    pub fn register_awaiter(&mut self, owner: OwnerId, task: TaskHandle, awaiter: A) {
        if let Err(error) = self.runtime.registry().state(owner, task) {
            self.ready.push(TaskResolution {
                owner,
                awaiter,
                encoded: command_result_json(Err(task_registry_nexa_error(
                    error,
                    "awaitTask",
                    task,
                ))),
            });
            return;
        }

        let Some(record) = self.records.get_mut(&task) else {
            self.ready.push(TaskResolution {
                owner,
                awaiter,
                encoded: command_result_json(Err(internal_failure(
                    "awaitTask",
                    "every live task has a System Host record",
                    "awaiterRegistration",
                    "task record is missing",
                    None,
                ))),
            });
            return;
        };
        if record.awaiter.is_some() {
            self.ready.push(TaskResolution {
                owner,
                awaiter,
                encoded: command_result_json(Err(invalid_state(
                    "awaitTask",
                    "awaiterRegistered",
                    handle_ref(task),
                ))),
            });
            return;
        }
        record.awaiter = Some(awaiter);
        self.queue_ready_record(task);
    }

    pub fn cancel(&mut self, owner: OwnerId, task: TaskHandle) -> CommandResult<TaskTransition> {
        self.runtime
            .cancel(owner, task)
            .map_err(|error| task_registry_nexa_error(error, "cancelTask", task))
    }

    pub fn invalidate_owner(&mut self, owner: OwnerId) -> Result<(), OwnerInvalidationError> {
        self.runtime.invalidate_owner(owner)?;
        self.records.retain(|_, record| record.owner != owner);
        self.ready.retain(|resolution| resolution.owner != owner);
        Ok(())
    }

    pub fn drain_completions(
        &mut self,
        scheduler: &Scheduler,
    ) -> Result<Vec<TaskResolution<A>>, TaskDrainError> {
        for settlement in self.runtime.drain_completions(scheduler)? {
            if matches!(
                settlement.disposition,
                TaskSettlementDisposition::Dropped(_)
            ) {
                continue;
            }
            let Some(record) = self.records.get_mut(&settlement.task) else {
                continue;
            };
            if record.result.is_some() {
                continue;
            }

            let result = match settlement.disposition {
                TaskSettlementDisposition::Deliver => match settlement.outcome {
                    WorkerOutcome::Completed(result) => encode_task_result(result),
                    outcome => command_result_json(Err(worker_failure_nexa_error(
                        &outcome,
                        record.operation,
                        record.owner,
                        record.kind,
                    )
                    .unwrap_or_else(|| {
                        internal_failure(
                            record.operation,
                            "non-completed worker outcome maps to an error",
                            "SystemCompletion",
                            "worker outcome lost its diagnostic",
                            None,
                        )
                    }))),
                },
                TaskSettlementDisposition::Cancelled => command_result_json(Err(cancelled(
                    record.operation,
                    "cooperativeCancellation",
                    record.owner.raw(),
                    record.kind,
                ))),
                TaskSettlementDisposition::Dropped(_) => unreachable!("handled above"),
            };
            record.result = Some(result);
            self.queue_ready_record(settlement.task);
        }
        Ok(std::mem::take(&mut self.ready))
    }

    #[must_use]
    #[cfg(test)]
    pub fn pending_completion_count(&self) -> usize {
        self.runtime.pending_completion_count()
    }

    fn queue_ready_record(&mut self, task: TaskHandle) {
        let ready = self
            .records
            .get(&task)
            .is_some_and(|record| record.awaiter.is_some() && record.result.is_some());
        if !ready {
            return;
        }
        let mut record = self.records.remove(&task).expect("ready record exists");
        self.ready.push(TaskResolution {
            owner: record.owner,
            awaiter: record.awaiter.take().expect("ready awaiter"),
            encoded: record.result.take().expect("ready result"),
        });
    }
}

fn handle_ref(task: TaskHandle) -> HandleRef {
    HandleRef {
        slot: task.slot(),
        generation: task.generation(),
    }
}

fn encode_task_result(result: CommandResult<SystemTaskValue>) -> String {
    command_result_json(result.map(|value| match value {
        SystemTaskValue::Text(text) => Value::String(text),
        SystemTaskValue::Unit => Value::Null,
        SystemTaskValue::OptionalText(path) => path.map_or(Value::Null, Value::String),
    }))
}

fn dialog_nexa_error(error: DialogError, operation: &str) -> NexaError {
    match error {
        DialogError::InvalidRequest(message) => invalid_data(operation, "dialog-request", &message),
        DialogError::PlatformFailure(message) => {
            platform_failure(operation, std::env::consts::OS, None, message, None)
        }
    }
}

fn clipboard_nexa_error(error: ClipboardError, operation: &str) -> NexaError {
    let (platform_code, message) = match error {
        ClipboardError::Unavailable(message) => ("CLIPBOARD_UNAVAILABLE", message),
        ClipboardError::Operation(message) => ("CLIPBOARD_OPERATION", message),
    };
    platform_failure(
        operation,
        std::env::consts::OS,
        Some(platform_code),
        message,
        None,
    )
}

fn task_spawn_nexa_error(error: TaskSpawnError, operation: &str, owner: OwnerId) -> NexaError {
    match error {
        TaskSpawnError::Create(error) => invalid_argument(
            operation,
            "owner",
            "active owner with available task capacity",
            &format!("{} ({error:?})", owner.raw()),
        ),
        TaskSpawnError::Registry(error) => internal_failure(
            operation,
            "new task activates in the creating owner",
            "taskSubmit",
            format!("task activation failed: {error:?}"),
            None,
        ),
        TaskSpawnError::QueueFull => platform_failure(
            operation,
            "runtime",
            Some("TASK_QUEUE_FULL"),
            "System worker queue is full",
            None,
        ),
        TaskSpawnError::ExecutorStopped => internal_failure(
            operation,
            "System worker executor remains available",
            "taskSubmit",
            "System worker executor is stopped",
            None,
        ),
    }
}

fn filesystem_nexa_error(
    error: FileSystemError,
    operation: &str,
    owner: OwnerId,
    kind: TaskKind,
    fallback_path: &Path,
) -> NexaError {
    let identifier = error.path().to_string_lossy().into_owned();
    match error {
        FileSystemError::Cancelled { .. } => {
            cancelled(operation, "cooperativeCancellation", owner.raw(), kind)
        }
        FileSystemError::NotFound { .. } => not_found(operation, "file", &identifier),
        FileSystemError::InvalidData { .. } => invalid_data(operation, "utf-8", &identifier),
        FileSystemError::PlatformFailure { source, .. } => {
            let platform_code = source.raw_os_error().map(|code| format!("OS_ERROR_{code}"));
            platform_failure(
                operation,
                std::env::consts::OS,
                platform_code.as_deref(),
                format!(
                    "filesystem operation failed for {}: {source}",
                    fallback_path.to_string_lossy()
                ),
                None,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use nui_app_runtime::{
        HandleKind, OwnerId, Scheduler, TaskDrainError, TaskHandle, TaskState, TaskTransition,
        TickPhase,
    };
    use nui_system_core::protocol::system::ErrorCode;
    use nui_system_core::{
        AtomicWriteFile, ClipboardBackend, ClipboardError, DialogBackend, DialogError,
        DialogRequest, FileSystemBackend,
    };
    use serde_json::{json, Value};

    use super::SystemTaskRuntime;

    const OWNER: OwnerId = OwnerId::from_raw(41);
    const TIMEOUT: Duration = Duration::from_secs(5);
    static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

    fn temporary_file(label: &str) -> PathBuf {
        let sequence = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "nexa-system-task-{label}-{}-{sequence}.txt",
            std::process::id()
        ))
    }

    fn scheduler_at_system_completion() -> Scheduler {
        let mut scheduler = Scheduler::new();
        scheduler.begin_tick().expect("begin tick");
        assert_eq!(scheduler.enter_next(), Ok(TickPhase::PlatformEvents));
        scheduler.exit_phase().expect("exit platform");
        assert_eq!(scheduler.enter_next(), Ok(TickPhase::SystemCompletion));
        scheduler
    }

    fn wait_for_completion(runtime: &SystemTaskRuntime<u32>) {
        let deadline = Instant::now() + TIMEOUT;
        while runtime.pending_completion_count() == 0 {
            assert!(Instant::now() < deadline, "task completion timed out");
            thread::yield_now();
        }
    }

    fn wait_until(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        while !predicate() {
            assert!(Instant::now() < deadline, "condition timed out");
            thread::yield_now();
        }
    }

    fn drain(runtime: &mut SystemTaskRuntime<u32>) -> Vec<(u32, Value)> {
        runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain task")
            .into_iter()
            .map(|resolution| {
                (
                    resolution.awaiter,
                    serde_json::from_str(&resolution.encoded).expect("result JSON"),
                )
            })
            .collect()
    }

    #[derive(Clone)]
    struct Gate {
        entered: Arc<Barrier>,
        release: Arc<Barrier>,
    }

    impl Gate {
        fn wait(&self) {
            self.entered.wait();
            self.release.wait();
        }
    }

    fn gate() -> (Gate, Arc<Barrier>, Arc<Barrier>) {
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        (
            Gate {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            },
            entered,
            release,
        )
    }

    #[derive(Default)]
    struct MemoryState {
        files: Mutex<HashMap<PathBuf, Vec<u8>>>,
        rename_count: AtomicUsize,
        remove_count: AtomicUsize,
    }

    #[derive(Clone)]
    struct MemoryBackend {
        state: Arc<MemoryState>,
        read_gate: Option<Gate>,
        sync_gate: Option<Gate>,
        rename_gate: Option<Gate>,
    }

    struct MemoryFile {
        state: Arc<MemoryState>,
        path: PathBuf,
        sync_gate: Option<Gate>,
    }

    impl MemoryBackend {
        fn with_target(path: &Path, contents: &str) -> Self {
            let state = Arc::new(MemoryState::default());
            state
                .files
                .lock()
                .expect("memory files")
                .insert(path.to_path_buf(), contents.as_bytes().to_vec());
            Self {
                state,
                read_gate: None,
                sync_gate: None,
                rename_gate: None,
            }
        }

        fn read_gate(mut self, gate: Gate) -> Self {
            self.read_gate = Some(gate);
            self
        }

        fn sync_gate(mut self, gate: Gate) -> Self {
            self.sync_gate = Some(gate);
            self
        }

        fn rename_gate(mut self, gate: Gate) -> Self {
            self.rename_gate = Some(gate);
            self
        }

        fn text(&self, path: &Path) -> String {
            String::from_utf8(
                self.state
                    .files
                    .lock()
                    .expect("memory files")
                    .get(path)
                    .cloned()
                    .expect("memory target"),
            )
            .expect("utf8 memory target")
        }

        fn rename_count(&self) -> usize {
            self.state.rename_count.load(Ordering::Acquire)
        }

        fn remove_count(&self) -> usize {
            self.state.remove_count.load(Ordering::Acquire)
        }

        fn file_count(&self) -> usize {
            self.state.files.lock().expect("memory files").len()
        }
    }

    impl Write for MemoryFile {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.state
                .files
                .lock()
                .expect("memory files")
                .entry(self.path.clone())
                .or_default()
                .extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl AtomicWriteFile for MemoryFile {
        fn sync_all(&mut self) -> io::Result<()> {
            if let Some(gate) = &self.sync_gate {
                gate.wait();
            }
            Ok(())
        }
    }

    impl FileSystemBackend for MemoryBackend {
        type WriteFile = MemoryFile;

        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            if let Some(gate) = &self.read_gate {
                gate.wait();
            }
            self.state
                .files
                .lock()
                .expect("memory files")
                .get(path)
                .cloned()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "memory file missing"))
        }

        fn create_new(&self, path: &Path) -> io::Result<Self::WriteFile> {
            let mut files = self.state.files.lock().expect("memory files");
            if files.contains_key(path) {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "memory file exists",
                ));
            }
            files.insert(path.to_path_buf(), Vec::new());
            Ok(MemoryFile {
                state: Arc::clone(&self.state),
                path: path.to_path_buf(),
                sync_gate: self.sync_gate.clone(),
            })
        }

        fn rename_replace(&self, source: &Path, target: &Path) -> io::Result<()> {
            if let Some(gate) = &self.rename_gate {
                gate.wait();
            }
            let mut files = self.state.files.lock().expect("memory files");
            let contents = files
                .remove(source)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "memory temp missing"))?;
            files.insert(target.to_path_buf(), contents);
            self.state.rename_count.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            let removed = self.state.files.lock().expect("memory files").remove(path);
            if removed.is_some() {
                self.state.remove_count.fetch_add(1, Ordering::AcqRel);
                Ok(())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "memory temp missing",
                ))
            }
        }
    }

    #[derive(Clone)]
    struct MemoryDialog {
        open: Result<Option<PathBuf>, DialogError>,
        save: Result<Option<PathBuf>, DialogError>,
    }

    impl DialogBackend for MemoryDialog {
        fn open_file(&self, _request: &DialogRequest) -> Result<Option<PathBuf>, DialogError> {
            self.open.clone()
        }

        fn save_file(&self, _request: &DialogRequest) -> Result<Option<PathBuf>, DialogError> {
            self.save.clone()
        }
    }

    #[derive(Default)]
    struct MemoryClipboard {
        value: String,
        failure: Option<ClipboardError>,
        read_gate: Option<Gate>,
    }

    impl ClipboardBackend for MemoryClipboard {
        fn read_text(&mut self) -> Result<String, ClipboardError> {
            if let Some(gate) = &self.read_gate {
                gate.wait();
            }
            if let Some(error) = &self.failure {
                return Err(error.clone());
            }
            Ok(self.value.clone())
        }

        fn write_text(&mut self, text: &str) -> Result<(), ClipboardError> {
            if let Some(error) = &self.failure {
                return Err(error.clone());
            }
            self.value = text.to_owned();
            Ok(())
        }
    }

    #[test]
    fn read_task_settles_only_in_system_completion_and_preserves_utf8() {
        let path = temporary_file("read");
        fs::write(&path, "Notes 中文 📝").expect("write fixture");
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_read(OWNER, path.clone())
            .expect("spawn read task");
        runtime.register_awaiter(OWNER, TaskHandle::new(handle.slot, handle.generation), 7);
        wait_for_completion(&runtime);

        let wrong_phase = Scheduler::new();
        assert!(matches!(
            runtime.drain_completions(&wrong_phase),
            Err(TaskDrainError::WrongPhase { .. })
        ));
        let resolutions = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain task");
        assert_eq!(resolutions.len(), 1);
        assert_eq!(resolutions[0].awaiter, 7);
        let encoded: Value = serde_json::from_str(&resolutions[0].encoded).expect("result JSON");
        assert_eq!(encoded, json!({ "ok": true, "value": "Notes 中文 📝" }));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn write_task_atomically_replaces_text_and_resolves_unit() {
        let path = temporary_file("write-success");
        let backend = MemoryBackend::with_target(&path, "old");
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_write_with(
                OWNER,
                path.clone(),
                "new text".to_owned(),
                Arc::new(backend.clone()),
            )
            .expect("spawn write task");
        runtime.register_awaiter(OWNER, TaskHandle::new(handle.slot, handle.generation), 11);
        wait_for_completion(&runtime);

        assert_eq!(
            drain(&mut runtime),
            vec![(11, json!({ "ok": true, "value": null }))]
        );
        assert_eq!(backend.text(&path), "new text");
        assert_eq!(backend.rename_count(), 1);
        assert_eq!(backend.remove_count(), 0);
        assert_eq!(backend.file_count(), 1);
    }

    #[test]
    fn cancellation_before_write_commit_removes_temp_and_resolves_cancelled() {
        let path = temporary_file("write-cancel");
        let (sync_gate, sync_entered, release_sync) = gate();
        let backend = MemoryBackend::with_target(&path, "old").sync_gate(sync_gate);
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_write_with(
                OWNER,
                path.clone(),
                "new text".to_owned(),
                Arc::new(backend.clone()),
            )
            .expect("spawn write task");
        let task = TaskHandle::new(handle.slot, handle.generation);
        runtime.register_awaiter(OWNER, task, 12);

        sync_entered.wait();
        assert_eq!(
            runtime.cancel(OWNER, task),
            Ok(TaskTransition::Changed {
                from: TaskState::Active,
                to: TaskState::Closing,
            })
        );
        assert_eq!(
            runtime.cancel(OWNER, task),
            Ok(TaskTransition::Unchanged(TaskState::Closing))
        );
        release_sync.wait();
        wait_until(|| backend.remove_count() == 1);
        wait_until(|| runtime.pending_completion_count() >= 2);

        let resolutions = drain(&mut runtime);
        assert_eq!(resolutions.len(), 1);
        assert_eq!(resolutions[0].0, 12);
        assert_eq!(resolutions[0].1["ok"], false);
        assert_eq!(
            resolutions[0].1["error"]["code"],
            ErrorCode::Cancelled as u32
        );
        assert_eq!(backend.text(&path), "old");
        assert_eq!(backend.rename_count(), 0);
        assert_eq!(backend.file_count(), 1);
    }

    #[test]
    fn write_commit_wins_over_late_cancellation() {
        let path = temporary_file("write-commit-wins");
        let (rename_gate, rename_entered, release_rename) = gate();
        let backend = MemoryBackend::with_target(&path, "old").rename_gate(rename_gate);
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_write_with(
                OWNER,
                path.clone(),
                "committed".to_owned(),
                Arc::new(backend.clone()),
            )
            .expect("spawn write task");
        let task = TaskHandle::new(handle.slot, handle.generation);
        runtime.register_awaiter(OWNER, task, 13);

        rename_entered.wait();
        assert_eq!(
            runtime.cancel(OWNER, task),
            Ok(TaskTransition::Unchanged(TaskState::Active))
        );
        release_rename.wait();
        wait_for_completion(&runtime);

        assert_eq!(
            drain(&mut runtime),
            vec![(13, json!({ "ok": true, "value": null }))]
        );
        assert_eq!(backend.text(&path), "committed");
        assert_eq!(backend.rename_count(), 1);
        assert_eq!(backend.remove_count(), 0);
        assert_eq!(backend.file_count(), 1);
    }

    #[test]
    fn duplicate_awaiter_gets_invalid_state_without_stealing_first_awaiter() {
        let path = temporary_file("duplicate-awaiter");
        let backend = MemoryBackend::with_target(&path, "result");
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_read_with(OWNER, path, Arc::new(backend))
            .expect("spawn read task");
        let task = TaskHandle::new(handle.slot, handle.generation);
        runtime.register_awaiter(OWNER, task, 21);
        runtime.register_awaiter(OWNER, task, 22);
        wait_for_completion(&runtime);

        let resolutions = drain(&mut runtime);
        let first = resolutions
            .iter()
            .find(|(awaiter, _)| *awaiter == 21)
            .expect("first awaiter resolution");
        let duplicate = resolutions
            .iter()
            .find(|(awaiter, _)| *awaiter == 22)
            .expect("duplicate awaiter resolution");
        assert_eq!(first.1, json!({ "ok": true, "value": "result" }));
        assert_eq!(duplicate.1["ok"], false);
        assert_eq!(duplicate.1["error"]["code"], ErrorCode::InvalidState as u32);
    }

    #[test]
    fn wrong_owner_and_stale_awaiters_receive_distinct_errors() {
        const OTHER_OWNER: OwnerId = OwnerId::from_raw(42);

        let path = temporary_file("invalid-awaiters");
        let (read_gate, read_entered, release_read) = gate();
        let backend = MemoryBackend::with_target(&path, "result").read_gate(read_gate);
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_read_with(OWNER, path, Arc::new(backend))
            .expect("spawn read task");
        let task = TaskHandle::new(handle.slot, handle.generation);
        let stale = TaskHandle::new(handle.slot, handle.generation + 1);

        read_entered.wait();
        let wrong_owner = runtime.cancel(OTHER_OWNER, task).expect_err("wrong owner");
        assert_eq!(wrong_owner.code, ErrorCode::WrongOwner as u32);
        assert_eq!(wrong_owner.operation, "cancelTask");
        let stale_handle = runtime.cancel(OWNER, stale).expect_err("stale handle");
        assert_eq!(stale_handle.code, ErrorCode::StaleHandle as u32);
        assert_eq!(stale_handle.operation, "cancelTask");
        runtime.register_awaiter(OTHER_OWNER, task, 31);
        runtime.register_awaiter(OWNER, stale, 32);
        let resolutions = drain(&mut runtime);
        assert_eq!(resolutions.len(), 2);
        assert_eq!(resolutions[0].0, 31);
        assert_eq!(
            resolutions[0].1["error"]["code"],
            ErrorCode::WrongOwner as u32
        );
        assert_eq!(resolutions[1].0, 32);
        assert_eq!(
            resolutions[1].1["error"]["code"],
            ErrorCode::StaleHandle as u32
        );

        runtime.invalidate_owner(OWNER).expect("invalidate owner");
        release_read.wait();
        wait_for_completion(&runtime);
        assert!(drain(&mut runtime).is_empty());
    }

    #[test]
    fn owner_invalidation_drops_awaiter_and_worker_result_that_arrives_late() {
        let path = temporary_file("invalidate");
        let (read_gate, read_entered, release_read) = gate();
        let backend = MemoryBackend::with_target(&path, "late").read_gate(read_gate);
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_read_with(OWNER, path, Arc::new(backend))
            .expect("spawn read task");
        runtime.register_awaiter(OWNER, TaskHandle::new(handle.slot, handle.generation), 9);

        read_entered.wait();
        runtime.invalidate_owner(OWNER).expect("invalidate owner");
        release_read.wait();
        wait_for_completion(&runtime);
        assert!(drain(&mut runtime).is_empty());
    }

    #[test]
    fn owner_close_invalidates_task_subscription_resource_and_drops_late_awaiter() {
        let path = temporary_file("close-all-handles");
        let (read_gate, read_entered, release_read) = gate();
        let backend = MemoryBackend::with_target(&path, "late").read_gate(read_gate);
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_read_with(OWNER, path, Arc::new(backend))
            .expect("spawn read task");
        let task = TaskHandle::new(handle.slot, handle.generation);
        let subscription = runtime
            .runtime
            .create_handle(OWNER, HandleKind::Subscription)
            .expect("create subscription");
        runtime
            .runtime
            .activate_handle(OWNER, HandleKind::Subscription, subscription)
            .expect("activate subscription");
        let resource = runtime
            .runtime
            .create_handle(OWNER, HandleKind::NativeResource)
            .expect("create resource");
        runtime
            .runtime
            .activate_handle(OWNER, HandleKind::NativeResource, resource)
            .expect("activate resource");
        runtime.register_awaiter(OWNER, task, 10);

        read_entered.wait();
        assert_eq!(runtime.invalidate_owner(OWNER), Ok(()));
        for (kind, handle) in [
            (HandleKind::Task, task),
            (HandleKind::Subscription, subscription),
            (HandleKind::NativeResource, resource),
        ] {
            assert_eq!(
                runtime.runtime.state_handle(OWNER, kind, handle),
                Ok(TaskState::Invalidated)
            );
        }

        release_read.wait();
        wait_for_completion(&runtime);
        assert!(drain(&mut runtime).is_empty());
    }

    #[test]
    fn dialog_tasks_return_selected_path_or_normal_cancel() {
        let request = DialogRequest {
            title: Some("Open notes".to_owned()),
            default_path: None,
            filters: Vec::new(),
        };
        let backend = Arc::new(MemoryDialog {
            open: Ok(Some(PathBuf::from("/tmp/selected.md"))),
            save: Ok(None),
        });
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let open = runtime
            .spawn_open(OWNER, request.clone(), Arc::clone(&backend))
            .expect("open dialog");
        let save = runtime
            .spawn_save(OWNER, request, backend)
            .expect("save dialog");
        runtime.register_awaiter(OWNER, TaskHandle::new(open.slot, open.generation), 41);
        runtime.register_awaiter(OWNER, TaskHandle::new(save.slot, save.generation), 42);
        wait_until(|| runtime.pending_completion_count() >= 2);

        let resolutions = drain(&mut runtime);
        assert_eq!(resolutions.len(), 2);
        let mut by_awaiter = resolutions.into_iter().collect::<HashMap<_, _>>();
        assert_eq!(
            by_awaiter.remove(&41),
            Some(json!({ "ok": true, "value": "/tmp/selected.md" }))
        );
        assert_eq!(
            by_awaiter.remove(&42),
            Some(json!({ "ok": true, "value": null }))
        );
        assert!(by_awaiter.is_empty());
    }

    #[test]
    fn clipboard_tasks_use_injected_backend_and_typed_results() {
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let write = runtime
            .spawn_clipboard_write_with(
                OWNER,
                "Nexa clipboard 中文 📝".to_owned(),
                MemoryClipboard::default(),
            )
            .expect("spawn clipboard write");
        let read = runtime
            .spawn_clipboard_read_with(
                OWNER,
                MemoryClipboard {
                    value: "fixture clipboard".to_owned(),
                    ..MemoryClipboard::default()
                },
            )
            .expect("spawn clipboard read");
        runtime.register_awaiter(OWNER, TaskHandle::new(write.slot, write.generation), 51);
        runtime.register_awaiter(OWNER, TaskHandle::new(read.slot, read.generation), 52);
        wait_until(|| runtime.pending_completion_count() >= 2);

        let resolutions = drain(&mut runtime);
        assert_eq!(resolutions.len(), 2);
        let mut by_awaiter = resolutions.into_iter().collect::<HashMap<_, _>>();
        assert_eq!(
            by_awaiter.remove(&51),
            Some(json!({ "ok": true, "value": null }))
        );
        assert_eq!(
            by_awaiter.remove(&52),
            Some(json!({ "ok": true, "value": "fixture clipboard" }))
        );
    }

    #[test]
    fn clipboard_backend_failure_is_platform_error_not_sentinel() {
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_clipboard_read_with(
                OWNER,
                MemoryClipboard {
                    failure: Some(ClipboardError::Unavailable(
                        "fixture unavailable".to_owned(),
                    )),
                    ..MemoryClipboard::default()
                },
            )
            .expect("spawn clipboard read");
        runtime.register_awaiter(OWNER, TaskHandle::new(handle.slot, handle.generation), 53);
        wait_until(|| runtime.pending_completion_count() >= 1);

        let resolutions = drain(&mut runtime);
        assert_eq!(resolutions.len(), 1);
        assert_eq!(resolutions[0].0, 53);
        assert_eq!(
            resolutions[0].1["error"]["code"],
            ErrorCode::PlatformFailure as u32
        );
        assert_eq!(
            resolutions[0].1["error"]["platformCode"],
            "CLIPBOARD_UNAVAILABLE"
        );
    }

    #[test]
    fn cancelled_clipboard_drops_a_late_backend_result() {
        let (read_gate, read_entered, release_read) = gate();
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_clipboard_read_with(
                OWNER,
                MemoryClipboard {
                    read_gate: Some(read_gate),
                    ..MemoryClipboard::default()
                },
            )
            .expect("spawn clipboard read");
        let task = TaskHandle::new(handle.slot, handle.generation);
        runtime.register_awaiter(OWNER, task, 54);
        read_entered.wait();
        assert!(runtime.cancel(OWNER, task).is_ok());
        release_read.wait();
        wait_for_completion(&runtime);

        let resolutions = drain(&mut runtime);
        assert_eq!(resolutions.len(), 1);
        assert_eq!(resolutions[0].0, 54);
        assert_eq!(
            resolutions[0].1["error"]["code"],
            ErrorCode::Cancelled as u32
        );
    }

    #[test]
    fn cancelled_dialog_drops_late_backend_result() {
        let request = DialogRequest {
            title: None,
            default_path: None,
            filters: Vec::new(),
        };
        let backend = Arc::new(MemoryDialog {
            open: Ok(Some(PathBuf::from("/tmp/late.md"))),
            save: Ok(None),
        });
        let mut runtime = SystemTaskRuntime::new().expect("task runtime");
        let handle = runtime
            .spawn_open(OWNER, request, backend)
            .expect("open dialog");
        let task = TaskHandle::new(handle.slot, handle.generation);
        runtime.register_awaiter(OWNER, task, 43);
        assert_eq!(
            runtime.cancel(OWNER, task),
            Ok(TaskTransition::Changed {
                from: TaskState::Active,
                to: TaskState::Closing,
            })
        );
        wait_until(|| runtime.pending_completion_count() >= 1);
        let resolutions = drain(&mut runtime);
        assert_eq!(resolutions.len(), 1);
        assert_eq!(resolutions[0].0, 43);
        assert_eq!(
            resolutions[0].1["error"]["code"],
            ErrorCode::Cancelled as u32
        );
    }
}

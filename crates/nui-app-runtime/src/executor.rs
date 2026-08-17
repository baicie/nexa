//! Bounded worker execution and Dispatcher-only task completion delivery.

use std::any::Any;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;

use nui_core::TickPhase;

use crate::dispatcher::{DispatchQueue, Dispatcher};
use crate::lifecycle::OwnerId;
use crate::scheduler::Scheduler;
use crate::task::{
    HandleIdentity, HandleIdentityRegistry, HandleKind, OwnerInvalidationError,
    TaskCompletionDisposition, TaskCompletionDropReason, TaskCreateError, TaskHandle,
    TaskRegistryError, TaskState, TaskTransition,
};

pub const DEFAULT_WORKER_COUNT: usize = 4;
pub const DEFAULT_WORK_QUEUE_CAPACITY: usize = 256;

/// Cooperative cancellation shared with one worker operation.
const CANCELLATION_OPEN: u8 = 0;
const CANCELLATION_REQUESTED: u8 = 1;
const CANCELLATION_COMMITTED: u8 = 2;

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    state: Arc<AtomicU8>,
}

impl CancellationToken {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark the operation cancelled and report whether this call won the race.
    #[must_use]
    pub fn cancel(&self) -> bool {
        self.state
            .compare_exchange(
                CANCELLATION_OPEN,
                CANCELLATION_REQUESTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.state.load(Ordering::Acquire) == CANCELLATION_REQUESTED
    }

    /// Enter an operation's irreversible commit section. Once this wins,
    /// later cancellation is a no-op and cannot rewrite a committed result.
    #[must_use]
    pub fn try_begin_commit(&self) -> bool {
        self.state
            .compare_exchange(
                CANCELLATION_OPEN,
                CANCELLATION_COMMITTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn is_committed(&self) -> bool {
        self.state.load(Ordering::Acquire) == CANCELLATION_COMMITTED
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerOutcome<R> {
    Completed(R),
    Cancelled,
    Panicked(String),
}

#[derive(Debug)]
enum TaskCompletionEvent<R> {
    Worker {
        owner: OwnerId,
        task: TaskHandle,
        outcome: WorkerOutcome<R>,
    },
    Cancellation {
        owner: OwnerId,
        task: TaskHandle,
    },
}

type Work<R> = Box<dyn FnOnce(CancellationToken) -> R + Send + 'static>;

struct WorkerJob<R> {
    owner: OwnerId,
    task: TaskHandle,
    cancellation: CancellationToken,
    work: Work<R>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerExecutorCreateError {
    InvalidWorkerCount,
    InvalidQueueCapacity,
    SpawnFailed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerSubmitError {
    QueueFull,
    Stopped,
}

/// Fixed-size worker pool with a bounded, non-blocking submission queue.
/// Jobs can only publish results through the supplied Dispatcher.
struct WorkerExecutor<R: Send + 'static> {
    sender: Option<SyncSender<WorkerJob<R>>>,
    worker_count: usize,
    queue_capacity: usize,
}

impl<R: Send + 'static> std::fmt::Debug for WorkerExecutor<R> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerExecutor")
            .field("worker_count", &self.worker_count)
            .field("queue_capacity", &self.queue_capacity)
            .field("running", &self.sender.is_some())
            .finish()
    }
}

impl<R: Send + 'static> WorkerExecutor<R> {
    fn new(
        worker_count: usize,
        queue_capacity: usize,
        completions: Dispatcher<TaskCompletionEvent<R>>,
    ) -> Result<Self, WorkerExecutorCreateError> {
        if worker_count == 0 {
            return Err(WorkerExecutorCreateError::InvalidWorkerCount);
        }
        if queue_capacity == 0 {
            return Err(WorkerExecutorCreateError::InvalidQueueCapacity);
        }

        let (sender, receiver) = mpsc::sync_channel(queue_capacity);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..worker_count {
            let receiver = Arc::clone(&receiver);
            let completions = completions.clone();
            thread::Builder::new()
                .name(format!("nexa-worker-{index}"))
                .spawn(move || worker_loop(receiver, completions))
                .map_err(|error| WorkerExecutorCreateError::SpawnFailed(error.to_string()))?;
        }

        Ok(Self {
            sender: Some(sender),
            worker_count,
            queue_capacity,
        })
    }

    fn submit(&self, job: WorkerJob<R>) -> Result<(), WorkerSubmitError> {
        let Some(sender) = &self.sender else {
            return Err(WorkerSubmitError::Stopped);
        };
        sender.try_send(job).map_err(|error| match error {
            TrySendError::Full(_) => WorkerSubmitError::QueueFull,
            TrySendError::Disconnected(_) => WorkerSubmitError::Stopped,
        })
    }
}

impl<R: Send + 'static> Drop for WorkerExecutor<R> {
    fn drop(&mut self) {
        // Closing the queue lets idle workers exit. JoinHandle is intentionally
        // detached so dropping the UI runtime never blocks on platform I/O.
        self.sender.take();
    }
}

fn worker_loop<R: Send + 'static>(
    receiver: Arc<Mutex<Receiver<WorkerJob<R>>>>,
    completions: Dispatcher<TaskCompletionEvent<R>>,
) {
    loop {
        let job = {
            let receiver = receiver
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            receiver.recv()
        };
        let Ok(job) = job else {
            return;
        };

        let outcome = run_job(job.cancellation, job.work);
        completions.enqueue(
            DispatchQueue::System,
            TaskCompletionEvent::Worker {
                owner: job.owner,
                task: job.task,
                outcome,
            },
        );
    }
}

fn run_job<R>(cancellation: CancellationToken, work: Work<R>) -> WorkerOutcome<R> {
    if cancellation.is_cancelled() {
        return WorkerOutcome::Cancelled;
    }

    match catch_unwind(AssertUnwindSafe(|| work(cancellation.clone()))) {
        Ok(_) if cancellation.is_cancelled() => WorkerOutcome::Cancelled,
        Ok(value) => WorkerOutcome::Completed(value),
        Err(payload) => WorkerOutcome::Panicked(panic_message(payload.as_ref())),
    }
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "worker panicked without a string payload".to_owned()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSettlementDisposition {
    Deliver,
    Cancelled,
    Dropped(TaskCompletionDropReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskCompletionSource {
    Worker,
    Cancellation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSettlement<R> {
    pub dispatch_sequence: u64,
    pub owner: OwnerId,
    pub task: TaskHandle,
    pub source: TaskCompletionSource,
    pub outcome: WorkerOutcome<R>,
    pub registry_disposition: TaskCompletionDisposition,
    pub disposition: TaskSettlementDisposition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskDrainError {
    WrongPhase { actual: Option<TickPhase> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSpawnError {
    Create(TaskCreateError),
    Registry(TaskRegistryError),
    QueueFull,
    ExecutorStopped,
}

/// UI-thread task coordinator. Workers own no framework, window, tree, or
/// renderer references; the UI thread observes results only by draining the
/// Dispatcher during `SystemCompletion`.
pub struct TaskRuntime<R: Send + 'static> {
    registry: HandleIdentityRegistry,
    executor: WorkerExecutor<R>,
    completions: Dispatcher<TaskCompletionEvent<R>>,
    cancellations: HashMap<TaskHandle, CancellationToken>,
}

impl<R: Send + 'static> Drop for TaskRuntime<R> {
    fn drop(&mut self) {
        for cancellation in self.cancellations.values() {
            let _ = cancellation.cancel();
        }
    }
}

impl<R: Send + 'static> std::fmt::Debug for TaskRuntime<R> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TaskRuntime")
            .field("registry", &self.registry)
            .field("executor", &self.executor)
            .field("pending_completions", &self.pending_completion_count())
            .field("active_cancellations", &self.cancellations.len())
            .finish()
    }
}

impl<R: Send + 'static> TaskRuntime<R> {
    pub fn new() -> Result<Self, WorkerExecutorCreateError> {
        Self::with_config(DEFAULT_WORKER_COUNT, DEFAULT_WORK_QUEUE_CAPACITY)
    }

    pub fn with_config(
        worker_count: usize,
        queue_capacity: usize,
    ) -> Result<Self, WorkerExecutorCreateError> {
        Self::from_dispatcher(worker_count, queue_capacity, Dispatcher::new())
    }

    pub fn with_wakeup(
        worker_count: usize,
        queue_capacity: usize,
        wakeup: impl Fn() + Send + Sync + 'static,
    ) -> Result<Self, WorkerExecutorCreateError> {
        Self::from_dispatcher(
            worker_count,
            queue_capacity,
            Dispatcher::with_wakeup(wakeup),
        )
    }

    fn from_dispatcher(
        worker_count: usize,
        queue_capacity: usize,
        completions: Dispatcher<TaskCompletionEvent<R>>,
    ) -> Result<Self, WorkerExecutorCreateError> {
        let executor = WorkerExecutor::new(worker_count, queue_capacity, completions.clone())?;
        Ok(Self {
            registry: HandleIdentityRegistry::new(),
            executor,
            completions,
            cancellations: HashMap::new(),
        })
    }

    pub fn spawn(
        &mut self,
        owner: OwnerId,
        work: impl FnOnce(CancellationToken) -> R + Send + 'static,
    ) -> Result<TaskHandle, TaskSpawnError> {
        let task = self
            .registry
            .create(owner)
            .map_err(TaskSpawnError::Create)?;
        if let Err(error) = self.registry.activate(owner, task) {
            self.rollback_spawn(owner, task);
            return Err(TaskSpawnError::Registry(error));
        }

        let cancellation = CancellationToken::new();
        self.cancellations.insert(task, cancellation.clone());
        let job = WorkerJob {
            owner,
            task,
            cancellation,
            work: Box::new(work),
        };
        if let Err(error) = self.executor.submit(job) {
            self.cancellations.remove(&task);
            self.rollback_spawn(owner, task);
            return Err(match error {
                WorkerSubmitError::QueueFull => TaskSpawnError::QueueFull,
                WorkerSubmitError::Stopped => TaskSpawnError::ExecutorStopped,
            });
        }
        Ok(task)
    }

    /// Allocate an owner-scoped identity for a non-worker System handle such
    /// as a Subscription or NativeResource. Task work still uses [`Self::spawn`].
    pub fn create_handle(
        &mut self,
        owner: OwnerId,
        kind: HandleKind,
    ) -> Result<HandleIdentity, TaskCreateError> {
        self.registry.create_handle(owner, kind)
    }

    /// Activate a non-worker System handle after its backing resource is ready.
    pub fn activate_handle(
        &mut self,
        owner: OwnerId,
        kind: HandleKind,
        handle: HandleIdentity,
    ) -> Result<TaskTransition, TaskRegistryError> {
        self.registry.activate_handle(owner, kind, handle)
    }

    /// Request idempotent close for a non-worker System handle.
    pub fn close_handle(
        &mut self,
        owner: OwnerId,
        kind: HandleKind,
        handle: HandleIdentity,
    ) -> Result<TaskTransition, TaskRegistryError> {
        self.registry.request_close_handle(owner, kind, handle)
    }

    /// Complete deferred cleanup for a non-worker System handle.
    pub fn finish_close_handle(
        &mut self,
        owner: OwnerId,
        kind: HandleKind,
        handle: HandleIdentity,
    ) -> Result<TaskTransition, TaskRegistryError> {
        self.registry.finish_close_handle(owner, kind, handle)
    }

    /// Read a non-worker System handle's lifecycle state after exact validation.
    pub fn state_handle(
        &self,
        owner: OwnerId,
        kind: HandleKind,
        handle: HandleIdentity,
    ) -> Result<TaskState, TaskRegistryError> {
        self.registry.state_handle(owner, kind, handle)
    }

    pub fn cancel(
        &mut self,
        owner: OwnerId,
        task: TaskHandle,
    ) -> Result<TaskTransition, TaskRegistryError> {
        let state = self.registry.state(owner, task)?;
        let Some(cancellation) = self.cancellations.get(&task) else {
            return self.registry.cancel(owner, task);
        };

        if cancellation.is_committed() {
            return Ok(TaskTransition::Unchanged(state));
        }
        let cancellation_won = cancellation.cancel();
        if !cancellation_won && cancellation.is_committed() {
            return Ok(TaskTransition::Unchanged(state));
        }

        let transition = self.registry.cancel(owner, task)?;
        if cancellation_won && matches!(transition, TaskTransition::Changed { .. }) {
            self.completions.enqueue(
                DispatchQueue::System,
                TaskCompletionEvent::Cancellation { owner, task },
            );
        }
        Ok(transition)
    }

    pub fn invalidate_owner(
        &mut self,
        owner: OwnerId,
    ) -> Result<Vec<HandleIdentity>, OwnerInvalidationError> {
        let handles = self.registry.invalidate_owner(owner)?;
        for handle in &handles {
            if let Some(cancellation) = self.cancellations.get(handle) {
                let _ = cancellation.cancel();
            }
        }
        Ok(handles)
    }

    pub fn drain_completions(
        &mut self,
        scheduler: &Scheduler,
    ) -> Result<Vec<TaskSettlement<R>>, TaskDrainError> {
        if scheduler.phase() != Some(TickPhase::SystemCompletion) {
            return Err(TaskDrainError::WrongPhase {
                actual: scheduler.phase(),
            });
        }

        let mut settlements = Vec::new();
        for item in self.completions.drain_tick() {
            debug_assert_eq!(item.queue, DispatchQueue::System);
            let (owner, task, source, outcome) = match item.payload {
                TaskCompletionEvent::Worker {
                    owner,
                    task,
                    outcome,
                } => (owner, task, TaskCompletionSource::Worker, outcome),
                TaskCompletionEvent::Cancellation { owner, task } => (
                    owner,
                    task,
                    TaskCompletionSource::Cancellation,
                    WorkerOutcome::Cancelled,
                ),
            };
            let cancel_requested = self
                .cancellations
                .get(&task)
                .is_some_and(CancellationToken::is_cancelled);
            let (registry_disposition, disposition, finish_close) = match source {
                TaskCompletionSource::Worker => {
                    let registry_disposition = self.registry.accept_completion(owner, task);
                    let disposition = match (registry_disposition, &outcome) {
                        (TaskCompletionDisposition::Accepted, WorkerOutcome::Cancelled) => {
                            TaskSettlementDisposition::Cancelled
                        }
                        (TaskCompletionDisposition::Accepted, _) => {
                            TaskSettlementDisposition::Deliver
                        }
                        (TaskCompletionDisposition::Dropped(reason), _) => {
                            TaskSettlementDisposition::Dropped(reason)
                        }
                    };
                    let finish_close =
                        matches!(registry_disposition, TaskCompletionDisposition::Accepted)
                            || matches!(
                                registry_disposition,
                                TaskCompletionDisposition::Dropped(
                                    TaskCompletionDropReason::NotActive(TaskState::Closing)
                                )
                            ) && !cancel_requested;
                    (registry_disposition, disposition, finish_close)
                }
                TaskCompletionSource::Cancellation => {
                    let registry_disposition = match self.registry.state(owner, task) {
                        Ok(state) => TaskCompletionDisposition::Dropped(
                            TaskCompletionDropReason::NotActive(state),
                        ),
                        Err(error) => {
                            TaskCompletionDisposition::Dropped(completion_drop_reason(error))
                        }
                    };
                    let disposition = match registry_disposition {
                        TaskCompletionDisposition::Dropped(
                            TaskCompletionDropReason::NotActive(TaskState::Closing),
                        ) => TaskSettlementDisposition::Cancelled,
                        TaskCompletionDisposition::Dropped(reason) => {
                            TaskSettlementDisposition::Dropped(reason)
                        }
                        TaskCompletionDisposition::Accepted => {
                            unreachable!("state lookup cannot accept a completion")
                        }
                    };
                    let finish_close = disposition == TaskSettlementDisposition::Cancelled;
                    (registry_disposition, disposition, finish_close)
                }
            };

            if finish_close {
                debug_assert!(self.registry.finish_close(owner, task).is_ok());
            }
            if source == TaskCompletionSource::Worker {
                self.cancellations.remove(&task);
            }
            settlements.push(TaskSettlement {
                dispatch_sequence: item.sequence,
                owner,
                task,
                source,
                outcome,
                registry_disposition,
                disposition,
            });
        }
        Ok(settlements)
    }

    #[must_use]
    pub const fn registry(&self) -> &HandleIdentityRegistry {
        &self.registry
    }

    #[must_use]
    pub fn pending_completion_count(&self) -> usize {
        self.completions.pending_count()
    }

    #[must_use]
    pub fn active_cancellation_count(&self) -> usize {
        self.cancellations.len()
    }

    fn rollback_spawn(&mut self, owner: OwnerId, task: TaskHandle) {
        self.registry
            .discard_unpublished_task(owner, task)
            .expect("a failed spawn must still own its unpublished task identity");
    }
}

fn completion_drop_reason(error: TaskRegistryError) -> TaskCompletionDropReason {
    match error {
        TaskRegistryError::InvalidHandle => TaskCompletionDropReason::InvalidHandle,
        TaskRegistryError::InvalidKind { expected, actual } => {
            TaskCompletionDropReason::InvalidKind { expected, actual }
        }
        TaskRegistryError::StaleHandle => TaskCompletionDropReason::StaleHandle,
        TaskRegistryError::WrongOwner { expected, actual } => {
            TaskCompletionDropReason::WrongOwner { expected, actual }
        }
        TaskRegistryError::InvalidState { state } => TaskCompletionDropReason::NotActive(state),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;
    use std::time::{Duration, Instant};

    use nui_core::TickPhase;

    use super::{
        TaskCompletionSource, TaskDrainError, TaskRuntime, TaskSettlementDisposition,
        TaskSpawnError, WorkerExecutorCreateError, WorkerOutcome,
    };
    use crate::{
        HandleKind, OwnerId, Scheduler, TaskCompletionDisposition, TaskCompletionDropReason,
        TaskRegistryError, TaskState, TaskTransition,
    };

    const OWNER_A: OwnerId = OwnerId::from_raw(41);
    const OWNER_B: OwnerId = OwnerId::from_raw(42);
    const TIMEOUT: Duration = Duration::from_secs(5);

    fn scheduler_at_system_completion() -> Scheduler {
        let mut scheduler = Scheduler::new();
        scheduler.begin_tick().expect("begin tick");
        assert_eq!(
            scheduler.enter_next().expect("platform phase"),
            TickPhase::PlatformEvents
        );
        scheduler.exit_phase().expect("exit platform phase");
        assert_eq!(
            scheduler.enter_next().expect("system phase"),
            TickPhase::SystemCompletion
        );
        scheduler
    }

    fn wait_for_pending<R: Send + 'static>(runtime: &TaskRuntime<R>, expected: usize) {
        let deadline = Instant::now() + TIMEOUT;
        while runtime.pending_completion_count() < expected {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {expected} pending completions; observed {}",
                runtime.pending_completion_count()
            );
            thread::yield_now();
        }
    }

    #[test]
    fn worker_runs_off_ui_thread_and_only_system_phase_can_drain() {
        let (wake_sender, wake_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_wakeup(1, 4, move || {
            let _ = wake_sender.send(());
        })
        .expect("worker runtime");
        let ui_thread = thread::current().id();
        let task = runtime
            .spawn(OWNER_A, |_| thread::current().id())
            .expect("spawn task");

        wake_receiver
            .recv_timeout(TIMEOUT)
            .expect("completion wakeup");
        assert_eq!(runtime.pending_completion_count(), 1);
        let scheduler = Scheduler::new();
        assert_eq!(
            runtime.drain_completions(&scheduler),
            Err(TaskDrainError::WrongPhase { actual: None })
        );
        assert_eq!(runtime.pending_completion_count(), 1);

        let scheduler = scheduler_at_system_completion();
        let settlements = runtime
            .drain_completions(&scheduler)
            .expect("system completion drain");
        assert_eq!(settlements.len(), 1);
        let settlement = &settlements[0];
        let WorkerOutcome::Completed(worker_thread) = settlement.outcome else {
            panic!("expected completed worker thread id")
        };
        assert_ne!(worker_thread, ui_thread);
        assert_eq!(settlement.task, task);
        assert_eq!(settlement.source, TaskCompletionSource::Worker);
        assert_eq!(
            settlement.registry_disposition,
            TaskCompletionDisposition::Accepted
        );
        assert_eq!(settlement.disposition, TaskSettlementDisposition::Deliver);
        assert_eq!(
            runtime.registry().state(OWNER_A, task),
            Ok(TaskState::Closed)
        );
        assert_eq!(runtime.active_cancellation_count(), 0);
    }

    #[test]
    fn cancellation_wins_the_worker_race_and_settles_once_as_cancelled() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_config(1, 4).expect("worker runtime");
        let task = runtime
            .spawn(OWNER_A, move |_| {
                started_sender.send(()).expect("signal started");
                release_receiver.recv().expect("release worker");
                17_u32
            })
            .expect("spawn task");
        started_receiver
            .recv_timeout(TIMEOUT)
            .expect("worker started");

        assert_eq!(
            runtime.cancel(OWNER_A, task),
            Ok(TaskTransition::Changed {
                from: TaskState::Active,
                to: TaskState::Closing,
            })
        );
        assert_eq!(
            runtime.cancel(OWNER_A, task),
            Ok(TaskTransition::Unchanged(TaskState::Closing))
        );
        assert_eq!(runtime.pending_completion_count(), 1);

        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain cancellation");
        assert_eq!(settlements.len(), 1);
        assert_eq!(settlements[0].outcome, WorkerOutcome::Cancelled);
        assert_eq!(settlements[0].source, TaskCompletionSource::Cancellation);
        assert_eq!(
            settlements[0].registry_disposition,
            TaskCompletionDisposition::Dropped(TaskCompletionDropReason::NotActive(
                TaskState::Closing,
            ))
        );
        assert_eq!(
            settlements[0].disposition,
            TaskSettlementDisposition::Cancelled
        );
        assert_eq!(
            runtime.registry().state(OWNER_A, task),
            Ok(TaskState::Closed)
        );
        assert_eq!(runtime.active_cancellation_count(), 1);

        release_sender.send(()).expect("release worker");
        wait_for_pending(&runtime, 1);
        let late = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain late worker completion");
        assert_eq!(late.len(), 1);
        assert_eq!(late[0].source, TaskCompletionSource::Worker);
        assert_eq!(late[0].outcome, WorkerOutcome::Cancelled);
        assert_eq!(
            late[0].disposition,
            TaskSettlementDisposition::Dropped(TaskCompletionDropReason::NotActive(
                TaskState::Closed,
            ))
        );
        assert_eq!(runtime.registry().completion_counts().dropped_closed, 1);
        assert_eq!(runtime.active_cancellation_count(), 0);
    }

    #[test]
    fn commit_wins_cancel_race_without_closing_or_cancellation_delivery() {
        let (commit_sender, commit_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_config(1, 4).expect("worker runtime");
        let task = runtime
            .spawn(OWNER_A, move |cancellation| {
                assert!(cancellation.try_begin_commit());
                commit_sender.send(()).expect("signal commit started");
                release_receiver.recv().expect("release worker");
                17_u32
            })
            .expect("spawn task");
        commit_receiver
            .recv_timeout(TIMEOUT)
            .expect("worker began commit");

        assert_eq!(
            runtime.cancel(OWNER_A, task),
            Ok(TaskTransition::Unchanged(TaskState::Active))
        );
        assert_eq!(runtime.pending_completion_count(), 0);
        assert_eq!(
            runtime.registry().state(OWNER_A, task),
            Ok(TaskState::Active)
        );

        release_sender.send(()).expect("release worker");
        wait_for_pending(&runtime, 1);
        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain committed worker");
        assert_eq!(settlements.len(), 1);
        assert_eq!(settlements[0].source, TaskCompletionSource::Worker);
        assert_eq!(settlements[0].outcome, WorkerOutcome::Completed(17));
        assert_eq!(
            settlements[0].disposition,
            TaskSettlementDisposition::Deliver
        );
        assert_eq!(
            runtime.registry().state(OWNER_A, task),
            Ok(TaskState::Closed)
        );
    }

    #[test]
    fn cancellation_wins_commit_race_and_prevents_commit() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let (commit_sender, commit_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_config(1, 4).expect("worker runtime");
        let task = runtime
            .spawn(OWNER_A, move |cancellation| {
                started_sender.send(()).expect("signal started");
                release_receiver.recv().expect("release worker");
                commit_sender
                    .send(cancellation.try_begin_commit())
                    .expect("report commit attempt");
                17_u32
            })
            .expect("spawn task");
        started_receiver
            .recv_timeout(TIMEOUT)
            .expect("worker started");

        assert_eq!(
            runtime.cancel(OWNER_A, task),
            Ok(TaskTransition::Changed {
                from: TaskState::Active,
                to: TaskState::Closing,
            })
        );
        assert_eq!(runtime.pending_completion_count(), 1);

        release_sender.send(()).expect("release worker");
        assert_eq!(
            commit_receiver.recv_timeout(TIMEOUT),
            Ok(false),
            "a cancelled operation must not begin its commit"
        );
        wait_for_pending(&runtime, 2);
        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain cancellation and worker");
        assert_eq!(settlements.len(), 2);
        assert_eq!(settlements[0].source, TaskCompletionSource::Cancellation);
        assert_eq!(
            settlements[0].disposition,
            TaskSettlementDisposition::Cancelled
        );
        assert_eq!(settlements[1].source, TaskCompletionSource::Worker);
        assert_eq!(settlements[1].outcome, WorkerOutcome::Cancelled);
        assert!(matches!(
            settlements[1].disposition,
            TaskSettlementDisposition::Dropped(_)
        ));
    }

    #[test]
    fn cancellation_supersedes_a_worker_completion_already_in_the_queue() {
        let mut runtime = TaskRuntime::with_config(1, 4).expect("worker runtime");
        let task = runtime.spawn(OWNER_A, |_| 17_u32).expect("spawn task");
        wait_for_pending(&runtime, 1);

        assert_eq!(
            runtime.cancel(OWNER_A, task),
            Ok(TaskTransition::Changed {
                from: TaskState::Active,
                to: TaskState::Closing,
            })
        );
        assert_eq!(runtime.pending_completion_count(), 2);

        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain raced completion and cancellation");
        assert_eq!(settlements.len(), 2);
        assert_eq!(settlements[0].source, TaskCompletionSource::Worker);
        assert_eq!(settlements[0].outcome, WorkerOutcome::Completed(17));
        assert_eq!(
            settlements[0].disposition,
            TaskSettlementDisposition::Dropped(TaskCompletionDropReason::NotActive(
                TaskState::Closing,
            ))
        );
        assert_eq!(settlements[1].source, TaskCompletionSource::Cancellation);
        assert_eq!(
            settlements[1].disposition,
            TaskSettlementDisposition::Cancelled
        );
        assert_eq!(
            settlements
                .iter()
                .filter(|settlement| {
                    !matches!(
                        settlement.disposition,
                        TaskSettlementDisposition::Dropped(_)
                    )
                })
                .count(),
            1
        );
        assert_eq!(
            runtime.registry().state(OWNER_A, task),
            Ok(TaskState::Closed)
        );
        assert_eq!(runtime.active_cancellation_count(), 0);
    }

    #[test]
    fn cancellation_controls_settlement_without_hiding_a_worker_panic() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::<()>::with_config(1, 4).expect("worker runtime");
        let task = runtime
            .spawn(OWNER_A, move |_| {
                started_sender.send(()).expect("signal started");
                release_receiver.recv().expect("release worker");
                panic!("panic after cancellation");
            })
            .expect("spawn task");
        started_receiver
            .recv_timeout(TIMEOUT)
            .expect("worker started");

        runtime.cancel(OWNER_A, task).expect("cancel task");
        let cancelled = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain cancellation");
        assert_eq!(cancelled.len(), 1);
        assert_eq!(
            cancelled[0].disposition,
            TaskSettlementDisposition::Cancelled
        );

        release_sender.send(()).expect("release worker");
        wait_for_pending(&runtime, 1);
        let late = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain panicked worker");
        assert_eq!(late.len(), 1);
        assert_eq!(
            late[0].outcome,
            WorkerOutcome::Panicked("panic after cancellation".to_owned())
        );
        assert_eq!(
            late[0].disposition,
            TaskSettlementDisposition::Dropped(TaskCompletionDropReason::NotActive(
                TaskState::Closed,
            ))
        );
    }

    #[test]
    fn wrong_owner_cancel_does_not_touch_the_worker_token() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_config(1, 4).expect("worker runtime");
        let task = runtime
            .spawn(OWNER_A, move |cancellation| {
                started_sender.send(()).expect("signal started");
                release_receiver.recv().expect("release worker");
                cancellation.is_cancelled()
            })
            .expect("spawn task");
        started_receiver
            .recv_timeout(TIMEOUT)
            .expect("worker started");

        assert_eq!(
            runtime.cancel(OWNER_B, task),
            Err(TaskRegistryError::WrongOwner {
                expected: OWNER_A,
                actual: OWNER_B,
            })
        );
        release_sender.send(()).expect("release worker");
        wait_for_pending(&runtime, 1);
        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain task");
        assert_eq!(settlements[0].outcome, WorkerOutcome::Completed(false));
        assert_eq!(
            settlements[0].disposition,
            TaskSettlementDisposition::Deliver
        );
    }

    #[test]
    fn owner_invalidation_cancels_work_and_drops_the_completion() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_config(1, 4).expect("worker runtime");
        let task = runtime
            .spawn(OWNER_A, move |_| {
                started_sender.send(()).expect("signal started");
                release_receiver.recv().expect("release worker");
                "late"
            })
            .expect("spawn task");
        started_receiver
            .recv_timeout(TIMEOUT)
            .expect("worker started");

        assert_eq!(runtime.invalidate_owner(OWNER_A), Ok(vec![task]));
        release_sender.send(()).expect("release worker");
        wait_for_pending(&runtime, 1);
        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain invalidated task");
        assert_eq!(settlements[0].outcome, WorkerOutcome::Cancelled);
        assert_eq!(
            settlements[0].disposition,
            TaskSettlementDisposition::Dropped(TaskCompletionDropReason::NotActive(
                TaskState::Invalidated,
            ))
        );
        assert_eq!(
            runtime.registry().state(OWNER_A, task),
            Ok(TaskState::Invalidated)
        );
        assert_eq!(runtime.active_cancellation_count(), 0);
    }

    #[test]
    fn owner_invalidation_invalidates_all_system_handles_and_drops_late_work() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_config(1, 4).expect("worker runtime");
        let task = runtime
            .spawn(OWNER_A, move |_| {
                started_sender.send(()).expect("worker started");
                release_receiver.recv().expect("release worker");
                "late"
            })
            .expect("spawn task");
        let subscription = runtime
            .create_handle(OWNER_A, HandleKind::Subscription)
            .expect("create subscription");
        runtime
            .activate_handle(OWNER_A, HandleKind::Subscription, subscription)
            .expect("activate subscription");
        let resource = runtime
            .create_handle(OWNER_A, HandleKind::NativeResource)
            .expect("create resource");
        runtime
            .activate_handle(OWNER_A, HandleKind::NativeResource, resource)
            .expect("activate resource");

        started_receiver
            .recv_timeout(TIMEOUT)
            .expect("worker entered close race");
        assert_eq!(
            runtime.invalidate_owner(OWNER_A),
            Ok(vec![task, subscription, resource])
        );
        for (kind, handle) in [
            (HandleKind::Task, task),
            (HandleKind::Subscription, subscription),
            (HandleKind::NativeResource, resource),
        ] {
            assert_eq!(
                runtime.state_handle(OWNER_A, kind, handle),
                Ok(TaskState::Invalidated)
            );
        }

        release_sender.send(()).expect("release worker");
        wait_for_pending(&runtime, 1);
        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain late worker completion");
        assert_eq!(settlements.len(), 1);
        assert_eq!(settlements[0].outcome, WorkerOutcome::Cancelled);
        assert_eq!(
            settlements[0].disposition,
            TaskSettlementDisposition::Dropped(TaskCompletionDropReason::NotActive(
                TaskState::Invalidated,
            ))
        );
        assert_eq!(runtime.active_cancellation_count(), 0);
    }

    #[test]
    fn two_workers_execute_concurrently() {
        let started_barrier = Arc::new(Barrier::new(3));
        let (started_sender, started_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_config(2, 4).expect("worker runtime");

        for index in 0..2 {
            let barrier = Arc::clone(&started_barrier);
            let started_sender = started_sender.clone();
            runtime
                .spawn(OWNER_A, move |_| {
                    started_sender.send(index).expect("signal started");
                    barrier.wait();
                    thread::current().id()
                })
                .expect("spawn concurrent task");
        }
        drop(started_sender);
        let mut started = vec![
            started_receiver
                .recv_timeout(TIMEOUT)
                .expect("first worker started"),
            started_receiver
                .recv_timeout(TIMEOUT)
                .expect("second worker started"),
        ];
        started.sort_unstable();
        assert_eq!(started, vec![0, 1]);
        started_barrier.wait();
        wait_for_pending(&runtime, 2);

        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain concurrent tasks");
        let worker_threads: HashSet<_> = settlements
            .into_iter()
            .map(|settlement| match settlement.outcome {
                WorkerOutcome::Completed(thread) => thread,
                outcome => panic!("unexpected worker outcome: {outcome:?}"),
            })
            .collect();
        assert_eq!(worker_threads.len(), 2);
    }

    #[test]
    fn single_worker_preserves_submission_order() {
        let mut runtime = TaskRuntime::with_config(1, 8).expect("worker runtime");
        let mut handles = Vec::new();
        for value in 0_u8..3 {
            handles.push(
                runtime
                    .spawn(OWNER_A, move |_| value)
                    .expect("spawn ordered task"),
            );
        }
        wait_for_pending(&runtime, 3);

        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain ordered tasks");
        assert_eq!(
            settlements
                .iter()
                .map(|settlement| settlement.task)
                .collect::<Vec<_>>(),
            handles
        );
        assert_eq!(
            settlements
                .iter()
                .map(|settlement| &settlement.outcome)
                .collect::<Vec<_>>(),
            vec![
                &WorkerOutcome::Completed(0),
                &WorkerOutcome::Completed(1),
                &WorkerOutcome::Completed(2),
            ]
        );
        assert!(settlements
            .windows(2)
            .all(|window| window[0].dispatch_sequence < window[1].dispatch_sequence));
    }

    #[test]
    fn full_queue_rejects_without_blocking_or_consuming_identity_budget() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_config(1, 1).expect("worker runtime");
        runtime
            .spawn(OWNER_A, move |_| {
                started_sender.send(()).expect("signal started");
                release_receiver.recv().expect("release worker");
                1_u8
            })
            .expect("spawn blocking task");
        started_receiver
            .recv_timeout(TIMEOUT)
            .expect("worker started");
        runtime.spawn(OWNER_A, |_| 2_u8).expect("fill work queue");

        for _ in 0..32 {
            assert_eq!(
                runtime.spawn(OWNER_B, |_| 3_u8),
                Err(TaskSpawnError::QueueFull)
            );
        }
        let usage = runtime.registry().identity_usage();
        assert_eq!(usage.identities, 2);
        assert_eq!(usage.owners, 1);
        assert_eq!((usage.live, usage.tombstones), (2, 0));

        release_sender.send(()).expect("release worker");
        wait_for_pending(&runtime, 2);
        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain queued work");
        assert_eq!(settlements.len(), 2);
        let usage = runtime.registry().identity_usage();
        assert_eq!((usage.live, usage.tombstones), (0, 2));
    }

    #[test]
    fn dropping_runtime_cancels_active_work_without_waiting_for_it() {
        let release = Arc::new(AtomicBool::new(false));
        let worker_release = Arc::clone(&release);
        let (started_sender, started_receiver) = mpsc::channel();
        let (cancelled_sender, cancelled_receiver) = mpsc::channel();
        let mut runtime = TaskRuntime::with_config(1, 1).expect("worker runtime");
        runtime
            .spawn(OWNER_A, move |cancellation| {
                started_sender.send(()).expect("signal started");
                while !cancellation.is_cancelled() && !worker_release.load(Ordering::Acquire) {
                    thread::yield_now();
                }
                cancelled_sender
                    .send(cancellation.is_cancelled())
                    .expect("report cancellation");
            })
            .expect("spawn task");
        started_receiver
            .recv_timeout(TIMEOUT)
            .expect("worker started");

        let dropped_at = Instant::now();
        drop(runtime);
        assert!(
            dropped_at.elapsed() < TIMEOUT,
            "dropping a runtime waited for worker completion"
        );
        let observed = cancelled_receiver.recv_timeout(TIMEOUT);
        release.store(true, Ordering::Release);
        assert_eq!(observed, Ok(true));
    }

    #[test]
    fn worker_panic_is_contained_and_the_worker_accepts_more_work() {
        let mut runtime = TaskRuntime::<usize>::with_config(1, 4).expect("worker runtime");
        runtime
            .spawn(OWNER_A, |_| panic!("worker boom"))
            .expect("spawn panicking task");
        wait_for_pending(&runtime, 1);
        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain panic");
        assert_eq!(
            settlements[0].outcome,
            WorkerOutcome::Panicked("worker boom".to_owned())
        );
        assert_eq!(
            settlements[0].disposition,
            TaskSettlementDisposition::Deliver
        );

        runtime
            .spawn(OWNER_A, |_| 9)
            .expect("spawn work after panic");
        wait_for_pending(&runtime, 1);
        let settlements = runtime
            .drain_completions(&scheduler_at_system_completion())
            .expect("drain recovery");
        assert_eq!(settlements[0].outcome, WorkerOutcome::Completed(9));
    }

    #[test]
    fn executor_configuration_rejects_zero_workers_or_queue_capacity() {
        assert!(matches!(
            TaskRuntime::<()>::with_config(0, 1),
            Err(WorkerExecutorCreateError::InvalidWorkerCount)
        ));
        assert!(matches!(
            TaskRuntime::<()>::with_config(1, 0),
            Err(WorkerExecutorCreateError::InvalidQueueCapacity)
        ));
    }
}

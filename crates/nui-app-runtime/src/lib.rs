//! Application Runtime skeleton (ADR-006 §3.5 / §3.4).
//!
//! Owns the process tick, cancellable tasks, and lifecycle — not UI paint
//! and not OS API backends.

pub mod dispatcher;
pub mod error_supervisor;
pub mod executor;
pub mod frame_clock;
pub mod lifecycle;
pub mod metrics;
pub mod scheduler;
pub mod task;

pub use dispatcher::{DispatchItem, DispatchQueue, Dispatcher};
pub use error_supervisor::{
    ErrorCounts, ErrorDisposition, ErrorSink, ErrorSupervisor, DEFAULT_ERROR_HISTORY_LIMIT,
};
pub use executor::{
    CancellationToken, TaskCompletionSource, TaskDrainError, TaskRuntime, TaskSettlement,
    TaskSettlementDisposition, TaskSpawnError, WorkerExecutorCreateError, WorkerOutcome,
    DEFAULT_WORKER_COUNT, DEFAULT_WORK_QUEUE_CAPACITY,
};
pub use frame_clock::{FrameClock, FrameInstant, ManualFrameClock, SystemFrameClock};
pub use lifecycle::{OwnerId, OwnerScope, OwnerState};
pub use metrics::{
    FrameCounts, FrameDropStage, FrameDurations, FrameMetrics, FrameMetricsObserver,
    FrameMetricsRecorder, FrameMetricsRecorderError, FrameMetricsSink, FrameMetricsTotals,
    FrameOutcome, FramePhase, DEFAULT_FRAME_METRICS_HISTORY_LIMIT,
};
pub use nui_core::{
    DirtyFlags, FrameScheduler, MutationBatch, MutationCommand, MutationError, MutationReceipt,
    NodeRef, TickPhase, ValidatedMutationBatch,
};
pub use scheduler::{Scheduler, SchedulerError};
pub use task::{
    HandleIdentity, HandleIdentityRegistry, HandleIdentityUsage, HandleKind, HandleRegistryError,
    HandleState, HandleTransition, OwnerInvalidationError, TaskCompletionCounts,
    TaskCompletionDisposition, TaskCompletionDropReason, TaskCreateError, TaskHandle, TaskRegistry,
    TaskRegistryError, TaskState, TaskTransition, DEFAULT_HANDLE_IDENTITY_LIMIT,
    DEFAULT_OWNER_IDENTITY_LIMIT,
};

#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

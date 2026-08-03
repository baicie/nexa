//! Application Runtime skeleton (ADR-006 §3.5 / §3.4).
//!
//! Owns the process tick, cancellable tasks, and lifecycle — not UI paint
//! and not OS API backends.

pub mod dispatcher;
pub mod error_supervisor;
pub mod frame_clock;
pub mod lifecycle;
pub mod scheduler;
pub mod task;

pub use nui_core::{FrameScheduler, TickPhase};
pub use task::{TaskHandle, TaskState};

#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

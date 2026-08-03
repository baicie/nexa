//! Cancellable async task handles (ADR-006 §3.4).

/// Lifecycle for Node / Callback / Task / Subscription / Resource handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskState {
    Created,
    Active,
    Closing,
    Closed,
    Invalidated,
}

/// Opaque generation handle for a cancellable task (slot + generation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TaskHandle(u64);

impl TaskHandle {
    #[must_use]
    pub const fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    #[must_use]
    pub const fn raw(self) -> u64 {
        self.0
    }
}

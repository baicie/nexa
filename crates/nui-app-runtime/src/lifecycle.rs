//! Owner lifecycle and deferred cleanup primitives (ADR-006/007).
//!
//! Runtime resources use an explicit owner scope rather than relying on host
//! language GC. Cleanup is queued during close and drained at the scheduler's
//! final phase so no callback/resource is released while an event is running.

use std::collections::VecDeque;

/// Stable identity for an app/window/session owner scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OwnerId(u64);

impl OwnerId {
    #[must_use]
    pub const fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    #[must_use]
    pub const fn raw(self) -> u64 {
        self.0
    }
}

/// Lifecycle shared by Node, Callback, Task, Subscription, and Resource
/// registries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OwnerState {
    Created,
    Active,
    Closing,
    Closed,
    Invalidated,
}

/// Owner-local close state and deferred cleanup queue.
pub struct OwnerScope {
    id: OwnerId,
    state: OwnerState,
    deferred: VecDeque<Box<dyn FnOnce() + Send + 'static>>,
}

impl std::fmt::Debug for OwnerScope {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OwnerScope")
            .field("id", &self.id)
            .field("state", &self.state)
            .field("deferred_count", &self.deferred.len())
            .finish()
    }
}

impl OwnerScope {
    #[must_use]
    pub fn new(id: OwnerId) -> Self {
        Self {
            id,
            state: OwnerState::Created,
            deferred: VecDeque::new(),
        }
    }

    #[must_use]
    pub const fn id(&self) -> OwnerId {
        self.id
    }

    #[must_use]
    pub const fn state(&self) -> OwnerState {
        self.state
    }

    #[must_use]
    pub const fn is_live(&self) -> bool {
        matches!(self.state, OwnerState::Created | OwnerState::Active)
    }

    /// Activate a newly created scope. Repeated activation is idempotent.
    pub fn activate(&mut self) {
        if self.state == OwnerState::Created {
            self.state = OwnerState::Active;
        }
    }

    /// Begin orderly close. Existing close requests are idempotent.
    pub fn begin_close(&mut self) {
        if matches!(self.state, OwnerState::Created | OwnerState::Active) {
            self.state = OwnerState::Closing;
        }
    }

    /// Invalidate the owner immediately; queued cleanup still drains later.
    pub fn invalidate(&mut self) {
        if self.state != OwnerState::Closed {
            self.state = OwnerState::Invalidated;
        }
    }

    /// Mark an orderly close complete after deferred work has drained.
    pub fn finish_close(&mut self) {
        if self.state == OwnerState::Closing {
            self.state = OwnerState::Closed;
        }
    }

    /// Queue resource release for the scheduler's DeferredCleanup phase.
    pub fn defer(&mut self, cleanup: impl FnOnce() + Send + 'static) {
        self.deferred.push_back(Box::new(cleanup));
    }

    /// Drain all queued cleanup callbacks in FIFO order.
    pub fn drain_deferred(&mut self) -> usize {
        let mut drained = 0;
        while let Some(cleanup) = self.deferred.pop_front() {
            cleanup();
            drained += 1;
        }
        drained
    }

    #[must_use]
    pub fn deferred_count(&self) -> usize {
        self.deferred.len()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::{OwnerId, OwnerScope, OwnerState};

    #[test]
    fn close_is_explicit_and_deferred_cleanup_runs_fifo() {
        let mut scope = OwnerScope::new(OwnerId::from_raw(9));
        assert_eq!(scope.state(), OwnerState::Created);
        scope.activate();
        scope.begin_close();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let first = Arc::clone(&observed);
        scope.defer(move || first.lock().expect("cleanup log").push(1));
        let second = Arc::clone(&observed);
        scope.defer(move || second.lock().expect("cleanup log").push(2));
        assert_eq!(scope.drain_deferred(), 2);
        scope.finish_close();
        assert_eq!(scope.state(), OwnerState::Closed);
        assert_eq!(*observed.lock().expect("cleanup log"), vec![1, 2]);
    }

    #[test]
    fn invalidated_owner_is_not_reactivated() {
        let mut scope = OwnerScope::new(OwnerId::from_raw(4));
        scope.activate();
        scope.invalidate();
        scope.activate();
        scope.finish_close();
        assert_eq!(scope.state(), OwnerState::Invalidated);
        assert!(!scope.is_live());
    }
}

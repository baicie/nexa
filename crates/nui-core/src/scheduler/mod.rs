//! Frame scheduling (ADR-006 §3.5 Application Scheduler).
//!
//! Target tick order (not all phases implemented yet):
//!
//! 1. Platform Events  
//! 2. System Completion  
//! 3. Framework Microtasks  
//! 4. State Effects  
//! 5. Host Mutation Commit  
//! 6. Layout  
//! 7. Semantics  
//! 8. Paint  
//! 9. Present  
//! 10. Deferred Cleanup  
//!
//! Hard rules: no state mutation during Layout/Paint; no sync Native→TS
//! callbacks; no nested Frame commits inside event handlers; no background
//! thread calling Framework Adapters.

/// Logical phase of an application tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum TickPhase {
    PlatformEvents = 1,
    SystemCompletion = 2,
    FrameworkMicrotasks = 3,
    StateEffects = 4,
    HostMutationCommit = 5,
    Layout = 6,
    Semantics = 7,
    Paint = 8,
    Present = 9,
    DeferredCleanup = 10,
}

/// Placeholder for the future app-runtime scheduler owned by `nui-app-runtime`.
#[derive(Debug, Default)]
pub struct FrameScheduler {
    phase: Option<TickPhase>,
}

impl FrameScheduler {
    #[must_use]
    pub const fn new() -> Self {
        Self { phase: None }
    }

    #[must_use]
    pub fn phase(&self) -> Option<TickPhase> {
        self.phase
    }

    pub fn enter(&mut self, phase: TickPhase) {
        self.phase = Some(phase);
    }

    pub fn exit(&mut self) {
        self.phase = None;
    }
}

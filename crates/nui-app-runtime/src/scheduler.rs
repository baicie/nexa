//! Deterministic ten-phase application tick scheduler.

use nui_core::TickPhase;

const TICK_ORDER: [TickPhase; 10] = [
    TickPhase::PlatformEvents,
    TickPhase::SystemCompletion,
    TickPhase::FrameworkMicrotasks,
    TickPhase::StateEffects,
    TickPhase::HostMutationCommit,
    TickPhase::Layout,
    TickPhase::Semantics,
    TickPhase::Paint,
    TickPhase::Present,
    TickPhase::DeferredCleanup,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerError {
    NestedFrame,
    TickNotActive,
    PhaseAlreadyExited,
    OutOfOrder {
        expected: TickPhase,
        actual: TickPhase,
    },
    MutationForbidden {
        phase: TickPhase,
    },
    IncompleteTick {
        expected: TickPhase,
    },
}

/// Runtime-owned scheduler. A tick must enter and exit every phase exactly
/// once; mutation guards reject tree/state changes during derived/rendering
/// phases.
#[derive(Debug, Default)]
pub struct Scheduler {
    active: bool,
    next_index: usize,
    phase: Option<TickPhase>,
    completed_ticks: u64,
}

impl Scheduler {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            active: false,
            next_index: 0,
            phase: None,
            completed_ticks: 0,
        }
    }

    #[must_use]
    pub fn phase(&self) -> Option<TickPhase> {
        self.phase
    }

    #[must_use]
    pub fn completed_ticks(&self) -> u64 {
        self.completed_ticks
    }

    #[must_use]
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Begin a new frame. Calling this while a frame is active is a nested
    /// commit attempt and is rejected deterministically.
    pub fn begin_tick(&mut self) -> Result<(), SchedulerError> {
        if self.active {
            return Err(SchedulerError::NestedFrame);
        }
        self.active = true;
        self.next_index = 0;
        self.phase = None;
        Ok(())
    }

    /// Enter the next contract phase.
    pub fn enter_next(&mut self) -> Result<TickPhase, SchedulerError> {
        if !self.active {
            return Err(SchedulerError::TickNotActive);
        }
        if self.phase.is_some() {
            return Err(SchedulerError::PhaseAlreadyExited);
        }
        let Some(&phase) = TICK_ORDER.get(self.next_index) else {
            return Err(SchedulerError::IncompleteTick {
                expected: TickPhase::DeferredCleanup,
            });
        };
        self.phase = Some(phase);
        Ok(phase)
    }

    /// Exit the current phase and advance the expected phase.
    pub fn exit_phase(&mut self) -> Result<(), SchedulerError> {
        let Some(phase) = self.phase.take() else {
            return Err(SchedulerError::PhaseAlreadyExited);
        };
        debug_assert_eq!(TICK_ORDER[self.next_index], phase);
        self.next_index += 1;
        Ok(())
    }

    /// Finish a tick after DeferredCleanup has exited.
    pub fn end_tick(&mut self) -> Result<(), SchedulerError> {
        if !self.active {
            return Err(SchedulerError::TickNotActive);
        }
        if self.phase.is_some() {
            return Err(SchedulerError::IncompleteTick {
                expected: TICK_ORDER[self.next_index],
            });
        }
        if self.next_index != TICK_ORDER.len() {
            return Err(SchedulerError::IncompleteTick {
                expected: TICK_ORDER[self.next_index],
            });
        }
        self.active = false;
        self.completed_ticks = self.completed_ticks.saturating_add(1);
        Ok(())
    }

    /// Return whether a tree/state mutation is legal in the current phase.
    pub fn check_mutation(&self) -> Result<(), SchedulerError> {
        match self.phase {
            Some(phase)
                if matches!(
                    phase,
                    TickPhase::Layout
                        | TickPhase::Semantics
                        | TickPhase::Paint
                        | TickPhase::Present
                ) =>
            {
                Err(SchedulerError::MutationForbidden { phase })
            }
            _ => Ok(()),
        }
    }

    #[must_use]
    pub const fn phases() -> &'static [TickPhase; 10] {
        &TICK_ORDER
    }
}

#[cfg(test)]
mod tests {
    use nui_core::TickPhase;

    use super::{Scheduler, SchedulerError};

    #[test]
    fn runs_all_phases_in_contract_order() {
        let mut scheduler = Scheduler::new();
        scheduler.begin_tick().unwrap();
        let mut seen = Vec::new();
        for _ in 0..10 {
            seen.push(scheduler.enter_next().unwrap());
            scheduler.exit_phase().unwrap();
        }
        scheduler.end_tick().unwrap();
        assert_eq!(seen.as_slice(), Scheduler::phases());
        assert_eq!(scheduler.completed_ticks(), 1);
    }

    #[test]
    fn rejects_nested_frames_and_render_mutations() {
        let mut scheduler = Scheduler::new();
        scheduler.begin_tick().unwrap();
        assert_eq!(scheduler.begin_tick(), Err(SchedulerError::NestedFrame));
        for _ in 0..5 {
            scheduler.enter_next().unwrap();
            scheduler.exit_phase().unwrap();
        }
        assert_eq!(scheduler.enter_next().unwrap(), TickPhase::Layout);
        assert_eq!(
            scheduler.check_mutation(),
            Err(SchedulerError::MutationForbidden {
                phase: TickPhase::Layout
            })
        );
    }

    #[test]
    fn incomplete_tick_cannot_end() {
        let mut scheduler = Scheduler::new();
        scheduler.begin_tick().unwrap();
        assert!(matches!(
            scheduler.end_tick(),
            Err(SchedulerError::IncompleteTick { .. })
        ));
    }
}

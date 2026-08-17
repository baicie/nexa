//! System-runtime handle identities and owner-scoped task lifecycle
//! (ADR-006 §3.4 / ADR-007 §4).

use std::collections::HashMap;

use crate::lifecycle::OwnerId;

pub use nui_core::protocol::common::HandleKind;

const RETIRED_GENERATION_FLOOR: u64 = u32::MAX as u64 + 1;
pub const DEFAULT_HANDLE_IDENTITY_LIMIT: usize = 65_536;
pub const DEFAULT_OWNER_IDENTITY_LIMIT: usize = 16_384;

/// Lifecycle shared by System Runtime Task, Subscription, and NativeResource
/// identities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskState {
    Created,
    Active,
    Closing,
    Closed,
    Invalidated,
}

/// Opaque generation identity with the wire shape `(slot, generation)`.
/// Task-facing APIs retain this historical name; kind remains authoritative in
/// [`HandleIdentityRegistry`], never in the client-provided tuple.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TaskHandle(u64);

impl TaskHandle {
    /// Construct the packed Rust representation of a wire `(slot, generation)`
    /// tuple. Registries reject generation zero when the handle is used.
    #[must_use]
    pub const fn new(slot: u32, generation: u32) -> Self {
        Self(((generation as u64) << 32) | slot as u64)
    }

    #[must_use]
    pub const fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    #[must_use]
    pub const fn raw(self) -> u64 {
        self.0
    }

    #[must_use]
    pub const fn slot(self) -> u32 {
        self.0 as u32
    }

    #[must_use]
    pub const fn generation(self) -> u32 {
        (self.0 >> 32) as u32
    }
}

/// Kind-neutral name used by shared System Runtime identity APIs.
pub type HandleIdentity = TaskHandle;

/// Kind-neutral name for the shared lifecycle state.
pub type HandleState = TaskState;

/// Observable result of one valid lifecycle request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskTransition {
    Changed { from: TaskState, to: TaskState },
    Unchanged(TaskState),
}

pub type HandleTransition = TaskTransition;

/// Registry-local handle validation failure.
///
/// Protocol error-code mapping belongs to the System Host and is intentionally
/// not part of this registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskRegistryError {
    InvalidHandle,
    InvalidKind {
        expected: HandleKind,
        actual: HandleKind,
    },
    StaleHandle,
    WrongOwner {
        expected: OwnerId,
        actual: OwnerId,
    },
    InvalidState {
        state: TaskState,
    },
}

pub type HandleRegistryError = TaskRegistryError;

/// Failure to register a task for an owner lifecycle scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskCreateError {
    OwnerInvalidated { owner: OwnerId },
    IdentityCapacityExceeded { limit: usize },
    OwnerCapacityExceeded { limit: usize },
}

/// Failure to install the terminal fence for an owner that never registered
/// a handle in this runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerInvalidationError {
    OwnerCapacityExceeded { limit: usize },
}

/// Observable hard limits and current lifetime usage for the identity ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandleIdentityUsage {
    pub identities: usize,
    pub identity_limit: usize,
    pub identity_remaining: usize,
    pub owners: usize,
    pub owner_limit: usize,
    pub owner_remaining: usize,
    pub live: usize,
    pub tombstones: usize,
}

/// Why a completion was rejected instead of being delivered to framework
/// settlement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskCompletionDropReason {
    InvalidHandle,
    InvalidKind {
        expected: HandleKind,
        actual: HandleKind,
    },
    StaleHandle,
    WrongOwner {
        expected: OwnerId,
        actual: OwnerId,
    },
    NotActive(TaskState),
}

/// Decision made at the UI-thread completion boundary.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskCompletionDisposition {
    Accepted,
    Dropped(TaskCompletionDropReason),
}

/// Runtime-scoped completion diagnostics. Counters are monotonic and saturate
/// rather than wrapping.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TaskCompletionCounts {
    pub accepted: u64,
    pub dropped: u64,
    pub dropped_invalid_handle: u64,
    pub dropped_invalid_kind: u64,
    pub dropped_stale_handle: u64,
    pub dropped_wrong_owner: u64,
    pub dropped_created: u64,
    pub dropped_active: u64,
    pub dropped_closing: u64,
    pub dropped_closed: u64,
    pub dropped_invalidated: u64,
}

impl TaskCompletionCounts {
    fn record(&mut self, disposition: TaskCompletionDisposition) {
        match disposition {
            TaskCompletionDisposition::Accepted => {
                self.accepted = self.accepted.saturating_add(1);
            }
            TaskCompletionDisposition::Dropped(reason) => {
                self.dropped = self.dropped.saturating_add(1);
                let counter = match reason {
                    TaskCompletionDropReason::InvalidHandle => &mut self.dropped_invalid_handle,
                    TaskCompletionDropReason::InvalidKind { .. } => &mut self.dropped_invalid_kind,
                    TaskCompletionDropReason::StaleHandle => &mut self.dropped_stale_handle,
                    TaskCompletionDropReason::WrongOwner { .. } => &mut self.dropped_wrong_owner,
                    TaskCompletionDropReason::NotActive(TaskState::Created) => {
                        &mut self.dropped_created
                    }
                    TaskCompletionDropReason::NotActive(TaskState::Active) => {
                        &mut self.dropped_active
                    }
                    TaskCompletionDropReason::NotActive(TaskState::Closing) => {
                        &mut self.dropped_closing
                    }
                    TaskCompletionDropReason::NotActive(TaskState::Closed) => {
                        &mut self.dropped_closed
                    }
                    TaskCompletionDropReason::NotActive(TaskState::Invalidated) => {
                        &mut self.dropped_invalidated
                    }
                };
                *counter = counter.saturating_add(1);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HandleRecord {
    handle: HandleIdentity,
    kind: HandleKind,
    owner: OwnerId,
    state: TaskState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HandleSlot {
    Vacant { next_generation: u64 },
    Occupied(HandleRecord),
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocatedHandle {
    Current(HandleRecord),
    Tombstone(HandleRecord),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwnerRegistration {
    Live,
    Invalidated,
}

impl LocatedHandle {
    const fn record(self) -> HandleRecord {
        match self {
            Self::Current(record) | Self::Tombstone(record) => record,
        }
    }
}

/// System Runtime identity registry shared by Task and NativeResource
/// payload stores. The `TaskRegistry` alias preserves the original G4-01 API
/// while making the single allocator explicit.
///
/// Terminal records remain as tombstones for this registry's full lifetime,
/// even after their slot is occupied by a later generation.
#[derive(Debug)]
pub struct HandleIdentityRegistry {
    slots: Vec<HandleSlot>,
    free_slots: Vec<u32>,
    tombstones: HashMap<HandleIdentity, HandleRecord>,
    owners: HashMap<OwnerId, OwnerRegistration>,
    identity_limit: usize,
    owner_limit: usize,
    identity_count: usize,
    live_count: usize,
    completion_counts: TaskCompletionCounts,
}

/// Backwards-compatible task-facing name for [`HandleIdentityRegistry`].
pub type TaskRegistry = HandleIdentityRegistry;

impl Default for HandleIdentityRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl HandleIdentityRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::with_limits(DEFAULT_HANDLE_IDENTITY_LIMIT, DEFAULT_OWNER_IDENTITY_LIMIT)
    }

    /// Construct a registry with hard lifetime budgets. Every successful
    /// allocation reserves its future tombstone, so terminal transitions do
    /// not need to allocate capacity or discard history.
    #[must_use]
    pub fn with_limits(identity_limit: usize, owner_limit: usize) -> Self {
        Self {
            slots: Vec::new(),
            free_slots: Vec::new(),
            tombstones: HashMap::new(),
            owners: HashMap::new(),
            identity_limit,
            owner_limit,
            identity_count: 0,
            live_count: 0,
            completion_counts: TaskCompletionCounts::default(),
        }
    }

    /// Register a newly created task for one app/window/session owner.
    pub fn create(&mut self, owner: OwnerId) -> Result<TaskHandle, TaskCreateError> {
        self.create_handle(owner, HandleKind::Task)
    }

    /// Allocate one identity from the System Runtime-wide slot/generation
    /// ledger. Task, NativeResource, and future system handle registries must
    /// use this entry point so a wire tuple cannot alias another kind.
    pub fn create_handle(
        &mut self,
        owner: OwnerId,
        kind: HandleKind,
    ) -> Result<HandleIdentity, TaskCreateError> {
        if self.owners.get(&owner) == Some(&OwnerRegistration::Invalidated) {
            return Err(TaskCreateError::OwnerInvalidated { owner });
        }
        let owner_is_new = !self.owners.contains_key(&owner);
        if owner_is_new && self.owners.len() >= self.owner_limit {
            return Err(TaskCreateError::OwnerCapacityExceeded {
                limit: self.owner_limit,
            });
        }
        if self.identity_count >= self.identity_limit {
            return Err(TaskCreateError::IdentityCapacityExceeded {
                limit: self.identity_limit,
            });
        }
        if owner_is_new {
            self.owners.insert(owner, OwnerRegistration::Live);
        }

        while let Some(slot) = self.free_slots.pop() {
            let entry = &mut self.slots[slot as usize];
            let next_generation = match *entry {
                HandleSlot::Vacant { next_generation } => next_generation,
                HandleSlot::Occupied(_) | HandleSlot::Retired => {
                    unreachable!("task free list points to an unavailable slot")
                }
            };
            if next_generation >= RETIRED_GENERATION_FLOOR {
                *entry = HandleSlot::Retired;
                continue;
            }

            let handle = TaskHandle::new(slot, next_generation as u32);
            *entry = HandleSlot::Occupied(HandleRecord {
                handle,
                kind,
                owner,
                state: TaskState::Created,
            });
            self.identity_count += 1;
            self.live_count += 1;
            return Ok(handle);
        }

        let slot = u32::try_from(self.slots.len()).expect("task slot space exhausted");
        let handle = TaskHandle::new(slot, 1);
        self.slots.push(HandleSlot::Occupied(HandleRecord {
            handle,
            kind,
            owner,
            state: TaskState::Created,
        }));
        self.identity_count += 1;
        self.live_count += 1;
        Ok(handle)
    }

    /// Activate a created task. Repeated activation is an idempotent no-op.
    pub fn activate(
        &mut self,
        owner: OwnerId,
        handle: TaskHandle,
    ) -> Result<TaskTransition, TaskRegistryError> {
        self.activate_handle(owner, HandleKind::Task, handle)
    }

    /// Activate a created identity after validating kind, owner, generation,
    /// and state against the shared ledger.
    pub fn activate_handle(
        &mut self,
        owner: OwnerId,
        expected_kind: HandleKind,
        handle: HandleIdentity,
    ) -> Result<TaskTransition, TaskRegistryError> {
        let located = self.lookup(owner, expected_kind, handle)?;
        match located {
            LocatedHandle::Current(record) if record.state == TaskState::Created => {
                self.set_current_state(handle, TaskState::Active);
                Ok(TaskTransition::Changed {
                    from: TaskState::Created,
                    to: TaskState::Active,
                })
            }
            LocatedHandle::Current(record) if record.state == TaskState::Active => {
                Ok(TaskTransition::Unchanged(TaskState::Active))
            }
            LocatedHandle::Current(record) | LocatedHandle::Tombstone(record) => {
                Err(TaskRegistryError::InvalidState {
                    state: record.state,
                })
            }
        }
    }

    /// Request cancellation. Created or active tasks enter `Closing`; later
    /// cleanup calls [`Self::finish_close`]. Repeated terminal requests are
    /// successful no-ops.
    pub fn cancel(
        &mut self,
        owner: OwnerId,
        handle: TaskHandle,
    ) -> Result<TaskTransition, TaskRegistryError> {
        self.request_close_handle(owner, HandleKind::Task, handle)
    }

    /// Request orderly close. This has the same lifecycle boundary as cancel:
    /// a live task enters `Closing`, while repeated requests are no-ops.
    pub fn close(
        &mut self,
        owner: OwnerId,
        handle: TaskHandle,
    ) -> Result<TaskTransition, TaskRegistryError> {
        self.request_close_handle(owner, HandleKind::Task, handle)
    }

    /// Request cancel/close for any System Runtime identity. Protocol-facing
    /// commands use their expected kind; a mismatched tuple fails atomically.
    pub fn request_close_handle(
        &mut self,
        owner: OwnerId,
        expected_kind: HandleKind,
        handle: HandleIdentity,
    ) -> Result<TaskTransition, TaskRegistryError> {
        let located = self.lookup(owner, expected_kind, handle)?;
        let state = located.record().state;
        match (located, state) {
            (LocatedHandle::Current(_), TaskState::Created | TaskState::Active) => {
                self.set_current_state(handle, TaskState::Closing);
                Ok(TaskTransition::Changed {
                    from: state,
                    to: TaskState::Closing,
                })
            }
            (_, TaskState::Closing | TaskState::Closed | TaskState::Invalidated) => {
                Ok(TaskTransition::Unchanged(state))
            }
            (_, TaskState::Created | TaskState::Active) => {
                Err(TaskRegistryError::InvalidState { state })
            }
        }
    }

    /// Finish cleanup for a closing task and release its slot. This is an
    /// internal runtime lifecycle hook, separate from a protocol close request.
    pub fn finish_close(
        &mut self,
        owner: OwnerId,
        handle: TaskHandle,
    ) -> Result<TaskTransition, TaskRegistryError> {
        self.finish_close_handle(owner, HandleKind::Task, handle)
    }

    /// Finish cleanup for a closing identity after exact validation.
    pub fn finish_close_handle(
        &mut self,
        owner: OwnerId,
        expected_kind: HandleKind,
        handle: HandleIdentity,
    ) -> Result<TaskTransition, TaskRegistryError> {
        let located = self.lookup(owner, expected_kind, handle)?;
        let state = located.record().state;
        match (located, state) {
            (LocatedHandle::Current(_), TaskState::Closing) => {
                self.finish_current(handle, TaskState::Closed);
                Ok(TaskTransition::Changed {
                    from: TaskState::Closing,
                    to: TaskState::Closed,
                })
            }
            (_, TaskState::Closed | TaskState::Invalidated) => Ok(TaskTransition::Unchanged(state)),
            (_, TaskState::Created | TaskState::Active | TaskState::Closing) => {
                Err(TaskRegistryError::InvalidState { state })
            }
        }
    }

    /// Validate a worker completion on the runtime thread. Acceptance moves
    /// the task to `Closing`; framework settlement and final close are later
    /// runtime phases. Every rejection is explicit and counted.
    pub fn accept_completion(
        &mut self,
        owner: OwnerId,
        handle: TaskHandle,
    ) -> TaskCompletionDisposition {
        let disposition = match self.lookup(owner, HandleKind::Task, handle) {
            Ok(LocatedHandle::Current(record)) if record.state == TaskState::Active => {
                self.set_current_state(handle, TaskState::Closing);
                TaskCompletionDisposition::Accepted
            }
            Ok(located) => TaskCompletionDisposition::Dropped(TaskCompletionDropReason::NotActive(
                located.record().state,
            )),
            Err(TaskRegistryError::InvalidHandle) => {
                TaskCompletionDisposition::Dropped(TaskCompletionDropReason::InvalidHandle)
            }
            Err(TaskRegistryError::InvalidKind { expected, actual }) => {
                TaskCompletionDisposition::Dropped(TaskCompletionDropReason::InvalidKind {
                    expected,
                    actual,
                })
            }
            Err(TaskRegistryError::StaleHandle) => {
                TaskCompletionDisposition::Dropped(TaskCompletionDropReason::StaleHandle)
            }
            Err(TaskRegistryError::WrongOwner { expected, actual }) => {
                TaskCompletionDisposition::Dropped(TaskCompletionDropReason::WrongOwner {
                    expected,
                    actual,
                })
            }
            Err(TaskRegistryError::InvalidState { state }) => {
                TaskCompletionDisposition::Dropped(TaskCompletionDropReason::NotActive(state))
            }
        };
        self.completion_counts.record(disposition);
        disposition
    }

    /// Install a terminal owner fence and immediately invalidate every live
    /// identity it owns. Returned handles are deterministic in slot order.
    pub fn invalidate_owner(
        &mut self,
        owner: OwnerId,
    ) -> Result<Vec<HandleIdentity>, OwnerInvalidationError> {
        if !self.owners.contains_key(&owner) && self.owners.len() >= self.owner_limit {
            return Err(OwnerInvalidationError::OwnerCapacityExceeded {
                limit: self.owner_limit,
            });
        }
        self.owners.insert(owner, OwnerRegistration::Invalidated);
        let handles: Vec<_> = self
            .slots
            .iter()
            .filter_map(|slot| match slot {
                HandleSlot::Occupied(record) if record.owner == owner => Some(record.handle),
                HandleSlot::Vacant { .. } | HandleSlot::Occupied(_) | HandleSlot::Retired => None,
            })
            .collect();
        for &handle in &handles {
            self.finish_current(handle, TaskState::Invalidated);
        }
        Ok(handles)
    }

    /// Return the current or retained terminal state after exact owner and
    /// generation validation.
    pub fn state(
        &self,
        owner: OwnerId,
        handle: TaskHandle,
    ) -> Result<TaskState, TaskRegistryError> {
        self.state_handle(owner, HandleKind::Task, handle)
    }

    /// Return state after exact kind, owner, and generation validation.
    pub fn state_handle(
        &self,
        owner: OwnerId,
        expected_kind: HandleKind,
        handle: HandleIdentity,
    ) -> Result<TaskState, TaskRegistryError> {
        self.lookup(owner, expected_kind, handle)
            .map(|located| located.record().state)
    }

    #[must_use]
    pub const fn live_count(&self) -> usize {
        self.live_count
    }

    #[must_use]
    pub fn tombstone_count(&self) -> usize {
        self.tombstones.len()
    }

    #[must_use]
    pub const fn completion_counts(&self) -> TaskCompletionCounts {
        self.completion_counts
    }

    #[must_use]
    pub fn identity_usage(&self) -> HandleIdentityUsage {
        HandleIdentityUsage {
            identities: self.identity_count,
            identity_limit: self.identity_limit,
            identity_remaining: self.identity_limit.saturating_sub(self.identity_count),
            owners: self.owners.len(),
            owner_limit: self.owner_limit,
            owner_remaining: self.owner_limit.saturating_sub(self.owners.len()),
            live: self.live_count,
            tombstones: self.tombstones.len(),
        }
    }

    /// Remove an identity that failed before it was published outside the
    /// runtime. Unlike close/invalidate, this restores the reserved lifetime
    /// budget and does not create a tombstone because no client could have
    /// observed the handle.
    pub(crate) fn discard_unpublished_task(
        &mut self,
        owner: OwnerId,
        handle: TaskHandle,
    ) -> Result<(), TaskRegistryError> {
        let located = self.lookup(owner, HandleKind::Task, handle)?;
        let LocatedHandle::Current(record) = located else {
            return Err(TaskRegistryError::InvalidState {
                state: located.record().state,
            });
        };
        if !matches!(record.state, TaskState::Created | TaskState::Active) {
            return Err(TaskRegistryError::InvalidState {
                state: record.state,
            });
        }

        let index = handle.slot() as usize;
        let HandleSlot::Occupied(removed) = std::mem::replace(
            &mut self.slots[index],
            HandleSlot::Vacant {
                next_generation: u64::from(handle.generation()),
            },
        ) else {
            unreachable!("validated unpublished task is no longer current")
        };
        assert_eq!(removed, record, "validated unpublished task changed");
        self.free_slots.push(handle.slot());
        self.identity_count -= 1;
        self.live_count -= 1;

        let owner_has_identity = self.slots.iter().any(
            |slot| matches!(slot, HandleSlot::Occupied(candidate) if candidate.owner == owner),
        ) || self
            .tombstones
            .values()
            .any(|candidate| candidate.owner == owner);
        if !owner_has_identity {
            self.owners.remove(&owner);
        }
        Ok(())
    }

    fn lookup(
        &self,
        owner: OwnerId,
        expected_kind: HandleKind,
        handle: TaskHandle,
    ) -> Result<LocatedHandle, TaskRegistryError> {
        if handle.generation() == 0 {
            return Err(TaskRegistryError::InvalidHandle);
        }

        if let Some(HandleSlot::Occupied(record)) = self.slots.get(handle.slot() as usize) {
            if record.handle == handle {
                if record.kind != expected_kind {
                    return Err(TaskRegistryError::InvalidKind {
                        expected: expected_kind,
                        actual: record.kind,
                    });
                }
                Self::validate_owner(owner, *record)?;
                return Ok(LocatedHandle::Current(*record));
            }
        }
        if let Some(record) = self.tombstones.get(&handle).copied() {
            if record.kind != expected_kind {
                return Err(TaskRegistryError::InvalidKind {
                    expected: expected_kind,
                    actual: record.kind,
                });
            }
            Self::validate_owner(owner, record)?;
            return Ok(LocatedHandle::Tombstone(record));
        }
        Err(TaskRegistryError::StaleHandle)
    }

    fn validate_owner(owner: OwnerId, record: HandleRecord) -> Result<(), TaskRegistryError> {
        if record.owner == owner {
            Ok(())
        } else {
            Err(TaskRegistryError::WrongOwner {
                expected: record.owner,
                actual: owner,
            })
        }
    }

    fn set_current_state(&mut self, handle: TaskHandle, state: TaskState) {
        let Some(HandleSlot::Occupied(record)) = self.slots.get_mut(handle.slot() as usize) else {
            unreachable!("validated task is no longer current")
        };
        assert_eq!(record.handle, handle, "validated task generation changed");
        record.state = state;
    }

    fn finish_current(&mut self, handle: TaskHandle, terminal_state: TaskState) {
        debug_assert!(matches!(
            terminal_state,
            TaskState::Closed | TaskState::Invalidated
        ));
        let index = handle.slot() as usize;
        let HandleSlot::Occupied(mut record) =
            std::mem::replace(&mut self.slots[index], HandleSlot::Retired)
        else {
            unreachable!("only a current task can become terminal")
        };
        assert_eq!(record.handle, handle, "validated task generation changed");
        record.state = terminal_state;
        self.tombstones.insert(handle, record);
        self.live_count -= 1;

        let next_generation = u64::from(handle.generation()) + 1;
        if next_generation < RETIRED_GENERATION_FLOOR {
            self.slots[index] = HandleSlot::Vacant { next_generation };
            self.free_slots.push(handle.slot());
        }
    }

    #[cfg(test)]
    fn force_next_generation_for_test(&mut self, slot: u32, generation: u32) {
        assert_ne!(generation, 0);
        while self.slots.len() <= slot as usize {
            let new_slot = self.slots.len() as u32;
            self.slots.push(HandleSlot::Vacant { next_generation: 1 });
            self.free_slots.push(new_slot);
        }
        assert!(matches!(
            self.slots[slot as usize],
            HandleSlot::Vacant { .. }
        ));
        self.slots[slot as usize] = HandleSlot::Vacant {
            next_generation: u64::from(generation),
        };
        self.free_slots.retain(|candidate| *candidate != slot);
        self.free_slots.push(slot);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        HandleIdentityUsage, HandleKind, OwnerInvalidationError, TaskCompletionDisposition,
        TaskCompletionDropReason, TaskCreateError, TaskHandle, TaskRegistry, TaskRegistryError,
        TaskState, TaskTransition,
    };
    use crate::OwnerId;

    const OWNER_A: OwnerId = OwnerId::from_raw(7);
    const OWNER_B: OwnerId = OwnerId::from_raw(8);

    fn create(registry: &mut TaskRegistry, owner: OwnerId) -> TaskHandle {
        registry.create(owner).expect("owner accepts tasks")
    }

    fn activate(registry: &mut TaskRegistry, handle: TaskHandle) {
        assert_eq!(
            registry.activate(OWNER_A, handle),
            Ok(TaskTransition::Changed {
                from: TaskState::Created,
                to: TaskState::Active,
            })
        );
    }

    fn cancel_and_finish_close(registry: &mut TaskRegistry, handle: TaskHandle) {
        assert_eq!(
            registry.cancel(OWNER_A, handle),
            Ok(TaskTransition::Changed {
                from: TaskState::Active,
                to: TaskState::Closing,
            })
        );
        assert_eq!(
            registry.finish_close(OWNER_A, handle),
            Ok(TaskTransition::Changed {
                from: TaskState::Closing,
                to: TaskState::Closed,
            })
        );
    }

    #[derive(Debug, Clone, Copy)]
    enum ModelOperation {
        Activate,
        Cancel,
        Close,
        FinishClose,
        Completion,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ModelOutcome {
        Lifecycle(Result<TaskTransition, TaskRegistryError>),
        Completion(TaskCompletionDisposition),
    }

    fn apply_model(state: &mut TaskState, operation: ModelOperation) -> ModelOutcome {
        match operation {
            ModelOperation::Activate => match *state {
                TaskState::Created => {
                    *state = TaskState::Active;
                    ModelOutcome::Lifecycle(Ok(TaskTransition::Changed {
                        from: TaskState::Created,
                        to: TaskState::Active,
                    }))
                }
                TaskState::Active => {
                    ModelOutcome::Lifecycle(Ok(TaskTransition::Unchanged(TaskState::Active)))
                }
                state @ (TaskState::Closing | TaskState::Closed | TaskState::Invalidated) => {
                    ModelOutcome::Lifecycle(Err(TaskRegistryError::InvalidState { state }))
                }
            },
            ModelOperation::Cancel | ModelOperation::Close => match *state {
                from @ (TaskState::Created | TaskState::Active) => {
                    *state = TaskState::Closing;
                    ModelOutcome::Lifecycle(Ok(TaskTransition::Changed {
                        from,
                        to: TaskState::Closing,
                    }))
                }
                state @ (TaskState::Closing | TaskState::Closed | TaskState::Invalidated) => {
                    ModelOutcome::Lifecycle(Ok(TaskTransition::Unchanged(state)))
                }
            },
            ModelOperation::FinishClose => match *state {
                TaskState::Closing => {
                    *state = TaskState::Closed;
                    ModelOutcome::Lifecycle(Ok(TaskTransition::Changed {
                        from: TaskState::Closing,
                        to: TaskState::Closed,
                    }))
                }
                state @ (TaskState::Closed | TaskState::Invalidated) => {
                    ModelOutcome::Lifecycle(Ok(TaskTransition::Unchanged(state)))
                }
                state @ (TaskState::Created | TaskState::Active) => {
                    ModelOutcome::Lifecycle(Err(TaskRegistryError::InvalidState { state }))
                }
            },
            ModelOperation::Completion => match *state {
                TaskState::Active => {
                    *state = TaskState::Closing;
                    ModelOutcome::Completion(TaskCompletionDisposition::Accepted)
                }
                state => ModelOutcome::Completion(TaskCompletionDisposition::Dropped(
                    TaskCompletionDropReason::NotActive(state),
                )),
            },
        }
    }

    fn apply_registry(
        registry: &mut TaskRegistry,
        handle: TaskHandle,
        operation: ModelOperation,
    ) -> ModelOutcome {
        match operation {
            ModelOperation::Activate => ModelOutcome::Lifecycle(registry.activate(OWNER_A, handle)),
            ModelOperation::Cancel => ModelOutcome::Lifecycle(registry.cancel(OWNER_A, handle)),
            ModelOperation::Close => ModelOutcome::Lifecycle(registry.close(OWNER_A, handle)),
            ModelOperation::FinishClose => {
                ModelOutcome::Lifecycle(registry.finish_close(OWNER_A, handle))
            }
            ModelOperation::Completion => {
                ModelOutcome::Completion(registry.accept_completion(OWNER_A, handle))
            }
        }
    }

    #[test]
    fn handle_round_trips_slot_generation_and_raw_value() {
        let handle = TaskHandle::new(7, 11);

        assert_eq!(handle.slot(), 7);
        assert_eq!(handle.generation(), 11);
        assert_eq!(TaskHandle::from_raw(handle.raw()), handle);
    }

    #[test]
    fn create_activate_cancel_close_follows_the_explicit_lifecycle() {
        let mut registry = TaskRegistry::new();
        let handle = create(&mut registry, OWNER_A);

        assert_eq!(handle.slot(), 0);
        assert_eq!(handle.generation(), 1);
        assert_eq!(registry.state(OWNER_A, handle), Ok(TaskState::Created));
        activate(&mut registry, handle);
        assert_eq!(
            registry.activate(OWNER_A, handle),
            Ok(TaskTransition::Unchanged(TaskState::Active))
        );
        assert_eq!(
            registry.cancel(OWNER_A, handle),
            Ok(TaskTransition::Changed {
                from: TaskState::Active,
                to: TaskState::Closing,
            })
        );
        assert_eq!(
            registry.cancel(OWNER_A, handle),
            Ok(TaskTransition::Unchanged(TaskState::Closing))
        );
        assert_eq!(
            registry.accept_completion(OWNER_A, handle),
            TaskCompletionDisposition::Dropped(TaskCompletionDropReason::NotActive(
                TaskState::Closing,
            ))
        );
        assert_eq!(registry.state(OWNER_A, handle), Ok(TaskState::Closing));
        assert_eq!(
            registry.close(OWNER_A, handle),
            Ok(TaskTransition::Unchanged(TaskState::Closing))
        );
        assert_eq!(
            registry.finish_close(OWNER_A, handle),
            Ok(TaskTransition::Changed {
                from: TaskState::Closing,
                to: TaskState::Closed,
            })
        );
        assert_eq!(
            registry.close(OWNER_A, handle),
            Ok(TaskTransition::Unchanged(TaskState::Closed))
        );
        assert_eq!(
            registry.cancel(OWNER_A, handle),
            Ok(TaskTransition::Unchanged(TaskState::Closed))
        );
        assert_eq!(
            registry.finish_close(OWNER_A, handle),
            Ok(TaskTransition::Unchanged(TaskState::Closed))
        );
        assert_eq!(registry.state(OWNER_A, handle), Ok(TaskState::Closed));
        assert_eq!(registry.live_count(), 0);
        assert_eq!(registry.tombstone_count(), 1);
    }

    #[test]
    fn operation_sequences_match_the_reference_state_model() {
        const OPERATIONS: [ModelOperation; 5] = [
            ModelOperation::Activate,
            ModelOperation::Cancel,
            ModelOperation::Close,
            ModelOperation::FinishClose,
            ModelOperation::Completion,
        ];
        const SEQUENCE_LENGTH: usize = 5;
        let sequence_count = OPERATIONS.len().pow(SEQUENCE_LENGTH as u32);

        for sequence in 0..sequence_count {
            let mut registry = TaskRegistry::new();
            let handle = create(&mut registry, OWNER_A);
            let mut model_state = TaskState::Created;
            let mut expected_accepted = 0_u64;
            let mut expected_dropped = 0_u64;
            let mut encoded = sequence;

            for step in 0..SEQUENCE_LENGTH {
                let operation = OPERATIONS[encoded % OPERATIONS.len()];
                encoded /= OPERATIONS.len();
                let expected = apply_model(&mut model_state, operation);
                let actual = apply_registry(&mut registry, handle, operation);
                assert_eq!(
                    actual, expected,
                    "sequence {sequence}, step {step}, operation {operation:?}"
                );
                assert_eq!(
                    registry.state(OWNER_A, handle),
                    Ok(model_state),
                    "sequence {sequence}, step {step}, operation {operation:?}"
                );
                if let ModelOutcome::Completion(disposition) = expected {
                    match disposition {
                        TaskCompletionDisposition::Accepted => expected_accepted += 1,
                        TaskCompletionDisposition::Dropped(_) => expected_dropped += 1,
                    }
                }
            }

            let counts = registry.completion_counts();
            assert_eq!(counts.accepted, expected_accepted, "sequence {sequence}");
            assert_eq!(counts.dropped, expected_dropped, "sequence {sequence}");
            let usage = registry.identity_usage();
            assert_eq!(usage.identities, 1, "sequence {sequence}");
            assert_eq!(
                (usage.live, usage.tombstones),
                if model_state == TaskState::Closed {
                    (0, 1)
                } else {
                    (1, 0)
                },
                "sequence {sequence}"
            );
        }
    }

    #[test]
    fn invalid_transitions_fail_atomically() {
        let mut registry = TaskRegistry::new();
        let handle = create(&mut registry, OWNER_A);

        assert_eq!(
            registry.finish_close(OWNER_A, handle),
            Err(TaskRegistryError::InvalidState {
                state: TaskState::Created,
            })
        );
        assert_eq!(registry.state(OWNER_A, handle), Ok(TaskState::Created));

        activate(&mut registry, handle);
        assert_eq!(
            registry.finish_close(OWNER_A, handle),
            Err(TaskRegistryError::InvalidState {
                state: TaskState::Active,
            })
        );
        assert_eq!(registry.state(OWNER_A, handle), Ok(TaskState::Active));
    }

    #[test]
    fn exact_owner_and_generation_are_required_without_mutating_the_task() {
        let mut registry = TaskRegistry::new();
        let handle = create(&mut registry, OWNER_A);
        activate(&mut registry, handle);

        assert_eq!(
            registry.cancel(OWNER_B, handle),
            Err(TaskRegistryError::WrongOwner {
                expected: OWNER_A,
                actual: OWNER_B,
            })
        );
        assert_eq!(
            registry.cancel(
                OWNER_A,
                TaskHandle::new(handle.slot(), handle.generation() + 1),
            ),
            Err(TaskRegistryError::StaleHandle)
        );
        assert_eq!(
            registry.cancel(OWNER_A, TaskHandle::new(handle.slot(), 0)),
            Err(TaskRegistryError::InvalidHandle)
        );
        assert_eq!(registry.state(OWNER_A, handle), Ok(TaskState::Active));
    }

    #[test]
    fn shared_identity_ledger_rejects_a_native_resource_as_a_task() {
        let mut registry = TaskRegistry::new();
        let resource = registry
            .create_handle(OWNER_A, HandleKind::NativeResource)
            .expect("live owner accepts native resources");

        assert_eq!(resource, TaskHandle::new(0, 1));
        assert_eq!(
            registry.cancel(OWNER_A, resource),
            Err(TaskRegistryError::InvalidKind {
                expected: HandleKind::Task,
                actual: HandleKind::NativeResource,
            })
        );
        assert_eq!(
            registry.accept_completion(OWNER_A, resource),
            TaskCompletionDisposition::Dropped(TaskCompletionDropReason::InvalidKind {
                expected: HandleKind::Task,
                actual: HandleKind::NativeResource,
            })
        );
        assert_eq!(registry.live_count(), 1);
        assert_eq!(registry.completion_counts().dropped_invalid_kind, 1);
        assert_eq!(
            registry.state_handle(OWNER_A, HandleKind::NativeResource, resource),
            Ok(TaskState::Created)
        );
        assert_eq!(
            registry.activate_handle(OWNER_A, HandleKind::NativeResource, resource),
            Ok(TaskTransition::Changed {
                from: TaskState::Created,
                to: TaskState::Active,
            })
        );
        assert_eq!(
            registry.request_close_handle(OWNER_A, HandleKind::NativeResource, resource),
            Ok(TaskTransition::Changed {
                from: TaskState::Active,
                to: TaskState::Closing,
            })
        );
        assert_eq!(
            registry.finish_close_handle(OWNER_A, HandleKind::NativeResource, resource),
            Ok(TaskTransition::Changed {
                from: TaskState::Closing,
                to: TaskState::Closed,
            })
        );
        assert_eq!(
            registry.state_handle(OWNER_A, HandleKind::NativeResource, resource),
            Ok(TaskState::Closed)
        );
    }

    #[test]
    fn accepted_completion_enters_closing_and_duplicate_completion_is_dropped() {
        let mut registry = TaskRegistry::new();
        let handle = create(&mut registry, OWNER_A);
        activate(&mut registry, handle);

        assert_eq!(
            registry.accept_completion(OWNER_A, handle),
            TaskCompletionDisposition::Accepted
        );
        assert_eq!(registry.state(OWNER_A, handle), Ok(TaskState::Closing));
        assert_eq!(
            registry.accept_completion(OWNER_A, handle),
            TaskCompletionDisposition::Dropped(TaskCompletionDropReason::NotActive(
                TaskState::Closing,
            ))
        );
        assert_eq!(registry.completion_counts().accepted, 1);
        assert_eq!(registry.completion_counts().dropped, 1);
        assert_eq!(registry.completion_counts().dropped_closing, 1);
    }

    #[test]
    fn closed_tombstone_survives_slot_reuse_and_rejects_late_completion() {
        let mut registry = TaskRegistry::new();
        let old = create(&mut registry, OWNER_A);
        activate(&mut registry, old);
        cancel_and_finish_close(&mut registry, old);

        let replacement = create(&mut registry, OWNER_A);
        activate(&mut registry, replacement);

        assert_eq!(replacement.slot(), old.slot());
        assert_eq!(replacement.generation(), old.generation() + 1);
        assert_eq!(registry.state(OWNER_A, old), Ok(TaskState::Closed));
        assert_eq!(
            registry.accept_completion(OWNER_A, old),
            TaskCompletionDisposition::Dropped(TaskCompletionDropReason::NotActive(
                TaskState::Closed,
            ))
        );
        assert_eq!(registry.state(OWNER_A, replacement), Ok(TaskState::Active));
        assert_eq!(registry.completion_counts().dropped_closed, 1);
    }

    #[test]
    fn owner_invalidation_is_idempotent_and_scoped() {
        let mut registry = TaskRegistry::new();
        let created = create(&mut registry, OWNER_A);
        let active = create(&mut registry, OWNER_A);
        activate(&mut registry, active);
        let other = create(&mut registry, OWNER_B);
        assert_eq!(
            registry.activate(OWNER_B, other),
            Ok(TaskTransition::Changed {
                from: TaskState::Created,
                to: TaskState::Active,
            })
        );

        assert_eq!(
            registry.invalidate_owner(OWNER_A),
            Ok(vec![created, active])
        );
        assert_eq!(registry.invalidate_owner(OWNER_A), Ok(Vec::new()));
        assert_eq!(registry.state(OWNER_A, created), Ok(TaskState::Invalidated));
        assert_eq!(registry.state(OWNER_A, active), Ok(TaskState::Invalidated));
        assert_eq!(registry.state(OWNER_B, other), Ok(TaskState::Active));

        assert_eq!(
            registry.create(OWNER_A),
            Err(TaskCreateError::OwnerInvalidated { owner: OWNER_A })
        );
        let replacement = create(&mut registry, OWNER_B);
        assert_eq!(
            registry.activate(OWNER_B, replacement),
            Ok(TaskTransition::Changed {
                from: TaskState::Created,
                to: TaskState::Active,
            })
        );
        assert_eq!(replacement.slot(), active.slot());
        assert_eq!(replacement.generation(), active.generation() + 1);
        assert_eq!(registry.state(OWNER_A, active), Ok(TaskState::Invalidated));
        assert_eq!(registry.state(OWNER_B, replacement), Ok(TaskState::Active));
        assert_eq!(
            registry.cancel(OWNER_A, active),
            Ok(TaskTransition::Unchanged(TaskState::Invalidated))
        );
        assert_eq!(
            registry.close(OWNER_A, active),
            Ok(TaskTransition::Unchanged(TaskState::Invalidated))
        );
    }

    #[test]
    fn owner_invalidation_wins_before_or_after_task_cancellation() {
        for cancel_first in [false, true] {
            let mut registry = TaskRegistry::new();
            let handle = create(&mut registry, OWNER_A);
            activate(&mut registry, handle);

            if cancel_first {
                assert_eq!(
                    registry.cancel(OWNER_A, handle),
                    Ok(TaskTransition::Changed {
                        from: TaskState::Active,
                        to: TaskState::Closing,
                    })
                );
            }
            assert_eq!(registry.invalidate_owner(OWNER_A), Ok(vec![handle]));
            assert_eq!(registry.state(OWNER_A, handle), Ok(TaskState::Invalidated));
            assert_eq!(
                registry.cancel(OWNER_A, handle),
                Ok(TaskTransition::Unchanged(TaskState::Invalidated))
            );
            assert_eq!(
                registry.accept_completion(OWNER_A, handle),
                TaskCompletionDisposition::Dropped(TaskCompletionDropReason::NotActive(
                    TaskState::Invalidated,
                ))
            );
            assert_eq!(registry.completion_counts().dropped_invalidated, 1);
        }
    }

    #[test]
    fn identity_and_owner_budgets_fail_atomically_and_bound_tombstones() {
        let mut registry = TaskRegistry::with_limits(2, 1);
        let first = create(&mut registry, OWNER_A);
        let second = create(&mut registry, OWNER_A);

        assert_eq!(
            registry.create(OWNER_A),
            Err(TaskCreateError::IdentityCapacityExceeded { limit: 2 })
        );
        assert_eq!(
            registry.create(OWNER_B),
            Err(TaskCreateError::OwnerCapacityExceeded { limit: 1 })
        );
        assert_eq!(
            registry.invalidate_owner(OWNER_B),
            Err(OwnerInvalidationError::OwnerCapacityExceeded { limit: 1 })
        );
        assert_eq!(registry.state(OWNER_A, first), Ok(TaskState::Created));
        assert_eq!(registry.state(OWNER_A, second), Ok(TaskState::Created));

        assert_eq!(registry.invalidate_owner(OWNER_A), Ok(vec![first, second]));
        assert_eq!(
            registry.identity_usage(),
            HandleIdentityUsage {
                identities: 2,
                identity_limit: 2,
                identity_remaining: 0,
                owners: 1,
                owner_limit: 1,
                owner_remaining: 0,
                live: 0,
                tombstones: 2,
            }
        );
        assert_eq!(
            registry.create(OWNER_A),
            Err(TaskCreateError::OwnerInvalidated { owner: OWNER_A })
        );
    }

    #[test]
    fn completion_drop_reason_preserves_validation_and_terminal_state() {
        let mut registry = TaskRegistry::new();
        let created = create(&mut registry, OWNER_A);
        let invalidated = create(&mut registry, OWNER_A);
        activate(&mut registry, invalidated);
        let pending = create(&mut registry, OWNER_B);
        assert_eq!(
            registry.invalidate_owner(OWNER_A),
            Ok(vec![created, invalidated])
        );

        let cases = [
            (
                OWNER_A,
                TaskHandle::new(created.slot(), 0),
                TaskCompletionDropReason::InvalidHandle,
            ),
            (
                OWNER_A,
                TaskHandle::new(999, 1),
                TaskCompletionDropReason::StaleHandle,
            ),
            (
                OWNER_B,
                invalidated,
                TaskCompletionDropReason::WrongOwner {
                    expected: OWNER_A,
                    actual: OWNER_B,
                },
            ),
            (
                OWNER_B,
                pending,
                TaskCompletionDropReason::NotActive(TaskState::Created),
            ),
            (
                OWNER_A,
                invalidated,
                TaskCompletionDropReason::NotActive(TaskState::Invalidated),
            ),
        ];

        for (owner, handle, reason) in cases {
            assert_eq!(
                registry.accept_completion(owner, handle),
                TaskCompletionDisposition::Dropped(reason),
            );
        }
        assert_eq!(registry.completion_counts().accepted, 0);
        assert_eq!(registry.completion_counts().dropped, cases.len() as u64);
        assert_eq!(registry.completion_counts().dropped_invalid_handle, 1);
        assert_eq!(registry.completion_counts().dropped_stale_handle, 1);
        assert_eq!(registry.completion_counts().dropped_wrong_owner, 1);
        assert_eq!(registry.completion_counts().dropped_created, 1);
        assert_eq!(registry.completion_counts().dropped_invalidated, 1);
    }

    #[test]
    fn repeated_reuse_monotonically_increments_generation_and_retains_history() {
        let mut registry = TaskRegistry::new();
        let mut history = Vec::new();

        for expected_generation in 1..=64 {
            let handle = create(&mut registry, OWNER_A);
            assert_eq!(handle.slot(), 0);
            assert_eq!(handle.generation(), expected_generation);
            activate(&mut registry, handle);
            cancel_and_finish_close(&mut registry, handle);
            history.push(handle);
        }

        for handle in history {
            assert_eq!(registry.state(OWNER_A, handle), Ok(TaskState::Closed));
        }
        assert_eq!(registry.tombstone_count(), 64);
    }

    #[test]
    fn maximum_generation_retires_the_slot_instead_of_wrapping() {
        let mut registry = TaskRegistry::new();
        registry.force_next_generation_for_test(0, u32::MAX);
        let terminal = create(&mut registry, OWNER_A);
        assert_eq!(terminal.slot(), 0);
        assert_eq!(terminal.generation(), u32::MAX);
        activate(&mut registry, terminal);
        cancel_and_finish_close(&mut registry, terminal);

        let replacement = create(&mut registry, OWNER_A);

        assert_ne!(replacement.slot(), terminal.slot());
        assert_eq!(replacement.generation(), 1);
        assert_eq!(registry.state(OWNER_A, terminal), Ok(TaskState::Closed));
    }
}

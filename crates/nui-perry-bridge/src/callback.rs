//! Session-local callback handles, ownership, and listener replacement state.
//!
//! The registry is the single source of truth for callback identity. Native
//! event delivery must validate the owner and exact generation at dispatch time
//! so a late event cannot invoke a replacement callback.

use std::collections::HashMap;

const RETIRED_GENERATION_FLOOR: u64 = u32::MAX as u64 + 1;

/// Native owner identity for an app/window/session callback scope.
pub type CallbackOwner = u64;

/// Opaque generation handle for a callback registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CallbackHandle {
    slot: u32,
    generation: u32,
}

impl CallbackHandle {
    #[must_use]
    pub const fn new(slot: u32, generation: u32) -> Self {
        Self { slot, generation }
    }

    #[must_use]
    pub const fn slot(self) -> u32 {
        self.slot
    }

    #[must_use]
    pub const fn generation(self) -> u32 {
        self.generation
    }
}

/// Lifecycle state retained for active registrations and tombstones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CallbackState {
    Created,
    Active,
    Closing,
    Closed,
    Invalidated,
}

/// Stable target key for one node/event pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ListenerKey {
    pub node_raw: u64,
    pub event: u32,
}

impl ListenerKey {
    #[must_use]
    pub const fn new(node_raw: u64, event: u32) -> Self {
        Self { node_raw, event }
    }
}

/// Active callback registration returned by the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallbackRegistration {
    pub handle: CallbackHandle,
    pub key: ListenerKey,
    pub owner: CallbackOwner,
    /// Perry closure pointer bits. This value is rooted only while active.
    pub token: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotState {
    Active(CallbackRegistration),
    Tombstone {
        registration: CallbackRegistration,
        state: CallbackState,
    },
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveResult {
    /// A live callback was closed and its pointer can be released from roots.
    Closed(CallbackRegistration),
    /// The callback was already closed. This is an idempotent no-op.
    AlreadyClosed,
    /// The callback was invalidated with its owner and cannot receive events.
    Invalidated,
    /// The handle belongs to another owner scope.
    WrongOwner {
        expected: CallbackOwner,
        actual: CallbackOwner,
    },
    /// The handle never existed and has no retained tombstone.
    Stale,
}

/// Session-local callback registry.
#[derive(Debug, Clone, Default)]
pub struct CallbackRegistry {
    slots: Vec<SlotState>,
    free_slots: Vec<u32>,
    next_generation_floor: Vec<u64>,
    /// Keyed by owner as well as target so independent sessions cannot replace
    /// one another when their node slots happen to match.
    active_by_key: HashMap<(CallbackOwner, ListenerKey), CallbackHandle>,
    /// Tombstones survive slot reuse for the lifetime of this registry.
    tombstones: HashMap<CallbackHandle, (CallbackRegistration, CallbackState)>,
}

impl CallbackRegistry {
    /// Add or replace a listener in the legacy owner-zero scope.
    pub fn add(
        &mut self,
        key: ListenerKey,
        token: i64,
    ) -> (CallbackRegistration, Option<CallbackRegistration>) {
        self.add_owned(0, key, token)
    }

    /// Add or replace the listener for one target in an explicit owner scope.
    pub fn add_owned(
        &mut self,
        owner: CallbackOwner,
        key: ListenerKey,
        token: i64,
    ) -> (CallbackRegistration, Option<CallbackRegistration>) {
        let registration = self.allocate(owner, key, token);
        let replaced = self
            .active_by_key
            .insert((owner, key), registration.handle)
            .and_then(|old| self.close_active(old, CallbackState::Closed));
        (registration, replaced)
    }

    /// Remove a callback without an owner check (compatibility API).
    pub fn remove(&mut self, handle: CallbackHandle) -> RemoveResult {
        self.remove_internal(None, handle)
    }

    /// Remove a callback only when it belongs to the supplied owner.
    pub fn remove_owned(&mut self, owner: CallbackOwner, handle: CallbackHandle) -> RemoveResult {
        self.remove_internal(Some(owner), handle)
    }

    /// Return the generation currently occupying a callback slot, when the
    /// slot is still represented by the registry.
    #[must_use]
    pub fn current_generation(&self, slot: u32) -> Option<u32> {
        self.slots.get(slot as usize).map(slot_generation)
    }

    /// Close every active listener owned by a node in the legacy owner-zero
    /// scope, used during node disposal.
    pub fn invalidate_node(&mut self, node_raw: u64) -> Vec<CallbackRegistration> {
        self.invalidate_node_owned(0, node_raw)
    }

    /// Invalidate every active listener owned by a node in one scope.
    pub fn invalidate_node_owned(
        &mut self,
        owner: CallbackOwner,
        node_raw: u64,
    ) -> Vec<CallbackRegistration> {
        let handles: Vec<_> = self
            .active_by_key
            .iter()
            .filter_map(|((entry_owner, key), handle)| {
                (*entry_owner == owner && key.node_raw == node_raw).then_some(*handle)
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| self.invalidate_handle(owner, handle))
            .collect()
    }

    /// Invalidate all active callbacks for an app/window owner.
    pub fn invalidate_owner(&mut self, owner: CallbackOwner) -> Vec<CallbackRegistration> {
        let handles: Vec<_> = self
            .active_by_key
            .iter()
            .filter_map(|((entry_owner, _), handle)| (*entry_owner == owner).then_some(*handle))
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| self.invalidate_handle(owner, handle))
            .collect()
    }

    /// Find the active registration for a target in the legacy owner-zero
    /// scope.
    #[must_use]
    pub fn active_for_key(&self, key: ListenerKey) -> Option<CallbackRegistration> {
        self.active_for_key_owned(0, key)
    }

    /// Find the active registration for a target and owner.
    #[must_use]
    pub fn active_for_key_owned(
        &self,
        owner: CallbackOwner,
        key: ListenerKey,
    ) -> Option<CallbackRegistration> {
        let handle = self.active_by_key.get(&(owner, key)).copied()?;
        self.active_registration(handle)
    }

    /// Return the retained state for a handle, including closed generations.
    #[must_use]
    pub fn state(&self, handle: CallbackHandle) -> Option<CallbackState> {
        let slot = self.slots.get(handle.slot as usize)?;
        if slot_generation(slot) == handle.generation {
            return Some(match *slot {
                SlotState::Active(_) => CallbackState::Active,
                SlotState::Tombstone { state, .. } => state,
                SlotState::Retired => CallbackState::Invalidated,
            });
        }
        self.tombstones.get(&handle).map(|(_, state)| *state)
    }

    /// Iterate active closure pointer slots for the Perry GC root scanner.
    pub fn visit_active_tokens(&mut self, mut visit: impl FnMut(&mut i64)) {
        for slot in &mut self.slots {
            if let SlotState::Active(registration) = &mut *slot {
                visit(&mut registration.token);
            }
        }
    }

    #[must_use]
    pub fn active_count(&self) -> usize {
        self.active_by_key.len()
    }

    /// Preserve generations exposed by an aborted transactional clone without
    /// applying its listener bindings to the active registry.
    pub fn absorb_aborted(&mut self, aborted: Self) {
        let slot_count = self.slots.len().max(aborted.slots.len());
        self.next_generation_floor.resize(slot_count, 1);

        for index in 0..slot_count {
            let aborted_floor = aborted
                .next_generation_floor
                .get(index)
                .copied()
                .or_else(|| {
                    aborted
                        .slots
                        .get(index)
                        .map(|slot| u64::from(slot_generation(slot)) + 1)
                })
                .unwrap_or(1);
            self.next_generation_floor[index] =
                self.next_generation_floor[index].max(aborted_floor);

            let Some(aborted_slot) = aborted.slots.get(index).copied() else {
                continue;
            };
            if index >= self.slots.len() {
                let retained = self.invalidated_aborted_slot(aborted_slot);
                self.slots.push(retained);
                continue;
            }

            if let SlotState::Active(registration) = aborted_slot {
                if self.active_registration(registration.handle).is_none() {
                    self.tombstones.insert(
                        registration.handle,
                        (registration, CallbackState::Invalidated),
                    );
                }
            }
            if !matches!(self.slots[index], SlotState::Active(_))
                && slot_generation(&aborted_slot) > slot_generation(&self.slots[index])
            {
                self.slots[index] = self.invalidated_aborted_slot(aborted_slot);
            }
        }

        for (handle, tombstone) in aborted.tombstones {
            if self.active_registration(handle).is_none() {
                self.tombstones.entry(handle).or_insert(tombstone);
            }
        }
        self.free_slots.clear();
        for (index, slot) in self.slots.iter_mut().enumerate() {
            if !matches!(slot, SlotState::Active(_) | SlotState::Retired) {
                if self.next_generation_floor[index] >= RETIRED_GENERATION_FLOOR {
                    *slot = SlotState::Retired;
                } else {
                    self.free_slots.push(index as u32);
                }
            }
        }
    }

    fn invalidated_aborted_slot(&mut self, slot: SlotState) -> SlotState {
        match slot {
            SlotState::Active(registration) => {
                self.tombstones.insert(
                    registration.handle,
                    (registration, CallbackState::Invalidated),
                );
                SlotState::Tombstone {
                    registration,
                    state: CallbackState::Invalidated,
                }
            }
            SlotState::Tombstone {
                registration,
                state,
            } => {
                self.tombstones
                    .entry(registration.handle)
                    .or_insert((registration, state));
                SlotState::Tombstone {
                    registration,
                    state,
                }
            }
            SlotState::Retired => SlotState::Retired,
        }
    }

    fn allocate(
        &mut self,
        owner: CallbackOwner,
        key: ListenerKey,
        token: i64,
    ) -> CallbackRegistration {
        while let Some(slot_index) = self.free_slots.pop() {
            let slot = &mut self.slots[slot_index as usize];
            let previous_generation = match slot {
                SlotState::Retired => continue,
                _ => slot_generation(slot),
            };
            let generation = (u64::from(previous_generation) + 1)
                .max(self.next_generation_floor[slot_index as usize]);
            if generation >= RETIRED_GENERATION_FLOOR {
                *slot = SlotState::Retired;
                continue;
            }
            let generation = generation as u32;
            let handle = CallbackHandle::new(slot_index, generation);
            let registration = CallbackRegistration {
                handle,
                key,
                owner,
                token,
            };
            *slot = SlotState::Active(registration);
            self.next_generation_floor[slot_index as usize] = u64::from(generation) + 1;
            return registration;
        }

        let slot_index = u32::try_from(self.slots.len()).expect("too many callback slots");
        let handle = CallbackHandle::new(slot_index, 1);
        let registration = CallbackRegistration {
            handle,
            key,
            owner,
            token,
        };
        self.slots.push(SlotState::Active(registration));
        self.next_generation_floor.push(2);
        registration
    }

    fn remove_internal(
        &mut self,
        owner: Option<CallbackOwner>,
        handle: CallbackHandle,
    ) -> RemoveResult {
        let Some(slot) = self.slots.get(handle.slot as usize).copied() else {
            return RemoveResult::Stale;
        };
        if slot_generation(&slot) == handle.generation {
            match slot {
                SlotState::Active(registration) => {
                    if let Some(owner) = owner {
                        if registration.owner != owner {
                            return RemoveResult::WrongOwner {
                                expected: registration.owner,
                                actual: owner,
                            };
                        }
                    }
                    let _ = self.close_active(handle, CallbackState::Closed);
                    RemoveResult::Closed(registration)
                }
                SlotState::Tombstone {
                    registration,
                    state,
                } => self.tombstone_result(owner, registration, state),
                SlotState::Retired => RemoveResult::Stale,
            }
        } else if let Some((registration, state)) = self.tombstones.get(&handle).copied() {
            self.tombstone_result(owner, registration, state)
        } else {
            RemoveResult::Stale
        }
    }

    fn tombstone_result(
        &self,
        owner: Option<CallbackOwner>,
        registration: CallbackRegistration,
        state: CallbackState,
    ) -> RemoveResult {
        if let Some(owner) = owner {
            if registration.owner != owner {
                return RemoveResult::WrongOwner {
                    expected: registration.owner,
                    actual: owner,
                };
            }
        }
        match state {
            CallbackState::Invalidated => RemoveResult::Invalidated,
            CallbackState::Closed | CallbackState::Closing => RemoveResult::AlreadyClosed,
            CallbackState::Created | CallbackState::Active => RemoveResult::Stale,
        }
    }

    fn invalidate_handle(
        &mut self,
        owner: CallbackOwner,
        handle: CallbackHandle,
    ) -> Option<CallbackRegistration> {
        let slot = self.slots.get(handle.slot as usize).copied()?;
        let SlotState::Active(registration) = slot else {
            return None;
        };
        if registration.owner != owner || registration.handle != handle {
            return None;
        }
        self.close_active(handle, CallbackState::Invalidated)
    }

    fn active_registration(&self, handle: CallbackHandle) -> Option<CallbackRegistration> {
        match *self.slots.get(handle.slot as usize)? {
            SlotState::Active(registration) if registration.handle == handle => Some(registration),
            SlotState::Active(_) | SlotState::Tombstone { .. } | SlotState::Retired => None,
        }
    }

    fn close_active(
        &mut self,
        handle: CallbackHandle,
        state: CallbackState,
    ) -> Option<CallbackRegistration> {
        let slot = self.slots.get_mut(handle.slot as usize)?;
        let SlotState::Active(registration) = *slot else {
            return None;
        };
        if registration.handle != handle {
            return None;
        }
        *slot = SlotState::Tombstone {
            registration,
            state,
        };
        self.tombstones.insert(handle, (registration, state));
        self.next_generation_floor[handle.slot as usize] =
            self.next_generation_floor[handle.slot as usize].max(u64::from(handle.generation) + 1);
        let map_key = (registration.owner, registration.key);
        if self.active_by_key.get(&map_key).copied() == Some(handle) {
            self.active_by_key.remove(&map_key);
        }
        self.free_slots.push(handle.slot);
        Some(registration)
    }
}

fn slot_generation(slot: &SlotState) -> u32 {
    match slot {
        SlotState::Active(registration) | SlotState::Tombstone { registration, .. } => {
            registration.handle.generation
        }
        SlotState::Retired => u32::MAX,
    }
}

#[cfg(test)]
mod tests {
    use super::{CallbackHandle, CallbackRegistry, CallbackState, ListenerKey, RemoveResult};

    fn key(node_raw: u64, event: u32) -> ListenerKey {
        ListenerKey::new(node_raw, event)
    }

    #[test]
    fn replacement_closes_old_registration_and_keeps_new_active() {
        let mut registry = CallbackRegistry::default();
        let (old, replaced) = registry.add(key(10, 1), 111);
        assert!(replaced.is_none());
        let (new, replaced) = registry.add(key(10, 1), 222);
        assert_eq!(replaced, Some(old));
        assert_ne!(old.handle, new.handle);
        assert_eq!(registry.active_for_key(key(10, 1)), Some(new));
        assert_eq!(registry.active_count(), 1);
        assert_eq!(registry.remove(old.handle), RemoveResult::AlreadyClosed);
        assert_eq!(registry.active_for_key(key(10, 1)), Some(new));
    }

    #[test]
    fn remove_is_idempotent_and_reuses_slot_with_new_generation() {
        let mut registry = CallbackRegistry::default();
        let (first, _) = registry.add(key(1, 1), 10);
        assert_eq!(registry.remove(first.handle), RemoveResult::Closed(first));
        assert_eq!(registry.remove(first.handle), RemoveResult::AlreadyClosed);

        let (second, _) = registry.add(key(2, 1), 20);
        assert_eq!(second.handle.slot(), first.handle.slot());
        assert_eq!(second.handle.generation(), first.handle.generation() + 1);
        assert_eq!(
            registry.remove(CallbackHandle::new(999, 1)),
            RemoveResult::Stale
        );
    }

    #[test]
    fn owner_scope_rejects_cross_owner_remove_and_keeps_callback_active() {
        let mut registry = CallbackRegistry::default();
        let (registration, _) = registry.add_owned(7, key(1, 1), 10);
        assert_eq!(
            registry.remove_owned(8, registration.handle),
            RemoveResult::WrongOwner {
                expected: 7,
                actual: 8
            }
        );
        assert_eq!(
            registry.state(registration.handle),
            Some(CallbackState::Active)
        );
        assert_eq!(
            registry.active_for_key_owned(7, key(1, 1)),
            Some(registration)
        );
    }

    #[test]
    fn owner_invalidation_is_idempotent_and_tombstone_survives_reuse() {
        let mut registry = CallbackRegistry::default();
        let (first, _) = registry.add_owned(7, key(1, 1), 10);
        let closed = registry.invalidate_owner(7);
        assert_eq!(closed, vec![first]);
        assert_eq!(
            registry.state(first.handle),
            Some(CallbackState::Invalidated)
        );
        assert_eq!(registry.invalidate_owner(7), Vec::<_>::new());
        let (replacement, _) = registry.add_owned(7, key(2, 1), 20);
        assert_eq!(replacement.handle.slot(), first.handle.slot());
        assert_eq!(
            registry.remove_owned(7, first.handle),
            RemoveResult::Invalidated
        );
        assert_eq!(
            registry.active_for_key_owned(7, key(2, 1)),
            Some(replacement)
        );
    }

    #[test]
    fn node_invalidation_closes_all_events() {
        let mut registry = CallbackRegistry::default();
        let (click, _) = registry.add(key(7, 1), 1);
        let (change, _) = registry.add(key(7, 2), 2);
        let (_, _) = registry.add(key(8, 1), 3);
        let closed = registry.invalidate_node(7);
        assert_eq!(closed.len(), 2);
        assert!(closed.contains(&click));
        assert!(closed.contains(&change));
        assert_eq!(registry.active_count(), 1);
        assert_eq!(registry.active_for_key(key(7, 1)), None);
    }
}

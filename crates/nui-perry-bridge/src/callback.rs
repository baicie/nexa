//! Session-local callback handles and listener replacement state.
//!
//! The registry owns logical callback identity. The Perry FFI layer owns the
//! actual closure pointer and uses this module to decide which pointers remain
//! rooted and which listener may receive an event.

use std::collections::HashMap;

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
    /// Perry closure pointer bits. This value is rooted only while active.
    pub token: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotState {
    Active(CallbackRegistration),
    Closed,
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CallbackSlot {
    generation: u32,
    state: SlotState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveResult {
    /// A live callback was closed and its pointer can be released from roots.
    Closed(CallbackRegistration),
    /// The callback was already closed. This is an idempotent no-op.
    AlreadyClosed,
    /// The handle never existed or its generation was superseded.
    Stale,
}

/// Session-local callback registry.
#[derive(Debug, Default)]
pub struct CallbackRegistry {
    slots: Vec<CallbackSlot>,
    free_slots: Vec<u32>,
    active_by_key: HashMap<ListenerKey, CallbackHandle>,
}

impl CallbackRegistry {
    /// Add or replace the listener for one target. The replaced registration is
    /// returned so the caller can remove its native/GC root immediately.
    pub fn add(
        &mut self,
        key: ListenerKey,
        token: i64,
    ) -> (CallbackRegistration, Option<CallbackRegistration>) {
        let registration = self.allocate(key, token);
        let replaced = self
            .active_by_key
            .insert(key, registration.handle)
            .and_then(|old| self.close_active(old));
        (registration, replaced)
    }

    /// Remove a callback handle. Stale and already-closed handles are harmless.
    pub fn remove(&mut self, handle: CallbackHandle) -> RemoveResult {
        let Some(slot) = self.slots.get_mut(handle.slot as usize) else {
            return RemoveResult::Stale;
        };
        if slot.generation != handle.generation {
            return RemoveResult::Stale;
        }
        match slot.state {
            SlotState::Active(registration) => {
                self.active_by_key.remove(&registration.key);
                slot.state = SlotState::Closed;
                self.free_slots.push(handle.slot);
                RemoveResult::Closed(registration)
            }
            SlotState::Closed => RemoveResult::AlreadyClosed,
            SlotState::Retired => RemoveResult::Stale,
        }
    }

    /// Close every active listener owned by a node, used during node disposal.
    pub fn invalidate_node(&mut self, node_raw: u64) -> Vec<CallbackRegistration> {
        let handles: Vec<_> = self
            .active_by_key
            .iter()
            .filter_map(|(key, handle)| (key.node_raw == node_raw).then_some(*handle))
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| match self.remove(handle) {
                RemoveResult::Closed(registration) => Some(registration),
                RemoveResult::AlreadyClosed | RemoveResult::Stale => None,
            })
            .collect()
    }

    /// Find the active registration for a target.
    #[must_use]
    pub fn active_for_key(&self, key: ListenerKey) -> Option<CallbackRegistration> {
        let handle = self.active_by_key.get(&key).copied()?;
        let slot = self.slots.get(handle.slot as usize)?;
        match slot.state {
            SlotState::Active(registration) if registration.handle == handle => Some(registration),
            SlotState::Active(_) | SlotState::Closed | SlotState::Retired => None,
        }
    }

    /// Iterate active closure pointer slots for the Perry GC root scanner.
    pub fn visit_active_tokens(&mut self, mut visit: impl FnMut(&mut i64)) {
        for slot in &mut self.slots {
            if let SlotState::Active(registration) = &mut slot.state {
                visit(&mut registration.token);
            }
        }
    }

    #[must_use]
    pub fn active_count(&self) -> usize {
        self.active_by_key.len()
    }

    fn allocate(&mut self, key: ListenerKey, token: i64) -> CallbackRegistration {
        while let Some(slot_index) = self.free_slots.pop() {
            let slot = &mut self.slots[slot_index as usize];
            if slot.generation == u32::MAX {
                slot.state = SlotState::Retired;
                continue;
            }
            slot.generation += 1;
            let handle = CallbackHandle::new(slot_index, slot.generation);
            let registration = CallbackRegistration { handle, key, token };
            slot.state = SlotState::Active(registration);
            return registration;
        }

        let slot_index = u32::try_from(self.slots.len()).expect("too many callback slots");
        let handle = CallbackHandle::new(slot_index, 1);
        let registration = CallbackRegistration { handle, key, token };
        self.slots.push(CallbackSlot {
            generation: 1,
            state: SlotState::Active(registration),
        });
        registration
    }

    fn close_active(&mut self, handle: CallbackHandle) -> Option<CallbackRegistration> {
        let slot = self.slots.get_mut(handle.slot as usize)?;
        if slot.generation != handle.generation {
            return None;
        }
        let SlotState::Active(registration) = slot.state else {
            return None;
        };
        slot.state = SlotState::Closed;
        self.free_slots.push(handle.slot);
        Some(registration)
    }
}

#[cfg(test)]
mod tests {
    use super::{CallbackHandle, CallbackRegistry, ListenerKey, RemoveResult};

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

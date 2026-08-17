//! Generation-bearing CPU resource identities and storage.

const RETIRED_GENERATION_FLOOR: u64 = u32::MAX as u64 + 1;

/// Monotonic identity of one successfully created backend surface.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SurfaceGeneration(u64);

impl SurfaceGeneration {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }

    #[must_use]
    pub fn next(self) -> Self {
        Self(
            self.0
                .checked_add(1)
                .expect("surface generation space exhausted"),
        )
    }
}

/// Opaque resource handle encoded as `(generation << 32) | slot`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ResourceId {
    raw: u64,
}

impl ResourceId {
    #[must_use]
    pub const fn new(slot: u32, generation: u32) -> Self {
        Self {
            raw: ((generation as u64) << 32) | slot as u64,
        }
    }

    #[must_use]
    pub const fn from_raw(raw: u64) -> Self {
        Self { raw }
    }

    #[must_use]
    pub const fn raw(self) -> u64 {
        self.raw
    }

    #[must_use]
    pub const fn slot(self) -> u32 {
        self.raw as u32
    }

    #[must_use]
    pub const fn generation(self) -> u32 {
        (self.raw >> 32) as u32
    }
}

#[derive(Debug, Clone)]
enum Slot<T> {
    Vacant { next_free: Option<u32> },
    Occupied { generation: u32, value: T },
    Retired,
}

/// Generation-checked storage for process-local CPU resources.
#[derive(Debug, Clone)]
pub struct ResourceStore<T> {
    slots: Vec<Slot<T>>,
    free_head: Option<u32>,
    next_generation_floor: Vec<u64>,
    len: usize,
}

impl<T> Default for ResourceStore<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> ResourceStore<T> {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            slots: Vec::new(),
            free_head: None,
            next_generation_floor: Vec::new(),
            len: 0,
        }
    }

    /// Inserts a resource and returns its exact generation identity.
    pub fn insert(&mut self, value: T) -> ResourceId {
        let mut value = Some(value);
        loop {
            let Some(slot) = self.free_head else {
                let slot = u32::try_from(self.slots.len()).expect("resource slot space exhausted");
                let generation = 1;
                self.slots.push(Slot::Occupied {
                    generation,
                    value: value.take().expect("resource inserted once"),
                });
                self.next_generation_floor.push(2);
                self.len += 1;
                return ResourceId::new(slot, generation);
            };

            let index = slot as usize;
            let next_free = match std::mem::replace(&mut self.slots[index], Slot::Retired) {
                Slot::Vacant { next_free } => next_free,
                Slot::Occupied { .. } | Slot::Retired => {
                    unreachable!("free list points to an unavailable resource slot")
                }
            };
            self.free_head = next_free;
            let generation = self.next_generation_floor[index];
            if generation >= RETIRED_GENERATION_FLOOR {
                continue;
            }
            let generation = generation as u32;
            self.slots[index] = Slot::Occupied {
                generation,
                value: value.take().expect("resource inserted once"),
            };
            self.next_generation_floor[index] = u64::from(generation) + 1;
            self.len += 1;
            return ResourceId::new(slot, generation);
        }
    }

    #[must_use]
    pub fn get(&self, id: ResourceId) -> Option<&T> {
        match self.slots.get(id.slot() as usize)? {
            Slot::Occupied { generation, value } if *generation == id.generation() => Some(value),
            Slot::Vacant { .. } | Slot::Occupied { .. } | Slot::Retired => None,
        }
    }

    pub fn get_mut(&mut self, id: ResourceId) -> Option<&mut T> {
        match self.slots.get_mut(id.slot() as usize)? {
            Slot::Occupied { generation, value } if *generation == id.generation() => Some(value),
            Slot::Vacant { .. } | Slot::Occupied { .. } | Slot::Retired => None,
        }
    }

    /// Iterates active resources with their exact generation identities.
    pub fn iter(&self) -> impl Iterator<Item = (ResourceId, &T)> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(slot, entry)| match entry {
                Slot::Occupied { generation, value } => {
                    Some((ResourceId::new(slot as u32, *generation), value))
                }
                Slot::Vacant { .. } | Slot::Retired => None,
            })
    }

    /// Removes only the exact active generation. Stale IDs are no-ops.
    pub fn remove(&mut self, id: ResourceId) -> Option<T> {
        let index = id.slot() as usize;
        let matches = matches!(
            self.slots.get(index),
            Some(Slot::Occupied { generation, .. }) if *generation == id.generation()
        );
        if !matches {
            return None;
        }

        let Slot::Occupied { generation, value } =
            std::mem::replace(&mut self.slots[index], Slot::Retired)
        else {
            unreachable!("resource generation was checked before removal")
        };
        self.next_generation_floor[index] =
            self.next_generation_floor[index].max(u64::from(generation) + 1);
        if self.next_generation_floor[index] < RETIRED_GENERATION_FLOOR {
            self.slots[index] = Slot::Vacant {
                next_free: self.free_head,
            };
            self.free_head = Some(id.slot());
        }
        self.len -= 1;
        Some(value)
    }

    /// Invalidates all current IDs without forgetting exposed generations.
    pub fn clear(&mut self) {
        for index in 0..self.slots.len() {
            let slot = std::mem::replace(&mut self.slots[index], Slot::Retired);
            match slot {
                Slot::Occupied { generation, .. } => {
                    self.next_generation_floor[index] =
                        self.next_generation_floor[index].max(u64::from(generation) + 1);
                    if self.next_generation_floor[index] < RETIRED_GENERATION_FLOOR {
                        self.slots[index] = Slot::Vacant { next_free: None };
                    }
                }
                Slot::Vacant { .. } => {
                    self.slots[index] = Slot::Vacant { next_free: None };
                }
                Slot::Retired => {}
            }
        }
        self.len = 0;
        self.rebuild_free_list();
    }

    /// Preserves generations exposed by a transactional clone without
    /// adopting the clone's values.
    pub fn absorb_generation_high_watermark(&mut self, other: &Self) {
        while self.slots.len() < other.slots.len() {
            self.slots.push(Slot::Vacant { next_free: None });
            self.next_generation_floor.push(1);
        }
        for (index, &other_floor) in other.next_generation_floor.iter().enumerate() {
            self.next_generation_floor[index] = self.next_generation_floor[index].max(other_floor);
            if self.next_generation_floor[index] >= RETIRED_GENERATION_FLOOR
                && matches!(self.slots[index], Slot::Vacant { .. })
            {
                self.slots[index] = Slot::Retired;
            }
        }
        self.rebuild_free_list();
    }

    #[must_use]
    pub const fn len(&self) -> usize {
        self.len
    }

    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn rebuild_free_list(&mut self) {
        self.free_head = None;
        for index in (0..self.slots.len()).rev() {
            if matches!(self.slots[index], Slot::Vacant { .. }) {
                self.slots[index] = Slot::Vacant {
                    next_free: self.free_head,
                };
                self.free_head = Some(index as u32);
            }
        }
    }

    #[cfg(test)]
    fn force_next_generation_for_test(&mut self, slot: u32, generation: u32) {
        while self.slots.len() <= slot as usize {
            self.slots.push(Slot::Vacant { next_free: None });
            self.next_generation_floor.push(1);
        }
        self.next_generation_floor[slot as usize] = u64::from(generation);
        self.rebuild_free_list();
    }
}

#[cfg(test)]
mod tests {
    use super::{ResourceId, ResourceStore};

    #[test]
    fn resource_id_round_trips_slot_generation_and_raw_value() {
        let id = ResourceId::new(7, 11);

        assert_eq!(id.slot(), 7);
        assert_eq!(id.generation(), 11);
        assert_eq!(ResourceId::from_raw(id.raw()), id);
    }

    #[test]
    fn removing_then_reusing_a_slot_invalidates_the_stale_id() {
        let mut store = ResourceStore::new();
        let first = store.insert(String::from("first"));

        assert_eq!(store.remove(first).as_deref(), Some("first"));
        assert!(store.get(first).is_none());

        let replacement = store.insert(String::from("replacement"));
        assert_eq!(replacement.slot(), first.slot());
        assert_eq!(replacement.generation(), first.generation() + 1);
        assert!(store.get(first).is_none());
        assert_eq!(
            store.get(replacement).map(String::as_str),
            Some("replacement")
        );
    }

    #[test]
    fn clear_invalidates_resources_without_resetting_generation_history() {
        let mut store = ResourceStore::new();
        let first = store.insert(10_u32);
        let second = store.insert(20_u32);

        store.clear();

        assert!(store.is_empty());
        assert!(store.get(first).is_none());
        assert!(store.get(second).is_none());
        let replacement = store.insert(30_u32);
        assert_ne!(replacement, first);
        assert_ne!(replacement, second);
    }

    #[test]
    fn absorbing_an_aborted_clone_prevents_provisional_id_reuse() {
        let mut active = ResourceStore::<u32>::new();
        let mut pending = active.clone();
        let provisional = pending.insert(10);

        active.absorb_generation_high_watermark(&pending);
        let replacement = active.insert(20);

        assert_eq!(replacement.slot(), provisional.slot());
        assert!(replacement.generation() > provisional.generation());
        assert!(active.get(provisional).is_none());
        assert_eq!(active.get(replacement), Some(&20));
    }

    #[test]
    fn mutable_access_requires_the_exact_active_generation() {
        let mut store = ResourceStore::new();
        let id = store.insert(10_u32);
        let stale = ResourceId::new(id.slot(), id.generation() + 1);

        *store.get_mut(id).expect("active resource") = 20;

        assert_eq!(store.get(id), Some(&20));
        assert!(store.get_mut(stale).is_none());
    }

    #[test]
    fn maximum_generation_is_retired_instead_of_wrapping() {
        let mut store = ResourceStore::new();
        store.force_next_generation_for_test(0, u32::MAX);
        let terminal = store.insert(10_u32);
        assert_eq!(terminal.generation(), u32::MAX);

        assert_eq!(store.remove(terminal), Some(10));
        let replacement = store.insert(20_u32);

        assert_ne!(replacement.slot(), terminal.slot());
        assert!(store.get(terminal).is_none());
    }
}

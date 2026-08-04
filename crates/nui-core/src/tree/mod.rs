//! Node tree, generation handles, and arena allocation.
//!
//! `NodeId` is a 64-bit generation handle (high 32 = generation, low 32 = slot).
//! Framework adapters must never hold raw Rust pointers.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::semantics::Semantics;
use crate::style::Style;

/// Native primitive node kinds defined by the generated Host Protocol.
pub use crate::protocol::ui::NodeType;

/// Opaque node handle with a 64-bit wire identity and native-only owner tag.
///
/// `raw()` is the only value exchanged across the NUI Host Protocol boundary;
/// the owner tag prevents Rust code from mixing handles from different arenas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId {
    raw: u64,
    /// Native-only owner identity. Zero means an unbound wire handle.
    owner: u64,
}

impl NodeId {
    #[must_use]
    pub const fn from_raw(raw: u64) -> Self {
        Self { raw, owner: 0 }
    }

    #[must_use]
    pub const fn raw(self) -> u64 {
        self.raw
    }

    #[must_use]
    pub const fn owner(self) -> u64 {
        self.owner
    }

    #[must_use]
    pub const fn slot(self) -> u32 {
        self.raw as u32
    }

    #[must_use]
    pub const fn generation(self) -> u32 {
        (self.raw >> 32) as u32
    }

    #[must_use]
    pub const fn new(slot: u32, generation: u32) -> Self {
        Self {
            raw: ((generation as u64) << 32) | (slot as u64),
            owner: 0,
        }
    }

    const fn with_owner(slot: u32, generation: u32, owner: u64) -> Self {
        Self {
            raw: ((generation as u64) << 32) | (slot as u64),
            owner,
        }
    }
}

/// Reasons a tree mutation was rejected before any links were changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeMutationError {
    StaleChild(NodeId),
    StaleParent(NodeId),
    StaleBefore(NodeId),
    BeforeNotChild(NodeId),
    SelfParent(NodeId),
    Cycle { child: NodeId, parent: NodeId },
}

/// Axis-aligned layout box in **logical** pixels.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct LayoutRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl LayoutRect {
    #[must_use]
    pub fn contains(self, px: f32, py: f32) -> bool {
        px >= self.x && py >= self.y && px < self.x + self.width && py < self.y + self.height
    }
}

/// A node in the native tree.
#[derive(Debug, Clone)]
pub struct Node {
    pub node_type: NodeType,
    pub parent: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub style: Style,
    pub text: Option<String>,
    /// When true, this node can be returned by hit-testing.
    pub clickable: bool,
    pub layout: LayoutRect,
    /// Assistive-tech semantics (ADR-006). Optional until AccessKit export.
    pub semantics: Option<Semantics>,
}

#[derive(Debug)]
enum Slot {
    Empty {
        next_free: Option<u32>,
        next_generation: u32,
    },
    Occupied {
        generation: u32,
        node: Box<Node>,
    },
    /// A generation at `u32::MAX` was destroyed; this slot must never reuse.
    Retired,
}

/// Generational arena for native nodes.
#[derive(Debug)]
pub struct Arena {
    owner: u64,
    slots: Vec<Slot>,
    free_head: Option<u32>,
}

impl Default for Arena {
    fn default() -> Self {
        Self::new()
    }
}

impl Arena {
    #[must_use]
    pub fn new() -> Self {
        static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);
        Self {
            owner: NEXT_OWNER.fetch_add(1, Ordering::Relaxed),
            slots: Vec::new(),
            free_head: None,
        }
    }

    #[must_use]
    pub const fn owner(&self) -> u64 {
        self.owner
    }

    fn accepts(&self, id: NodeId) -> bool {
        id.owner == 0 || id.owner == self.owner
    }

    fn canonical(&self, id: NodeId) -> Option<NodeId> {
        if !self.accepts(id) || self.get_unchecked_owner(id).is_none() {
            return None;
        }
        Some(NodeId::with_owner(id.slot(), id.generation(), self.owner))
    }

    fn get_unchecked_owner(&self, id: NodeId) -> Option<&Node> {
        match self.slots.get(id.slot() as usize)? {
            Slot::Occupied { generation, node } if *generation == id.generation() => {
                Some(node.as_ref())
            }
            _ => None,
        }
    }

    pub fn create(&mut self, node_type: NodeType) -> NodeId {
        let node = Box::new(Node {
            node_type,
            parent: None,
            children: Vec::new(),
            style: Style::default(),
            text: None,
            clickable: false,
            layout: LayoutRect::default(),
            semantics: None,
        });

        if let Some(slot_index) = self.free_head {
            let generation = match &self.slots[slot_index as usize] {
                Slot::Empty {
                    next_free,
                    next_generation,
                } => {
                    self.free_head = *next_free;
                    (*next_generation).max(1)
                }
                Slot::Occupied { .. } | Slot::Retired => {
                    unreachable!("free list points at a non-empty slot")
                }
            };
            self.slots[slot_index as usize] = Slot::Occupied { generation, node };
            return NodeId::with_owner(slot_index, generation, self.owner);
        }

        let slot_index = u32::try_from(self.slots.len()).expect("too many nodes");
        let generation = 1;
        self.slots.push(Slot::Occupied { generation, node });
        NodeId::with_owner(slot_index, generation, self.owner)
    }

    /// Free a node slot (does not detach from parent — caller must manage tree links).
    pub fn destroy(&mut self, id: NodeId) {
        if !self.accepts(id) {
            return;
        }
        let Some(slot) = self.slots.get_mut(id.slot() as usize) else {
            return;
        };
        let Slot::Occupied { generation, .. } = slot else {
            return;
        };
        if *generation != id.generation() {
            return;
        }
        if *generation == u32::MAX {
            *slot = Slot::Retired;
        } else {
            let next_generation = *generation + 1;
            *slot = Slot::Empty {
                next_free: self.free_head,
                next_generation,
            };
            self.free_head = Some(id.slot());
        }
    }

    #[must_use]
    pub fn get(&self, id: NodeId) -> Option<&Node> {
        if !self.accepts(id) {
            return None;
        }
        self.get_unchecked_owner(id)
    }

    pub fn get_mut(&mut self, id: NodeId) -> Option<&mut Node> {
        if !self.accepts(id) {
            return None;
        }
        match self.slots.get_mut(id.slot() as usize)? {
            Slot::Occupied { generation, node } if *generation == id.generation() => {
                Some(node.as_mut())
            }
            _ => None,
        }
    }

    pub fn insert_child(&mut self, parent: NodeId, child: NodeId) {
        self.insert_child_before(parent, child, None);
    }

    /// Validate and insert `child` under `parent` atomically.
    ///
    /// The old `insert_child_before` wrapper intentionally discards this
    /// result for legacy callers; new Host/Runtime paths should use this
    /// method so rejected mutations are observable.
    pub fn try_insert_child_before(
        &mut self,
        parent: NodeId,
        child: NodeId,
        before: Option<NodeId>,
    ) -> Result<(), TreeMutationError> {
        let original_child = child;
        let original_parent = parent;
        let child = self
            .canonical(child)
            .ok_or(TreeMutationError::StaleChild(original_child))?;
        let parent = self
            .canonical(parent)
            .ok_or(TreeMutationError::StaleParent(original_parent))?;
        let before = match before {
            Some(before) => Some(
                self.canonical(before)
                    .ok_or(TreeMutationError::StaleBefore(before))?,
            ),
            None => None,
        };

        if self.get(child).is_none() {
            return Err(TreeMutationError::StaleChild(child));
        }
        if self.get(parent).is_none() {
            return Err(TreeMutationError::StaleParent(parent));
        }
        if child == parent {
            return Err(TreeMutationError::SelfParent(child));
        }

        if let Some(before) = before {
            if before == child {
                return Err(TreeMutationError::BeforeNotChild(before));
            }
            let is_sibling = self
                .get(parent)
                .is_some_and(|node| node.children.contains(&before));
            if !is_sibling {
                return Err(TreeMutationError::BeforeNotChild(before));
            }
        }

        // Walking ancestors catches parent-in-child cycles without touching
        // any links. The visited set also prevents malformed pre-existing
        // state from turning validation into an infinite loop.
        let mut current = Some(parent);
        let mut visited = HashSet::new();
        while let Some(id) = current {
            if !visited.insert(id) || id == child {
                return Err(TreeMutationError::Cycle { child, parent });
            }
            current = self.get(id).and_then(|node| node.parent);
        }

        let old_parent = self.get(child).and_then(|node| node.parent);
        if let Some(old_parent) = old_parent {
            if let Some(node) = self.get_mut(old_parent) {
                node.children.retain(|id| *id != child);
            }
        }
        if let Some(node) = self.get_mut(child) {
            node.parent = Some(parent);
        }
        if let Some(node) = self.get_mut(parent) {
            if let Some(before) = before {
                let index = node
                    .children
                    .iter()
                    .position(|id| *id == before)
                    .expect("before sibling was validated");
                node.children.insert(index, child);
            } else {
                node.children.push(child);
            }
        }
        Ok(())
    }

    /// Insert `child` under `parent`, discarding a rejected mutation for
    /// compatibility with the pre-v1 API.
    pub fn insert_child_before(&mut self, parent: NodeId, child: NodeId, before: Option<NodeId>) {
        let _ = self.try_insert_child_before(parent, child, before);
    }

    /// Detach `id` from its parent without destroying it (Solid removeNode).
    pub fn detach_child(&mut self, parent: NodeId, child: NodeId) {
        if let Some(p) = self.get_mut(parent) {
            p.children.retain(|c| *c != child);
        }
        if let Some(node) = self.get_mut(child) {
            if node.parent == Some(parent) {
                node.parent = None;
            }
        }
    }

    /// Detach `id` from its parent and destroy the subtree.
    pub fn remove(&mut self, id: NodeId) {
        if let Some(parent) = self.get(id).and_then(|n| n.parent) {
            if let Some(p) = self.get_mut(parent) {
                p.children.retain(|c| *c != id);
            }
            if let Some(node) = self.get_mut(id) {
                node.parent = None;
            }
        }
        self.destroy_subtree(id);
    }

    fn destroy_subtree(&mut self, id: NodeId) {
        let mut stack = vec![id];
        let mut visited = HashSet::new();
        while let Some(current) = stack.pop() {
            if !visited.insert(current) {
                continue;
            }
            if let Some(node) = self.get(current) {
                stack.extend(node.children.iter().copied());
            }
            self.destroy(current);
        }
    }

    pub fn set_text(&mut self, id: NodeId, text: impl Into<String>) {
        if let Some(node) = self.get_mut(id) {
            node.text = Some(text.into());
            node.node_type = NodeType::Text;
        }
    }

    pub fn set_style(&mut self, id: NodeId, style: Style) {
        if let Some(node) = self.get_mut(id) {
            node.style = style;
        }
    }

    pub fn set_clickable(&mut self, id: NodeId, clickable: bool) {
        if let Some(node) = self.get_mut(id) {
            node.clickable = clickable;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_storage_remains_pointer_sized() {
        let slot_bytes = std::mem::size_of::<Slot>();
        let pointer_sized_budget = std::mem::size_of::<usize>() * 4;

        assert!(
            slot_bytes <= pointer_sized_budget,
            "Slot is {slot_bytes} bytes; expected at most {pointer_sized_budget} bytes"
        );
    }

    #[test]
    fn node_id_roundtrip() {
        let id = NodeId::new(42, 7);
        assert_eq!(id.slot(), 42);
        assert_eq!(id.generation(), 7);
        assert_eq!(NodeId::from_raw(id.raw()), id);
    }

    #[test]
    fn arena_create_and_lookup() {
        let mut arena = Arena::new();
        let id = arena.create(NodeType::View);
        assert!(arena.get(id).is_some());
        assert_eq!(arena.get(id).unwrap().node_type, NodeType::View);
    }

    #[test]
    fn arena_generation_invalidates_destroyed() {
        let mut arena = Arena::new();
        let id = arena.create(NodeType::View);
        arena.destroy(id);
        assert!(arena.get(id).is_none());
        let reused = arena.create(NodeType::Text);
        assert_eq!(reused.slot(), id.slot());
        assert_ne!(reused.generation(), id.generation());
        assert!(arena.get(reused).is_some());
    }

    #[test]
    fn remove_detaches_and_destroys_subtree() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let child = arena.create(NodeType::View);
        let grand = arena.create(NodeType::Text);
        arena.insert_child(root, child);
        arena.insert_child(child, grand);

        arena.remove(child);
        assert!(arena.get(child).is_none());
        assert!(arena.get(grand).is_none());
        assert!(arena.get(root).unwrap().children.is_empty());
    }

    #[test]
    fn insert_before_preserves_order() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let a = arena.create(NodeType::View);
        let b = arena.create(NodeType::View);
        let c = arena.create(NodeType::View);
        arena.insert_child(root, a);
        arena.insert_child(root, c);
        arena.insert_child_before(root, b, Some(c));
        assert_eq!(arena.get(root).unwrap().children, vec![a, b, c]);
    }

    #[test]
    fn rejects_stale_parent_without_mutating_links() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let child = arena.create(NodeType::View);
        let stale_parent = arena.create(NodeType::View);
        arena.insert_child(root, child);
        arena.destroy(stale_parent);

        let before = arena.get(root).unwrap().children.clone();
        assert_eq!(
            arena.try_insert_child_before(stale_parent, child, None),
            Err(TreeMutationError::StaleParent(stale_parent))
        );
        assert_eq!(arena.get(root).unwrap().children, before);
        assert_eq!(arena.get(child).unwrap().parent, Some(root));
    }

    #[test]
    fn rejects_a_foreign_arena_handle_without_mutating_links() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let child = arena.create(NodeType::View);
        let mut foreign = Arena::new();
        let _ = foreign.create(NodeType::View);
        let _ = foreign.create(NodeType::View);
        let foreign_parent = foreign.create(NodeType::View);
        arena.insert_child(root, child);

        assert_eq!(
            arena.try_insert_child_before(foreign_parent, child, None),
            Err(TreeMutationError::StaleParent(foreign_parent))
        );
        assert_eq!(arena.get(root).unwrap().children, vec![child]);
        assert_eq!(arena.get(child).unwrap().parent, Some(root));
    }

    #[test]
    fn rejects_cycles_and_invalid_siblings_atomically() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let child = arena.create(NodeType::View);
        let sibling = arena.create(NodeType::View);
        let foreign_sibling = arena.create(NodeType::View);
        arena.insert_child(root, child);
        arena.insert_child(root, sibling);

        assert!(matches!(
            arena.try_insert_child_before(child, root, None),
            Err(TreeMutationError::Cycle { .. })
        ));
        assert_eq!(arena.get(root).unwrap().children, vec![child, sibling]);
        assert_eq!(arena.get(child).unwrap().parent, Some(root));

        assert_eq!(
            arena.try_insert_child_before(root, child, Some(foreign_sibling)),
            Err(TreeMutationError::BeforeNotChild(foreign_sibling))
        );
        assert_eq!(arena.get(root).unwrap().children, vec![child, sibling]);
    }

    #[test]
    fn retires_generation_maximum_instead_of_wrapping() {
        let mut arena = Arena::new();
        let first = arena.create(NodeType::View);
        arena.destroy(first);
        if let Slot::Empty {
            next_generation, ..
        } = &mut arena.slots[first.slot() as usize]
        {
            *next_generation = u32::MAX;
        } else {
            panic!("destroyed node should be reusable before retirement");
        }

        let maximum = arena.create(NodeType::View);
        assert_eq!(maximum.slot(), first.slot());
        assert_eq!(maximum.generation(), u32::MAX);
        arena.destroy(maximum);

        let replacement = arena.create(NodeType::View);
        assert_ne!(replacement.slot(), maximum.slot());
        assert_eq!(replacement.generation(), 1);
        assert!(arena.get(maximum).is_none());
    }
}

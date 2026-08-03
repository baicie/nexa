//! Node tree, generation handles, and arena allocation.
//!
//! `NodeId` is a 64-bit generation handle (high 32 = generation, low 32 = slot).
//! Framework adapters must never hold raw Rust pointers.

use crate::semantics::Semantics;
use crate::style::Style;

/// Opaque node handle exchanged across the NUI Host Protocol boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId(u64);

impl NodeId {
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

    #[must_use]
    pub const fn new(slot: u32, generation: u32) -> Self {
        Self(((generation as u64) << 32) | (slot as u64))
    }
}

/// Native primitive node kinds (MVP).
///
/// Composite components like `Button` / `Column` are compositions of these
/// primitives — they are not separate native types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum NodeType {
    Root = 0,
    View = 1,
    Text = 2,
    Image = 3,
    Scroll = 4,
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
        node: Node,
    },
}

/// Generational arena for native nodes.
#[derive(Debug)]
pub struct Arena {
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
        Self {
            slots: Vec::new(),
            free_head: None,
        }
    }

    pub fn create(&mut self, node_type: NodeType) -> NodeId {
        let node = Node {
            node_type,
            parent: None,
            children: Vec::new(),
            style: Style::default(),
            text: None,
            clickable: false,
            layout: LayoutRect::default(),
            semantics: None,
        };

        if let Some(slot_index) = self.free_head {
            let generation = match &self.slots[slot_index as usize] {
                Slot::Empty {
                    next_free,
                    next_generation,
                } => {
                    self.free_head = *next_free;
                    (*next_generation).max(1)
                }
                Slot::Occupied { .. } => 1,
            };
            self.slots[slot_index as usize] = Slot::Occupied { generation, node };
            return NodeId::new(slot_index, generation);
        }

        let slot_index = u32::try_from(self.slots.len()).expect("too many nodes");
        let generation = 1;
        self.slots.push(Slot::Occupied { generation, node });
        NodeId::new(slot_index, generation)
    }

    /// Free a node slot (does not detach from parent — caller must manage tree links).
    pub fn destroy(&mut self, id: NodeId) {
        let Some(slot) = self.slots.get_mut(id.slot() as usize) else {
            return;
        };
        let Slot::Occupied { generation, .. } = slot else {
            return;
        };
        if *generation != id.generation() {
            return;
        }
        let next_generation = generation.wrapping_add(1).max(1);
        *slot = Slot::Empty {
            next_free: self.free_head,
            next_generation,
        };
        self.free_head = Some(id.slot());
    }

    #[must_use]
    pub fn get(&self, id: NodeId) -> Option<&Node> {
        match self.slots.get(id.slot() as usize)? {
            Slot::Occupied { generation, node } if *generation == id.generation() => Some(node),
            _ => None,
        }
    }

    pub fn get_mut(&mut self, id: NodeId) -> Option<&mut Node> {
        match self.slots.get_mut(id.slot() as usize)? {
            Slot::Occupied { generation, node } if *generation == id.generation() => Some(node),
            _ => None,
        }
    }

    pub fn insert_child(&mut self, parent: NodeId, child: NodeId) {
        self.insert_child_before(parent, child, None);
    }

    /// Insert `child` under `parent`. If `before` is set, insert immediately
    /// before that sibling; otherwise append. Reparents `child` if needed.
    pub fn insert_child_before(
        &mut self,
        parent: NodeId,
        child: NodeId,
        before: Option<NodeId>,
    ) {
        if let Some(old_parent) = self.get(child).and_then(|n| n.parent) {
            if let Some(p) = self.get_mut(old_parent) {
                p.children.retain(|c| *c != child);
            }
        }
        if let Some(node) = self.get_mut(child) {
            node.parent = Some(parent);
        }
        if let Some(node) = self.get_mut(parent) {
            if let Some(before) = before {
                if let Some(idx) = node.children.iter().position(|c| *c == before) {
                    node.children.insert(idx, child);
                    return;
                }
            }
            node.children.push(child);
        }
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
        let children = self
            .get(id)
            .map(|n| n.children.clone())
            .unwrap_or_default();
        for child in children {
            self.destroy_subtree(child);
        }
        self.destroy(id);
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
}

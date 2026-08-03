//! Node tree and generation handles.
//!
//! `NodeId` is a 64-bit generation handle (high 32 = generation, low 32 = slot).
//! Framework adapters must never hold raw Rust pointers.

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
/// Composite components like `Button` / `Column` are TS-side compositions
/// of these primitives — they are not separate native types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum NodeType {
    Root = 0,
    View = 1,
    Text = 2,
    Image = 3,
    Scroll = 4,
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
}

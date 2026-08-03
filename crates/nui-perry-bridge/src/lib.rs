//! Perry ↔ NUI Host FFI bridge.
//!
//! Isolates Perry runtime / ABI details from `nui-core` (ADR-004 §8).
//! Slice 2 will expose HostOps as native functions callable from Perry TS.

use nui_core::{NodeId, NodeType};

/// Placeholder Host entry used by Slice 2 scaffolding.
///
/// Real slot allocation lands with the node arena in Slice 1.
#[must_use]
pub fn create_node(_node_type: NodeType) -> NodeId {
    NodeId::new(0, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_node_returns_handle() {
        let id = create_node(NodeType::View);
        assert_eq!(id.slot(), 0);
        assert_eq!(id.generation(), 1);
    }
}

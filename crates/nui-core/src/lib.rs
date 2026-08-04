//! NUI Core — framework-agnostic native UI runtime.
//!
//! See `docs/decisions/ADR-004-framework-adapters-native-host-mvp.md`
//! and `docs/decisions/ADR-006-application-runtime-composition-p0.md`.

pub mod event;
pub mod layout;
pub mod paint;
pub mod scheduler;
pub mod semantics;
pub mod style;
pub mod tree;

pub use nui_protocol as protocol;

pub use event::{hit_scroll, hit_test, EventId};
pub use layout::measure_text;
pub use scheduler::{FrameScheduler, TickPhase};
pub use semantics::{SemanticAction, SemanticRole, Semantics};
pub use style::{Align, ColorRgba, FlexDirection, PropertyId, Style};
pub use tree::{Arena, LayoutRect, Node, NodeId, NodeType};

/// Library version string for diagnostics.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod protocol_type_tests {
    use super::{event::EventId, style::PropertyId, tree::NodeType};

    #[test]
    fn public_protocol_ids_are_generated_types() {
        let node: NodeType = super::protocol::ui::NodeType::View;
        let property: PropertyId = super::protocol::ui::PropertyId::Width;
        let event: EventId = super::protocol::ui::EventId::Click;

        let _: super::protocol::ui::NodeType = node;
        let _: super::protocol::ui::PropertyId = property;
        let _: super::protocol::ui::EventId = event;
    }
}

//! NUI Core — framework-agnostic native UI runtime.
//!
//! See `docs/decisions/ADR-004-framework-adapters-native-host-mvp.md`
//! and `docs/decisions/ADR-006-application-runtime-composition-p0.md`.

pub mod event;
pub mod focus;
pub mod interaction;
pub mod layout;
pub mod mutation;
pub mod paint;
pub mod resource;
pub mod scheduler;
pub mod semantic_tree;
pub mod semantics;
pub mod style;
pub mod tree;

pub use nui_protocol as protocol;

pub use event::{
    event_path, hit_scroll, hit_test, CompositionEvent, CompositionKind, DispatchResult,
    EventContext, EventDispatcher, EventId, EventModifiers, FocusEvent, FocusKind, KeyboardEvent,
    KeyboardKind, PointerCapture, PointerEvent, PointerKind, PropagationPhase, PropagationState,
    TextInputEvent, WheelEvent,
};
pub use focus::{FocusManager, FocusRegistration};
pub use interaction::{InteractionModel, InteractionState, InteractionStateToken};
pub use layout::measure_text;
pub use mutation::{
    DirtyFlags, MutationBatch, MutationCommand, MutationError, MutationReceipt, NodeRef,
    ValidatedMutationBatch,
};
pub use paint::{DisplayCommand, DisplayGlyph, DisplayList, GlyphRun};
pub use resource::{ResourceId, ResourceStore, SurfaceGeneration};
pub use scheduler::{FrameScheduler, TickPhase};
pub use semantic_tree::{SemanticNode, SemanticState, SemanticTreeDiff, SemanticTreeSnapshot};
pub use semantics::{SemanticAction, SemanticRole, Semantics};
pub use style::{
    Align, ColorRgba, FlexDirection, InteractionOutline, PropertyId, ResolvedInteractionStyle,
    Style,
};
pub use tree::{Arena, LayoutRect, Node, NodeId, NodeType, TreeMutationError};

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

    #[test]
    fn normalized_event_types_are_public_core_contracts() {
        let _: super::PointerKind = super::protocol::ui::PointerKind::Down;
        let _: super::PropagationPhase = super::protocol::ui::PropagationPhase::Capture;
        let _: super::protocol::ui::EventContext = super::protocol::ui::EventContext {
            window_id: 1,
            target: None,
            timestamp: "1".to_owned(),
            modifiers: super::protocol::ui::EventModifiers {
                shift: false,
                control: false,
                alt: false,
                meta: false,
                caps_lock: false,
                num_lock: false,
            },
            propagation: super::protocol::ui::PropagationState {
                phase: super::protocol::ui::PropagationPhase::Capture,
                default_prevented: false,
                propagation_stopped: false,
                immediate_propagation_stopped: false,
            },
        };
    }
}

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

pub use event::{hit_scroll, hit_test};
pub use layout::measure_text;
pub use scheduler::{FrameScheduler, TickPhase};
pub use semantics::{SemanticAction, SemanticRole, Semantics};
pub use style::{Align, ColorRgba, FlexDirection, PropertyId, Style};
pub use tree::{Arena, LayoutRect, Node, NodeId, NodeType};

/// Library version string for diagnostics.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

//! NUI Core — framework-agnostic native UI runtime.
//!
//! See `docs/decisions/ADR-004-framework-adapters-native-host-mvp.md`.

pub mod event;
pub mod layout;
pub mod paint;
pub mod scheduler;
pub mod style;
pub mod tree;

pub use event::hit_test;
pub use layout::measure_text;
pub use style::{ColorRgba, FlexDirection, PropertyId, Style};
pub use tree::{Arena, LayoutRect, Node, NodeId, NodeType};

/// Library version string for diagnostics.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

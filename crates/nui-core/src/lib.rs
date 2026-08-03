//! NUI Core — framework-agnostic native UI runtime.
//!
//! See `docs/decisions/ADR-004-framework-adapters-native-host-mvp.md`.

pub mod event;
pub mod layout;
pub mod paint;
pub mod scheduler;
pub mod style;
pub mod tree;

pub use tree::{NodeId, NodeType};

/// Library version string for diagnostics.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

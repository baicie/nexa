//! Accessibility semantics attached to visual nodes (ADR-006 §3.3).
//!
//! Visual Tree and Semantic Tree are separate concerns: paint uses layout,
//! AT uses role/label/actions. Fields are optional so Slice ≤12 demos stay
//! unchanged until AccessKit export lands.

/// High-level control role for assistive tech.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[repr(u16)]
pub enum SemanticRole {
    #[default]
    None = 0,
    Button = 1,
    Text = 2,
    Image = 3,
    TextInput = 4,
    Scroll = 5,
    Header = 6,
}

/// Action an AT client may invoke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum SemanticAction {
    Invoke = 1,
    Focus = 2,
    SetValue = 3,
}

/// Semantic properties derived from or attached to a visual node.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Semantics {
    pub role: SemanticRole,
    pub label: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub disabled: bool,
    pub checked: Option<bool>,
    pub actions: Vec<SemanticAction>,
}

impl Semantics {
    #[must_use]
    pub fn button(label: impl Into<String>) -> Self {
        Self {
            role: SemanticRole::Button,
            label: Some(label.into()),
            actions: vec![SemanticAction::Invoke],
            ..Self::default()
        }
    }

    #[must_use]
    pub fn text(label: impl Into<String>) -> Self {
        Self {
            role: SemanticRole::Text,
            label: Some(label.into()),
            ..Self::default()
        }
    }
}

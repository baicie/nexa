//! Typed style properties (no CSS string / selector engine).

/// Property identifiers for the Host Protocol.
///
/// Adapters map framework style objects onto these IDs — never pass
/// arbitrary property name strings across the FFI boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum PropertyId {
    Width = 1,
    Height = 2,
    MinWidth = 3,
    MinHeight = 4,
    Padding = 5,
    Gap = 6,
    FlexDirection = 7,
    AlignItems = 8,
    JustifyContent = 9,
    BackgroundColor = 10,
    BorderRadius = 11,
    Opacity = 12,
    FontSize = 13,
    FontWeight = 14,
    TextColor = 15,
}

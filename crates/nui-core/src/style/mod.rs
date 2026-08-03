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

/// Flex main-axis direction for Slice 1 hand layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlexDirection {
    #[default]
    Column,
    Row,
}

/// Premultiplied-friendly sRGB color (a=255 means opaque).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColorRgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl ColorRgba {
    #[must_use]
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }
}

/// Node style used by the Slice 1 hand layout + paint path.
#[derive(Debug, Clone)]
pub struct Style {
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub padding: f32,
    pub gap: f32,
    pub flex_direction: FlexDirection,
    pub background: Option<ColorRgba>,
    pub border_radius: f32,
    pub font_size: f32,
    pub color: ColorRgba,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            width: None,
            height: None,
            padding: 0.0,
            gap: 0.0,
            flex_direction: FlexDirection::Column,
            background: None,
            border_radius: 0.0,
            font_size: 16.0,
            color: ColorRgba::rgb(0x11, 0x18, 0x27),
        }
    }
}

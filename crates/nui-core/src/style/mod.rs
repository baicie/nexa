//! Typed style properties (no CSS string / selector engine).

/// Property identifiers defined by the generated Host Protocol.
pub use crate::protocol::ui::PropertyId;

/// Flex main-axis direction for Slice 1 hand layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlexDirection {
    #[default]
    Column,
    Row,
}

/// Cross-axis / main-axis alignment (Host PropertyId numeric mapping).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Align {
    #[default]
    Start = 0,
    Center = 1,
    End = 2,
    Stretch = 3,
}

impl Align {
    #[must_use]
    pub fn from_f64(value: f64) -> Self {
        match value as u8 {
            1 => Self::Center,
            2 => Self::End,
            3 => Self::Stretch,
            _ => Self::Start,
        }
    }
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
    pub min_width: Option<f32>,
    pub min_height: Option<f32>,
    pub padding: f32,
    pub gap: f32,
    pub flex_direction: FlexDirection,
    pub align_items: Align,
    pub justify_content: Align,
    pub flex_grow: f32,
    pub background: Option<ColorRgba>,
    pub border_radius: f32,
    pub opacity: f32,
    pub font_size: f32,
    pub font_weight: u32,
    pub color: ColorRgba,
    /// Scroll content offset (positive = content moved up). Only meaningful on Scroll.
    pub scroll_offset_y: f32,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            width: None,
            height: None,
            min_width: None,
            min_height: None,
            padding: 0.0,
            gap: 0.0,
            flex_direction: FlexDirection::Column,
            align_items: Align::Start,
            justify_content: Align::Start,
            flex_grow: 0.0,
            background: None,
            border_radius: 0.0,
            opacity: 1.0,
            font_size: 16.0,
            font_weight: 400,
            color: ColorRgba::rgb(0x11, 0x18, 0x27),
            scroll_offset_y: 0.0,
        }
    }
}

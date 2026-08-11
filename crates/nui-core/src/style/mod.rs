//! Typed style properties (no CSS string / selector engine).

use crate::InteractionStateToken;

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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InteractionOutline {
    pub color: ColorRgba,
    pub width: f32,
}

/// Paint-only style resolved from one stable interaction-state token.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedInteractionStyle {
    pub token: InteractionStateToken,
    pub background: Option<ColorRgba>,
    pub opacity: f32,
    pub outline: Option<InteractionOutline>,
}

/// Node style used by the Slice 1 hand layout + paint path.
#[derive(Debug, Clone, PartialEq)]
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
    pub disabled: bool,
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
            disabled: false,
            font_size: 16.0,
            font_weight: 400,
            color: ColorRgba::rgb(0x11, 0x18, 0x27),
            scroll_offset_y: 0.0,
        }
    }
}

impl Style {
    #[must_use]
    pub fn resolve_interaction(
        &self,
        interaction: InteractionStateToken,
    ) -> ResolvedInteractionStyle {
        let token = if self.disabled {
            interaction | InteractionStateToken::DISABLED
        } else {
            interaction
        };
        let disabled = token.contains(InteractionStateToken::DISABLED);
        let background = if disabled {
            self.background
        } else if token.contains(InteractionStateToken::PRESSED) {
            self.background
                .map(|color| mix_color(color, ColorRgba::rgb(0, 0, 0), 14))
        } else if token.contains(InteractionStateToken::HOVERED) {
            self.background
                .map(|color| mix_color(color, ColorRgba::rgb(0xff, 0xff, 0xff), 10))
        } else {
            self.background
        };
        let opacity = self.opacity.clamp(0.0, 1.0) * if disabled { 0.5 } else { 1.0 };
        let outline = (!disabled && token.contains(InteractionStateToken::FOCUSED)).then_some(
            InteractionOutline {
                color: ColorRgba::rgb(0xf5, 0x9e, 0x0b),
                width: 2.0,
            },
        );
        ResolvedInteractionStyle {
            token,
            background,
            opacity,
            outline,
        }
    }

    /// Apply a protocol numeric property using the same coercion rules as the
    /// Host FFI. Keeping this conversion in Core makes queued and immediate
    /// mutation paths observe identical style semantics.
    pub fn set_property(&mut self, property: PropertyId, value: f64) {
        let raw = value;
        let value = value as f32;
        match property {
            PropertyId::Width => self.width = Some(value),
            PropertyId::Height => self.height = Some(value),
            PropertyId::MinWidth => self.min_width = Some(value.max(0.0)),
            PropertyId::MinHeight => self.min_height = Some(value.max(0.0)),
            PropertyId::Padding => self.padding = value,
            PropertyId::Gap => self.gap = value,
            PropertyId::FlexDirection => {
                self.flex_direction = if raw >= 0.5 {
                    FlexDirection::Row
                } else {
                    FlexDirection::Column
                };
            }
            PropertyId::AlignItems => self.align_items = Align::from_f64(raw),
            PropertyId::JustifyContent => self.justify_content = Align::from_f64(raw),
            PropertyId::FlexGrow => self.flex_grow = value.max(0.0),
            PropertyId::BorderRadius => self.border_radius = value,
            PropertyId::Opacity => self.opacity = value.clamp(0.0, 1.0),
            PropertyId::Disabled => self.disabled = raw >= 0.5,
            PropertyId::FontSize => self.font_size = value,
            PropertyId::FontWeight => {
                self.font_weight = raw.max(0.0).min(u32::MAX as f64) as u32;
            }
            PropertyId::BackgroundColor => self.background = Some(color_from_u32(raw as u32)),
            PropertyId::TextColor => self.color = color_from_u32(raw as u32),
            PropertyId::ScrollOffsetY => self.scroll_offset_y = value.max(0.0),
        }
    }

    /// Restore the protocol-declared default/unset value for a property.
    pub fn clear_property(&mut self, property: PropertyId) {
        let defaults = Self::default();
        match property {
            PropertyId::Width => self.width = defaults.width,
            PropertyId::Height => self.height = defaults.height,
            PropertyId::MinWidth => self.min_width = defaults.min_width,
            PropertyId::MinHeight => self.min_height = defaults.min_height,
            PropertyId::Padding => self.padding = defaults.padding,
            PropertyId::Gap => self.gap = defaults.gap,
            PropertyId::FlexDirection => self.flex_direction = defaults.flex_direction,
            PropertyId::AlignItems => self.align_items = defaults.align_items,
            PropertyId::JustifyContent => self.justify_content = defaults.justify_content,
            PropertyId::BackgroundColor => self.background = defaults.background,
            PropertyId::BorderRadius => self.border_radius = defaults.border_radius,
            PropertyId::Opacity => self.opacity = defaults.opacity,
            PropertyId::Disabled => self.disabled = defaults.disabled,
            PropertyId::FontSize => self.font_size = defaults.font_size,
            PropertyId::FontWeight => self.font_weight = defaults.font_weight,
            PropertyId::TextColor => self.color = defaults.color,
            PropertyId::ScrollOffsetY => self.scroll_offset_y = defaults.scroll_offset_y,
            PropertyId::FlexGrow => self.flex_grow = defaults.flex_grow,
        }
    }
}

fn mix_color(source: ColorRgba, target: ColorRgba, target_percent: u16) -> ColorRgba {
    fn channel(source: u8, target: u8, target_percent: u16) -> u8 {
        let source_percent = 100 - target_percent;
        ((u16::from(source) * source_percent + u16::from(target) * target_percent + 50) / 100) as u8
    }

    ColorRgba {
        r: channel(source.r, target.r, target_percent),
        g: channel(source.g, target.g, target_percent),
        b: channel(source.b, target.b, target_percent),
        a: source.a,
    }
}

fn color_from_u32(value: u32) -> ColorRgba {
    ColorRgba {
        r: (value >> 24) as u8,
        g: (value >> 16) as u8,
        b: (value >> 8) as u8,
        a: value as u8,
    }
}

#[cfg(test)]
mod tests {
    use super::{ColorRgba, PropertyId, Style};
    use crate::InteractionStateToken;

    #[test]
    fn disabled_property_set_and_clear_restore_the_default() {
        let mut style = Style::default();
        assert!(!style.disabled);

        style.set_property(PropertyId::Disabled, 1.0);
        assert!(style.disabled);

        style.clear_property(PropertyId::Disabled);
        assert!(!style.disabled);
    }

    #[test]
    fn interaction_states_resolve_stable_visual_feedback() {
        let style = Style {
            background: Some(ColorRgba::rgb(0x20, 0x40, 0x80)),
            opacity: 0.8,
            ..Style::default()
        };

        let idle = style.resolve_interaction(InteractionStateToken::IDLE);
        let hovered = style.resolve_interaction(InteractionStateToken::HOVERED);
        let pressed = style.resolve_interaction(InteractionStateToken::PRESSED);
        let focused = style.resolve_interaction(InteractionStateToken::FOCUSED);

        assert_eq!(idle.token, InteractionStateToken::IDLE);
        assert_eq!(idle.background, style.background);
        assert_eq!(idle.opacity, 0.8);
        assert!(idle.outline.is_none());

        assert_eq!(hovered.token, InteractionStateToken::HOVERED);
        assert_ne!(hovered.background, style.background);
        assert_eq!(hovered.opacity, 0.8);
        assert!(hovered.outline.is_none());

        assert_eq!(pressed.token, InteractionStateToken::PRESSED);
        assert_ne!(pressed.background, hovered.background);
        assert_eq!(pressed.opacity, 0.8);
        assert!(pressed.outline.is_none());

        assert_eq!(focused.token, InteractionStateToken::FOCUSED);
        assert_eq!(focused.background, style.background);
        assert_eq!(focused.opacity, 0.8);
        assert!(focused.outline.is_some());

        let combined = style
            .resolve_interaction(InteractionStateToken::HOVERED | InteractionStateToken::FOCUSED);
        assert_ne!(combined.background, style.background);
        assert!(combined.outline.is_some());

        let pressed_focused = style
            .resolve_interaction(InteractionStateToken::PRESSED | InteractionStateToken::FOCUSED);
        assert_eq!(pressed_focused.background, pressed.background);
        assert!(pressed_focused.outline.is_some());

        let disabled = Style {
            disabled: true,
            ..style
        }
        .resolve_interaction(InteractionStateToken::HOVERED);
        assert!(disabled.token.contains(InteractionStateToken::DISABLED));
        assert_eq!(disabled.opacity, 0.4);
        assert!(disabled.outline.is_none());
    }
}

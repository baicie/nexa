//! Skia rendering backend (CPU raster).
//!
//! Frames are painted into softbuffer-compatible `u32` pixels via
//! [`skia_safe::surfaces::wrap_pixels`].

use bytemuck::cast_slice_mut;
use nui_core::{Arena, ColorRgba, NodeId, NodeType};
use skia_safe::{
    surfaces, AlphaType, Color, ColorType, Font, FontMgr, FontStyle, ImageInfo, Paint, PaintStyle,
    Point, RRect, Rect,
};

use nui_core::VERSION as CORE_VERSION;

#[must_use]
pub fn backend_name() -> &'static str {
    "skia"
}

#[must_use]
pub fn core_version() -> &'static str {
    CORE_VERSION
}

/// Errors from Skia frame painting.
#[derive(Debug)]
pub enum PaintError {
    InvalidSize,
    WrapPixels,
    Typeface,
}

impl std::fmt::Display for PaintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSize => f.write_str("width and height must be non-zero"),
            Self::WrapPixels => f.write_str("failed to wrap pixel buffer as Skia surface"),
            Self::Typeface => f.write_str("failed to resolve a system typeface"),
        }
    }
}

impl std::error::Error for PaintError {}

/// Paint a laid-out node tree into a softbuffer pixel buffer.
pub fn paint_tree(
    arena: &Arena,
    root: NodeId,
    pixels: &mut [u32],
    width: u32,
    height: u32,
    scale: f64,
) -> Result<(), PaintError> {
    if width == 0 || height == 0 {
        return Err(PaintError::InvalidSize);
    }
    if pixels.len() < (width as usize) * (height as usize) {
        return Err(PaintError::InvalidSize);
    }

    let w = i32::try_from(width).map_err(|_| PaintError::InvalidSize)?;
    let h = i32::try_from(height).map_err(|_| PaintError::InvalidSize)?;
    let scale = scale.max(0.5) as f32;

    let info = ImageInfo::new((w, h), ColorType::BGRA8888, AlphaType::Opaque, None);
    let bytes: &mut [u8] = cast_slice_mut(pixels);
    let mut surface =
        surfaces::wrap_pixels(&info, bytes, None, None).ok_or(PaintError::WrapPixels)?;
    let canvas = surface.canvas();

    canvas.clear(Color::from_rgb(0xF4, 0xF6, 0xF8));

    let typeface = resolve_typeface().ok_or(PaintError::Typeface)?;
    paint_node(arena, root, canvas, &typeface, scale);
    Ok(())
}

fn paint_node(
    arena: &Arena,
    id: NodeId,
    canvas: &skia_safe::Canvas,
    typeface: &skia_safe::Typeface,
    scale: f32,
) {
    let Some(node) = arena.get(id) else {
        return;
    };

    let rect = node.layout;
    let x = rect.x * scale;
    let y = rect.y * scale;
    let w = rect.width * scale;
    let h = rect.height * scale;

    if let Some(bg) = node.style.background {
        let mut fill = Paint::default();
        fill.set_anti_alias(true);
        fill.set_style(PaintStyle::Fill);
        fill.set_color(to_skia_color(bg));
        let radius = node.style.border_radius * scale;
        let rrect = RRect::new_rect_xy(Rect::from_xywh(x, y, w, h), radius, radius);
        canvas.draw_rrect(rrect, &fill);
    }

    if node.node_type == NodeType::Text {
        if let Some(text) = node.text.as_deref() {
            let mut text_paint = Paint::default();
            text_paint.set_anti_alias(true);
            text_paint.set_color(to_skia_color(node.style.color));

            let font = Font::from_typeface(typeface, node.style.font_size * scale);
            // Baseline roughly inside the layout box.
            let baseline = y + node.style.font_size * scale * 0.9;
            canvas.draw_str(text, Point::new(x, baseline), &font, &text_paint);
        }
    }

    for child in &node.children {
        paint_node(arena, *child, canvas, typeface, scale);
    }
}

fn to_skia_color(c: ColorRgba) -> Color {
    Color::from_argb(c.a, c.r, c.g, c.b)
}

/// Slice 0 helper retained for backwards smoke checks.
pub fn paint_hello_frame(
    pixels: &mut [u32],
    width: u32,
    height: u32,
    scale: f64,
) -> Result<(), PaintError> {
    // Build a tiny one-off tree-equivalent draw (card + label) without arena.
    if width == 0 || height == 0 {
        return Err(PaintError::InvalidSize);
    }
    if pixels.len() < (width as usize) * (height as usize) {
        return Err(PaintError::InvalidSize);
    }

    let w = i32::try_from(width).map_err(|_| PaintError::InvalidSize)?;
    let h = i32::try_from(height).map_err(|_| PaintError::InvalidSize)?;
    let scale = scale.max(0.5) as f32;

    let info = ImageInfo::new((w, h), ColorType::BGRA8888, AlphaType::Opaque, None);
    let bytes: &mut [u8] = cast_slice_mut(pixels);
    let mut surface =
        surfaces::wrap_pixels(&info, bytes, None, None).ok_or(PaintError::WrapPixels)?;
    let canvas = surface.canvas();

    canvas.clear(Color::from_rgb(0xF4, 0xF6, 0xF8));

    let card_w = 320.0 * scale;
    let card_h = 160.0 * scale;
    let card_x = (w as f32 - card_w) * 0.5;
    let card_y = (h as f32 - card_h) * 0.5;
    let radius = 16.0 * scale;

    let mut fill = Paint::default();
    fill.set_anti_alias(true);
    fill.set_style(PaintStyle::Fill);
    fill.set_color(Color::from_rgb(0x1F, 0x6F, 0xEB));

    let rrect = RRect::new_rect_xy(
        Rect::from_xywh(card_x, card_y, card_w, card_h),
        radius,
        radius,
    );
    canvas.draw_rrect(rrect, &fill);

    let mut text_paint = Paint::default();
    text_paint.set_anti_alias(true);
    text_paint.set_color(Color::WHITE);

    let typeface = resolve_typeface().ok_or(PaintError::Typeface)?;
    let font = Font::from_typeface(typeface, 28.0 * scale);
    let label = "Hello Nexa UI";
    let (_advance, text_bounds) = font.measure_str(label, Some(&text_paint));
    let text_x = card_x + (card_w - text_bounds.width()) * 0.5 - text_bounds.left;
    let text_y = card_y + (card_h + text_bounds.height()) * 0.5 - text_bounds.bottom;

    canvas.draw_str(label, Point::new(text_x, text_y), &font, &text_paint);
    Ok(())
}

/// Offscreen smoke: paint one frame into an owned buffer (no window).
pub fn smoke_paint_hello(width: u32, height: u32, scale: f64) -> Result<Vec<u32>, PaintError> {
    let mut pixels = vec![0_u32; (width as usize) * (height as usize)];
    paint_hello_frame(&mut pixels, width, height, scale)?;
    Ok(pixels)
}

fn resolve_typeface() -> Option<skia_safe::Typeface> {
    let font_mgr = FontMgr::new();
    for family in [
        "Helvetica Neue",
        "Helvetica",
        "Arial",
        "Segoe UI",
        "sans-serif",
    ] {
        if let Some(face) = font_mgr.match_family_style(family, FontStyle::normal()) {
            return Some(face);
        }
    }
    font_mgr.legacy_make_typeface(None, FontStyle::normal())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nui_core::{layout_tree, Arena, ColorRgba, FlexDirection, NodeType, Style};

    #[test]
    fn backend_is_skia() {
        assert_eq!(backend_name(), "skia");
        assert!(!core_version().is_empty());
    }

    #[test]
    fn smoke_paint_produces_pixels() {
        let pixels = smoke_paint_hello(320, 200, 1.0).expect("smoke paint");
        assert_eq!(pixels.len(), 320 * 200);
        assert!(pixels.iter().any(|&p| p != 0));
    }

    #[test]
    fn paint_tree_counter_frame() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(320.0),
                height: Some(200.0),
                padding: 24.0,
                gap: 12.0,
                flex_direction: FlexDirection::Column,
                ..Style::default()
            },
        );
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "Count: 0");
        arena.set_style(
            text,
            Style {
                font_size: 28.0,
                color: ColorRgba::rgb(0x11, 0x18, 0x27),
                ..Style::default()
            },
        );
        arena.insert_child(root, text);
        layout_tree(&mut arena, root, 320.0, 200.0);

        let mut pixels = vec![0_u32; 320 * 200];
        paint_tree(&arena, root, &mut pixels, 320, 200, 1.0).expect("paint");
        assert!(pixels.iter().any(|&p| p != 0));
    }
}

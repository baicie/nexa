//! Skia rendering backend (CPU raster for Slice 0).
//!
//! Frames are painted into softbuffer-compatible `u32` pixels via
//! [`skia_safe::surfaces::wrap_pixels`].

use bytemuck::cast_slice_mut;
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

/// Slice 0 acceptance frame: clear, centered rounded rect, “Hello Nexa UI”.
///
/// `pixels` is softbuffer layout (`u32` per pixel). Drawn as BGRA8888 opaque.
pub fn paint_hello_frame(
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
}

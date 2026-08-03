//! Skia rendering backend (CPU raster).
//!
//! Frames are painted into softbuffer-compatible `u32` pixels via
//! [`skia_safe::surfaces::wrap_pixels`].

use bytemuck::{cast_slice, cast_slice_mut};
use nui_core::{Arena, ColorRgba, NodeId, NodeType};
use skia_safe::{
    images, surfaces, AlphaType, Color, ColorType, Data, Font, FontMgr, FontStyle, ImageInfo, Paint,
    PaintStyle, Point, RRect, Rect,
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

/// Optional paint hints for focused Input (caret / placeholder).
#[derive(Debug, Clone)]
pub struct FocusedPaint {
    pub text_node: NodeId,
    pub caret: usize,
    pub placeholder: String,
}

/// Decoded bitmap attached to an Image node for this frame.
#[derive(Debug, Clone)]
pub struct ImagePaint {
    pub node: NodeId,
    pub width: u32,
    pub height: u32,
    /// Softbuffer-compatible BGRA8888 pixels (`0xAARRGGBB` on little-endian as u32).
    pub pixels: Vec<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct PaintHints {
    pub focused: Option<FocusedPaint>,
    pub images: Vec<ImagePaint>,
}

/// Decode encoded image bytes (PNG/JPEG/…) into BGRA `u32` pixels.
///
/// Returns `None` when Skia cannot decode the payload.
#[must_use]
pub fn decode_image_bytes(bytes: &[u8]) -> Option<(u32, u32, Vec<u32>)> {
    let data = Data::new_copy(bytes);
    let image = skia_safe::Image::from_encoded(data)?;
    let w = u32::try_from(image.width()).ok()?;
    let h = u32::try_from(image.height()).ok()?;
    if w == 0 || h == 0 {
        return None;
    }
    let info = ImageInfo::new(
        (image.width(), image.height()),
        ColorType::BGRA8888,
        AlphaType::Unpremul,
        None,
    );
    let mut pixels = vec![0_u32; (w as usize) * (h as usize)];
    let row_bytes = (w as usize) * std::mem::size_of::<u32>();
    if !image.read_pixels(
        &info,
        pixels.as_mut_slice(),
        row_bytes,
        (0, 0),
        skia_safe::image::CachingHint::Allow,
    ) {
        return None;
    }
    Some((w, h, pixels))
}

/// Decode an image file from disk. On I/O or decode failure returns `None`.
#[must_use]
pub fn decode_image_file(path: &str) -> Option<(u32, u32, Vec<u32>)> {
    let bytes = std::fs::read(path).ok()?;
    decode_image_bytes(&bytes)
}

/// Paint a laid-out node tree into a softbuffer pixel buffer.
pub fn paint_tree(
    arena: &Arena,
    root: NodeId,
    pixels: &mut [u32],
    width: u32,
    height: u32,
    scale: f64,
    hints: Option<&PaintHints>,
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
    paint_node(arena, root, canvas, &typeface, scale, hints);
    Ok(())
}

fn paint_node(
    arena: &Arena,
    id: NodeId,
    canvas: &skia_safe::Canvas,
    typeface: &skia_safe::Typeface,
    scale: f32,
    hints: Option<&PaintHints>,
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

    if node.node_type == NodeType::Image {
        paint_image_node(id, x, y, w, h, canvas, hints);
    }

    if node.node_type == NodeType::Text {
        let focused = hints
            .and_then(|h| h.focused.as_ref())
            .filter(|f| f.text_node == id);
        let raw = node.text.as_deref().unwrap_or("");
        let font = Font::from_typeface(typeface, node.style.font_size * scale);
        let baseline = y + node.style.font_size * scale * 0.9;

        if raw.is_empty() {
            if let Some(f) = focused {
                if !f.placeholder.is_empty() {
                    let mut ph = Paint::default();
                    ph.set_anti_alias(true);
                    ph.set_color(Color::from_rgb(0x9C, 0xA3, 0xAF));
                    canvas.draw_str(&f.placeholder, Point::new(x, baseline), &font, &ph);
                }
            }
        } else {
            let mut text_paint = Paint::default();
            text_paint.set_anti_alias(true);
            text_paint.set_color(to_skia_color(node.style.color));
            canvas.draw_str(raw, Point::new(x, baseline), &font, &text_paint);
        }

        if let Some(f) = focused {
            let prefix: String = raw.chars().take(f.caret).collect();
            let (caret_x, _) = font.measure_str(&prefix, None);
            let mut caret = Paint::default();
            caret.set_anti_alias(true);
            caret.set_color(Color::from_rgb(0x11, 0x18, 0x27));
            caret.set_stroke_width(1.5 * scale);
            caret.set_style(PaintStyle::Stroke);
            let top = y + 2.0 * scale;
            let bottom = y + h - 2.0 * scale;
            canvas.draw_line(
                Point::new(x + caret_x, top),
                Point::new(x + caret_x, bottom),
                &caret,
            );
        }
    }

    let is_scroll = node.node_type == NodeType::Scroll;
    let scroll_offset = node.style.scroll_offset_y;
    let children = node.children.clone();

    if is_scroll {
        canvas.save();
        canvas.clip_rect(Rect::from_xywh(x, y, w, h), None, Some(true));
        canvas.translate((0.0, -scroll_offset * scale));
    }

    for child in &children {
        paint_node(arena, *child, canvas, typeface, scale, hints);
    }

    if is_scroll {
        canvas.restore();
    }
}

fn paint_image_node(
    id: NodeId,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    canvas: &skia_safe::Canvas,
    hints: Option<&PaintHints>,
) {
    let asset = hints.and_then(|h| h.images.iter().find(|img| img.node == id));
    let dst = Rect::from_xywh(x, y, w.max(1.0), h.max(1.0));

    let Some(asset) = asset.filter(|a| !a.pixels.is_empty() && a.width > 0 && a.height > 0) else {
        let mut fill = Paint::default();
        fill.set_anti_alias(true);
        fill.set_style(PaintStyle::Fill);
        fill.set_color(Color::from_rgb(0xD1, 0xD5, 0xDB));
        canvas.draw_rect(dst, &fill);
        return;
    };

    let info = ImageInfo::new(
        (asset.width as i32, asset.height as i32),
        ColorType::BGRA8888,
        AlphaType::Unpremul,
        None,
    );
    let row_bytes = (asset.width as usize) * std::mem::size_of::<u32>();
    let data = Data::new_copy(cast_slice(&asset.pixels));
    let Some(image) = images::raster_from_data(&info, data, row_bytes) else {
        let mut fill = Paint::default();
        fill.set_anti_alias(true);
        fill.set_style(PaintStyle::Fill);
        fill.set_color(Color::from_rgb(0xD1, 0xD5, 0xDB));
        canvas.draw_rect(dst, &fill);
        return;
    };

    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    let src = Rect::from_wh(asset.width as f32, asset.height as f32);
    canvas.draw_image_rect(
        &image,
        Some((&src, skia_safe::canvas::SrcRectConstraint::Strict)),
        dst,
        &paint,
    );
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
    use nui_core::layout::layout_tree;
    use nui_core::{Arena, ColorRgba, FlexDirection, NodeType, Style};

    /// 1×1 opaque red PNG.
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE, 0x02, 0xFE, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

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
    fn decode_tiny_png_bytes() {
        let (w, h, pixels) = decode_image_bytes(TINY_PNG).expect("decode png");
        assert_eq!((w, h), (1, 1));
        assert_eq!(pixels.len(), 1);
    }

    #[test]
    fn paint_tree_image_node() {
        let (iw, ih, ipixels) = decode_image_bytes(TINY_PNG).expect("decode");
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(64.0),
                height: Some(64.0),
                padding: 8.0,
                ..Style::default()
            },
        );
        let image = arena.create(NodeType::Image);
        arena.set_style(
            image,
            Style {
                width: Some(32.0),
                height: Some(32.0),
                ..Style::default()
            },
        );
        arena.insert_child(root, image);
        layout_tree(&mut arena, root, 64.0, 64.0);

        let hints = PaintHints {
            images: vec![ImagePaint {
                node: image,
                width: iw,
                height: ih,
                pixels: ipixels,
            }],
            ..PaintHints::default()
        };
        let mut pixels = vec![0_u32; 64 * 64];
        paint_tree(&arena, root, &mut pixels, 64, 64, 1.0, Some(&hints)).expect("paint");
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
        paint_tree(&arena, root, &mut pixels, 320, 200, 1.0, None).expect("paint");
        assert!(pixels.iter().any(|&p| p != 0));
    }
}

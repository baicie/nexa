//! Skia rendering backend (CPU raster).
//!
//! Frames are painted into softbuffer-compatible `u32` pixels via
//! [`skia_safe::surfaces::wrap_pixels`].

use bytemuck::{cast_slice, cast_slice_mut};
use nui_core::{
    ColorRgba, DisplayCommand, DisplayList, LayoutRect, NodeId, ResourceId, SurfaceGeneration,
};
use skia_safe::{
    font_style::{Slant, Weight, Width},
    images, surfaces, AlphaType, Color, ColorType, Data, Font, FontMgr, FontStyle, ImageInfo,
    Paint, PaintStyle, Point, RRect, Rect,
};
use std::collections::HashMap;
use std::sync::Arc;

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
    MissingFontResource(u64),
    InvalidFontResource(u64),
    InvalidGlyphGeometry(u64),
}

impl std::fmt::Display for PaintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSize => f.write_str("width and height must be non-zero"),
            Self::WrapPixels => f.write_str("failed to wrap pixel buffer as Skia surface"),
            Self::Typeface => f.write_str("failed to resolve a system typeface"),
            Self::MissingFontResource(font_id) => {
                write!(f, "glyph run references missing font resource {font_id}")
            }
            Self::InvalidFontResource(font_id) => {
                write!(f, "glyph run references invalid font resource {font_id}")
            }
            Self::InvalidGlyphGeometry(font_id) => {
                write!(f, "glyph run {font_id} contains non-finite geometry")
            }
        }
    }
}

impl std::error::Error for PaintError {}

/// Optional paint hints for focused editable text overlays.
#[derive(Debug, Clone)]
pub struct FocusedPaint {
    pub text_node: NodeId,
    /// Paragraph-local logical-pixel caret geometry.
    pub caret_rect: Option<LayoutRect>,
    /// Paragraph-local selection geometry, one rectangle per visual line.
    pub selection_rects: Vec<LayoutRect>,
}

/// Decoded bitmap attached to an Image node for this frame.
#[derive(Debug, Clone)]
pub struct ImagePaint {
    pub resource_id: ResourceId,
    pub width: u32,
    pub height: u32,
    /// Softbuffer-compatible BGRA8888 pixels (`0xAARRGGBB` on little-endian as u32).
    pub pixels: Arc<[u32]>,
}

/// Source-backed font resource required by a `GlyphRun` command.
#[derive(Debug, Clone)]
pub struct FontPaint {
    pub font_id: u64,
    pub bytes: Arc<[u8]>,
    pub face_index: u32,
}

#[derive(Debug, Clone, Default)]
pub struct PaintHints {
    pub focused: Option<FocusedPaint>,
    pub images: Vec<ImagePaint>,
    pub fonts: Vec<FontPaint>,
}

struct CachedImage {
    image: skia_safe::Image,
    _pixels: Arc<[u32]>,
}

/// Backend objects materialized from generation-bearing CPU resources.
pub struct BackendResourceCache {
    surface_generation: SurfaceGeneration,
    images: HashMap<ResourceId, CachedImage>,
    fonts: HashMap<u64, skia_safe::Typeface>,
    image_upload_count: u64,
    font_upload_count: u64,
}

impl Default for BackendResourceCache {
    fn default() -> Self {
        Self::new()
    }
}

impl BackendResourceCache {
    #[must_use]
    pub fn new() -> Self {
        Self {
            surface_generation: SurfaceGeneration::default(),
            images: HashMap::new(),
            fonts: HashMap::new(),
            image_upload_count: 0,
            font_upload_count: 0,
        }
    }

    pub fn set_surface_generation(&mut self, generation: SurfaceGeneration) {
        if self.surface_generation != generation {
            self.surface_generation = generation;
            self.release_surface_resources();
        }
    }

    /// Drop objects owned by the current backend surface while retaining CPU
    /// resources and lifetime upload counters.
    pub fn release_surface_resources(&mut self) {
        self.images.clear();
        self.fonts.clear();
    }

    #[must_use]
    pub const fn surface_generation(&self) -> SurfaceGeneration {
        self.surface_generation
    }

    #[must_use]
    pub const fn image_upload_count(&self) -> u64 {
        self.image_upload_count
    }

    #[must_use]
    pub const fn font_upload_count(&self) -> u64 {
        self.font_upload_count
    }

    /// Number of image objects currently owned by the active backend surface.
    #[must_use]
    pub fn cached_image_count(&self) -> usize {
        self.images.len()
    }

    /// Number of typeface objects currently owned by the active backend surface.
    #[must_use]
    pub fn cached_font_count(&self) -> usize {
        self.fonts.len()
    }

    fn image<'a>(
        &'a mut self,
        resource_id: ResourceId,
        hints: Option<&PaintHints>,
    ) -> Option<&'a skia_safe::Image> {
        if let std::collections::hash_map::Entry::Vacant(entry) = self.images.entry(resource_id) {
            let asset = hints?
                .images
                .iter()
                .find(|image| image.resource_id == resource_id)?;
            if asset.pixels.is_empty() || asset.width == 0 || asset.height == 0 {
                return None;
            }
            let pixel_count = (asset.width as usize).checked_mul(asset.height as usize)?;
            if asset.pixels.len() < pixel_count {
                return None;
            }
            let width = i32::try_from(asset.width).ok()?;
            let height = i32::try_from(asset.height).ok()?;
            let info = ImageInfo::new(
                (width, height),
                ColorType::BGRA8888,
                AlphaType::Unpremul,
                None,
            );
            let row_bytes = (asset.width as usize).checked_mul(std::mem::size_of::<u32>())?;
            let pixels = Arc::clone(&asset.pixels);
            // CachedImage keeps the Arc alive for as long as Skia borrows it.
            let data = unsafe { Data::new_bytes(cast_slice(pixels.as_ref())) };
            let image = images::raster_from_data(&info, data, row_bytes)?;
            entry.insert(CachedImage {
                image,
                _pixels: pixels,
            });
            self.image_upload_count = self.image_upload_count.saturating_add(1);
        }
        self.images.get(&resource_id).map(|cached| &cached.image)
    }

    fn font(
        &mut self,
        font_id: u64,
        hints: Option<&PaintHints>,
    ) -> Result<skia_safe::Typeface, PaintError> {
        if let Some(typeface) = self.fonts.get(&font_id) {
            return Ok(typeface.clone());
        }
        let typeface = resolve_font_resource(font_id, hints)?;
        self.fonts.insert(font_id, typeface.clone());
        self.font_upload_count = self.font_upload_count.saturating_add(1);
        Ok(typeface)
    }
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

/// Execute an immutable display-list snapshot into a softbuffer pixel buffer.
pub fn paint_display_list(
    display_list: &DisplayList,
    pixels: &mut [u32],
    width: u32,
    height: u32,
    scale: f64,
    hints: Option<&PaintHints>,
) -> Result<(), PaintError> {
    let mut cache = BackendResourceCache::new();
    paint_display_list_with_cache(
        display_list,
        pixels,
        width,
        height,
        scale,
        hints,
        &mut cache,
    )
}

/// Execute a display list while retaining backend resources across frames.
pub fn paint_display_list_with_cache(
    display_list: &DisplayList,
    pixels: &mut [u32],
    width: u32,
    height: u32,
    scale: f64,
    hints: Option<&PaintHints>,
    cache: &mut BackendResourceCache,
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

    let mut typeface = None;
    for command in display_list.commands() {
        match command {
            DisplayCommand::PushOpacity { opacity } => {
                canvas.save_layer_alpha_f(None, opacity.clamp(0.0, 1.0));
            }
            DisplayCommand::PopOpacity => {
                canvas.restore();
            }
            DisplayCommand::FillRect {
                rect,
                color,
                radius,
            } => {
                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_style(PaintStyle::Fill);
                fill.set_color(to_skia_color(*color));
                let radius = *radius * scale;
                let rrect = RRect::new_rect_xy(scaled_rect(*rect, scale), radius, radius);
                canvas.draw_rrect(rrect, &fill);
            }
            DisplayCommand::StrokeRect {
                rect,
                color,
                radius,
                width,
            } => {
                let width = width.max(0.0) * scale;
                if width == 0.0 {
                    continue;
                }
                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(PaintStyle::Stroke);
                stroke.set_stroke_width(width);
                stroke.set_color(to_skia_color(*color));
                let radius = radius.max(0.0) * scale;
                let rrect = RRect::new_rect_xy(scaled_rect(*rect, scale), radius, radius);
                canvas.draw_rrect(rrect, &stroke);
            }
            DisplayCommand::ClipRect { rect } => {
                canvas.save();
                canvas.clip_rect(scaled_rect(*rect, scale), None, Some(true));
            }
            DisplayCommand::RestoreClip => {
                canvas.restore();
            }
            DisplayCommand::Image {
                resource_id, rect, ..
            } => {
                let rect = scaled_rect(*rect, scale);
                paint_image_resource(*resource_id, rect, canvas, hints, cache);
            }
            DisplayCommand::Text {
                node,
                rect,
                text,
                color,
                font_size,
                font_weight,
            } => {
                if typeface.is_none() {
                    typeface = Some(resolve_typeface().ok_or(PaintError::Typeface)?);
                }
                paint_text_command(
                    *node,
                    *rect,
                    text,
                    *color,
                    *font_size,
                    *font_weight,
                    canvas,
                    typeface.as_ref().expect("typeface resolved"),
                    scale,
                    hints,
                );
            }
            DisplayCommand::TextBox { node, rect, .. } => {
                let focused = hints
                    .and_then(|h| h.focused.as_ref())
                    .is_some_and(|focused| focused.text_node == *node);
                if focused {
                    paint_text_overlay(*node, *rect, canvas, scale, hints);
                }
            }
            DisplayCommand::GlyphRun { node: _, run } => {
                let typeface = cache.font(run.font_id, hints)?;
                let font = Font::from_typeface(typeface, run.font_size * scale);
                let mut glyphs = Vec::with_capacity(run.glyphs.len());
                let mut positions = Vec::with_capacity(run.glyphs.len());
                for glyph in &run.glyphs {
                    let x = glyph.x * scale;
                    let y = glyph.y * scale;
                    if !x.is_finite() || !y.is_finite() {
                        return Err(PaintError::InvalidGlyphGeometry(run.font_id));
                    }
                    glyphs.push(glyph.glyph_id as skia_safe::GlyphId);
                    positions.push(Point::new(x, y));
                }
                let mut paint = Paint::default();
                paint.set_anti_alias(true);
                paint.set_color(to_skia_color(run.color));
                canvas.draw_glyphs_at(
                    &glyphs,
                    positions.as_slice(),
                    Point::default(),
                    &font,
                    &paint,
                );
            }
        }
    }
    Ok(())
}

fn resolve_font_resource(
    font_id: u64,
    hints: Option<&PaintHints>,
) -> Result<skia_safe::Typeface, PaintError> {
    let resource = hints
        .and_then(|hints| hints.fonts.iter().find(|font| font.font_id == font_id))
        .ok_or(PaintError::MissingFontResource(font_id))?;
    FontMgr::new()
        .new_from_data(&resource.bytes, resource.face_index as usize)
        .ok_or(PaintError::InvalidFontResource(font_id))
}

fn scaled_rect(rect: nui_core::LayoutRect, scale: f32) -> Rect {
    Rect::from_xywh(
        rect.x * scale,
        rect.y * scale,
        rect.width * scale,
        rect.height * scale,
    )
}

#[allow(clippy::too_many_arguments)]
fn paint_text_command(
    node: NodeId,
    rect: nui_core::LayoutRect,
    text: &str,
    color: ColorRgba,
    font_size: f32,
    font_weight: u32,
    canvas: &skia_safe::Canvas,
    typeface: &skia_safe::Typeface,
    scale: f32,
    hints: Option<&PaintHints>,
) {
    let focused = hints
        .and_then(|h| h.focused.as_ref())
        .filter(|focused| focused.text_node == node);
    let font = resolve_weighted_font(typeface, font_size * scale, font_weight);
    let x = rect.x * scale;
    let y = rect.y * scale;
    let baseline = y + font_size * scale * 0.9;

    if let Some(focused) = focused {
        paint_selection(&focused.selection_rects, rect, canvas, scale);
    }

    if !text.is_empty() {
        let mut text_paint = Paint::default();
        text_paint.set_anti_alias(true);
        text_paint.set_color(to_skia_color(color));
        canvas.draw_str(text, Point::new(x, baseline), &font, &text_paint);
    }

    if let Some(caret_rect) = focused.and_then(|focused| focused.caret_rect) {
        paint_caret(caret_rect, rect, canvas, scale);
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_text_overlay(
    node: NodeId,
    rect: nui_core::LayoutRect,
    canvas: &skia_safe::Canvas,
    scale: f32,
    hints: Option<&PaintHints>,
) {
    let Some(focused) = hints
        .and_then(|hints| hints.focused.as_ref())
        .filter(|focused| focused.text_node == node)
    else {
        return;
    };
    paint_selection(&focused.selection_rects, rect, canvas, scale);
    let Some(caret_rect) = focused.caret_rect else {
        return;
    };
    paint_caret(caret_rect, rect, canvas, scale);
}

fn paint_caret(
    caret_rect: LayoutRect,
    text_rect: LayoutRect,
    canvas: &skia_safe::Canvas,
    scale: f32,
) {
    let mut caret = Paint::default();
    caret.set_anti_alias(true);
    caret.set_color(Color::from_rgb(0x11, 0x18, 0x27));
    caret.set_style(PaintStyle::Fill);
    canvas.draw_rect(
        scaled_rect(text_local_rect(caret_rect, text_rect), scale),
        &caret,
    );
}

fn paint_selection(
    selection_rects: &[LayoutRect],
    text_rect: LayoutRect,
    canvas: &skia_safe::Canvas,
    scale: f32,
) {
    if selection_rects.is_empty() {
        return;
    }
    let mut selection = Paint::default();
    selection.set_anti_alias(true);
    selection.set_color(Color::from_argb(0x66, 0x33, 0x8A, 0xFF));
    selection.set_style(PaintStyle::Fill);
    for rect in selection_rects {
        canvas.draw_rect(
            scaled_rect(text_local_rect(*rect, text_rect), scale),
            &selection,
        );
    }
}

fn text_local_rect(rect: LayoutRect, text_rect: LayoutRect) -> LayoutRect {
    LayoutRect {
        x: text_rect.x + rect.x,
        y: text_rect.y + rect.y,
        width: rect.width,
        height: rect.height,
    }
}

fn resolve_weighted_font(fallback: &skia_safe::Typeface, size: f32, weight: u32) -> Font {
    let requested_weight = weight.clamp(1, 1000) as i32;
    let style = FontStyle::new(
        Weight::from(requested_weight),
        Width::NORMAL,
        Slant::Upright,
    );
    let font_mgr = FontMgr::new();
    let typeface = [
        "Helvetica Neue",
        "Helvetica",
        "Arial",
        "Segoe UI",
        "sans-serif",
    ]
    .into_iter()
    .find_map(|family| font_mgr.match_family_style(family, style))
    .or_else(|| font_mgr.legacy_make_typeface(None, style))
    .unwrap_or_else(|| fallback.clone());
    let synthetic_bold = requested_weight >= 600 && !typeface.is_bold();
    let mut font = Font::from_typeface(typeface, size);
    font.set_embolden(synthetic_bold);
    font
}

fn paint_image_resource(
    resource_id: Option<ResourceId>,
    dst: Rect,
    canvas: &skia_safe::Canvas,
    hints: Option<&PaintHints>,
    cache: &mut BackendResourceCache,
) {
    let dst = Rect::from_xywh(
        dst.left,
        dst.top,
        dst.width().max(1.0),
        dst.height().max(1.0),
    );
    let Some(resource_id) = resource_id else {
        let mut fill = Paint::default();
        fill.set_anti_alias(true);
        fill.set_style(PaintStyle::Fill);
        fill.set_color(Color::from_rgb(0xD1, 0xD5, 0xDB));
        canvas.draw_rect(dst, &fill);
        return;
    };
    let asset = hints.and_then(|hints| {
        hints
            .images
            .iter()
            .find(|image| image.resource_id == resource_id)
    });
    let Some((asset, image)) =
        asset.and_then(|asset| cache.image(resource_id, hints).map(|image| (asset, image)))
    else {
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
        image,
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
    use nui_core::{
        Arena, ColorRgba, DisplayGlyph, FlexDirection, GlyphRun, InteractionStateToken, NodeType,
        Style,
    };
    use std::sync::Arc;

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
    fn paint_display_list_executes_fill_rect_snapshot() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(16.0),
                height: Some(16.0),
                background: Some(ColorRgba::rgb(0xff, 0x00, 0x00)),
                ..Style::default()
            },
        );
        layout_tree(&mut arena, root, 16.0, 16.0);
        let display_list = nui_core::DisplayList::from_arena(&arena, root);
        let mut pixels = vec![0_u32; 16 * 16];

        paint_display_list(&display_list, &mut pixels, 16, 16, 1.0, None)
            .expect("paint display list");

        assert!(pixels.iter().any(|&pixel| pixel != 0xfff4f6f8));
    }

    #[test]
    fn paint_display_list_renders_the_focus_state_outline() {
        let mut arena = Arena::new();
        let button = arena.create(NodeType::View);
        arena.get_mut(button).expect("button").layout = LayoutRect {
            x: 4.0,
            y: 4.0,
            width: 16.0,
            height: 16.0,
        };
        arena.get_mut(button).expect("button").style = Style {
            background: Some(ColorRgba::rgb(0x1f, 0x6f, 0xeb)),
            border_radius: 2.0,
            ..Style::default()
        };

        let idle = DisplayList::from_arena(&arena, button);
        let focused = DisplayList::from_arena_with_interactions(&arena, button, |node| {
            (node == button).then_some(InteractionStateToken::FOCUSED)
        });
        let mut idle_pixels = vec![0_u32; 24 * 24];
        let mut focused_pixels = vec![0_u32; 24 * 24];
        paint_display_list(&idle, &mut idle_pixels, 24, 24, 1.0, None).expect("paint idle");
        paint_display_list(&focused, &mut focused_pixels, 24, 24, 1.0, None)
            .expect("paint focused");

        assert_ne!(focused_pixels, idle_pixels);
    }

    #[test]
    fn decode_tiny_png_bytes() {
        let (w, h, pixels) = decode_image_bytes(TINY_PNG).expect("decode png");
        assert_eq!((w, h), (1, 1));
        assert_eq!(pixels.len(), 1);
    }

    #[test]
    fn paint_display_list_image_command_uses_attached_pixels() {
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
        arena.set_image_resource(image, Some(ResourceId::new(0, 1)));
        layout_tree(&mut arena, root, 64.0, 64.0);

        let hints = PaintHints {
            images: vec![ImagePaint {
                resource_id: ResourceId::new(0, 1),
                width: 1,
                height: 1,
                pixels: Arc::<[u32]>::from(vec![0xffff0000]),
            }],
            ..PaintHints::default()
        };
        let display_list = DisplayList::from_arena(&arena, root);
        let image_rect = display_list
            .commands()
            .iter()
            .find_map(|command| match command {
                DisplayCommand::Image { node, rect, .. } if *node == image => Some(*rect),
                _ => None,
            })
            .expect("image command");
        let mut pixels = vec![0_u32; 64 * 64];
        paint_display_list(&display_list, &mut pixels, 64, 64, 1.0, Some(&hints)).expect("paint");
        let sample_x = (image_rect.x + image_rect.width * 0.5) as usize;
        let sample_y = (image_rect.y + image_rect.height * 0.5) as usize;
        assert_eq!(pixels[sample_y * 64 + sample_x], 0xffff0000);
    }

    #[test]
    fn paint_display_list_clip_restricts_child_fill() {
        let mut arena = Arena::new();
        let scroll = arena.create(NodeType::Scroll);
        arena.get_mut(scroll).expect("scroll").layout = nui_core::LayoutRect {
            x: 4.0,
            y: 4.0,
            width: 4.0,
            height: 4.0,
        };
        let child = arena.create(NodeType::View);
        let child_node = arena.get_mut(child).expect("child");
        child_node.layout = nui_core::LayoutRect {
            x: 0.0,
            y: 0.0,
            width: 16.0,
            height: 16.0,
        };
        child_node.style.background = Some(ColorRgba::rgb(0xff, 0x00, 0x00));
        arena.insert_child(scroll, child);
        let display_list = DisplayList::from_arena(&arena, scroll);
        let mut pixels = vec![0_u32; 16 * 16];

        paint_display_list(&display_list, &mut pixels, 16, 16, 1.0, None).expect("paint");

        assert_eq!(pixels[5 * 16 + 5], 0xffff0000);
        assert_eq!(pixels[5 * 16 + 9], 0xfff4f6f8);
    }

    #[test]
    fn paint_display_list_counter_frame() {
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

        let display_list = DisplayList::from_arena(&arena, root);
        let mut pixels = vec![0_u32; 320 * 200];
        paint_display_list(&display_list, &mut pixels, 320, 200, 1.0, None).expect("paint");
        assert!(pixels.iter().any(|&p| p != 0));
    }

    fn paint_background_with_opacity(opacity: f32) -> Vec<u32> {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(16.0),
                height: Some(16.0),
                background: Some(ColorRgba::rgb(0xff, 0x00, 0x00)),
                opacity,
                ..Style::default()
            },
        );
        layout_tree(&mut arena, root, 16.0, 16.0);
        let display_list = DisplayList::from_arena(&arena, root);
        let mut pixels = vec![0_u32; 16 * 16];
        paint_display_list(&display_list, &mut pixels, 16, 16, 1.0, None).expect("paint opacity");
        pixels
    }

    #[test]
    fn paint_display_list_applies_node_opacity() {
        let opaque = paint_background_with_opacity(1.0);
        let transparent = paint_background_with_opacity(0.0);
        assert_ne!(opaque, transparent);
    }

    #[test]
    fn paint_display_list_applies_parent_opacity_to_descendants() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(16.0),
                height: Some(16.0),
                opacity: 0.0,
                ..Style::default()
            },
        );
        let child = arena.create(NodeType::View);
        arena.set_style(
            child,
            Style {
                width: Some(16.0),
                height: Some(16.0),
                background: Some(ColorRgba::rgb(0xff, 0x00, 0x00)),
                ..Style::default()
            },
        );
        arena.insert_child(root, child);
        layout_tree(&mut arena, root, 16.0, 16.0);
        let display_list = DisplayList::from_arena(&arena, root);
        let mut pixels = vec![0_u32; 16 * 16];

        paint_display_list(&display_list, &mut pixels, 16, 16, 1.0, None)
            .expect("paint transparent subtree");

        assert!(pixels.iter().all(|&pixel| pixel == 0xfff4f6f8));
    }

    fn paint_text_with_weight(font_weight: u32) -> Vec<u32> {
        let mut arena = Arena::new();
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "Weight");
        arena.set_style(
            text,
            Style {
                width: Some(160.0),
                height: Some(48.0),
                font_size: 32.0,
                font_weight,
                ..Style::default()
            },
        );
        layout_tree(&mut arena, text, 160.0, 48.0);
        let mut pixels = vec![0_u32; 160 * 48];
        let display_list = DisplayList::from_arena(&arena, text);
        paint_display_list(&display_list, &mut pixels, 160, 48, 1.0, None).expect("paint weight");
        pixels
    }

    #[test]
    fn paint_display_list_applies_font_weight() {
        assert_ne!(paint_text_with_weight(400), paint_text_with_weight(700));
    }

    #[test]
    fn focused_caret_uses_host_provided_paragraph_geometry() {
        let mut arena = Arena::new();
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "");
        arena.get_mut(text).expect("text node").layout = nui_core::LayoutRect {
            x: 8.0,
            y: 4.0,
            width: 64.0,
            height: 32.0,
        };
        let display_list =
            DisplayList::try_from_arena_with_glyph_runs(&arena, text, |_, _, _, _, _, _| {
                Ok::<_, std::convert::Infallible>(Vec::new())
            })
            .expect("production text display list");
        let hints = PaintHints {
            focused: Some(FocusedPaint {
                text_node: text,
                caret_rect: Some(nui_core::LayoutRect {
                    x: 40.0,
                    y: 6.0,
                    width: 1.0,
                    height: 20.0,
                }),
                selection_rects: Vec::new(),
            }),
            ..PaintHints::default()
        };
        let mut pixels = vec![0_u32; 64 * 32];

        paint_display_list(&display_list, &mut pixels, 64, 32, 1.0, Some(&hints))
            .expect("paint focused caret");

        assert_ne!(pixels[10 * 64 + 48], 0xfff4f6f8);
        assert_eq!(pixels[10 * 64 + 40], 0xfff4f6f8);
    }

    #[test]
    fn focused_selection_uses_paragraph_rects_in_the_production_text_box() {
        let mut arena = Arena::new();
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "");
        arena.get_mut(text).expect("text node").layout = nui_core::LayoutRect {
            x: 8.0,
            y: 4.0,
            width: 64.0,
            height: 32.0,
        };
        let display_list =
            DisplayList::try_from_arena_with_glyph_runs(&arena, text, |_, _, _, _, _, _| {
                Ok::<_, std::convert::Infallible>(Vec::new())
            })
            .expect("production text display list");
        let hints = PaintHints {
            focused: Some(FocusedPaint {
                text_node: text,
                caret_rect: None,
                selection_rects: vec![nui_core::LayoutRect {
                    x: 4.0,
                    y: 2.0,
                    width: 20.0,
                    height: 20.0,
                }],
            }),
            ..PaintHints::default()
        };
        let mut pixels = vec![0_u32; 64 * 32];

        paint_display_list(&display_list, &mut pixels, 64, 32, 1.0, Some(&hints))
            .expect("paint focused selection");

        assert_ne!(pixels[10 * 64 + 12], 0xfff4f6f8);
        assert_eq!(pixels[2 * 64 + 4], 0xfff4f6f8);
    }

    #[test]
    fn paint_display_list_executes_backend_neutral_glyph_run() {
        let mut arena = Arena::new();
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "A");
        arena.get_mut(text).unwrap().layout = nui_core::LayoutRect {
            width: 48.0,
            height: 48.0,
            ..nui_core::LayoutRect::default()
        };
        let typeface = FontMgr::new()
            .new_from_data(font_test_data::AHEM, 0)
            .expect("Ahem typeface");
        let font = Font::from_typeface(typeface, 32.0);
        let glyph_id = font.text_to_glyphs_vec("A")[0];
        let list = nui_core::DisplayList::try_from_arena_with_glyph_runs(
            &arena,
            text,
            |_, _, rect, color, font_size, _| {
                Ok::<_, std::convert::Infallible>(vec![GlyphRun {
                    font_id: 42,
                    font_size,
                    color,
                    glyphs: vec![DisplayGlyph {
                        glyph_id,
                        x: rect.x,
                        y: rect.y + 30.0,
                    }],
                }])
            },
        )
        .unwrap();
        let hints = PaintHints {
            fonts: vec![FontPaint {
                font_id: 42,
                bytes: Arc::<[u8]>::from(font_test_data::AHEM),
                face_index: 0,
            }],
            ..PaintHints::default()
        };
        let mut pixels = vec![0_u32; 48 * 48];
        paint_display_list(&list, &mut pixels, 48, 48, 1.0, Some(&hints)).expect("glyph paint");
        assert!(pixels.iter().any(|&pixel| pixel != 0xfff4f6f8));
    }

    fn glyph_run_display_list(run: GlyphRun) -> DisplayList {
        let mut arena = Arena::new();
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "A");
        arena.get_mut(text).expect("text node").layout = nui_core::LayoutRect {
            width: 64.0,
            height: 64.0,
            ..nui_core::LayoutRect::default()
        };
        DisplayList::try_from_arena_with_glyph_runs(&arena, text, |_, _, _, _, _, _| {
            Ok::<_, std::convert::Infallible>(vec![run.clone()])
        })
        .expect("glyph display list")
    }

    fn ahem_glyph_id() -> skia_safe::GlyphId {
        let typeface = FontMgr::new()
            .new_from_data(font_test_data::AHEM, 0)
            .expect("Ahem typeface");
        Font::from_typeface(typeface, 10.0).text_to_glyphs_vec("A")[0]
    }

    fn ahem_hints(font_id: u64) -> PaintHints {
        PaintHints {
            fonts: vec![FontPaint {
                font_id,
                bytes: Arc::<[u8]>::from(font_test_data::AHEM),
                face_index: 0,
            }],
            ..PaintHints::default()
        }
    }

    #[test]
    fn paint_glyph_run_scales_logical_geometry_at_two_x() {
        let font_id = 42;
        let list = glyph_run_display_list(GlyphRun {
            font_id,
            font_size: 10.0,
            color: ColorRgba::rgb(0x11, 0x18, 0x27),
            glyphs: vec![DisplayGlyph {
                glyph_id: ahem_glyph_id(),
                x: 7.0,
                y: 18.0,
            }],
        });
        let hints = ahem_hints(font_id);
        let mut one_x = vec![0_u32; 32 * 32];
        let mut two_x = vec![0_u32; 64 * 64];

        paint_display_list(&list, &mut one_x, 32, 32, 1.0, Some(&hints))
            .expect("paint glyph at 1x");
        paint_display_list(&list, &mut two_x, 64, 64, 2.0, Some(&hints))
            .expect("paint glyph at 2x");

        assert_ne!(one_x[15 * 32 + 12], 0xfff4f6f8);
        assert_ne!(two_x[30 * 64 + 24], 0xfff4f6f8);
        assert_ne!(two_x[30 * 64 + 31], 0xfff4f6f8);
        assert_eq!(two_x[15 * 64 + 12], 0xfff4f6f8);
        assert_eq!(two_x[30 * 64 + 38], 0xfff4f6f8);
    }

    #[test]
    fn paint_glyph_run_rejects_missing_font_resource() {
        let list = glyph_run_display_list(GlyphRun {
            font_id: 404,
            font_size: 10.0,
            color: ColorRgba::rgb(0x11, 0x18, 0x27),
            glyphs: vec![DisplayGlyph {
                glyph_id: ahem_glyph_id(),
                x: 7.0,
                y: 18.0,
            }],
        });
        let mut pixels = vec![0_u32; 32 * 32];

        let error = paint_display_list(&list, &mut pixels, 32, 32, 1.0, None)
            .expect_err("missing font resource must fail");

        assert!(matches!(error, PaintError::MissingFontResource(404)));
    }

    #[test]
    fn paint_glyph_run_rejects_invalid_font_bytes() {
        let font_id = 43;
        let list = glyph_run_display_list(GlyphRun {
            font_id,
            font_size: 10.0,
            color: ColorRgba::rgb(0x11, 0x18, 0x27),
            glyphs: vec![DisplayGlyph {
                glyph_id: 1,
                x: 7.0,
                y: 18.0,
            }],
        });
        let hints = PaintHints {
            fonts: vec![FontPaint {
                font_id,
                bytes: Arc::<[u8]>::from(&b"not a font"[..]),
                face_index: 0,
            }],
            ..PaintHints::default()
        };
        let mut pixels = vec![0_u32; 32 * 32];

        let error = paint_display_list(&list, &mut pixels, 32, 32, 1.0, Some(&hints))
            .expect_err("invalid font bytes must fail");

        assert!(matches!(error, PaintError::InvalidFontResource(43)));
    }

    #[test]
    fn paint_glyph_run_rejects_non_finite_positions() {
        let font_id = 44;
        let hints = ahem_hints(font_id);
        for (x, y) in [(f32::NAN, 18.0), (7.0, f32::INFINITY)] {
            let list = glyph_run_display_list(GlyphRun {
                font_id,
                font_size: 10.0,
                color: ColorRgba::rgb(0x11, 0x18, 0x27),
                glyphs: vec![DisplayGlyph {
                    glyph_id: ahem_glyph_id(),
                    x,
                    y,
                }],
            });
            let mut pixels = vec![0_u32; 32 * 32];

            let error = paint_display_list(&list, &mut pixels, 32, 32, 1.0, Some(&hints))
                .expect_err("non-finite glyph position must fail");

            assert!(matches!(error, PaintError::InvalidGlyphGeometry(44)));
        }
    }

    #[test]
    fn backend_resource_cache_reuploads_after_release_and_generation_change() {
        let resource_id = ResourceId::new(0, 1);
        let mut arena = Arena::new();
        let image = arena.create(NodeType::Image);
        arena.get_mut(image).expect("image").layout = nui_core::LayoutRect {
            width: 8.0,
            height: 8.0,
            ..nui_core::LayoutRect::default()
        };
        arena.set_image_resource(image, Some(resource_id));
        let list = DisplayList::from_arena(&arena, image);
        let hints = PaintHints {
            images: vec![ImagePaint {
                resource_id,
                width: 1,
                height: 1,
                pixels: Arc::from(vec![0xffff0000]),
            }],
            ..PaintHints::default()
        };
        let mut pixels = vec![0_u32; 8 * 8];
        let mut cache = BackendResourceCache::new();
        cache.set_surface_generation(SurfaceGeneration::new(1));

        paint_display_list_with_cache(&list, &mut pixels, 8, 8, 1.0, Some(&hints), &mut cache)
            .unwrap();
        paint_display_list_with_cache(&list, &mut pixels, 8, 8, 1.0, Some(&hints), &mut cache)
            .unwrap();
        assert_eq!(cache.image_upload_count(), 1);
        assert_eq!(cache.cached_image_count(), 1);

        cache.release_surface_resources();
        assert_eq!(cache.cached_image_count(), 0);
        paint_display_list_with_cache(&list, &mut pixels, 8, 8, 1.0, Some(&hints), &mut cache)
            .unwrap();
        assert_eq!(cache.image_upload_count(), 2);
        assert_eq!(cache.cached_image_count(), 1);

        cache.set_surface_generation(SurfaceGeneration::new(2));
        paint_display_list_with_cache(&list, &mut pixels, 8, 8, 1.0, Some(&hints), &mut cache)
            .unwrap();
        assert_eq!(cache.image_upload_count(), 3);
    }

    #[test]
    fn backend_font_cache_reuploads_after_release_and_generation_change() {
        let font_id = 42;
        let list = glyph_run_display_list(GlyphRun {
            font_id,
            font_size: 10.0,
            color: ColorRgba::rgb(0x11, 0x18, 0x27),
            glyphs: vec![DisplayGlyph {
                glyph_id: ahem_glyph_id(),
                x: 7.0,
                y: 18.0,
            }],
        });
        let hints = ahem_hints(font_id);
        let mut pixels = vec![0_u32; 32 * 32];
        let mut cache = BackendResourceCache::new();
        cache.set_surface_generation(SurfaceGeneration::new(1));

        paint_display_list_with_cache(&list, &mut pixels, 32, 32, 1.0, Some(&hints), &mut cache)
            .expect("first font upload");
        paint_display_list_with_cache(&list, &mut pixels, 32, 32, 1.0, Some(&hints), &mut cache)
            .expect("reuse cached font");
        assert_eq!(cache.font_upload_count(), 1);
        assert_eq!(cache.cached_font_count(), 1);

        cache.release_surface_resources();
        assert_eq!(cache.cached_font_count(), 0);
        paint_display_list_with_cache(&list, &mut pixels, 32, 32, 1.0, Some(&hints), &mut cache)
            .expect("re-upload font after suspend");
        assert_eq!(cache.font_upload_count(), 2);
        assert_eq!(cache.cached_font_count(), 1);

        cache.set_surface_generation(SurfaceGeneration::new(2));
        paint_display_list_with_cache(&list, &mut pixels, 32, 32, 1.0, Some(&hints), &mut cache)
            .expect("upload font for replacement surface");
        assert_eq!(cache.font_upload_count(), 3);
    }
}

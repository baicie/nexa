//! Backend-neutral glyph shaping over shared font resources.

use std::error::Error;
use std::fmt;

use harfrust::{BufferClusterLevel, Direction, ShapeOptions, ShaperData, UnicodeBuffer};
use unicode_script::Script;
use unicode_segmentation::UnicodeSegmentation;

use crate::bidi::{itemize_script, resolve_bidi, ScriptRun, TextDirection};
use crate::font_database::{FontDatabase, FontId};
use crate::font_fallback::FontRequest;
use crate::types::{Utf8Offset, Utf8Range};
use crate::TextIndexMap;

/// Two-dimensional distance in logical pixels (positive Y points down).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct GlyphVector {
    pub x: f32,
    pub y: f32,
}

/// Per-glyph movement and offset in logical pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct GlyphPosition {
    pub x_advance: f32,
    pub y_advance: f32,
    pub x_offset: f32,
    pub y_offset: f32,
}

/// One shaped glyph with an absolute UTF-8 source cluster.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShapedGlyph {
    pub glyph_id: u16,
    pub cluster_utf8: Utf8Offset,
    pub position: GlyphPosition,
    pub unsafe_to_break: bool,
}

/// Glyphs sharing one font, script, direction, size, and logical source range.
#[derive(Debug, Clone, PartialEq)]
pub struct ShapedRun {
    pub range: Utf8Range,
    pub font_id: FontId,
    pub font_size: f32,
    pub direction: TextDirection,
    pub script: Script,
    pub glyphs: Vec<ShapedGlyph>,
    pub advance: GlyphVector,
}

/// Visual-order runs for one resolved Unicode paragraph.
#[derive(Debug, Clone, PartialEq)]
pub struct ShapedParagraph {
    pub range: Utf8Range,
    pub base_direction: TextDirection,
    pub runs: Vec<ShapedRun>,
}

/// Shaping output preserving Unicode paragraph boundaries.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShapedText {
    pub paragraphs: Vec<ShapedParagraph>,
}

/// Validated request for one font/script/direction run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShapeRequest {
    range: Utf8Range,
    font_id: FontId,
    font_size: f32,
    direction: TextDirection,
    script: Script,
}

impl ShapeRequest {
    pub fn new(
        range: Utf8Range,
        font_id: FontId,
        font_size: f32,
        direction: TextDirection,
        script: Script,
    ) -> Result<Self, ShapeError> {
        validate_font_size(font_size)?;
        if range.source_len() > u32::MAX as usize {
            return Err(ShapeError::SourceTooLong {
                source_len: range.source_len(),
            });
        }
        Ok(Self {
            range,
            font_id,
            font_size,
            direction,
            script,
        })
    }
}

/// Shaping failure with enough range and font context to diagnose the boundary.
#[derive(Debug, Clone, PartialEq)]
pub enum ShapeError {
    InvalidFontSize {
        font_size: f32,
    },
    SourceTooLong {
        source_len: usize,
    },
    RangeSourceLengthMismatch {
        range: Utf8Range,
        actual_source_len: usize,
    },
    RangeNotGraphemeAligned {
        range: Utf8Range,
    },
    MissingFont {
        font_id: FontId,
    },
    MissingFontSource {
        font_id: FontId,
    },
    InvalidFontSource {
        font_id: FontId,
    },
    MissingGlyph {
        range: Utf8Range,
    },
    NonFinitePosition {
        font_id: FontId,
        range: Utf8Range,
    },
}

impl fmt::Display for ShapeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFontSize { font_size } => {
                write!(
                    formatter,
                    "font size must be finite and positive, got {font_size}"
                )
            }
            Self::SourceTooLong { source_len } => write!(
                formatter,
                "UTF-8 source length {source_len} exceeds shaping cluster capacity"
            ),
            Self::RangeSourceLengthMismatch {
                range,
                actual_source_len,
            } => write!(
                formatter,
                "shape range was validated against {} source bytes, got {actual_source_len}",
                range.source_len(),
            ),
            Self::RangeNotGraphemeAligned { range } => write!(
                formatter,
                "shape range {}..{} is not grapheme aligned",
                range.start().get(),
                range.end().get()
            ),
            Self::MissingFont { font_id } => {
                write!(formatter, "font {} is not registered", font_id.get())
            }
            Self::MissingFontSource { font_id } => write!(
                formatter,
                "font {} has metadata but no shared source",
                font_id.get()
            ),
            Self::InvalidFontSource { font_id } => {
                write!(
                    formatter,
                    "font {} source is no longer parseable",
                    font_id.get()
                )
            }
            Self::MissingGlyph { range } => write!(
                formatter,
                "no single font covers UTF-8 cluster {}..{}",
                range.start().get(),
                range.end().get()
            ),
            Self::NonFinitePosition { font_id, range } => write!(
                formatter,
                "font {} produced non-finite glyph metrics for UTF-8 range {}..{}",
                font_id.get(),
                range.start().get(),
                range.end().get()
            ),
        }
    }
}

impl Error for ShapeError {}

/// Shapes one already-itemized logical run.
pub fn shape_run(
    database: &FontDatabase,
    text: &str,
    request: ShapeRequest,
) -> Result<ShapedRun, ShapeError> {
    let run_text = request
        .range
        .slice(text)
        .ok_or(ShapeError::RangeSourceLengthMismatch {
            range: request.range,
            actual_source_len: text.len(),
        })?;
    let index_map = TextIndexMap::new(text);
    if index_map
        .utf8_to_grapheme(request.range.start().get())
        .is_none()
        || index_map
            .utf8_to_grapheme(request.range.end().get())
            .is_none()
    {
        return Err(ShapeError::RangeNotGraphemeAligned {
            range: request.range,
        });
    }

    let descriptor = database
        .face(request.font_id)
        .ok_or(ShapeError::MissingFont {
            font_id: request.font_id,
        })?;
    let source = descriptor.source().ok_or(ShapeError::MissingFontSource {
        font_id: request.font_id,
    })?;
    let font = source.font_ref().ok_or(ShapeError::InvalidFontSource {
        font_id: request.font_id,
    })?;

    let mut buffer = UnicodeBuffer::new();
    buffer.set_direction(match request.direction {
        TextDirection::LeftToRight => Direction::LeftToRight,
        TextDirection::RightToLeft => Direction::RightToLeft,
    });
    buffer.set_script(
        request
            .script
            .short_name()
            .parse()
            .unwrap_or(harfrust::script::UNKNOWN),
    );
    buffer.set_cluster_level(BufferClusterLevel::MonotoneGraphemes);
    for (relative_start, grapheme) in run_text.grapheme_indices(true) {
        let cluster =
            u32::try_from(request.range.start().get() + relative_start).map_err(|_| {
                ShapeError::SourceTooLong {
                    source_len: text.len(),
                }
            })?;
        for character in grapheme.chars() {
            buffer.add(character, cluster);
        }
    }

    let shaper_data = ShaperData::new(&font);
    let shaper = shaper_data.shaper(&font).build();
    let upem = shaper.units_per_em() as f32;
    let scale = request.font_size / upem;
    let glyph_buffer = shaper.shape(buffer, ShapeOptions::default());
    let mut advance = GlyphVector::default();
    let glyphs = glyph_buffer
        .glyph_infos()
        .iter()
        .zip(glyph_buffer.glyph_positions())
        .map(|(info, position)| {
            let glyph_id = info.glyph_id as u16;
            let cluster = info.cluster as usize;
            if glyph_id == 0
                || cluster < request.range.start().get()
                || cluster >= request.range.end().get()
            {
                return Err(ShapeError::MissingGlyph {
                    range: request.range,
                });
            }
            let position = GlyphPosition {
                x_advance: position.x_advance as f32 * scale,
                y_advance: -(position.y_advance as f32) * scale,
                x_offset: position.x_offset as f32 * scale,
                y_offset: -(position.y_offset as f32) * scale,
            };
            if !position.x_advance.is_finite()
                || !position.y_advance.is_finite()
                || !position.x_offset.is_finite()
                || !position.y_offset.is_finite()
            {
                return Err(ShapeError::NonFinitePosition {
                    font_id: request.font_id,
                    range: request.range,
                });
            }
            advance.x += position.x_advance;
            advance.y += position.y_advance;
            if !advance.x.is_finite() || !advance.y.is_finite() {
                return Err(ShapeError::NonFinitePosition {
                    font_id: request.font_id,
                    range: request.range,
                });
            }
            Ok(ShapedGlyph {
                glyph_id,
                cluster_utf8: Utf8Offset::validated(cluster, text.len()),
                position,
                unsafe_to_break: info.unsafe_to_break(),
            })
        })
        .collect::<Result<Vec<_>, ShapeError>>()?;

    Ok(ShapedRun {
        range: request.range,
        font_id: request.font_id,
        font_size: request.font_size,
        direction: request.direction,
        script: request.script,
        glyphs,
        advance,
    })
}

/// Itemizes, resolves BiDi, applies grapheme fallback, and shapes visual runs.
pub fn shape_text(
    database: &FontDatabase,
    text: &str,
    request: &FontRequest,
    font_size: f32,
    default_direction: Option<TextDirection>,
) -> Result<ShapedText, ShapeError> {
    validate_font_size(font_size)?;
    if text.len() > u32::MAX as usize {
        return Err(ShapeError::SourceTooLong {
            source_len: text.len(),
        });
    }
    let script_runs = itemize_script(text);
    let bidi_paragraphs = resolve_bidi(text, default_direction);
    let mut paragraphs = Vec::with_capacity(bidi_paragraphs.len());

    for paragraph in bidi_paragraphs {
        let mut shaped_runs = Vec::new();
        for bidi_run in &paragraph.visual_runs {
            let mut segments = font_segments(
                database,
                text,
                request,
                &script_runs,
                bidi_run.range,
                bidi_run.direction,
            )?;
            if bidi_run.direction == TextDirection::RightToLeft {
                segments.reverse();
            }
            for segment in segments {
                shaped_runs.push(shape_run(
                    database,
                    text,
                    ShapeRequest::new(
                        segment.range,
                        segment.font_id,
                        font_size,
                        segment.direction,
                        segment.script,
                    )?,
                )?);
            }
        }
        paragraphs.push(ShapedParagraph {
            range: paragraph.range,
            base_direction: paragraph.base_direction,
            runs: shaped_runs,
        });
    }

    Ok(ShapedText { paragraphs })
}

#[derive(Debug, Clone, Copy)]
struct FontSegment {
    range: Utf8Range,
    font_id: FontId,
    direction: TextDirection,
    script: Script,
}

fn font_segments(
    database: &FontDatabase,
    text: &str,
    request: &FontRequest,
    script_runs: &[ScriptRun],
    bidi_range: Utf8Range,
    direction: TextDirection,
) -> Result<Vec<FontSegment>, ShapeError> {
    let mut segments: Vec<FontSegment> = Vec::new();
    for script_run in script_runs {
        let Some(range) = bidi_range.intersection(script_run.range) else {
            continue;
        };
        let run_text = range
            .slice(text)
            .ok_or(ShapeError::RangeSourceLengthMismatch {
                range,
                actual_source_len: text.len(),
            })?;
        let script_request = request.clone().with_script(script_run.script);
        for (relative_start, grapheme) in run_text.grapheme_indices(true) {
            if grapheme.chars().all(is_paragraph_separator) {
                continue;
            }
            let start = range.start().get() + relative_start;
            let cluster_range = Utf8Range::validated(start, start + grapheme.len(), text.len());
            let font_id = database
                .fallback_for_cluster(&script_request, grapheme)
                .ok_or(ShapeError::MissingGlyph {
                    range: cluster_range,
                })?;
            if let Some(previous) = segments.last_mut() {
                if previous.font_id == font_id
                    && previous.script == script_run.script
                    && previous.direction == direction
                    && previous.range.end().get() == start
                {
                    previous.range = Utf8Range::validated(
                        previous.range.start().get(),
                        cluster_range.end().get(),
                        text.len(),
                    );
                    continue;
                }
            }
            segments.push(FontSegment {
                range: cluster_range,
                font_id,
                direction,
                script: script_run.script,
            });
        }
    }
    Ok(segments)
}

fn validate_font_size(font_size: f32) -> Result<(), ShapeError> {
    if font_size.is_finite() && font_size > 0.0 {
        Ok(())
    } else {
        Err(ShapeError::InvalidFontSize { font_size })
    }
}

fn is_paragraph_separator(character: char) -> bool {
    matches!(
        character,
        '\n' | '\r' | '\u{000b}' | '\u{000c}' | '\u{0085}' | '\u{2028}' | '\u{2029}'
    )
}

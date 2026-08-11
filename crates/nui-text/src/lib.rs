//! Backend-neutral text contracts for indexing, font matching, shaping, and paragraphs.
//!
//! Font discovery backends register validated face metadata and glyph coverage in
//! [`FontDatabase`]. Immutable paragraph snapshots preserve the source offsets consumed by
//! later layout, hit testing, and rendering stages.

pub mod bidi;
pub mod editable_text;
pub mod font_database;
pub mod font_fallback;
pub mod keyboard;
pub mod line_breaking;
pub mod paragraph;
pub mod selection;
pub mod shaping;
pub mod system_fonts;
pub mod text_area;
pub mod types;

pub use bidi::{itemize_script, resolve_bidi, BidiParagraph, BidiRun, ScriptRun, TextDirection};
pub use editable_text::{GraphemeBoundary, TextIndexMap};
pub use font_database::{
    FontDatabase, FontDatabaseError, FontDatabaseRevision, FontFaceDescriptor, FontId, FontSlant,
    FontSource, FontSourceError, FontStretch, FontStyle, FontWeight, GlyphCoverage, UnicodeRange,
};
pub use font_fallback::FontRequest;
pub use keyboard::{CommandOutcome, KeyCommand, KeyModifiers, NavigationKey};
pub use line_breaking::{line_break_opportunities, LineBreakKind, LineBreakOpportunity};
pub use paragraph::{
    layout_paragraph, CaretAffinity, CaretStop, ClusterMapEntry, HorizontalDirection, LineMetrics,
    ParagraphError, ParagraphLine, ParagraphSnapshot, ParagraphStyle, ParagraphWidth,
    PositionedGlyph, PositionedRun, TextHit, TextRect, TextSize,
};
pub use selection::{
    CompositionRange, EditError, EditableText, GraphemeIndex, GraphemeRange, TextSelection,
    Utf16Range, Utf16Selection,
};
pub use shaping::{
    shape_run, shape_text, GlyphPosition, GlyphVector, ShapeError, ShapeRequest, ShapedGlyph,
    ShapedParagraph, ShapedRun, ShapedText,
};
pub use system_fonts::{system_font_database, SystemFontError};
pub use text_area::{TextAreaController, VerticalDirection};
pub use types::{Utf8Offset, Utf8Range, Utf8RangeError};
pub use unicode_script::Script;

/// Acceptance strings for the first real text slice (ADR-006).
pub const ACCEPTANCE_SAMPLES: &[&str] = &[
    "Hello, Nexa",
    "你好，Nexa UI",
    "مرحباً بالعالم",
    "👨‍👩‍👧‍👦 ❤️ 🧑🏽‍💻",
    "English 中文 mixed text",
];

#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acceptance_samples_non_empty() {
        assert_eq!(ACCEPTANCE_SAMPLES.len(), 5);
        assert!(ACCEPTANCE_SAMPLES.iter().all(|s| !s.is_empty()));
    }
}

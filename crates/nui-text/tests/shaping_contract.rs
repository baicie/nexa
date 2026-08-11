use std::sync::Arc;

use nui_text::{
    shape_run, shape_text, FontDatabase, FontFaceDescriptor, FontRequest, FontSource,
    FontSourceError, FontStyle, GlyphCoverage, Script, ShapeError, ShapeRequest, TextDirection,
    TextIndexMap, Utf8Range,
};

const NOTO_SANS_ARABIC: &[u8] = include_bytes!("fixtures/NotoSansArabic.ttf");

fn source(bytes: &[u8], face_index: u32) -> Result<FontSource, FontSourceError> {
    FontSource::new(Arc::<[u8]>::from(bytes), face_index)
}

fn register_source_face(
    database: &mut FontDatabase,
    family: &str,
    script: Script,
    characters: &str,
    bytes: &[u8],
) -> nui_text::FontId {
    database.register_face(
        FontFaceDescriptor::new(
            family,
            FontStyle::default(),
            GlyphCoverage::from_chars(characters.chars()),
        )
        .expect("fixture descriptor")
        .with_scripts([script])
        .with_source(source(bytes, 0).expect("fixture face must parse")),
    )
}

#[test]
fn font_source_rejects_corrupt_bytes_and_invalid_collection_index() {
    assert!(matches!(
        source(b"not a font", 0),
        Err(FontSourceError::InvalidFace { face_index: 0 })
    ));
    assert!(matches!(
        source(font_test_data::NOTOSERIF_AUTOHINT_SHAPING, 1),
        Err(FontSourceError::InvalidFace { face_index: 1 })
    ));
    assert!(source(font_test_data::ttc::TTC, 0).is_ok());
    assert!(source(font_test_data::ttc::TTC, 1).is_ok());
    assert!(matches!(
        source(font_test_data::ttc::TTC, 2),
        Err(FontSourceError::InvalidFace { face_index: 2 })
    ));
}

#[test]
fn harfrust_shapes_ligatures_with_absolute_utf8_clusters_and_logical_pixels() {
    let mut database = FontDatabase::new();
    let font = register_source_face(
        &mut database,
        "Noto Serif Fixture",
        Script::Latin,
        "Hfix",
        font_test_data::NOTOSERIF_AUTOHINT_SHAPING,
    );
    let text = "fi";
    let request = ShapeRequest::new(
        Utf8Range::new(text, 0, text.len()).unwrap(),
        font,
        16.0,
        TextDirection::LeftToRight,
        Script::Latin,
    )
    .unwrap();

    let run = shape_run(&database, text, request).expect("fixture shapes");

    assert_eq!(run.glyphs.len(), 1, "default liga must combine fi");
    assert_eq!(run.glyphs[0].cluster_utf8.get(), 0);
    assert!(run.glyphs[0].glyph_id > 0);
    assert!(run.glyphs[0].position.x_advance > 0.0);
    assert!(run.advance.x.is_finite() && run.advance.x > 0.0);
    assert_eq!(run.range.slice(text), Some(text));
}

#[test]
fn cjk_fixture_shapes_with_absolute_grapheme_clusters() {
    let mut database = FontDatabase::new();
    let font = register_source_face(
        &mut database,
        "Noto Serif TC Fixture",
        Script::Han,
        "你們",
        font_test_data::NOTOSERIFTC_AUTOHINT_METRICS,
    );
    let text = "A你們";
    let run = shape_run(
        &database,
        text,
        ShapeRequest::new(
            Utf8Range::new(text, 1, text.len()).unwrap(),
            font,
            18.0,
            TextDirection::LeftToRight,
            Script::Han,
        )
        .unwrap(),
    )
    .expect("CJK fixture shapes");

    assert_eq!(run.glyphs.len(), 2);
    assert_eq!(
        run.glyphs
            .iter()
            .map(|glyph| glyph.cluster_utf8.get())
            .collect::<Vec<_>>(),
        vec![1, 1 + "你".len()]
    );
    assert!(run.glyphs.iter().all(|glyph| glyph.glyph_id > 0));
    assert!(run.advance.x.is_finite() && run.advance.x > 0.0);
}

#[test]
fn arabic_joining_and_combining_marks_preserve_grapheme_clusters() {
    let mut database = FontDatabase::new();
    let font = register_source_face(
        &mut database,
        "Noto Sans Arabic Fixture",
        Script::Arabic,
        "مَر",
        NOTO_SANS_ARABIC,
    );

    let shape = |text: &str| {
        shape_run(
            &database,
            text,
            ShapeRequest::new(
                Utf8Range::new(text, 0, text.len()).unwrap(),
                font,
                20.0,
                TextDirection::RightToLeft,
                Script::Arabic,
            )
            .unwrap(),
        )
        .expect("Arabic fixture shapes")
    };

    let isolated = shape("م");
    let joined = shape("مم");
    assert_eq!(isolated.glyphs.len(), 1);
    assert_eq!(joined.glyphs.len(), 2);
    assert!(joined
        .glyphs
        .iter()
        .any(|glyph| glyph.glyph_id != isolated.glyphs[0].glyph_id));

    let combined_text = "م\u{64e}ر";
    let combined = shape(combined_text);
    let index_map = TextIndexMap::new(combined_text);
    for glyph in &combined.glyphs {
        assert!(index_map
            .utf8_to_grapheme(glyph.cluster_utf8.get())
            .is_some());
        assert!(glyph.position.x_advance.is_finite());
        assert!(glyph.position.x_offset.is_finite());
        assert!(glyph.position.y_offset.is_finite());
    }
}

#[test]
fn cluster_fallback_keeps_zwj_variation_and_skin_tone_sequences_atomic() {
    let mut database = FontDatabase::new();
    let base_only = database.register_face(
        FontFaceDescriptor::new(
            "Base Emoji",
            FontStyle::default(),
            GlyphCoverage::from_chars("👨👍".chars()),
        )
        .unwrap(),
    );
    let complete = database.register_face(
        FontFaceDescriptor::new(
            "Complete Emoji",
            FontStyle::default(),
            GlyphCoverage::from_chars("👨👩👧👦👍🏽❤".chars()),
        )
        .unwrap(),
    );
    let request = FontRequest::new(["Base Emoji", "Complete Emoji"]);

    assert_eq!(
        database.fallback_for_cluster(&request, "👨‍👩‍👧‍👦"),
        Some(complete)
    );
    assert_eq!(
        database.fallback_for_cluster(&request, "👍🏽"),
        Some(complete)
    );
    assert_eq!(
        database.fallback_for_cluster(&request, "❤️"),
        Some(complete)
    );
    assert_ne!(
        database.fallback_for_cluster(&request, "👍🏽"),
        Some(base_only)
    );
}

#[test]
fn emoji_modifier_variation_and_zwj_shape_as_one_source_cluster() {
    let mut database = FontDatabase::new();
    let text = "✍🏽‍✍️";
    let font = register_source_face(
        &mut database,
        "Noto Handwriting Fixture",
        Script::Common,
        text,
        font_test_data::NOTO_HANDWRITING_SBIX,
    );
    let run = shape_run(
        &database,
        text,
        ShapeRequest::new(
            Utf8Range::new(text, 0, text.len()).unwrap(),
            font,
            20.0,
            TextDirection::LeftToRight,
            Script::Common,
        )
        .unwrap(),
    )
    .expect("Emoji fixture shapes");

    assert_eq!(TextIndexMap::new(text).grapheme_count(), 1);
    assert!(!run.glyphs.is_empty());
    assert!(run.glyphs.iter().all(|glyph| {
        glyph.glyph_id > 0
            && glyph.cluster_utf8.get() == 0
            && glyph.position.x_advance.is_finite()
            && glyph.position.x_offset.is_finite()
            && glyph.position.y_offset.is_finite()
    }));
}

#[test]
fn shaping_rejects_sizes_that_cannot_produce_finite_positions() {
    let mut database = FontDatabase::new();
    let font = register_source_face(
        &mut database,
        "Ahem Fixture",
        Script::Latin,
        "A",
        font_test_data::AHEM,
    );
    let text = "AAAA";
    let range = Utf8Range::new(text, 0, text.len()).unwrap();

    for invalid in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        assert!(matches!(
            ShapeRequest::new(
                range,
                font,
                invalid,
                TextDirection::LeftToRight,
                Script::Latin,
            ),
            Err(ShapeError::InvalidFontSize { .. })
        ));
    }

    let request = ShapeRequest::new(
        range,
        font,
        f32::MAX,
        TextDirection::LeftToRight,
        Script::Latin,
    )
    .expect("a finite positive size passes request validation");
    assert!(matches!(
        shape_run(&database, text, request),
        Err(ShapeError::NonFinitePosition { font_id, range: error_range })
            if font_id == font && error_range == range
    ));

    let request = FontRequest::new(["Ahem Fixture"]);
    assert!(matches!(
        shape_text(&database, "", &request, f32::NAN, None),
        Err(ShapeError::InvalidFontSize { .. })
    ));
}

#[test]
fn shape_run_reports_range_alignment_source_and_font_failures() {
    let mut database = FontDatabase::new();
    let font = register_source_face(
        &mut database,
        "Ahem Fixture",
        Script::Latin,
        "Ae",
        font_test_data::AHEM,
    );

    let wrong_source_range = Utf8Range::new("AB", 0, 2).unwrap();
    let wrong_source = shape_run(
        &database,
        "A",
        ShapeRequest::new(
            wrong_source_range,
            font,
            16.0,
            TextDirection::LeftToRight,
            Script::Latin,
        )
        .unwrap(),
    );
    assert!(matches!(
        wrong_source,
        Err(ShapeError::RangeSourceLengthMismatch {
            actual_source_len: 1,
            ..
        })
    ));

    let combined = "e\u{301}";
    let inside_grapheme = Utf8Range::new(combined, 0, 1).unwrap();
    let unaligned = shape_run(
        &database,
        combined,
        ShapeRequest::new(
            inside_grapheme,
            font,
            16.0,
            TextDirection::LeftToRight,
            Script::Latin,
        )
        .unwrap(),
    );
    assert!(matches!(
        unaligned,
        Err(ShapeError::RangeNotGraphemeAligned { .. })
    ));

    assert!(database.remove_face(font).is_some());
    let missing_font = shape_run(
        &database,
        "A",
        ShapeRequest::new(
            Utf8Range::new("A", 0, 1).unwrap(),
            font,
            16.0,
            TextDirection::LeftToRight,
            Script::Latin,
        )
        .unwrap(),
    );
    assert!(matches!(
        missing_font,
        Err(ShapeError::MissingFont { font_id }) if font_id == font
    ));
}

#[test]
fn shape_text_preserves_empty_and_hard_break_ranges_and_reports_missing_glyphs() {
    let mut database = FontDatabase::new();
    register_source_face(
        &mut database,
        "Ahem Fixture",
        Script::Latin,
        "A",
        font_test_data::AHEM,
    );
    let request = FontRequest::new(["Ahem Fixture"]);

    assert!(shape_text(&database, "", &request, 16.0, None)
        .unwrap()
        .paragraphs
        .is_empty());

    let newline = shape_text(&database, "\n", &request, 16.0, None).unwrap();
    assert_eq!(newline.paragraphs.len(), 1);
    assert_eq!(newline.paragraphs[0].range.slice("\n"), Some("\n"));
    assert!(newline.paragraphs[0].runs.is_empty());

    let missing = shape_text(&database, "B", &request, 16.0, None);
    assert!(matches!(
        missing,
        Err(ShapeError::MissingGlyph { range }) if range.slice("B") == Some("B")
    ));
}

#[test]
fn shape_run_accepts_an_empty_grapheme_aligned_range() {
    let mut database = FontDatabase::new();
    let font = register_source_face(
        &mut database,
        "Ahem Fixture",
        Script::Latin,
        "A",
        font_test_data::AHEM,
    );
    let text = "A";
    let run = shape_run(
        &database,
        text,
        ShapeRequest::new(
            Utf8Range::new(text, 1, 1).unwrap(),
            font,
            16.0,
            TextDirection::LeftToRight,
            Script::Latin,
        )
        .unwrap(),
    )
    .expect("empty aligned ranges are valid");

    assert!(run.glyphs.is_empty());
    assert_eq!(run.advance.x, 0.0);
    assert_eq!(run.advance.y, 0.0);
}

#[test]
fn shape_text_returns_visual_runs_and_reports_missing_font_sources() {
    let text = "مرحبا";
    let mut database = FontDatabase::new();
    let font = register_source_face(
        &mut database,
        "Noto Sans Arabic Fixture",
        Script::Arabic,
        text,
        NOTO_SANS_ARABIC,
    );
    let request = FontRequest::new(["Noto Sans Arabic Fixture"]);

    let shaped = shape_text(&database, text, &request, 18.0, None).expect("text shapes");
    let paragraph = shaped.paragraphs.first().expect("one paragraph");
    assert_eq!(paragraph.base_direction, TextDirection::RightToLeft);
    assert_eq!(paragraph.range.slice(text), Some(text));
    assert!(paragraph.runs.iter().all(|run| run.font_id == font));
    assert!(paragraph
        .runs
        .iter()
        .all(|run| run.direction == TextDirection::RightToLeft));
    assert!(paragraph
        .runs
        .iter()
        .flat_map(|run| &run.glyphs)
        .all(|glyph| glyph.glyph_id > 0));

    let metadata_only = database.register_face(
        FontFaceDescriptor::new(
            "Metadata Only",
            FontStyle::default(),
            GlyphCoverage::from_chars("A".chars()),
        )
        .unwrap(),
    );
    let missing_source = shape_run(
        &database,
        "A",
        ShapeRequest::new(
            Utf8Range::new("A", 0, 1).unwrap(),
            metadata_only,
            16.0,
            TextDirection::LeftToRight,
            Script::Latin,
        )
        .unwrap(),
    );
    assert!(matches!(
        missing_source,
        Err(ShapeError::MissingFontSource { font_id }) if font_id == metadata_only
    ));
}

#[test]
fn shape_text_combines_latin_han_and_arabic_runs_without_losing_clusters() {
    let text = "A你 مرحبا A";
    let mut database = FontDatabase::new();
    let latin = register_source_face(
        &mut database,
        "Ahem Fixture",
        Script::Latin,
        "A ",
        font_test_data::AHEM,
    );
    let han = register_source_face(
        &mut database,
        "Noto Serif TC Fixture",
        Script::Han,
        "你",
        font_test_data::NOTOSERIFTC_AUTOHINT_METRICS,
    );
    let arabic = register_source_face(
        &mut database,
        "Noto Sans Arabic Fixture",
        Script::Arabic,
        "مرحبا ",
        NOTO_SANS_ARABIC,
    );
    let request = FontRequest::new([
        "Ahem Fixture",
        "Noto Serif TC Fixture",
        "Noto Sans Arabic Fixture",
    ]);

    let shaped = shape_text(
        &database,
        text,
        &request,
        18.0,
        Some(TextDirection::LeftToRight),
    )
    .expect("mixed paragraph shapes");
    let paragraph = shaped.paragraphs.first().expect("one paragraph");
    let font_ids: Vec<_> = paragraph.runs.iter().map(|run| run.font_id).collect();

    assert_eq!(paragraph.range.slice(text), Some(text));
    assert!(font_ids.contains(&latin));
    assert!(font_ids.contains(&han));
    assert!(font_ids.contains(&arabic));
    assert!(paragraph
        .runs
        .iter()
        .any(|run| run.direction == TextDirection::LeftToRight));
    assert!(paragraph
        .runs
        .iter()
        .any(|run| run.direction == TextDirection::RightToLeft));

    let index_map = TextIndexMap::new(text);
    let mut run_ranges: Vec<_> = paragraph.runs.iter().map(|run| run.range).collect();
    run_ranges.sort_unstable();
    assert_eq!(
        run_ranges
            .iter()
            .map(|range| range.slice(text).unwrap())
            .collect::<String>(),
        text
    );
    for run in &paragraph.runs {
        for glyph in &run.glyphs {
            let cluster = glyph.cluster_utf8.get();
            assert!(cluster >= run.range.start().get() && cluster < run.range.end().get());
            assert!(index_map.utf8_to_grapheme(cluster).is_some());
        }
    }
}

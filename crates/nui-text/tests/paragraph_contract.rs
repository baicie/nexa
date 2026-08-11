use std::sync::Arc;

use nui_text::{
    layout_paragraph, FontDatabase, FontFaceDescriptor, FontRequest, FontSource, FontStyle,
    GlyphCoverage, LineBreakKind, ParagraphError, ParagraphStyle, ParagraphWidth, Script,
    TextDirection, TextIndexMap, Utf8Range,
};

const NOTO_SANS_ARABIC: &[u8] = include_bytes!("fixtures/NotoSansArabic.ttf");

fn paragraph_fixture() -> (FontDatabase, ParagraphStyle) {
    let mut database = FontDatabase::new();
    database.register_face(
        FontFaceDescriptor::new(
            "Ahem Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars("ABC ".chars()),
        )
        .unwrap()
        .with_scripts([Script::Latin])
        .with_source(
            FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0)
                .expect("fixture face parses"),
        ),
    );
    let style = ParagraphStyle::new(FontRequest::new(["Ahem Fixture"]), 20.0)
        .expect("fixture style is valid")
        .with_default_direction(TextDirection::LeftToRight);
    (database, style)
}

fn mixed_bidi_fixture() -> (FontDatabase, ParagraphStyle) {
    let mut database = FontDatabase::new();
    database.register_face(
        FontFaceDescriptor::new(
            "Ahem Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars("A ".chars()),
        )
        .unwrap()
        .with_scripts([Script::Latin])
        .with_source(
            FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0)
                .expect("Ahem fixture is a valid face"),
        ),
    );
    database.register_face(
        FontFaceDescriptor::new(
            "Noto Sans Arabic Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars("مَرَحبا ".chars()),
        )
        .unwrap()
        .with_scripts([Script::Arabic])
        .with_source(
            FontSource::new(Arc::<[u8]>::from(NOTO_SANS_ARABIC), 0)
                .expect("Arabic fixture is a valid face"),
        ),
    );
    let style = ParagraphStyle::new(
        FontRequest::new(["Ahem Fixture", "Noto Sans Arabic Fixture"]),
        20.0,
    )
    .unwrap()
    .with_default_direction(TextDirection::LeftToRight);
    (database, style)
}

#[test]
fn validates_width_and_font_size_at_the_public_boundary() {
    for invalid in [-1.0, f32::NAN, f32::INFINITY] {
        assert!(matches!(
            ParagraphWidth::at_most(invalid),
            Err(ParagraphError::InvalidWidth { .. })
        ));
    }
    assert_eq!(ParagraphWidth::at_most(0.0).unwrap().max_width(), Some(0.0));
    assert_eq!(ParagraphWidth::unbounded().max_width(), None);

    for invalid in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        assert!(matches!(
            ParagraphStyle::new(FontRequest::new(["Ahem Fixture"]), invalid),
            Err(ParagraphError::InvalidFontSize { .. })
        ));
    }
}

#[test]
fn empty_text_produces_one_measurable_line_and_caret_stop() {
    let (database, style) = paragraph_fixture();
    let snapshot = layout_paragraph(&database, "", &style, ParagraphWidth::unbounded())
        .expect("empty paragraphs have font metrics");

    assert_eq!(snapshot.text(), "");
    assert_eq!(snapshot.index_map().text(), "");
    assert_eq!(snapshot.font_revision(), database.revision());
    assert_eq!(snapshot.lines().len(), 1);
    assert_eq!(snapshot.size().width(), 0.0);
    assert!(snapshot.size().height().is_finite() && snapshot.size().height() > 0.0);

    let line = &snapshot.lines()[0];
    assert!(line.source_range().is_empty());
    assert!(line.content_range().is_empty());
    assert_eq!(line.break_kind(), LineBreakKind::EndOfText);
    assert!(line.runs().is_empty());
    assert!(line.clusters().is_empty());
    assert_eq!(line.caret_stops().len(), 1);
    assert_eq!(line.caret_stops()[0].offset().get(), 0);
    assert_eq!(line.caret_stops()[0].x(), 0.0);
    assert!(line.metrics().baseline() > 0.0);
    assert!(line.metrics().height() > 0.0);
}

#[test]
fn hard_breaks_partition_source_and_preserve_empty_and_trailing_lines() {
    let (database, style) = paragraph_fixture();
    let text = "A\r\n\nA\n";
    let snapshot = layout_paragraph(&database, text, &style, ParagraphWidth::unbounded())
        .expect("hard-break fixture lays out");

    assert_eq!(snapshot.lines().len(), 4);
    assert_eq!(
        snapshot.lines()[0].source_range().slice(text),
        Some("A\r\n")
    );
    assert_eq!(snapshot.lines()[0].content_range().slice(text), Some("A"));
    assert_eq!(snapshot.lines()[0].break_kind(), LineBreakKind::Hard);
    assert_eq!(snapshot.lines()[1].source_range().slice(text), Some("\n"));
    assert!(snapshot.lines()[1].content_range().is_empty());
    assert_eq!(snapshot.lines()[2].source_range().slice(text), Some("A\n"));
    assert_eq!(snapshot.lines()[2].content_range().slice(text), Some("A"));
    assert!(snapshot.lines()[3].source_range().is_empty());
    assert_eq!(snapshot.lines()[3].break_kind(), LineBreakKind::EndOfText);

    let reconstructed: String = snapshot
        .lines()
        .iter()
        .map(|line| line.source_range().slice(text).unwrap())
        .collect();
    assert_eq!(reconstructed, text);
    assert!(snapshot
        .lines()
        .windows(2)
        .all(|lines| lines[0].metrics().baseline() < lines[1].metrics().baseline()));
}

#[test]
fn unbounded_width_keeps_soft_opportunities_on_one_line() {
    let (database, style) = paragraph_fixture();
    let text = "A A";
    let snapshot = layout_paragraph(&database, text, &style, ParagraphWidth::unbounded())
        .expect("unbounded paragraph lays out");

    assert_eq!(snapshot.lines().len(), 1);
    assert_eq!(snapshot.lines()[0].content_range().slice(text), Some(text));
    assert!(!snapshot.lines()[0].metrics().overflows());
}

#[test]
fn greedy_wrap_uses_the_last_fitting_soft_opportunity() {
    let (database, style) = paragraph_fixture();
    let prefix = layout_paragraph(&database, "A ", &style, ParagraphWidth::unbounded())
        .unwrap()
        .lines()[0]
        .metrics()
        .advance();
    let text = "A A";
    let snapshot = layout_paragraph(
        &database,
        text,
        &style,
        ParagraphWidth::at_most(prefix).unwrap(),
    )
    .expect("soft-wrapped paragraph lays out");

    assert_eq!(snapshot.lines().len(), 2);
    assert_eq!(snapshot.lines()[0].source_range().slice(text), Some("A "));
    assert_eq!(snapshot.lines()[0].break_kind(), LineBreakKind::Soft);
    assert!(!snapshot.lines()[0].metrics().overflows());
    assert_eq!(snapshot.lines()[1].source_range().slice(text), Some("A"));
    assert_eq!(snapshot.lines()[1].break_kind(), LineBreakKind::EndOfText);
}

#[test]
fn unbreakable_content_overflows_without_splitting_arbitrary_graphemes() {
    let (database, style) = paragraph_fixture();
    let text = "AA";
    let snapshot = layout_paragraph(
        &database,
        text,
        &style,
        ParagraphWidth::at_most(0.0).unwrap(),
    )
    .expect("unbreakable paragraph still lays out");

    assert_eq!(snapshot.lines().len(), 1);
    assert_eq!(snapshot.lines()[0].content_range().slice(text), Some(text));
    assert!(snapshot.lines()[0].metrics().overflows());
}

#[test]
fn overflowing_first_word_advances_to_the_next_safe_break() {
    let (database, style) = paragraph_fixture();
    let one_glyph = layout_paragraph(&database, "A", &style, ParagraphWidth::unbounded())
        .unwrap()
        .size()
        .width();
    let text = "AA A";
    let snapshot = layout_paragraph(
        &database,
        text,
        &style,
        ParagraphWidth::at_most(one_glyph).unwrap(),
    )
    .expect("overflowing word lays out");

    assert_eq!(snapshot.lines().len(), 2);
    assert_eq!(snapshot.lines()[0].content_range().slice(text), Some("AA "));
    assert!(snapshot.lines()[0].metrics().overflows());
    assert_eq!(snapshot.lines()[1].content_range().slice(text), Some("A"));
    assert!(!snapshot.lines()[1].metrics().overflows());
}

#[test]
fn cjk_wraps_only_at_absolute_utf8_grapheme_boundaries() {
    let mut database = FontDatabase::new();
    database.register_face(
        FontFaceDescriptor::new(
            "Noto Serif TC Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars("你們".chars()),
        )
        .unwrap()
        .with_scripts([Script::Han])
        .with_source(
            FontSource::new(
                Arc::<[u8]>::from(font_test_data::NOTOSERIFTC_AUTOHINT_METRICS),
                0,
            )
            .unwrap(),
        ),
    );
    let style = ParagraphStyle::new(FontRequest::new(["Noto Serif TC Fixture"]), 20.0).unwrap();
    let one_glyph = layout_paragraph(&database, "你", &style, ParagraphWidth::unbounded())
        .unwrap()
        .size()
        .width();
    let text = "你們";
    let snapshot = layout_paragraph(
        &database,
        text,
        &style,
        ParagraphWidth::at_most(one_glyph).unwrap(),
    )
    .expect("CJK paragraph wraps");

    assert_eq!(snapshot.lines().len(), 2);
    assert_eq!(snapshot.lines()[0].content_range().slice(text), Some("你"));
    assert_eq!(snapshot.lines()[1].content_range().slice(text), Some("們"));
    assert_eq!(snapshot.lines()[0].content_range().end().get(), "你".len());
}

#[test]
fn cluster_map_and_caret_stops_cover_ligature_graphemes() {
    let mut database = FontDatabase::new();
    database.register_face(
        FontFaceDescriptor::new(
            "Noto Serif Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars("fi".chars()),
        )
        .unwrap()
        .with_scripts([Script::Latin])
        .with_source(
            FontSource::new(
                Arc::<[u8]>::from(font_test_data::NOTOSERIF_AUTOHINT_SHAPING),
                0,
            )
            .unwrap(),
        ),
    );
    let style = ParagraphStyle::new(FontRequest::new(["Noto Serif Fixture"]), 20.0).unwrap();
    let text = "fi";
    let snapshot = layout_paragraph(&database, text, &style, ParagraphWidth::unbounded())
        .expect("ligature paragraph lays out");
    let line = &snapshot.lines()[0];

    assert_eq!(line.clusters().len(), 1);
    assert_eq!(line.clusters()[0].range().slice(text), Some(text));
    assert!(line.clusters()[0].bounds().width() > 0.0);
    assert!(line.clusters()[0].bounds().width().is_finite());
    assert_eq!(line.runs().len(), 1);
    assert_eq!(line.runs()[0].glyphs().len(), 1);
    assert!(line.runs()[0].glyphs()[0].x().is_finite());
    assert!(line.runs()[0].glyphs()[0].y().is_finite());

    let caret_offsets: Vec<_> = line
        .caret_stops()
        .iter()
        .map(|stop| stop.offset().get())
        .collect();
    assert_eq!(caret_offsets, vec![0, 1, 2]);
    assert!(line
        .caret_stops()
        .windows(2)
        .all(|stops| stops[0].x() <= stops[1].x()));
    assert!(line.caret_stops().iter().all(|stop| TextIndexMap::new(text)
        .utf8_to_grapheme(stop.offset().get())
        .is_some()));
}

#[test]
fn wrapped_mixed_bidi_lines_are_reordered_independently() {
    let (database, style) = mixed_bidi_fixture();
    let line_text = "A مرحبا ";
    let line_width = layout_paragraph(&database, line_text, &style, ParagraphWidth::unbounded())
        .unwrap()
        .size()
        .width();
    let text = "A مرحبا A مرحبا";
    let snapshot = layout_paragraph(
        &database,
        text,
        &style,
        ParagraphWidth::at_most(line_width).unwrap(),
    )
    .expect("mixed paragraph wraps");

    assert_eq!(snapshot.lines().len(), 2);
    for line in snapshot.lines() {
        assert!(line
            .clusters()
            .windows(2)
            .all(|clusters| clusters[0].bounds().x() <= clusters[1].bounds().x()));
        let rtl_starts: Vec<_> = line
            .clusters()
            .iter()
            .filter(|cluster| cluster.direction() == TextDirection::RightToLeft)
            .map(|cluster| cluster.range().start().get())
            .collect();
        assert!(rtl_starts.len() > 1);
        assert!(rtl_starts.windows(2).all(|starts| starts[0] > starts[1]));
    }

    let first = &snapshot.lines()[0];
    assert_eq!(first.content_range().slice(text), Some(line_text));
    let trailing_space = first.clusters().last().expect("trailing space cluster");
    assert_eq!(trailing_space.range().slice(text), Some(" "));
    assert_eq!(trailing_space.direction(), TextDirection::LeftToRight);
}

#[test]
fn mixed_bidi_selection_emits_discontiguous_visual_segments() {
    let (database, style) = mixed_bidi_fixture();
    let text = "A مرحبا A";
    let snapshot = layout_paragraph(&database, text, &style, ParagraphWidth::unbounded())
        .expect("mixed-BiDi paragraph lays out");
    let selection = Utf8Range::new(text, 0, "A م".len()).expect("selection boundaries");

    let rects = snapshot.selection_rects(selection);

    assert_eq!(rects.len(), 2, "selection has two visual islands");
    assert!(rects[0].x() + rects[0].width() <= rects[1].x());
    for cluster in snapshot.lines()[0].clusters() {
        let midpoint = cluster.bounds().x() + cluster.bounds().width() * 0.5;
        let covered = rects
            .iter()
            .any(|rect| rect.x() <= midpoint && midpoint < rect.x() + rect.width());
        let selected = cluster.range().intersection(selection).is_some();
        assert_eq!(
            covered,
            selected,
            "cluster {:?} must be covered iff selected",
            cluster.range().slice(text)
        );
    }
}

#[test]
fn mixed_bidi_selection_ranges_cover_only_selected_clusters() {
    let (database, style) = mixed_bidi_fixture();
    let text = "A مرحبا A";
    let snapshot = layout_paragraph(&database, text, &style, ParagraphWidth::unbounded())
        .expect("mixed-BiDi paragraph lays out");
    let map = TextIndexMap::new(text);

    for start in 0..map.grapheme_count() {
        for end in (start + 1)..=map.grapheme_count() {
            let range = Utf8Range::new(
                text,
                map.grapheme_to_utf8(start).expect("start boundary"),
                map.grapheme_to_utf8(end).expect("end boundary"),
            )
            .expect("grapheme selection range");
            let rects = snapshot.selection_rects(range);

            for (line_index, line) in snapshot.lines().iter().enumerate() {
                for cluster in line.clusters() {
                    let midpoint = cluster.bounds().x() + cluster.bounds().width() * 0.5;
                    let covered = rects.iter().any(|rect| {
                        rect.y() == line.metrics().top()
                            && rect.x() <= midpoint
                            && midpoint < rect.x() + rect.width()
                    });
                    let selected = cluster.range().intersection(range).is_some();
                    assert_eq!(
                        covered,
                        selected,
                        "line {line_index}, cluster {:?}, selection {start}..{end}",
                        cluster.range().slice(text)
                    );
                }
            }
        }
    }
}

#[test]
fn mixed_bidi_caret_point_round_trip_preserves_cluster_boundaries() {
    let (database, style) = mixed_bidi_fixture();
    let text = "A مرحبا A";
    let snapshot = layout_paragraph(&database, text, &style, ParagraphWidth::unbounded())
        .expect("mixed-BiDi paragraph lays out");
    let map = TextIndexMap::new(text);

    for (line_index, line) in snapshot.lines().iter().enumerate() {
        let y = line.metrics().top() + line.metrics().height() * 0.5;
        for stop in line.caret_stops() {
            let hit = snapshot.hit_test(stop.x(), y).expect("caret point hits");
            assert_eq!(hit.line(), line_index);
            assert!(map.utf8_to_grapheme(hit.offset().get()).is_some());
            let bounds = snapshot
                .caret_bounds(hit.offset(), hit.affinity())
                .expect("hit returns a paintable caret");
            assert!((bounds.x() - stop.x()).abs() < 0.001);
        }
    }
}

#[test]
fn rtl_base_level_resets_trailing_space_for_each_wrapped_line() {
    let (database, _) = paragraph_fixture();
    let style = ParagraphStyle::new(FontRequest::new(["Ahem Fixture"]), 20.0)
        .unwrap()
        .with_default_direction(TextDirection::RightToLeft);
    let line_width = layout_paragraph(&database, "AAA ", &style, ParagraphWidth::unbounded())
        .unwrap()
        .size()
        .width();
    let text = "AAA AAA";
    let snapshot = layout_paragraph(
        &database,
        text,
        &style,
        ParagraphWidth::at_most(line_width).unwrap(),
    )
    .unwrap();

    assert_eq!(snapshot.lines().len(), 2);
    assert_eq!(
        snapshot.lines()[0]
            .clusters()
            .iter()
            .map(|cluster| cluster.range().start().get())
            .collect::<Vec<_>>(),
        vec![3, 0, 1, 2]
    );
    assert_eq!(
        snapshot.lines()[0].clusters()[0].direction(),
        TextDirection::RightToLeft
    );
    assert_eq!(
        snapshot.lines()[1]
            .clusters()
            .iter()
            .map(|cluster| cluster.range().start().get())
            .collect::<Vec<_>>(),
        vec![4, 5, 6]
    );
    assert!(snapshot.lines()[1].caret_stops().iter().all(|caret| {
        let offset = caret.offset().get();
        (4..=text.len()).contains(&offset)
    }));
}

#[test]
fn fallback_only_lines_use_metrics_from_participating_fonts() {
    let mut database = FontDatabase::new();
    database.register_face(
        FontFaceDescriptor::new(
            "Noto Serif TC Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars("你".chars()),
        )
        .unwrap()
        .with_scripts([Script::Han])
        .with_source(
            FontSource::new(
                Arc::<[u8]>::from(font_test_data::NOTOSERIFTC_AUTOHINT_METRICS),
                0,
            )
            .unwrap(),
        ),
    );
    database.register_face(
        FontFaceDescriptor::new(
            "Ahem Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars("A".chars()),
        )
        .unwrap()
        .with_scripts([Script::Latin])
        .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
    );
    let fallback_style = ParagraphStyle::new(
        FontRequest::new(["Noto Serif TC Fixture", "Ahem Fixture"]),
        20.0,
    )
    .unwrap();
    let direct_style = ParagraphStyle::new(FontRequest::new(["Ahem Fixture"]), 20.0).unwrap();
    let han_style = ParagraphStyle::new(FontRequest::new(["Noto Serif TC Fixture"]), 20.0).unwrap();

    let fallback =
        layout_paragraph(&database, "A", &fallback_style, ParagraphWidth::unbounded()).unwrap();
    let direct =
        layout_paragraph(&database, "A", &direct_style, ParagraphWidth::unbounded()).unwrap();

    assert_eq!(fallback.lines()[0].metrics(), direct.lines()[0].metrics());

    let han = layout_paragraph(&database, "你", &han_style, ParagraphWidth::unbounded()).unwrap();
    let mixed = layout_paragraph(
        &database,
        "你A",
        &fallback_style,
        ParagraphWidth::unbounded(),
    )
    .unwrap();
    let mixed_metrics = mixed.lines()[0].metrics();
    let han_metrics = han.lines()[0].metrics();
    let latin_metrics = direct.lines()[0].metrics();
    assert_eq!(
        mixed_metrics.ascent(),
        han_metrics.ascent().max(latin_metrics.ascent())
    );
    assert_eq!(
        mixed_metrics.descent(),
        han_metrics.descent().max(latin_metrics.descent())
    );
    assert_eq!(
        mixed_metrics.leading(),
        han_metrics.leading().max(latin_metrics.leading())
    );
}

#[test]
fn all_uax_hard_separators_are_consumed_without_shaping_missing_glyphs() {
    let (database, style) = paragraph_fixture();
    for separator in ['\u{000b}', '\u{000c}', '\u{0085}', '\u{2028}', '\u{2029}'] {
        let text = format!("A{separator}B");
        let snapshot =
            layout_paragraph(&database, text.clone(), &style, ParagraphWidth::unbounded())
                .unwrap_or_else(|error| panic!("{separator:?} must be a hard separator: {error}"));

        assert_eq!(snapshot.lines().len(), 2);
        assert_eq!(snapshot.lines()[0].content_range().slice(&text), Some("A"));
        assert_eq!(snapshot.lines()[0].break_kind(), LineBreakKind::Hard);
        assert_eq!(snapshot.lines()[1].content_range().slice(&text), Some("B"));
        assert_eq!(snapshot.lines()[1].break_kind(), LineBreakKind::EndOfText);
    }
}

#[test]
fn adjacent_clusters_with_the_same_style_share_one_positioned_run() {
    let (database, style) = paragraph_fixture();
    let snapshot = layout_paragraph(&database, "ABC", &style, ParagraphWidth::unbounded()).unwrap();
    let line = &snapshot.lines()[0];

    assert_eq!(line.clusters().len(), 3);
    assert_eq!(line.runs().len(), 1);
    assert_eq!(line.runs()[0].range().slice(snapshot.text()), Some("ABC"));
    assert_eq!(line.runs()[0].glyphs().len(), 3);
}

#[test]
fn zero_width_preserves_a_combining_grapheme_and_marks_overflow() {
    let (database, style) = mixed_bidi_fixture();
    let text = "م\u{64e}";
    let snapshot = layout_paragraph(
        &database,
        text,
        &style,
        ParagraphWidth::at_most(0.0).unwrap(),
    )
    .unwrap();

    assert_eq!(snapshot.lines().len(), 1);
    assert_eq!(snapshot.lines()[0].clusters().len(), 1);
    assert_eq!(
        snapshot.lines()[0].clusters()[0].range().slice(text),
        Some(text)
    );
    assert!(snapshot.lines()[0].metrics().overflows());
}

#[test]
fn zero_width_preserves_an_emoji_zwj_grapheme_and_marks_overflow() {
    let text = "✍🏽‍✍️";
    let mut database = FontDatabase::new();
    database.register_face(
        FontFaceDescriptor::new(
            "Noto Handwriting Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars(text.chars()),
        )
        .unwrap()
        .with_scripts([Script::Common])
        .with_source(
            FontSource::new(Arc::<[u8]>::from(font_test_data::NOTO_HANDWRITING_SBIX), 0).unwrap(),
        ),
    );
    let style = ParagraphStyle::new(FontRequest::new(["Noto Handwriting Fixture"]), 20.0).unwrap();
    let snapshot = layout_paragraph(
        &database,
        text,
        &style,
        ParagraphWidth::at_most(0.0).unwrap(),
    )
    .unwrap();

    assert_eq!(TextIndexMap::new(text).grapheme_count(), 1);
    assert_eq!(snapshot.lines().len(), 1);
    assert_eq!(snapshot.lines()[0].clusters().len(), 1);
    assert_eq!(
        snapshot.lines()[0].clusters()[0].range().slice(text),
        Some(text)
    );
    assert!(snapshot.lines()[0].metrics().overflows());
}

#[test]
fn omitted_default_ignorables_keep_zero_width_clusters_and_caret_boundaries() {
    let mut database = FontDatabase::new();
    database.register_face(
        FontFaceDescriptor::new(
            "Material Icons Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars(['\u{e951}']),
        )
        .unwrap()
        .with_scripts([Script::Common])
        .with_source(
            FontSource::new(Arc::<[u8]>::from(font_test_data::MATERIAL_ICONS_SUBSET), 0).unwrap(),
        ),
    );
    let style = ParagraphStyle::new(FontRequest::new(["Material Icons Fixture"]), 20.0).unwrap();
    let text = "\u{e951}\u{200b}\u{e951}";
    let snapshot = layout_paragraph(&database, text, &style, ParagraphWidth::unbounded())
        .expect("default-ignorables do not require font coverage");
    let line = &snapshot.lines()[0];

    assert_eq!(line.clusters().len(), 3);
    assert_eq!(line.clusters()[0].range().slice(text), Some("\u{e951}"));
    assert_eq!(line.clusters()[1].range().slice(text), Some("\u{200b}"));
    assert_eq!(line.clusters()[2].range().slice(text), Some("\u{e951}"));
    assert_eq!(line.clusters()[1].bounds().width(), 0.0);

    let after_first_icon = line
        .caret_stops()
        .iter()
        .find(|stop| stop.offset().get() == "\u{e951}".len())
        .expect("first icon end remains a legal caret");
    let after_zwsp = line
        .caret_stops()
        .iter()
        .find(|stop| stop.offset().get() == "\u{e951}\u{200b}".len())
        .expect("ZWSP end remains a legal caret");
    assert_eq!(after_first_icon.x(), after_zwsp.x());

    let only_ignorables = layout_paragraph(
        &database,
        "\u{200b}\u{200b}",
        &style,
        ParagraphWidth::unbounded(),
    )
    .expect("a paragraph may contain only default-ignorables");
    let only_line = &only_ignorables.lines()[0];
    assert_eq!(only_line.clusters().len(), 2);
    assert!(only_line.runs().is_empty());
    assert!(only_line
        .caret_stops()
        .iter()
        .any(|stop| stop.offset().get() == 3));
}

#[test]
fn rejects_non_finite_geometry_after_finite_glyph_shaping() {
    let (database, _) = paragraph_fixture();
    let style = ParagraphStyle::new(FontRequest::new(["Ahem Fixture"]), 2.2e38).unwrap();

    let result = layout_paragraph(&database, "A\nA", &style, ParagraphWidth::unbounded());
    assert!(matches!(result, Err(ParagraphError::NonFiniteGeometry)));
}

use std::sync::Arc;

use nui_text::{
    layout_paragraph, FontDatabase, FontFaceDescriptor, FontRequest, FontSource, FontStyle,
    GlyphCoverage, HorizontalDirection, ParagraphSnapshot, ParagraphStyle, ParagraphWidth, Script,
    TextAreaController, TextDirection, TextHit, TextSelection, VerticalDirection,
};

const NOTO_SANS_ARABIC: &[u8] = include_bytes!("fixtures/NotoSansArabic.ttf");

fn fixture(
    family: &str,
    supported: &str,
    scripts: impl IntoIterator<Item = Script>,
    source: &'static [u8],
) -> (FontDatabase, ParagraphStyle) {
    let mut database = FontDatabase::new();
    database.register_face(
        FontFaceDescriptor::new(
            family,
            FontStyle::default(),
            GlyphCoverage::from_chars(supported.chars()),
        )
        .expect("fixture descriptor")
        .with_scripts(scripts)
        .with_source(FontSource::new(Arc::<[u8]>::from(source), 0).expect("fixture font parses")),
    );
    let style = ParagraphStyle::new(FontRequest::new([family]), 20.0).expect("paragraph style");
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
        .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
    );
    database.register_face(
        FontFaceDescriptor::new(
            "Noto Sans Arabic Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars("مرحبا ".chars()),
        )
        .unwrap()
        .with_scripts([Script::Arabic])
        .with_source(FontSource::new(Arc::<[u8]>::from(NOTO_SANS_ARABIC), 0).unwrap()),
    );
    let style = ParagraphStyle::new(
        FontRequest::new(["Ahem Fixture", "Noto Sans Arabic Fixture"]),
        20.0,
    )
    .unwrap()
    .with_default_direction(TextDirection::LeftToRight);
    (database, style)
}

fn variable_advance_fixture() -> (FontDatabase, ParagraphStyle) {
    let mut database = FontDatabase::new();
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
    database.register_face(
        FontFaceDescriptor::new(
            "Noto Serif Fixture",
            FontStyle::default(),
            GlyphCoverage::from_chars("i".chars()),
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
    let style = ParagraphStyle::new(
        FontRequest::new(["Ahem Fixture", "Noto Serif Fixture"]),
        20.0,
    )
    .unwrap();
    (database, style)
}

fn line_midpoint_y(snapshot: &ParagraphSnapshot, line: usize) -> f32 {
    let metrics = snapshot.lines()[line].metrics();
    metrics.top() + metrics.height() * 0.5
}

fn hit_on_line(snapshot: &ParagraphSnapshot, line: usize, x: f32) -> TextHit {
    let hit = snapshot
        .hit_test(x, line_midpoint_y(snapshot, line))
        .expect("visual line has a caret stop");
    assert_eq!(hit.line(), line);
    hit
}

fn grapheme_for_hit(snapshot: &ParagraphSnapshot, hit: TextHit) -> usize {
    snapshot
        .index_map()
        .utf8_to_grapheme(hit.offset().get())
        .expect("paragraph caret is a grapheme boundary")
}

fn set_caret_from_hit(area: &mut TextAreaController, snapshot: &ParagraphSnapshot, hit: TextHit) {
    area.editor_mut()
        .set_caret(grapheme_for_hit(snapshot, hit), false)
        .expect("fixture caret");
}

fn move_down(
    area: &mut TextAreaController,
    snapshot: &ParagraphSnapshot,
    current: TextHit,
) -> TextHit {
    area.move_vertical_in_snapshot(snapshot, current.affinity(), VerticalDirection::Down, false)
        .expect("visual down")
}

fn assert_down_matches_visual_x(snapshot: &ParagraphSnapshot, x: f32) {
    assert!(snapshot.lines().len() >= 2);
    let start = hit_on_line(snapshot, 0, x);
    let expected = hit_on_line(snapshot, 1, x);
    assert_ne!(
        start.offset(),
        expected.offset(),
        "fixture must change lines"
    );

    let mut area = TextAreaController::new(snapshot.text());
    set_caret_from_hit(&mut area, snapshot, start);
    let moved = move_down(&mut area, snapshot, start);

    assert_eq!(moved, expected);
    assert_eq!(
        area.editor().selection(),
        TextSelection::collapsed(grapheme_for_hit(snapshot, expected))
    );
}

#[test]
fn down_uses_soft_wrapped_visual_lines_instead_of_logical_newlines() {
    let (database, style) = fixture(
        "Ahem Fixture",
        "ABC ",
        [Script::Latin],
        font_test_data::AHEM,
    );
    let first_line =
        layout_paragraph(&database, "ABC ", &style, ParagraphWidth::unbounded()).unwrap();
    let snapshot = layout_paragraph(
        &database,
        "ABC ABC",
        &style,
        ParagraphWidth::at_most(first_line.size().width()).unwrap(),
    )
    .unwrap();

    assert_eq!(snapshot.lines().len(), 2);
    assert_down_matches_visual_x(&snapshot, first_line.size().width() * 0.5);
}

#[test]
fn preferred_x_survives_a_short_intermediate_line() {
    let (database, style) = variable_advance_fixture();
    let snapshot = layout_paragraph(
        &database,
        "AA\ni\niiiiiiii",
        &style,
        ParagraphWidth::unbounded(),
    )
    .unwrap();
    assert_eq!(snapshot.lines().len(), 3);

    let preferred_x = snapshot.lines()[0].metrics().advance();
    let start = hit_on_line(&snapshot, 0, preferred_x);
    let short_line = hit_on_line(&snapshot, 1, preferred_x);
    let restored = hit_on_line(&snapshot, 2, preferred_x);
    let third_line_start = snapshot
        .index_map()
        .utf8_to_grapheme(snapshot.lines()[2].content_range().start().get())
        .unwrap();
    assert!(
        grapheme_for_hit(&snapshot, restored) > third_line_start + 2,
        "fixture must distinguish pixel x from a logical column"
    );

    let mut area = TextAreaController::new(snapshot.text());
    set_caret_from_hit(&mut area, &snapshot, start);
    let first_move = move_down(&mut area, &snapshot, start);
    assert_eq!(first_move, short_line);
    let second_move = move_down(&mut area, &snapshot, first_move);

    assert_eq!(second_move, restored);
    assert_eq!(
        area.editor().selection(),
        TextSelection::collapsed(grapheme_for_hit(&snapshot, restored))
    );
}

#[test]
fn cjk_soft_wrap_navigation_stays_on_grapheme_boundaries() {
    let (database, style) = fixture(
        "Noto Serif TC Fixture",
        "你們",
        [Script::Han],
        font_test_data::NOTOSERIFTC_AUTOHINT_METRICS,
    );
    let pair = layout_paragraph(&database, "你們", &style, ParagraphWidth::unbounded()).unwrap();
    let snapshot = layout_paragraph(
        &database,
        "你們你們",
        &style,
        ParagraphWidth::at_most(pair.size().width()).unwrap(),
    )
    .unwrap();

    assert_eq!(snapshot.lines().len(), 2);
    assert_down_matches_visual_x(&snapshot, pair.size().width() * 0.5);
}

#[test]
fn rtl_navigation_uses_visual_x_instead_of_a_logical_column() {
    let (database, style) = mixed_bidi_fixture();
    let visual_line = "A مرحبا ";
    let width = layout_paragraph(&database, visual_line, &style, ParagraphWidth::unbounded())
        .unwrap()
        .size()
        .width();
    let snapshot = layout_paragraph(
        &database,
        "A مرحبا A مرحبا",
        &style,
        ParagraphWidth::at_most(width).unwrap(),
    )
    .unwrap();
    assert_eq!(snapshot.lines().len(), 2);

    let (start, expected) = snapshot.lines()[0]
        .caret_stops()
        .iter()
        .find_map(|stop| {
            let start = hit_on_line(&snapshot, 0, stop.x());
            let expected = hit_on_line(&snapshot, 1, stop.x());
            let start_grapheme = grapheme_for_hit(&snapshot, start);
            let expected_grapheme = grapheme_for_hit(&snapshot, expected);
            let second_start = snapshot
                .index_map()
                .utf8_to_grapheme(snapshot.lines()[1].content_range().start().get())
                .unwrap();
            let logical_column = start_grapheme;
            (expected_grapheme != second_start + logical_column).then_some((start, expected))
        })
        .expect("fixture exposes a visual/logical navigation difference");

    let mut area = TextAreaController::new(snapshot.text());
    set_caret_from_hit(&mut area, &snapshot, start);
    let moved = move_down(&mut area, &snapshot, start);

    assert_eq!(moved, expected);
    assert_eq!(
        area.editor().selection(),
        TextSelection::collapsed(grapheme_for_hit(&snapshot, expected))
    );
}

#[test]
fn mixed_bidi_left_and_right_follow_visual_caret_order() {
    let (database, style) = mixed_bidi_fixture();
    let text = "A مرحبا A";
    let snapshot = layout_paragraph(&database, text, &style, ParagraphWidth::unbounded()).unwrap();
    let line = &snapshot.lines()[0];
    let (start, expected) = line
        .caret_stops()
        .windows(2)
        .find_map(|pair| {
            let start = pair[0];
            let expected = pair[1];
            let start_grapheme = snapshot
                .index_map()
                .utf8_to_grapheme(start.offset().get())?;
            let expected_grapheme = snapshot
                .index_map()
                .utf8_to_grapheme(expected.offset().get())?;
            (start_grapheme.abs_diff(expected_grapheme) > 1).then_some((start, expected))
        })
        .expect("fixture contains a visual neighbor that is not a logical neighbor");
    let start_grapheme = snapshot
        .index_map()
        .utf8_to_grapheme(start.offset().get())
        .unwrap();
    let expected_grapheme = snapshot
        .index_map()
        .utf8_to_grapheme(expected.offset().get())
        .unwrap();
    let mut area = TextAreaController::new(text);
    area.editor_mut()
        .set_caret(start_grapheme, false)
        .expect("fixture caret");

    let moved = area
        .move_horizontal_in_snapshot(
            &snapshot,
            start.affinity(),
            HorizontalDirection::Right,
            false,
        )
        .expect("visual right");

    assert_eq!(moved.offset(), expected.offset());
    assert_eq!(moved.affinity(), expected.affinity());
    assert_eq!(
        area.editor().selection(),
        TextSelection::collapsed(expected_grapheme)
    );

    let returned = area
        .move_horizontal_in_snapshot(&snapshot, moved.affinity(), HorizontalDirection::Left, true)
        .expect("shift visual left");
    assert_eq!(returned.offset(), start.offset());
    assert_eq!(returned.affinity(), start.affinity());
    assert_eq!(
        area.editor().selection(),
        TextSelection::new(expected_grapheme, start_grapheme)
    );
}

#[test]
fn emoji_zwj_navigation_never_splits_the_extended_grapheme() {
    let emoji = "✍🏽‍✍️";
    let text = format!("{emoji} {emoji}");
    let (database, style) = fixture(
        "Noto Handwriting Fixture",
        &text,
        [Script::Common],
        font_test_data::NOTO_HANDWRITING_SBIX,
    );
    let first = layout_paragraph(
        &database,
        format!("{emoji} "),
        &style,
        ParagraphWidth::unbounded(),
    )
    .unwrap();
    let snapshot = layout_paragraph(
        &database,
        text,
        &style,
        ParagraphWidth::at_most(first.size().width()).unwrap(),
    )
    .unwrap();

    assert_eq!(snapshot.index_map().grapheme_count(), 3);
    assert_eq!(snapshot.lines().len(), 2);
    assert_down_matches_visual_x(&snapshot, first.size().width() * 0.75);
}

#[test]
fn crlf_is_one_grapheme_break_but_two_visual_lines() {
    let (database, style) = fixture("Ahem Fixture", "AB", [Script::Latin], font_test_data::AHEM);
    let snapshot =
        layout_paragraph(&database, "A\r\nB", &style, ParagraphWidth::unbounded()).unwrap();

    assert_eq!(snapshot.index_map().grapheme_count(), 3);
    assert_eq!(snapshot.lines().len(), 2);
    assert_down_matches_visual_x(&snapshot, snapshot.lines()[0].metrics().advance());
}

#[test]
fn home_and_end_use_the_current_soft_wrapped_visual_line() {
    let (database, style) = fixture(
        "Ahem Fixture",
        "ABC ",
        [Script::Latin],
        font_test_data::AHEM,
    );
    let first_line =
        layout_paragraph(&database, "ABC ", &style, ParagraphWidth::unbounded()).unwrap();
    let snapshot = layout_paragraph(
        &database,
        "ABC ABC",
        &style,
        ParagraphWidth::at_most(first_line.size().width()).unwrap(),
    )
    .unwrap();
    let start = hit_on_line(&snapshot, 1, first_line.size().width() * 0.5);
    let home = hit_on_line(&snapshot, 1, 0.0);
    let end = hit_on_line(&snapshot, 1, snapshot.lines()[1].metrics().advance());
    let mut area = TextAreaController::new(snapshot.text());
    set_caret_from_hit(&mut area, &snapshot, start);

    let moved_home = area
        .move_to_line_edge_in_snapshot(&snapshot, start.affinity(), false, false)
        .expect("visual home");
    assert_eq!(moved_home, home);

    let moved_end = area
        .move_to_line_edge_in_snapshot(&snapshot, moved_home.affinity(), true, true)
        .expect("shift visual end");
    assert_eq!(moved_end, end);
    assert_eq!(
        area.editor().selection(),
        TextSelection::new(
            grapheme_for_hit(&snapshot, home),
            grapheme_for_hit(&snapshot, end),
        )
    );
}

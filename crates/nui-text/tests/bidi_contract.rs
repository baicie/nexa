use nui_text::{itemize_script, resolve_bidi, Script, TextDirection, TextIndexMap, Utf8Range};

fn covered_text(text: &str, ranges: impl IntoIterator<Item = Utf8Range>) -> String {
    ranges
        .into_iter()
        .map(|range| range.slice(text).expect("run range must belong to source"))
        .collect()
}

#[test]
fn utf8_ranges_reject_non_boundaries_and_wrong_source_lengths() {
    let text = "A😀中";
    let range = Utf8Range::new(text, 1, 5).expect("emoji is a valid UTF-8 range");

    assert_eq!(range.start().get(), 1);
    assert_eq!(range.end().get(), 5);
    assert_eq!(range.slice(text), Some("😀"));
    assert!(Utf8Range::new(text, 2, 5).is_err());
    assert!(Utf8Range::new(text, 5, 1).is_err());
    assert_eq!(range.slice("short"), None);
}

#[test]
fn script_itemization_resolves_common_and_inherited_without_splitting_graphemes() {
    let text = "(Hello, 世界 e\u{301} 👨‍👩‍👧‍👦 مرحبا)";
    let runs = itemize_script(text);

    assert_eq!(covered_text(text, runs.iter().map(|run| run.range)), text);
    assert_eq!(runs.first().map(|run| run.script), Some(Script::Latin));
    assert!(runs.iter().any(|run| run.script == Script::Han));
    assert!(runs.iter().any(|run| run.script == Script::Arabic));

    let index_map = TextIndexMap::new(text);
    for run in runs {
        assert!(index_map
            .utf8_to_grapheme(run.range.start().get())
            .is_some());
        assert!(index_map.utf8_to_grapheme(run.range.end().get()).is_some());
    }
}

#[test]
fn bidi_exposes_complete_logical_runs_and_explicit_visual_order() {
    let text = "abc مرحبا 123";
    let paragraphs = resolve_bidi(text, Some(TextDirection::LeftToRight));
    let paragraph = paragraphs.first().expect("one paragraph");

    assert_eq!(paragraph.base_direction, TextDirection::LeftToRight);
    assert_eq!(paragraph.range.slice(text), Some(text));
    assert_eq!(
        covered_text(text, paragraph.logical_runs.iter().map(|run| run.range)),
        text
    );
    assert!(paragraph
        .logical_runs
        .iter()
        .any(|run| run.direction == TextDirection::RightToLeft && run.level % 2 == 1));

    let mut logical_ranges: Vec<_> = paragraph.logical_runs.iter().map(|run| run.range).collect();
    let mut visual_ranges: Vec<_> = paragraph.visual_runs.iter().map(|run| run.range).collect();
    logical_ranges.sort_unstable();
    visual_ranges.sort_unstable();
    assert_eq!(visual_ranges, logical_ranges);
    assert_ne!(paragraph.visual_runs, paragraph.logical_runs);
}

#[test]
fn bidi_runs_never_split_extended_grapheme_clusters() {
    let text = "A 👨‍👩‍👧‍👦 م\u{64e} B";
    let index_map = TextIndexMap::new(text);
    let paragraphs = resolve_bidi(text, None);

    for run in paragraphs
        .iter()
        .flat_map(|paragraph| paragraph.logical_runs.iter().chain(&paragraph.visual_runs))
    {
        assert!(index_map
            .utf8_to_grapheme(run.range.start().get())
            .is_some());
        assert!(index_map.utf8_to_grapheme(run.range.end().get()).is_some());
    }
}

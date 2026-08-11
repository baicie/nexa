use nui_text::{line_break_opportunities, LineBreakKind, TextIndexMap};

fn pairs(text: &str) -> Vec<(usize, LineBreakKind)> {
    line_break_opportunities(text)
        .iter()
        .map(|opportunity| (opportunity.offset().get(), opportunity.kind()))
        .collect()
}

#[test]
fn exposes_typed_space_cjk_and_end_of_text_opportunities() {
    assert_eq!(
        pairs("a b"),
        vec![(2, LineBreakKind::Soft), (3, LineBreakKind::EndOfText)]
    );
    assert_eq!(
        pairs("你們"),
        vec![(3, LineBreakKind::Soft), (6, LineBreakKind::EndOfText)]
    );
    assert_eq!(pairs(""), vec![(0, LineBreakKind::EndOfText)]);
}

#[test]
fn normalizes_crlf_and_trailing_hard_breaks_without_losing_the_final_line() {
    assert_eq!(
        pairs("A\r\n"),
        vec![(3, LineBreakKind::Hard), (3, LineBreakKind::EndOfText)]
    );
    assert_eq!(
        pairs("A\r\n\nB"),
        vec![
            (3, LineBreakKind::Hard),
            (4, LineBreakKind::Hard),
            (5, LineBreakKind::EndOfText),
        ]
    );
}

#[test]
fn every_exposed_offset_is_an_extended_grapheme_boundary() {
    let text = "e\u{301}👨‍👩‍👧‍👦👍🏽 A";
    let index_map = TextIndexMap::new(text);
    let opportunities = line_break_opportunities(text);

    assert!(opportunities.iter().all(|opportunity| index_map
        .utf8_to_grapheme(opportunity.offset().get())
        .is_some()));
    assert_eq!(
        opportunities.last().map(|opportunity| opportunity.kind()),
        Some(LineBreakKind::EndOfText)
    );
}

#[test]
fn omits_soft_hyphen_breaks_until_visible_hyphen_insertion_is_supported() {
    let text = "co\u{ad}operate";
    let after_soft_hyphen = "co\u{ad}".len();

    assert!(!line_break_opportunities(text).iter().any(|opportunity| {
        opportunity.kind() == LineBreakKind::Soft && opportunity.offset().get() == after_soft_hyphen
    }));
}

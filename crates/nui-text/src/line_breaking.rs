//! Grapheme-safe typed line break opportunities over UAX #14.

use unicode_linebreak::{linebreaks, BreakOpportunity};

use crate::{TextIndexMap, Utf8Offset};

/// A normalized line break category owned by Nexa UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LineBreakKind {
    /// Optional wrap opportunity that does not consume a hard separator.
    Soft,
    /// Required break after a hard separator such as LF or CRLF.
    Hard,
    /// Synthetic terminal opportunity; every source has exactly one.
    EndOfText,
}

/// A grapheme-aligned absolute UTF-8 offset after which a line may end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LineBreakOpportunity {
    offset: Utf8Offset,
    kind: LineBreakKind,
}

impl LineBreakOpportunity {
    #[must_use]
    pub const fn offset(self) -> Utf8Offset {
        self.offset
    }

    #[must_use]
    pub const fn kind(self) -> LineBreakKind {
        self.kind
    }
}

/// Returns UAX #14 opportunities as stable, grapheme-safe Nexa UI types.
///
/// `unicode-linebreak 0.1.5` reports byte offsets and uses `Mandatory` both for
/// hard separators and end-of-text. This wrapper distinguishes those cases and
/// synthesizes a terminal opportunity after a trailing hard break.
/// The pinned dependency uses Unicode 15.0 and resolves complex-context `SA`
/// characters as `AL`; dictionary-based line breaking is outside this contract.
/// Soft-hyphen opportunities are omitted until paragraph output can insert a
/// visible hyphen at the selected break.
///
/// See <https://docs.rs/unicode-linebreak/0.1.5/unicode_linebreak/fn.linebreaks.html>.
#[must_use]
pub fn line_break_opportunities(text: &str) -> Vec<LineBreakOpportunity> {
    let index_map = TextIndexMap::new(text);
    let mut opportunities = Vec::new();

    for (offset, opportunity) in linebreaks(text) {
        if index_map.utf8_to_grapheme(offset).is_none() {
            continue;
        }
        let kind = match opportunity {
            BreakOpportunity::Allowed => {
                if preceding_character(text, offset) == Some('\u{ad}') {
                    continue;
                }
                LineBreakKind::Soft
            }
            BreakOpportunity::Mandatory if hard_break_start(text, offset).is_some() => {
                LineBreakKind::Hard
            }
            BreakOpportunity::Mandatory => LineBreakKind::EndOfText,
        };
        opportunities.push(LineBreakOpportunity {
            offset: Utf8Offset::validated(offset, text.len()),
            kind,
        });
    }

    if !matches!(
        opportunities.last(),
        Some(opportunity)
            if opportunity.offset.get() == text.len()
                && opportunity.kind == LineBreakKind::EndOfText
    ) {
        opportunities.push(LineBreakOpportunity {
            offset: Utf8Offset::validated(text.len(), text.len()),
            kind: LineBreakKind::EndOfText,
        });
    }

    opportunities
}

pub(crate) fn hard_break_start(text: &str, offset: usize) -> Option<usize> {
    let prefix = text.get(..offset)?;
    let (last_start, last) = prefix.char_indices().next_back()?;
    if last == '\n' && prefix[..last_start].ends_with('\r') {
        return Some(last_start - '\r'.len_utf8());
    }
    is_hard_break_character(last).then_some(last_start)
}

fn preceding_character(text: &str, offset: usize) -> Option<char> {
    text.get(..offset)?.chars().next_back()
}

fn is_hard_break_character(character: char) -> bool {
    matches!(
        character,
        '\n' | '\r' | '\u{000b}' | '\u{000c}' | '\u{0085}' | '\u{2028}' | '\u{2029}'
    )
}

//! Grapheme-safe editable text state and selection contracts.

use std::fmt;

use crate::TextIndexMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GraphemeIndex(pub usize);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GraphemeRange {
    pub start: GraphemeIndex,
    pub end: GraphemeIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextSelection {
    pub anchor: GraphemeIndex,
    pub focus: GraphemeIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Utf16Selection {
    pub anchor: usize,
    pub focus: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Utf16Range {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompositionRange {
    pub range: GraphemeRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditError {
    InvalidRange {
        start: usize,
        end: usize,
        grapheme_count: usize,
    },
    InvalidUtf16Range {
        start: usize,
        end: usize,
        utf16_length: usize,
    },
    StaleRevision {
        expected: u64,
        actual: u64,
    },
    RevisionExhausted,
}

impl fmt::Display for EditError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRange {
                start,
                end,
                grapheme_count,
            } => write!(
                formatter,
                "grapheme range {start}..{end} is outside text with {grapheme_count} clusters"
            ),
            Self::InvalidUtf16Range {
                start,
                end,
                utf16_length,
            } => write!(
                formatter,
                "UTF-16 range {start}..{end} is not a valid text boundary in text of length {utf16_length}"
            ),
            Self::StaleRevision { expected, actual } => {
                write!(
                    formatter,
                    "edit revision {expected} is stale; current revision is {actual}"
                )
            }
            Self::RevisionExhausted => formatter.write_str("editable text revision exhausted"),
        }
    }
}

impl std::error::Error for EditError {}

impl GraphemeRange {
    #[must_use]
    pub const fn new(start: usize, end: usize) -> Self {
        Self {
            start: GraphemeIndex(start),
            end: GraphemeIndex(end),
        }
    }
}

impl TextSelection {
    #[must_use]
    pub const fn collapsed(index: usize) -> Self {
        Self {
            anchor: GraphemeIndex(index),
            focus: GraphemeIndex(index),
        }
    }

    #[must_use]
    pub const fn new(anchor: usize, focus: usize) -> Self {
        Self {
            anchor: GraphemeIndex(anchor),
            focus: GraphemeIndex(focus),
        }
    }

    #[must_use]
    pub const fn is_collapsed(self) -> bool {
        self.anchor.0 == self.focus.0
    }

    #[must_use]
    pub const fn range(self) -> GraphemeRange {
        if self.anchor.0 <= self.focus.0 {
            GraphemeRange::new(self.anchor.0, self.focus.0)
        } else {
            GraphemeRange::new(self.focus.0, self.anchor.0)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditableText {
    value: String,
    selection: TextSelection,
    composition: Option<ActiveComposition>,
    revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveComposition {
    utf8_start: usize,
    utf8_end: usize,
    selection: Utf16Range,
    snapshot: Option<CompositionSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CompositionSnapshot {
    value: String,
    selection: TextSelection,
}

impl EditableText {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        let value = value.into();
        let caret = TextIndexMap::new(&value).grapheme_count();
        Self {
            value,
            selection: TextSelection::collapsed(caret),
            composition: None,
            revision: 0,
        }
    }

    #[must_use]
    pub fn value(&self) -> &str {
        &self.value
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub const fn selection(&self) -> TextSelection {
        self.selection
    }

    /// Return the selected source text in logical order. Reversed selections
    /// use the same normalized grapheme range as replacement and deletion.
    #[must_use]
    pub fn selected_text(&self) -> &str {
        let range = self.selection.range();
        let map = TextIndexMap::new(&self.value);
        let start = map
            .grapheme_to_utf8(range.start.0)
            .expect("selection start is validated");
        let end = map
            .grapheme_to_utf8(range.end.0)
            .expect("selection end is validated");
        &self.value[start..end]
    }

    #[must_use]
    pub fn composition(&self) -> Option<CompositionRange> {
        self.composition
            .as_ref()
            .map(|composition| CompositionRange {
                range: self.composition_grapheme_range(composition),
            })
    }

    /// Active preedit range in absolute UTF-16 code units.
    #[must_use]
    pub fn composition_utf16_range(&self) -> Option<Utf16Range> {
        self.composition.as_ref().map(|composition| Utf16Range {
            start: self.value[..composition.utf8_start].encode_utf16().count(),
            end: self.value[..composition.utf8_end].encode_utf16().count(),
        })
    }

    /// Cursor or selection reported by the IME, relative to the preedit.
    #[must_use]
    pub fn composition_selection(&self) -> Option<Utf16Range> {
        self.composition
            .as_ref()
            .map(|composition| composition.selection)
    }

    pub fn set_selection(&mut self, selection: TextSelection) -> Result<(), EditError> {
        self.validate_range(selection.range())?;
        self.selection = selection;
        Ok(())
    }

    /// Number of user-perceived grapheme clusters in the current value.
    #[must_use]
    pub fn grapheme_count(&self) -> usize {
        TextIndexMap::new(&self.value).grapheme_count()
    }

    /// Set the caret, optionally retaining the existing anchor for a shifted
    /// keyboard selection.
    pub fn set_caret(&mut self, index: usize, extend: bool) -> Result<(), EditError> {
        let count = self.grapheme_count();
        if index > count {
            return Err(EditError::InvalidRange {
                start: index,
                end: index,
                grapheme_count: count,
            });
        }
        self.selection = if extend {
            TextSelection {
                anchor: self.selection.anchor,
                focus: GraphemeIndex(index),
            }
        } else {
            TextSelection::collapsed(index)
        };
        Ok(())
    }

    /// Move the caret by grapheme clusters, preserving the anchor when
    /// `extend` is true.
    pub fn move_caret(&mut self, delta: isize, extend: bool) -> Result<(), EditError> {
        let current = self.selection.focus.0;
        let next = if delta.is_negative() {
            current.saturating_sub(delta.unsigned_abs())
        } else {
            current
                .saturating_add(delta as usize)
                .min(self.grapheme_count())
        };
        self.set_caret(next, extend)
    }

    /// Collapse a non-empty selection to its logical start or end.
    pub fn collapse_selection(&mut self, to_end: bool) {
        let index = if to_end {
            self.selection.range().end.0
        } else {
            self.selection.range().start.0
        };
        self.selection = TextSelection::collapsed(index);
    }

    pub fn set_composition(&mut self, range: Option<GraphemeRange>) -> Result<(), EditError> {
        if let Some(range) = range {
            self.validate_range(range)?;
            let map = TextIndexMap::new(&self.value);
            let utf8_start = map
                .grapheme_to_utf8(range.start.0)
                .expect("validated composition start");
            let utf8_end = map
                .grapheme_to_utf8(range.end.0)
                .expect("validated composition end");
            let utf16_length = self.value[utf8_start..utf8_end].encode_utf16().count();
            self.composition = Some(ActiveComposition {
                utf8_start,
                utf8_end,
                selection: Utf16Range {
                    start: utf16_length,
                    end: utf16_length,
                },
                snapshot: None,
            });
        } else {
            self.composition = None;
        }
        Ok(())
    }

    /// Begin a platform IME preedit without changing the committed value.
    pub fn start_composition(&mut self) {
        if self.composition.is_some() {
            return;
        }
        let range = self.selection.range();
        let map = TextIndexMap::new(&self.value);
        self.composition = Some(ActiveComposition {
            utf8_start: map
                .grapheme_to_utf8(range.start.0)
                .expect("selection start is validated"),
            utf8_end: map
                .grapheme_to_utf8(range.end.0)
                .expect("selection end is validated"),
            selection: Utf16Range { start: 0, end: 0 },
            snapshot: Some(CompositionSnapshot {
                value: self.value.clone(),
                selection: self.selection,
            }),
        });
    }

    /// Replace the active preedit and place its cursor at the end.
    pub fn update_composition(&mut self, preedit: &str) -> Result<(), EditError> {
        self.update_composition_with_selection(preedit, None)
    }

    /// Replace the active preedit while preserving the IME cursor or selection
    /// as UTF-16 code units relative to `preedit`.
    pub fn update_composition_with_selection(
        &mut self,
        preedit: &str,
        selection: Option<Utf16Range>,
    ) -> Result<(), EditError> {
        let selection = validate_composition_selection(preedit, selection)?;
        let next_revision = self.checked_next_revision()?;
        if self.composition.is_none() {
            self.start_composition();
        }
        let composition = self
            .composition
            .as_ref()
            .expect("composition starts before update");
        let start = composition.utf8_start;
        let end = composition.utf8_end;
        self.value.replace_range(start..end, preedit);
        let next_map = TextIndexMap::new(&self.value);
        let selection_start = start
            + utf16_to_utf8(preedit, selection.start).expect("composition selection was validated");
        let selection_end = start
            + utf16_to_utf8(preedit, selection.end).expect("composition selection was validated");
        self.selection = TextSelection::new(
            grapheme_at_or_after(&next_map, selection_start),
            grapheme_at_or_after(&next_map, selection_end),
        );
        let composition = self
            .composition
            .as_mut()
            .expect("composition remains active during update");
        composition.utf8_start = start;
        composition.utf8_end = start + preedit.len();
        composition.selection = selection;
        self.revision = next_revision;
        Ok(())
    }

    /// Commit the current preedit as ordinary text and clear composition
    /// state. With no active preedit this behaves like normal insertion.
    pub fn commit_composition(&mut self, text: &str) -> Result<(), EditError> {
        if let Some(composition) = self.composition.as_ref() {
            let next_revision = self.checked_next_revision()?;
            let start = composition.utf8_start;
            let end = composition.utf8_end;
            self.value.replace_range(start..end, text);
            let next_map = TextIndexMap::new(&self.value);
            let caret = grapheme_at_or_after(&next_map, start + text.len());
            self.selection = TextSelection::collapsed(caret);
            self.composition = None;
            self.revision = next_revision;
        } else {
            self.replace_selection(text, None)?;
        }
        Ok(())
    }

    /// Cancel preedit and restore the committed value and selection captured
    /// at [`Self::start_composition`].
    pub fn cancel_composition(&mut self) -> Result<bool, EditError> {
        let Some(composition) = self.composition.as_ref() else {
            return Ok(false);
        };
        let Some(snapshot) = composition.snapshot.as_ref() else {
            self.composition = None;
            return Ok(false);
        };
        let changed = self.value != snapshot.value || self.selection != snapshot.selection;
        let next_revision = changed.then(|| self.checked_next_revision()).transpose()?;
        self.value.clone_from(&snapshot.value);
        self.selection = snapshot.selection;
        self.composition = None;
        if let Some(next_revision) = next_revision {
            self.revision = next_revision;
        }
        Ok(changed)
    }

    pub fn replace_selection(
        &mut self,
        text: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), EditError> {
        self.replace_range(self.selection.range(), text, expected_revision)
    }

    /// Replace a UTF-16 code-unit range received from TypeScript/IME. The
    /// range must land on extended grapheme boundaries.
    pub fn replace_utf16_range(
        &mut self,
        range: Utf16Range,
        text: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), EditError> {
        let map = TextIndexMap::new(&self.value);
        let start = map
            .utf16_to_grapheme(range.start)
            .ok_or(EditError::InvalidUtf16Range {
                start: range.start,
                end: range.end,
                utf16_length: self.value.encode_utf16().count(),
            })?;
        let end = map
            .utf16_to_grapheme(range.end)
            .ok_or(EditError::InvalidUtf16Range {
                start: range.start,
                end: range.end,
                utf16_length: self.value.encode_utf16().count(),
            })?;
        self.replace_range(GraphemeRange::new(start, end), text, expected_revision)
    }

    pub fn replace_range(
        &mut self,
        range: GraphemeRange,
        text: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), EditError> {
        self.check_revision(expected_revision)?;
        self.validate_range(range)?;
        let map = TextIndexMap::new(&self.value);
        let start = map
            .grapheme_to_utf8(range.start.0)
            .expect("validated grapheme start");
        let end = map
            .grapheme_to_utf8(range.end.0)
            .expect("validated grapheme end");
        self.next_revision()?;
        self.value.replace_range(start..end, text);
        let next_map = TextIndexMap::new(&self.value);
        let caret_utf8 = start + text.len();
        let caret = next_map
            .utf8_to_grapheme(caret_utf8)
            .or_else(|| {
                next_map
                    .boundaries()
                    .iter()
                    .position(|boundary| boundary.utf8_start > caret_utf8)
            })
            .unwrap_or_else(|| next_map.grapheme_count());
        self.selection = TextSelection::collapsed(caret);
        self.composition = None;
        Ok(())
    }

    pub fn delete_backward(&mut self, expected_revision: Option<u64>) -> Result<bool, EditError> {
        self.check_revision(expected_revision)?;
        let range = if self.selection.is_collapsed() {
            let caret = self.selection.focus.0;
            if caret == 0 {
                return Ok(false);
            }
            GraphemeRange::new(caret - 1, caret)
        } else {
            self.selection.range()
        };
        self.replace_range(range, "", expected_revision)
            .map(|()| true)
    }

    pub fn delete_forward(&mut self, expected_revision: Option<u64>) -> Result<bool, EditError> {
        self.check_revision(expected_revision)?;
        let range = if self.selection.is_collapsed() {
            let caret = self.selection.focus.0;
            let count = TextIndexMap::new(&self.value).grapheme_count();
            if caret >= count {
                return Ok(false);
            }
            GraphemeRange::new(caret, caret + 1)
        } else {
            self.selection.range()
        };
        self.replace_range(range, "", expected_revision)
            .map(|()| true)
    }

    #[must_use]
    pub fn utf16_selection(&self) -> Utf16Selection {
        if let (Some(composition), Some(range)) =
            (self.composition.as_ref(), self.composition_utf16_range())
        {
            return Utf16Selection {
                anchor: range.start + composition.selection.start,
                focus: range.start + composition.selection.end,
            };
        }
        let map = TextIndexMap::new(&self.value);
        Utf16Selection {
            anchor: map
                .grapheme_to_utf16(self.selection.anchor.0)
                .expect("selection is validated"),
            focus: map
                .grapheme_to_utf16(self.selection.focus.0)
                .expect("selection is validated"),
        }
    }

    fn check_revision(&self, expected_revision: Option<u64>) -> Result<(), EditError> {
        if let Some(expected) = expected_revision {
            if expected != self.revision {
                return Err(EditError::StaleRevision {
                    expected,
                    actual: self.revision,
                });
            }
        }
        Ok(())
    }

    fn next_revision(&mut self) -> Result<(), EditError> {
        self.revision = self.checked_next_revision()?;
        Ok(())
    }

    fn checked_next_revision(&self) -> Result<u64, EditError> {
        self.revision
            .checked_add(1)
            .ok_or(EditError::RevisionExhausted)
    }

    fn validate_range(&self, range: GraphemeRange) -> Result<(), EditError> {
        let count = TextIndexMap::new(&self.value).grapheme_count();
        if range.start.0 > range.end.0 || range.end.0 > count {
            return Err(EditError::InvalidRange {
                start: range.start.0,
                end: range.end.0,
                grapheme_count: count,
            });
        }
        Ok(())
    }

    fn composition_grapheme_range(&self, composition: &ActiveComposition) -> GraphemeRange {
        let map = TextIndexMap::new(&self.value);
        if composition.utf8_start == composition.utf8_end {
            let caret = grapheme_at_or_after(&map, composition.utf8_start);
            return GraphemeRange::new(caret, caret);
        }
        GraphemeRange::new(
            grapheme_at_or_before(&map, composition.utf8_start),
            grapheme_at_or_after(&map, composition.utf8_end),
        )
    }
}

fn validate_composition_selection(
    preedit: &str,
    selection: Option<Utf16Range>,
) -> Result<Utf16Range, EditError> {
    let utf16_length = preedit.encode_utf16().count();
    let selection = selection.unwrap_or(Utf16Range {
        start: utf16_length,
        end: utf16_length,
    });
    if selection.start > selection.end
        || selection.end > utf16_length
        || utf16_to_utf8(preedit, selection.start).is_none()
        || utf16_to_utf8(preedit, selection.end).is_none()
    {
        return Err(EditError::InvalidUtf16Range {
            start: selection.start,
            end: selection.end,
            utf16_length,
        });
    }
    Ok(selection)
}

fn utf16_to_utf8(text: &str, offset: usize) -> Option<usize> {
    if offset == 0 {
        return Some(0);
    }
    let mut utf16 = 0;
    for (utf8, value) in text.char_indices() {
        utf16 += value.len_utf16();
        if utf16 == offset {
            return Some(utf8 + value.len_utf8());
        }
        if utf16 > offset {
            return None;
        }
    }
    (utf16 == offset).then_some(text.len())
}

fn grapheme_at_or_before(map: &TextIndexMap, utf8: usize) -> usize {
    map.utf8_to_grapheme(utf8).unwrap_or_else(|| {
        map.boundaries()
            .iter()
            .position(|boundary| boundary.utf8_start < utf8 && utf8 < boundary.utf8_end)
            .unwrap_or_else(|| map.grapheme_count())
    })
}

fn grapheme_at_or_after(map: &TextIndexMap, utf8: usize) -> usize {
    map.utf8_to_grapheme(utf8).unwrap_or_else(|| {
        map.boundaries()
            .iter()
            .position(|boundary| boundary.utf8_start < utf8 && utf8 < boundary.utf8_end)
            .map_or_else(|| map.grapheme_count(), |index| index + 1)
    })
}

#[cfg(test)]
mod editable_tests {
    use super::{EditError, EditableText, GraphemeRange, TextSelection, Utf16Range};

    #[test]
    fn replacement_is_grapheme_safe_and_updates_revision_and_caret() {
        let mut text = EditableText::new("A😀e\u{301}");
        text.set_selection(TextSelection::new(1, 2)).unwrap();
        text.replace_selection("中", Some(0)).unwrap();
        assert_eq!(text.value(), "A中e\u{301}");
        assert_eq!(text.selection(), TextSelection::collapsed(2));
        assert_eq!(text.revision(), 1);
    }

    #[test]
    fn stale_revision_rejects_without_mutating_buffer_or_selection() {
        let mut text = EditableText::new("😀x");
        text.set_selection(TextSelection::collapsed(1)).unwrap();
        let before = text.clone();
        assert_eq!(
            text.replace_selection("z", Some(7)),
            Err(EditError::StaleRevision {
                expected: 7,
                actual: 0,
            })
        );
        assert_eq!(text, before);
    }

    #[test]
    fn backward_and_forward_delete_remove_whole_grapheme_clusters() {
        let mut text = EditableText::new("A👨‍👩‍👧‍👦B");
        text.set_selection(TextSelection::collapsed(2)).unwrap();
        assert!(text.delete_backward(Some(0)).unwrap());
        assert_eq!(text.value(), "AB");
        assert!(text.delete_forward(Some(1)).unwrap());
        assert_eq!(text.value(), "A");
        assert!(!text.delete_forward(Some(2)).unwrap());
    }

    #[test]
    fn utf16_selection_maps_emoji_and_composition_validates_ranges() {
        let mut text = EditableText::new("A😀中");
        text.set_selection(TextSelection::new(1, 2)).unwrap();
        assert_eq!(text.utf16_selection().anchor, 1);
        assert_eq!(text.utf16_selection().focus, 3);
        text.set_composition(Some(GraphemeRange::new(1, 2)))
            .unwrap();
        assert!(text.composition().is_some());
        assert_eq!(
            text.set_composition(Some(GraphemeRange::new(0, 9))),
            Err(EditError::InvalidRange {
                start: 0,
                end: 9,
                grapheme_count: 3,
            })
        );
    }

    #[test]
    fn composition_update_commit_and_cancel_keep_preedit_separate() {
        let mut text = EditableText::new("a");
        text.set_caret(1, false).expect("caret");
        text.start_composition();
        text.update_composition("n").expect("preedit");
        assert_eq!(text.value(), "an");
        assert_eq!(
            text.composition().expect("range").range,
            GraphemeRange::new(1, 2)
        );
        text.commit_composition("你").expect("commit");
        assert_eq!(text.value(), "a你");
        assert_eq!(text.composition(), None);

        text.start_composition();
        text.update_composition("x").expect("preedit");
        assert!(text.cancel_composition().expect("cancel"));
        assert_eq!(text.value(), "a你");
        assert_eq!(text.composition(), None);
    }

    #[test]
    fn combining_preedit_after_committed_text_keeps_an_exact_cancel_range() {
        let mut text = EditableText::new("e");
        text.start_composition();

        text.update_composition_with_selection("\u{301}", Some(Utf16Range { start: 1, end: 1 }))
            .expect("combining preedit must not require a new grapheme boundary");

        assert_eq!(text.value(), "e\u{301}");
        assert_eq!(
            text.composition_utf16_range(),
            Some(Utf16Range { start: 1, end: 2 })
        );
        assert!(text.cancel_composition().expect("cancel combining preedit"));
        assert_eq!(text.value(), "e");
    }

    #[test]
    fn composition_preserves_relative_utf16_cursor_and_selection() {
        let mut text = EditableText::new("prefix ");
        text.start_composition();

        text.update_composition_with_selection("A😀B", Some(Utf16Range { start: 1, end: 3 }))
            .expect("surrogate-pair selection boundaries");

        assert_eq!(
            text.composition_selection(),
            Some(Utf16Range { start: 1, end: 3 })
        );
        assert_eq!(
            text.composition_utf16_range(),
            Some(Utf16Range { start: 7, end: 11 })
        );
    }

    #[test]
    fn composition_commit_replaces_only_combining_preedit_bytes() {
        let mut text = EditableText::new("e");
        text.start_composition();
        text.update_composition("\u{301}")
            .expect("combining preedit");

        text.commit_composition("x")
            .expect("commit replaces exact preedit range");

        assert_eq!(text.value(), "ex");
        assert_eq!(text.composition(), None);
    }

    #[test]
    fn invalid_composition_selection_is_rejected_atomically() {
        let mut text = EditableText::new("committed");
        let before = text.clone();

        assert!(matches!(
            text.update_composition_with_selection("😀", Some(Utf16Range { start: 1, end: 1 }),),
            Err(EditError::InvalidUtf16Range { .. })
        ));
        assert_eq!(text, before);
    }

    #[test]
    fn clearing_a_legacy_composition_cannot_leave_update_in_an_invalid_state() {
        let mut text = EditableText::new("base");
        text.start_composition();
        text.set_composition(None).expect("clear composition");

        text.update_composition("x")
            .expect("update starts a fresh composition");

        assert_eq!(text.value(), "basex");
        assert!(text.cancel_composition().expect("cancel fresh composition"));
        assert_eq!(text.value(), "base");
    }

    #[test]
    fn revision_exhaustion_keeps_composition_transitions_atomic() {
        let mut update = EditableText::new("base");
        update.revision = u64::MAX;
        let before_update = update.clone();
        assert_eq!(
            update.update_composition("x"),
            Err(EditError::RevisionExhausted)
        );
        assert_eq!(update, before_update);

        let mut cancel = EditableText::new("base");
        cancel.update_composition("x").expect("active preedit");
        cancel.revision = u64::MAX;
        let before_cancel = cancel.clone();
        assert_eq!(
            cancel.cancel_composition(),
            Err(EditError::RevisionExhausted)
        );
        assert_eq!(cancel, before_cancel);
    }

    #[test]
    fn utf16_replace_rejects_surrogate_interior_and_replaces_emoji_boundary() {
        let mut text = EditableText::new("A😀中");
        assert!(matches!(
            text.replace_utf16_range(Utf16Range { start: 2, end: 3 }, "x", None),
            Err(EditError::InvalidUtf16Range { .. })
        ));
        text.replace_utf16_range(Utf16Range { start: 1, end: 3 }, "你", None)
            .expect("emoji boundary");
        assert_eq!(text.value(), "A你中");
    }

    #[test]
    fn selected_text_preserves_reversed_cjk_emoji_and_combining_boundaries() {
        let mut text = EditableText::new("第一行\n✍🏽‍✍️e\u{301}尾");
        text.set_selection(TextSelection::new(6, 2))
            .expect("cross-line selection");

        assert_eq!(text.selected_text(), "行\n✍🏽‍✍️e\u{301}");
    }
}

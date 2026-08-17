//! Multiline editor controller built on top of [`EditableText`].

use std::ops::{Deref, DerefMut, Range};

use unicode_segmentation::UnicodeSegmentation;

use crate::{
    CaretAffinity, EditError, EditableText, HorizontalDirection, ParagraphSnapshot, TextHit,
    Utf8Offset, Utf8Range,
};

#[cfg(test)]
use crate::TextSelection;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerticalDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextAreaController {
    editor: EditableText,
    preferred_column: Option<usize>,
    preferred_x: Option<f32>,
    viewport_lines: usize,
    first_visible_line: usize,
}

impl Deref for TextAreaController {
    type Target = EditableText;

    fn deref(&self) -> &Self::Target {
        &self.editor
    }
}

impl DerefMut for TextAreaController {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.preferred_x = None;
        &mut self.editor
    }
}

impl TextAreaController {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            editor: EditableText::new(value),
            preferred_column: None,
            preferred_x: None,
            viewport_lines: 1,
            first_visible_line: 0,
        }
    }

    #[must_use]
    pub fn editor(&self) -> &EditableText {
        &self.editor
    }

    #[must_use]
    pub fn editor_mut(&mut self) -> &mut EditableText {
        self.preferred_x = None;
        &mut self.editor
    }

    pub fn set_viewport_lines(&mut self, lines: usize) {
        self.viewport_lines = lines.max(1);
        self.ensure_caret_visible();
    }

    #[must_use]
    pub const fn first_visible_line(&self) -> usize {
        self.first_visible_line
    }

    #[must_use]
    pub fn line_count(&self) -> usize {
        line_starts(self.editor.value()).len()
    }

    #[must_use]
    pub fn visible_line_range(&self) -> Range<usize> {
        let end = (self.first_visible_line + self.viewport_lines).min(self.line_count());
        self.first_visible_line.min(end)..end
    }

    pub fn move_vertical(
        &mut self,
        direction: VerticalDirection,
        extend: bool,
    ) -> Result<(), EditError> {
        let starts = line_starts(self.editor.value());
        let caret = self.editor.selection().focus.0;
        let (line, column) = line_and_column(self.editor.value(), &starts, caret);
        let preferred = self.preferred_column.unwrap_or(column);
        let target_line = match direction {
            VerticalDirection::Up => line.saturating_sub(1),
            VerticalDirection::Down => (line + 1).min(starts.len().saturating_sub(1)),
        };
        let target = starts[target_line]
            + preferred.min(line_len(self.editor.value(), &starts, target_line));
        self.editor.set_caret(target, extend)?;
        self.preferred_column = Some(preferred);
        self.ensure_caret_visible();
        Ok(())
    }

    /// Move between laid-out visual lines while retaining the original pixel x.
    /// The caller supplies the current affinity because a soft-wrap boundary has
    /// one logical offset but distinct upstream/downstream visual positions.
    pub fn move_vertical_in_snapshot(
        &mut self,
        snapshot: &ParagraphSnapshot,
        affinity: CaretAffinity,
        direction: VerticalDirection,
        extend: bool,
    ) -> Result<TextHit, EditError> {
        let current = self.current_visual_position(snapshot, affinity)?;
        let preferred_x = self.preferred_x.unwrap_or(current.1);
        let target_line = match direction {
            VerticalDirection::Up => current.0.saturating_sub(1),
            VerticalDirection::Down => {
                (current.0 + 1).min(snapshot.lines().len().saturating_sub(1))
            }
        };
        let metrics = snapshot.lines()[target_line].metrics();
        let target = snapshot
            .hit_test(preferred_x, metrics.top() + metrics.height() * 0.5)
            .expect("a laid-out visual line has at least one caret stop");
        self.set_caret_from_hit(snapshot, target, extend)?;
        self.preferred_x = Some(preferred_x);
        self.preferred_column = None;
        self.ensure_caret_visible();
        Ok(target)
    }

    /// Move between adjacent visual caret stops on the current paragraph
    /// line, crossing soft-wrap boundaries when the edge is reached.
    pub fn move_horizontal_in_snapshot(
        &mut self,
        snapshot: &ParagraphSnapshot,
        affinity: CaretAffinity,
        direction: HorizontalDirection,
        extend: bool,
    ) -> Result<TextHit, EditError> {
        let current = self.current_utf8_offset(snapshot)?;
        let target = snapshot
            .adjacent_caret(current, affinity, direction)
            .ok_or(EditError::InvalidRange {
                start: self.editor.selection().focus.0,
                end: self.editor.selection().focus.0,
                grapheme_count: snapshot.index_map().grapheme_count(),
            })?;
        self.set_caret_from_hit(snapshot, target, extend)?;
        self.preferred_x = None;
        self.preferred_column = None;
        self.ensure_caret_visible();
        Ok(target)
    }

    /// Move to the visual start (`to_end = false`) or end of the current
    /// laid-out line. This keeps Home/End local to soft-wrapped lines.
    pub fn move_to_line_edge_in_snapshot(
        &mut self,
        snapshot: &ParagraphSnapshot,
        affinity: CaretAffinity,
        to_end: bool,
        extend: bool,
    ) -> Result<TextHit, EditError> {
        let (line_index, _) = self.current_visual_position(snapshot, affinity)?;
        let line = &snapshot.lines()[line_index];
        let x = if to_end {
            line.caret_stops().last()
        } else {
            line.caret_stops().first()
        }
        .expect("a laid-out visual line has at least one caret stop")
        .x();
        let metrics = line.metrics();
        let target = snapshot
            .hit_test(x, metrics.top() + metrics.height() * 0.5)
            .expect("a laid-out visual line has at least one caret stop");
        self.set_caret_from_hit(snapshot, target, extend)?;
        self.preferred_x = None;
        self.preferred_column = None;
        self.ensure_caret_visible();
        Ok(target)
    }

    fn current_visual_position(
        &self,
        snapshot: &ParagraphSnapshot,
        affinity: CaretAffinity,
    ) -> Result<(usize, f32), EditError> {
        let focus = self.editor.selection().focus.0;
        if snapshot.text() != self.editor.value() {
            return Err(EditError::InvalidRange {
                start: focus,
                end: focus,
                grapheme_count: snapshot.index_map().grapheme_count(),
            });
        }
        let utf8 = snapshot
            .index_map()
            .grapheme_to_utf8(focus)
            .expect("editor and paragraph share grapheme boundaries");
        let offset = Utf8Range::new(snapshot.text(), utf8, utf8)
            .expect("editor caret is a UTF-8 boundary")
            .start();
        Ok(snapshot
            .lines()
            .iter()
            .enumerate()
            .find_map(|(line, value)| {
                value
                    .caret_stops()
                    .iter()
                    .find(|stop| stop.offset() == offset && stop.affinity() == affinity)
                    .map(|stop| (line, stop.x()))
            })
            .or_else(|| {
                snapshot
                    .lines()
                    .iter()
                    .enumerate()
                    .find_map(|(line, value)| {
                        value
                            .caret_stops()
                            .iter()
                            .find(|stop| stop.offset() == offset)
                            .map(|stop| (line, stop.x()))
                    })
            })
            .expect("paragraph snapshots cover every editor caret boundary"))
    }

    fn current_utf8_offset(&self, snapshot: &ParagraphSnapshot) -> Result<Utf8Offset, EditError> {
        let focus = self.editor.selection().focus.0;
        if snapshot.text() != self.editor.value() {
            return Err(EditError::InvalidRange {
                start: focus,
                end: focus,
                grapheme_count: snapshot.index_map().grapheme_count(),
            });
        }
        let utf8 = snapshot
            .index_map()
            .grapheme_to_utf8(focus)
            .expect("editor and paragraph share grapheme boundaries");
        Utf8Range::new(snapshot.text(), utf8, utf8)
            .map(Utf8Range::start)
            .map_err(|_| EditError::InvalidRange {
                start: focus,
                end: focus,
                grapheme_count: snapshot.index_map().grapheme_count(),
            })
    }

    fn set_caret_from_hit(
        &mut self,
        snapshot: &ParagraphSnapshot,
        hit: TextHit,
        extend: bool,
    ) -> Result<(), EditError> {
        let grapheme = snapshot
            .index_map()
            .utf8_to_grapheme(hit.offset().get())
            .expect("paragraph caret stops are grapheme boundaries");
        self.editor.set_caret(grapheme, extend)
    }

    pub fn move_home(&mut self, extend: bool) -> Result<(), EditError> {
        let starts = line_starts(self.editor.value());
        let line = line_and_column(
            self.editor.value(),
            &starts,
            self.editor.selection().focus.0,
        )
        .0;
        self.editor.set_caret(starts[line], extend)?;
        self.preferred_column = Some(0);
        self.ensure_caret_visible();
        Ok(())
    }

    pub fn move_end(&mut self, extend: bool) -> Result<(), EditError> {
        let starts = line_starts(self.editor.value());
        let line = line_and_column(
            self.editor.value(),
            &starts,
            self.editor.selection().focus.0,
        )
        .0;
        let target = starts[line] + line_len(self.editor.value(), &starts, line);
        self.editor.set_caret(target, extend)?;
        self.preferred_column = Some(line_len(self.editor.value(), &starts, line));
        self.ensure_caret_visible();
        Ok(())
    }

    pub fn ensure_caret_visible(&mut self) {
        let starts = line_starts(self.editor.value());
        let line = line_and_column(
            self.editor.value(),
            &starts,
            self.editor.selection().focus.0,
        )
        .0;
        if line < self.first_visible_line {
            self.first_visible_line = line;
        } else if line >= self.first_visible_line + self.viewport_lines {
            self.first_visible_line = line + 1 - self.viewport_lines;
        }
    }
}

fn line_starts(value: &str) -> Vec<usize> {
    let mut starts = vec![0];
    let mut index = 0;
    for grapheme in value.graphemes(true) {
        index += 1;
        if grapheme == "\n" {
            starts.push(index);
        }
    }
    starts
}

fn line_len(value: &str, starts: &[usize], line: usize) -> usize {
    let start = starts[line];
    let end = starts
        .get(line + 1)
        .copied()
        .unwrap_or_else(|| value.graphemes(true).count());
    let mut length = end.saturating_sub(start);
    if line + 1 < starts.len() {
        length = length.saturating_sub(1);
    }
    length
}

fn line_and_column(value: &str, starts: &[usize], caret: usize) -> (usize, usize) {
    let line = starts
        .iter()
        .enumerate()
        .take_while(|(_, start)| **start <= caret)
        .map(|(index, _)| index)
        .last()
        .unwrap_or(0);
    (
        line,
        caret
            .saturating_sub(starts[line])
            .min(line_len(value, starts, line)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vertical_navigation_preserves_column_and_shift_selection() {
        let mut area = TextAreaController::new("ab\n中😀\nxyz");
        area.editor_mut().set_caret(1, false).expect("caret");
        area.move_vertical(VerticalDirection::Down, false)
            .expect("down");
        assert_eq!(area.editor().selection(), TextSelection::collapsed(4));
        area.move_vertical(VerticalDirection::Down, true)
            .expect("shift down");
        assert_eq!(area.editor().selection(), TextSelection::new(4, 7));
    }

    #[test]
    fn visible_lines_follow_caret_with_a_small_viewport() {
        let mut area = TextAreaController::new("a\nb\nc\nd");
        area.set_viewport_lines(2);
        area.editor_mut().set_caret(6, false).expect("caret");
        area.ensure_caret_visible();
        assert_eq!(area.first_visible_line(), 2);
        assert_eq!(area.visible_line_range(), 2..4);
    }

    #[test]
    fn home_and_end_stop_before_line_breaks() {
        let mut area = TextAreaController::new("ab\n中😀");
        area.editor_mut().set_caret(5, false).expect("caret");
        area.move_home(false).expect("home");
        assert_eq!(area.editor().selection(), TextSelection::collapsed(3));
        area.move_end(false).expect("end");
        assert_eq!(area.editor().selection(), TextSelection::collapsed(5));
    }
}

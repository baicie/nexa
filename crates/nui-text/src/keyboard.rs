//! Platform-neutral keyboard editing commands for [`EditableText`].

use unicode_segmentation::UnicodeSegmentation;

use crate::selection::{EditError, EditableText, GraphemeRange};

#[cfg(test)]
use crate::selection::TextSelection;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyModifiers {
    pub shift: bool,
    pub word: bool,
}

impl KeyModifiers {
    #[must_use]
    pub const fn none() -> Self {
        Self {
            shift: false,
            word: false,
        }
    }

    #[must_use]
    pub const fn word_modifier(self) -> bool {
        self.word
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationKey {
    Left,
    Right,
    Home,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyCommand {
    Navigate(NavigationKey),
    Backspace,
    Delete,
    Enter,
    Unhandled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandOutcome {
    Handled,
    Changed,
    Submit,
    Unhandled,
}

impl KeyCommand {
    pub fn apply(
        self,
        text: &mut EditableText,
        modifiers: KeyModifiers,
        multiline: bool,
    ) -> Result<CommandOutcome, EditError> {
        match self {
            Self::Navigate(key) => {
                if !text.selection().is_collapsed() && !modifiers.shift {
                    let to_end = matches!(key, NavigationKey::Right | NavigationKey::End);
                    text.collapse_selection(to_end);
                    return Ok(CommandOutcome::Handled);
                }
                let target = match key {
                    NavigationKey::Home => 0,
                    NavigationKey::End => text.grapheme_count(),
                    NavigationKey::Left => {
                        if modifiers.word_modifier() {
                            previous_word_boundary(text)
                        } else {
                            text.selection().focus.0.saturating_sub(1)
                        }
                    }
                    NavigationKey::Right => {
                        if modifiers.word_modifier() {
                            next_word_boundary(text)
                        } else {
                            text.selection()
                                .focus
                                .0
                                .saturating_add(1)
                                .min(text.grapheme_count())
                        }
                    }
                };
                text.set_caret(target, modifiers.shift)?;
                Ok(CommandOutcome::Handled)
            }
            Self::Backspace => {
                if modifiers.word_modifier() {
                    delete_to_word_boundary(text, true)
                } else {
                    text.delete_backward(None).map(|changed| {
                        if changed {
                            CommandOutcome::Changed
                        } else {
                            CommandOutcome::Handled
                        }
                    })
                }
            }
            Self::Delete => {
                if modifiers.word_modifier() {
                    delete_to_word_boundary(text, false)
                } else {
                    text.delete_forward(None).map(|changed| {
                        if changed {
                            CommandOutcome::Changed
                        } else {
                            CommandOutcome::Handled
                        }
                    })
                }
            }
            Self::Enter if multiline => text
                .replace_selection("\n", None)
                .map(|()| CommandOutcome::Changed),
            Self::Enter => Ok(CommandOutcome::Submit),
            Self::Unhandled => Ok(CommandOutcome::Unhandled),
        }
    }
}

fn grapheme_strings(text: &EditableText) -> Vec<&str> {
    text.value().graphemes(true).collect()
}

fn is_word(grapheme: &str) -> bool {
    grapheme.chars().any(char::is_alphanumeric) || grapheme == "_"
}

fn previous_word_boundary(text: &EditableText) -> usize {
    let graphemes = grapheme_strings(text);
    let mut index = text.selection().focus.0.min(graphemes.len());
    while index > 0 && !is_word(graphemes[index - 1]) {
        index -= 1;
    }
    while index > 0 && is_word(graphemes[index - 1]) {
        index -= 1;
    }
    index
}

fn next_word_boundary(text: &EditableText) -> usize {
    let graphemes = grapheme_strings(text);
    let mut index = text.selection().focus.0.min(graphemes.len());
    while index < graphemes.len() && !is_word(graphemes[index]) {
        index += 1;
    }
    while index < graphemes.len() && is_word(graphemes[index]) {
        index += 1;
    }
    index
}

fn delete_to_word_boundary(
    text: &mut EditableText,
    backward: bool,
) -> Result<CommandOutcome, EditError> {
    if !text.selection().is_collapsed() {
        return text
            .replace_selection("", None)
            .map(|()| CommandOutcome::Changed);
    }
    let caret = text.selection().focus.0;
    let target = if backward {
        previous_word_boundary(text)
    } else {
        next_word_boundary(text)
    };
    if target == caret {
        return Ok(CommandOutcome::Handled);
    }
    let range = if backward {
        (target, caret)
    } else {
        (caret, target)
    };
    text.replace_range(GraphemeRange::new(range.0, range.1), "", None)
        .map(|()| CommandOutcome::Changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain() -> KeyModifiers {
        KeyModifiers::none()
    }

    #[test]
    fn arrows_extend_and_collapse_grapheme_safe_selection() {
        let mut text = EditableText::new("A😀B");
        text.set_caret(1, false).expect("caret");
        KeyCommand::Navigate(NavigationKey::Right)
            .apply(
                &mut text,
                KeyModifiers {
                    shift: true,
                    ..plain()
                },
                false,
            )
            .expect("shift right");
        assert_eq!(text.selection(), TextSelection::new(1, 2));
        KeyCommand::Navigate(NavigationKey::Left)
            .apply(&mut text, plain(), false)
            .expect("collapse");
        assert_eq!(text.selection(), TextSelection::collapsed(1));
    }

    #[test]
    fn word_navigation_and_deletion_skip_whitespace() {
        let mut text = EditableText::new("one two");
        text.set_caret(7, false).expect("caret");
        KeyCommand::Navigate(NavigationKey::Left)
            .apply(
                &mut text,
                KeyModifiers {
                    word: true,
                    ..plain()
                },
                false,
            )
            .expect("word left");
        assert_eq!(text.selection(), TextSelection::collapsed(4));
        KeyCommand::Backspace
            .apply(
                &mut text,
                KeyModifiers {
                    word: true,
                    ..plain()
                },
                false,
            )
            .expect("word delete");
        assert_eq!(text.value(), "two");
    }

    #[test]
    fn enter_differs_between_single_and_multiline_modes() {
        let mut single = EditableText::new("a");
        assert_eq!(
            KeyCommand::Enter.apply(&mut single, plain(), false),
            Ok(CommandOutcome::Submit)
        );
        let mut multi = EditableText::new("a");
        assert_eq!(
            KeyCommand::Enter.apply(&mut multi, plain(), true),
            Ok(CommandOutcome::Changed)
        );
        assert_eq!(multi.value(), "a\n");
    }
}

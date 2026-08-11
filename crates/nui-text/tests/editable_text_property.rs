use nui_text::{EditError, EditableText, TextIndexMap, TextSelection};
use unicode_segmentation::UnicodeSegmentation;

const SEED: u64 = 0x4e45_5841_4733_4134;
const STEPS: usize = 512;

#[derive(Clone, Debug)]
struct ReferenceEditor {
    value: String,
    selection: TextSelection,
    revision: u64,
}

impl ReferenceEditor {
    fn new(value: &str) -> Self {
        let selection = TextSelection::collapsed(grapheme_offsets(value).len() - 1);
        Self {
            value: value.to_owned(),
            selection,
            revision: 0,
        }
    }

    fn set_selection(&mut self, selection: TextSelection) {
        self.selection = selection;
    }

    fn collapse_selection(&mut self, to_end: bool) {
        let start = self.selection.anchor.0.min(self.selection.focus.0);
        let end = self.selection.anchor.0.max(self.selection.focus.0);
        self.selection = TextSelection::collapsed(if to_end { end } else { start });
    }

    fn replace_selection(&mut self, replacement: &str) {
        let start = self.selection.anchor.0.min(self.selection.focus.0);
        let end = self.selection.anchor.0.max(self.selection.focus.0);
        self.replace_range(start, end, replacement);
    }

    fn delete_backward(&mut self) -> bool {
        let start = self.selection.anchor.0.min(self.selection.focus.0);
        let end = self.selection.anchor.0.max(self.selection.focus.0);
        if start != end {
            self.replace_range(start, end, "");
            return true;
        }
        if start == 0 {
            return false;
        }
        self.replace_range(start - 1, start, "");
        true
    }

    fn delete_forward(&mut self) -> bool {
        let start = self.selection.anchor.0.min(self.selection.focus.0);
        let end = self.selection.anchor.0.max(self.selection.focus.0);
        if start != end {
            self.replace_range(start, end, "");
            return true;
        }
        if start == self.grapheme_count() {
            return false;
        }
        self.replace_range(start, start + 1, "");
        true
    }

    fn grapheme_count(&self) -> usize {
        grapheme_offsets(&self.value).len() - 1
    }

    fn replace_range(&mut self, start: usize, end: usize, replacement: &str) {
        let offsets = grapheme_offsets(&self.value);
        let start_utf8 = offsets[start];
        let end_utf8 = offsets[end];
        self.value.replace_range(start_utf8..end_utf8, replacement);

        let caret_utf8 = start_utf8 + replacement.len();
        let next_offsets = grapheme_offsets(&self.value);
        let caret = next_offsets
            .binary_search(&caret_utf8)
            .unwrap_or_else(|next_boundary| next_boundary);
        self.selection = TextSelection::collapsed(caret);
        self.revision += 1;
    }
}

#[derive(Debug)]
struct SeededRng(u64);

impl SeededRng {
    fn next(&mut self) -> u64 {
        let mut value = self.0;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.0 = value;
        value
    }

    fn index(&mut self, upper_bound: usize) -> usize {
        (self.next() as usize) % upper_bound
    }

    fn bool(&mut self) -> bool {
        self.next() & 1 == 1
    }
}

fn grapheme_offsets(value: &str) -> Vec<usize> {
    value
        .grapheme_indices(true)
        .map(|(offset, _)| offset)
        .chain(std::iter::once(value.len()))
        .collect()
}

fn random_selection(rng: &mut SeededRng, grapheme_count: usize) -> TextSelection {
    TextSelection::new(rng.index(grapheme_count + 1), rng.index(grapheme_count + 1))
}

fn assert_invariants(editor: &EditableText, model: &ReferenceEditor, step: usize) {
    let context = format!("seed {SEED:#018x}, step {step}");
    assert_eq!(editor.value(), model.value, "value mismatch at {context}");
    assert_eq!(
        editor.selection(),
        model.selection,
        "selection mismatch at {context}"
    );
    assert_eq!(
        editor.revision(),
        model.revision,
        "revision mismatch at {context}"
    );

    let map = TextIndexMap::new(editor.value());
    let offsets = grapheme_offsets(editor.value());
    assert_eq!(map.grapheme_count() + 1, offsets.len(), "{context}");

    for (grapheme, utf8) in offsets.iter().copied().enumerate() {
        let utf16 = editor.value()[..utf8].encode_utf16().count();
        let scalar = editor.value()[..utf8].chars().count();
        assert_eq!(map.grapheme_to_utf8(grapheme), Some(utf8), "{context}");
        assert_eq!(map.utf8_to_grapheme(utf8), Some(grapheme), "{context}");
        assert_eq!(map.grapheme_to_utf16(grapheme), Some(utf16), "{context}");
        assert_eq!(map.utf16_to_grapheme(utf16), Some(grapheme), "{context}");
        assert_eq!(map.grapheme_to_scalar(grapheme), Some(scalar), "{context}");
        assert_eq!(map.scalar_to_grapheme(scalar), Some(grapheme), "{context}");
    }

    let selection = editor.selection();
    for index in [selection.anchor.0, selection.focus.0] {
        let utf8 = map
            .grapheme_to_utf8(index)
            .unwrap_or_else(|| panic!("selection outside grapheme map at {context}"));
        assert!(editor.value().is_char_boundary(utf8), "{context}");
        assert_eq!(map.utf8_to_grapheme(utf8), Some(index), "{context}");
    }

    let utf16_selection = editor.utf16_selection();
    assert_eq!(
        map.utf16_to_grapheme(utf16_selection.anchor),
        Some(selection.anchor.0),
        "{context}"
    );
    assert_eq!(
        map.utf16_to_grapheme(utf16_selection.focus),
        Some(selection.focus.0),
        "{context}"
    );
}

#[test]
fn fixed_seed_edit_sequence_preserves_value_selection_and_revision_invariants() {
    const REPLACEMENTS: &[&str] = &[
        "",
        "a",
        "中",
        "ש",
        "😀",
        "e\u{301}",
        "\u{301}",
        "👩‍💻",
        "👍🏽",
        "🇨🇳",
        "\r\n",
        "\u{200d}",
    ];

    let initial = "A😀e\u{301}👨‍👩‍👧‍👦中";
    let mut editor = EditableText::new(initial);
    let mut model = ReferenceEditor::new(initial);
    let mut rng = SeededRng(SEED);
    let mut operation_counts = [0_usize; 8];

    assert_invariants(&editor, &model, 0);

    for step in 1..=STEPS {
        let operation = rng.index(operation_counts.len());
        operation_counts[operation] += 1;
        match operation {
            0 => {
                let selection = random_selection(&mut rng, model.grapheme_count());
                editor
                    .set_selection(selection)
                    .expect("generated selection");
                model.set_selection(selection);
            }
            1 => {
                let target = rng.index(model.grapheme_count() + 1);
                let extend = rng.bool();
                editor.set_caret(target, extend).expect("generated caret");
                model.selection = if extend {
                    TextSelection::new(model.selection.anchor.0, target)
                } else {
                    TextSelection::collapsed(target)
                };
            }
            2 => {
                let to_end = rng.bool();
                editor.collapse_selection(to_end);
                model.collapse_selection(to_end);
            }
            3 => {
                let caret = rng.index(model.grapheme_count() + 1);
                let replacement = REPLACEMENTS[rng.index(REPLACEMENTS.len())];
                editor.set_caret(caret, false).expect("generated caret");
                model.set_selection(TextSelection::collapsed(caret));
                editor
                    .replace_selection(replacement, Some(model.revision))
                    .expect("fresh insertion revision");
                model.replace_selection(replacement);
            }
            4 => {
                let selection = random_selection(&mut rng, model.grapheme_count());
                let replacement = REPLACEMENTS[rng.index(REPLACEMENTS.len())];
                editor
                    .set_selection(selection)
                    .expect("generated selection");
                model.set_selection(selection);
                editor
                    .replace_selection(replacement, Some(model.revision))
                    .expect("fresh replacement revision");
                model.replace_selection(replacement);
            }
            5 => {
                let selection = random_selection(&mut rng, model.grapheme_count());
                editor
                    .set_selection(selection)
                    .expect("generated selection");
                model.set_selection(selection);
                let changed = editor
                    .delete_backward(Some(model.revision))
                    .expect("fresh backward-delete revision");
                assert_eq!(
                    changed,
                    model.delete_backward(),
                    "seed {SEED:#x}, step {step}"
                );
            }
            6 => {
                let selection = random_selection(&mut rng, model.grapheme_count());
                editor
                    .set_selection(selection)
                    .expect("generated selection");
                model.set_selection(selection);
                let changed = editor
                    .delete_forward(Some(model.revision))
                    .expect("fresh forward-delete revision");
                assert_eq!(
                    changed,
                    model.delete_forward(),
                    "seed {SEED:#x}, step {step}"
                );
            }
            7 => {
                let selection = if rng.bool() {
                    TextSelection::collapsed(0)
                } else {
                    TextSelection::collapsed(model.grapheme_count())
                };
                editor
                    .set_selection(selection)
                    .expect("generated selection");
                model.set_selection(selection);
                let stale_revision = model.revision + 1;
                let before = editor.clone();
                let result = match rng.index(3) {
                    0 => editor
                        .replace_selection("stale", Some(stale_revision))
                        .map(|()| false),
                    1 => editor.delete_backward(Some(stale_revision)),
                    _ => editor.delete_forward(Some(stale_revision)),
                };
                assert_eq!(
                    result,
                    Err(EditError::StaleRevision {
                        expected: stale_revision,
                        actual: model.revision,
                    }),
                    "seed {SEED:#x}, step {step}"
                );
                assert_eq!(
                    editor, before,
                    "stale edit mutated state at seed {SEED:#x}, step {step}"
                );
            }
            _ => unreachable!(),
        }

        assert_invariants(&editor, &model, step);
    }

    assert!(
        operation_counts.iter().all(|count| *count >= 40),
        "seed {SEED:#x} did not exercise every operation enough: {operation_counts:?}"
    );
}

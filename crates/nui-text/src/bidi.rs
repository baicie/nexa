//! Script itemization and Unicode Bidirectional Algorithm contracts.

use unicode_bidi::{BidiInfo, Level};
use unicode_script::{Script, UnicodeScript};
use unicode_segmentation::UnicodeSegmentation;

use crate::types::Utf8Range;

/// Horizontal text direction after BiDi resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TextDirection {
    LeftToRight,
    RightToLeft,
}

impl TextDirection {
    fn from_level(level: Level) -> Self {
        if level.is_rtl() {
            Self::RightToLeft
        } else {
            Self::LeftToRight
        }
    }

    const fn level(self) -> Level {
        match self {
            Self::LeftToRight => unicode_bidi::LTR_LEVEL,
            Self::RightToLeft => unicode_bidi::RTL_LEVEL,
        }
    }
}

/// A grapheme-aligned source range with one resolved Unicode script.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptRun {
    pub range: Utf8Range,
    pub script: Script,
}

/// A logical source range with one embedding level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BidiRun {
    pub range: Utf8Range,
    pub level: u8,
    pub direction: TextDirection,
}

/// BiDi resolution for one Unicode paragraph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BidiParagraph {
    pub range: Utf8Range,
    pub base_direction: TextDirection,
    pub base_level: u8,
    pub logical_runs: Vec<BidiRun>,
    pub visual_runs: Vec<BidiRun>,
}

#[derive(Debug, Clone, Copy)]
struct GraphemeScript {
    range: Utf8Range,
    script: Option<Script>,
}

/// Resolves Common and Inherited clusters to adjacent strong scripts.
#[must_use]
pub fn itemize_script(text: &str) -> Vec<ScriptRun> {
    let mut clusters: Vec<_> = text
        .grapheme_indices(true)
        .map(|(start, grapheme)| GraphemeScript {
            range: Utf8Range::validated(start, start + grapheme.len(), text.len()),
            script: strong_script(grapheme),
        })
        .collect();

    for index in 0..clusters.len() {
        if clusters[index].script.is_some() {
            continue;
        }
        let previous = clusters[..index]
            .iter()
            .rev()
            .find_map(|cluster| cluster.script);
        let next = clusters[index + 1..]
            .iter()
            .find_map(|cluster| cluster.script);
        clusters[index].script = Some(previous.or(next).unwrap_or(Script::Common));
    }

    let mut runs: Vec<ScriptRun> = Vec::new();
    for cluster in clusters {
        let script = cluster.script.unwrap_or(Script::Common);
        if let Some(previous) = runs.last_mut() {
            if previous.script == script
                && previous.range.end().get() == cluster.range.start().get()
            {
                previous.range = Utf8Range::validated(
                    previous.range.start().get(),
                    cluster.range.end().get(),
                    text.len(),
                );
                continue;
            }
        }
        runs.push(ScriptRun {
            range: cluster.range,
            script,
        });
    }
    runs
}

/// Runs UAX #9 and returns both logical partitions and their visual order.
#[must_use]
pub fn resolve_bidi(text: &str, default_direction: Option<TextDirection>) -> Vec<BidiParagraph> {
    if text.is_empty() {
        return Vec::new();
    }
    let info = BidiInfo::new(text, default_direction.map(TextDirection::level));

    info.paragraphs
        .iter()
        .map(|paragraph| {
            let levels = info.reordered_levels(paragraph, paragraph.range.clone());
            let mut logical_with_levels: Vec<(BidiRun, Level)> = Vec::new();
            let paragraph_text = &text[paragraph.range.clone()];
            for (relative_start, grapheme) in paragraph_text.grapheme_indices(true) {
                let start = paragraph.range.start + relative_start;
                let end = start + grapheme.len();
                let level = levels[start];
                if let Some((previous, previous_level)) = logical_with_levels.last_mut() {
                    if *previous_level == level && previous.range.end().get() == start {
                        previous.range =
                            Utf8Range::validated(previous.range.start().get(), end, text.len());
                        continue;
                    }
                }
                logical_with_levels.push((
                    BidiRun {
                        range: Utf8Range::validated(start, end, text.len()),
                        level: level.number(),
                        direction: TextDirection::from_level(level),
                    },
                    level,
                ));
            }

            let visual_order = BidiInfo::reorder_visual(
                &logical_with_levels
                    .iter()
                    .map(|(_, level)| *level)
                    .collect::<Vec<_>>(),
            );
            let logical_runs: Vec<_> = logical_with_levels.iter().map(|(run, _)| *run).collect();
            let visual_runs = visual_order
                .into_iter()
                .map(|index| logical_with_levels[index].0)
                .collect();

            BidiParagraph {
                range: Utf8Range::validated(paragraph.range.start, paragraph.range.end, text.len()),
                base_direction: TextDirection::from_level(paragraph.level),
                base_level: paragraph.level.number(),
                logical_runs,
                visual_runs,
            }
        })
        .collect()
}

/// One UAX #9 analysis reused by every visual line in a paragraph snapshot.
pub(crate) struct BidiAnalysis<'text> {
    info: BidiInfo<'text>,
}

impl<'text> BidiAnalysis<'text> {
    pub(crate) fn new(text: &'text str, default_direction: Option<TextDirection>) -> Self {
        Self {
            info: BidiInfo::new(text, default_direction.map(TextDirection::level)),
        }
    }

    /// Applies UAX #9 rules L1/L2 to one already-broken visual line.
    pub(crate) fn visual_runs_for_line(&self, line: Utf8Range) -> Vec<BidiRun> {
        if line.is_empty() {
            return Vec::new();
        }

        let line_start = line.start().get();
        let line_end = line.end().get();
        let Some(paragraph) = self.info.paragraphs.iter().find(|paragraph| {
            paragraph.range.start <= line_start && line_end <= paragraph.range.end
        }) else {
            return Vec::new();
        };
        let (levels, visual_ranges) = self.info.visual_runs(paragraph, line_start..line_end);

        visual_ranges
            .into_iter()
            .map(|range| {
                let level = levels[range.start];
                BidiRun {
                    range: Utf8Range::validated(range.start, range.end, self.info.text.len()),
                    level: level.number(),
                    direction: TextDirection::from_level(level),
                }
            })
            .collect()
    }
}

fn strong_script(grapheme: &str) -> Option<Script> {
    grapheme.chars().find_map(|character| {
        let script = character.script();
        (!matches!(script, Script::Common | Script::Inherited | Script::Unknown)).then_some(script)
    })
}

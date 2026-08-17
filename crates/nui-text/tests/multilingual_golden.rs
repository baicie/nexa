use std::sync::Arc;

use nui_text::{
    layout_paragraph, FontDatabase, FontFaceDescriptor, FontRequest, FontSource, FontStyle,
    GlyphCoverage, LineBreakKind, ParagraphSnapshot, ParagraphStyle, ParagraphWidth, Script,
    TextDirection,
};
use serde::{Deserialize, Serialize};

const MANIFEST: &str = include_str!("fixtures/multilingual-golden.json");
const NOTO_SANS_ARABIC: &[u8] = include_bytes!("fixtures/NotoSansArabic.ttf");

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenManifest {
    schema_version: u32,
    cases: Vec<GoldenCase>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCase {
    id: String,
    text: String,
    font_size: f32,
    max_width: Option<f32>,
    default_direction: String,
    expected: Option<GoldenSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenSnapshot {
    size_64: [i64; 2],
    lines: Vec<GoldenLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenLine {
    source: String,
    content: String,
    break_kind: String,
    advance_64: i64,
    overflows: bool,
    clusters: Vec<GoldenCluster>,
    runs: Vec<GoldenRun>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenCluster {
    source: String,
    direction: String,
    x_64: i64,
    width_64: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenRun {
    source: String,
    font: String,
    direction: String,
    script: String,
    glyphs: Vec<GoldenGlyph>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenGlyph {
    id: u16,
    cluster_utf8: usize,
    x_64: i64,
    y_64: i64,
}

fn register_face(
    database: &mut FontDatabase,
    family: &str,
    scripts: impl IntoIterator<Item = Script>,
    coverage: &str,
    bytes: &[u8],
) {
    database.register_face(
        FontFaceDescriptor::new(
            family,
            FontStyle::default(),
            GlyphCoverage::from_chars(coverage.chars()),
        )
        .expect("golden font descriptor")
        .with_scripts(scripts)
        .with_source(
            FontSource::new(Arc::<[u8]>::from(bytes), 0).expect("golden font source parses"),
        ),
    );
}

fn golden_fonts() -> (FontDatabase, FontRequest) {
    let mut database = FontDatabase::new();
    register_face(
        &mut database,
        "Ahem Golden",
        [Script::Latin],
        "ABC ",
        font_test_data::AHEM,
    );
    register_face(
        &mut database,
        "Noto Serif TC Golden",
        [Script::Han],
        "你們",
        font_test_data::NOTOSERIFTC_AUTOHINT_METRICS,
    );
    register_face(
        &mut database,
        "Noto Sans Arabic Golden",
        [Script::Arabic],
        "مرحبا",
        NOTO_SANS_ARABIC,
    );
    register_face(
        &mut database,
        "Noto Handwriting Golden",
        [Script::Common],
        "✍🏽‍️",
        font_test_data::NOTO_HANDWRITING_SBIX,
    );
    let request = FontRequest::new([
        "Ahem Golden",
        "Noto Serif TC Golden",
        "Noto Sans Arabic Golden",
        "Noto Handwriting Golden",
    ]);
    (database, request)
}

fn direction(value: &str) -> TextDirection {
    match value {
        "ltr" => TextDirection::LeftToRight,
        "rtl" => TextDirection::RightToLeft,
        other => panic!("unknown golden direction {other:?}"),
    }
}

fn direction_name(value: TextDirection) -> String {
    match value {
        TextDirection::LeftToRight => "ltr",
        TextDirection::RightToLeft => "rtl",
    }
    .to_owned()
}

fn break_name(value: LineBreakKind) -> String {
    match value {
        LineBreakKind::Soft => "soft",
        LineBreakKind::Hard => "hard",
        LineBreakKind::EndOfText => "end",
    }
    .to_owned()
}

fn quantize(value: f32) -> i64 {
    assert!(value.is_finite(), "golden geometry must be finite");
    (f64::from(value) * 64.0).round() as i64
}

fn snapshot_golden(database: &FontDatabase, snapshot: &ParagraphSnapshot) -> GoldenSnapshot {
    let text = snapshot.text();
    GoldenSnapshot {
        size_64: [
            quantize(snapshot.size().width()),
            quantize(snapshot.size().height()),
        ],
        lines: snapshot
            .lines()
            .iter()
            .map(|line| GoldenLine {
                source: line
                    .source_range()
                    .slice(text)
                    .expect("source range")
                    .to_owned(),
                content: line
                    .content_range()
                    .slice(text)
                    .expect("content range")
                    .to_owned(),
                break_kind: break_name(line.break_kind()),
                advance_64: quantize(line.metrics().advance()),
                overflows: line.metrics().overflows(),
                clusters: line
                    .clusters()
                    .iter()
                    .map(|cluster| GoldenCluster {
                        source: cluster
                            .range()
                            .slice(text)
                            .expect("cluster range")
                            .to_owned(),
                        direction: direction_name(cluster.direction()),
                        x_64: quantize(cluster.bounds().x()),
                        width_64: quantize(cluster.bounds().width()),
                    })
                    .collect(),
                runs: line
                    .runs()
                    .iter()
                    .map(|run| GoldenRun {
                        source: run.range().slice(text).expect("run range").to_owned(),
                        font: database
                            .face(run.font_id())
                            .expect("run font exists")
                            .family()
                            .to_owned(),
                        direction: direction_name(run.direction()),
                        script: format!("{:?}", run.script()),
                        glyphs: run
                            .glyphs()
                            .iter()
                            .map(|glyph| GoldenGlyph {
                                id: glyph.glyph_id(),
                                cluster_utf8: glyph.cluster_utf8().get(),
                                x_64: quantize(glyph.x()),
                                y_64: quantize(glyph.y()),
                            })
                            .collect(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

#[test]
fn multilingual_paragraphs_match_checked_in_golden_geometry() {
    let manifest: GoldenManifest = serde_json::from_str(MANIFEST).expect("golden manifest parses");
    assert_eq!(manifest.schema_version, 1);
    assert!(!manifest.cases.is_empty());
    let (database, request) = golden_fonts();
    let mut generated = manifest.clone();

    for case in &mut generated.cases {
        let style = ParagraphStyle::new(request.clone(), case.font_size)
            .expect("golden style")
            .with_default_direction(direction(&case.default_direction));
        let width = case
            .max_width
            .map_or_else(ParagraphWidth::unbounded, |width| {
                ParagraphWidth::at_most(width).expect("golden width")
            });
        let snapshot = layout_paragraph(&database, &case.text, &style, width)
            .unwrap_or_else(|error| panic!("golden case {:?} failed: {error}", case.id));
        case.expected = Some(snapshot_golden(&database, &snapshot));
    }

    if std::env::var_os("NUI_PRINT_TEXT_GOLDENS").is_some() {
        eprintln!(
            "{}",
            serde_json::to_string_pretty(&generated).expect("generated golden serializes")
        );
    }

    for (expected, actual) in manifest.cases.iter().zip(&generated.cases) {
        assert_eq!(
            expected.expected, actual.expected,
            "golden case {:?} changed",
            expected.id
        );
    }
}

#[derive(Debug)]
struct DeterministicRng(u64);

impl DeterministicRng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    fn index(&mut self, len: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(len).expect("corpus length fits u64"))
            .expect("bounded corpus index fits usize")
    }
}

fn assert_snapshot_invariants(snapshot: &ParagraphSnapshot) {
    let text = snapshot.text();
    let map = snapshot.index_map();
    let size = snapshot.size();
    assert!(size.width().is_finite() && size.width() >= 0.0);
    assert!(size.height().is_finite() && size.height() > 0.0);
    assert!(!snapshot.lines().is_empty());

    let mut next_source_start = 0;
    for line in snapshot.lines() {
        let source = line.source_range();
        let content = line.content_range();
        assert_eq!(source.start().get(), next_source_start);
        assert!(source.slice(text).is_some());
        assert!(content.slice(text).is_some());
        assert!(content.start() >= source.start() && content.end() <= source.end());
        next_source_start = source.end().get();

        let metrics = line.metrics();
        for value in [
            metrics.top(),
            metrics.baseline(),
            metrics.ascent(),
            metrics.descent(),
            metrics.leading(),
            metrics.advance(),
            metrics.height(),
        ] {
            assert!(value.is_finite());
        }
        assert!(metrics.advance() >= 0.0 && metrics.height() > 0.0);

        assert!(line
            .clusters()
            .windows(2)
            .all(|clusters| { clusters[0].bounds().x() <= clusters[1].bounds().x() }));
        for cluster in line.clusters() {
            let range = cluster.range();
            let bounds = cluster.bounds();
            assert!(range.start() >= content.start() && range.end() <= content.end());
            assert!(map.utf8_to_grapheme(range.start().get()).is_some());
            assert!(map.utf8_to_grapheme(range.end().get()).is_some());
            for value in [bounds.x(), bounds.y(), bounds.width(), bounds.height()] {
                assert!(value.is_finite());
            }
            assert!(bounds.width() >= 0.0 && bounds.height() > 0.0);
        }

        for run in line.runs() {
            let range = run.range();
            assert!(range.start() >= content.start() && range.end() <= content.end());
            assert!(map.utf8_to_grapheme(range.start().get()).is_some());
            assert!(map.utf8_to_grapheme(range.end().get()).is_some());
            assert!(run.font_size().is_finite() && run.font_size() > 0.0);
            assert!(run.advance().x.is_finite() && run.advance().y.is_finite());
            for glyph in run.glyphs() {
                assert!(map.utf8_to_grapheme(glyph.cluster_utf8().get()).is_some());
                assert!(glyph.x().is_finite() && glyph.y().is_finite());
                let position = glyph.position();
                assert!(position.x_advance.is_finite());
                assert!(position.y_advance.is_finite());
                assert!(position.x_offset.is_finite());
                assert!(position.y_offset.is_finite());
            }
        }

        assert!(!line.caret_stops().is_empty());
        for caret in line.caret_stops() {
            assert!(map.utf8_to_grapheme(caret.offset().get()).is_some());
            assert!(caret.x().is_finite());
        }
    }
    assert_eq!(next_source_start, text.len());
}

#[test]
fn deterministic_mixed_script_corpus_preserves_layout_invariants() {
    const TOKENS: &[&str] = &["A", "B", "C", " ", "你", "們", "مرحبا", "✍🏽‍✍️", "\n"];
    const WIDTHS: &[Option<f32>] = &[None, Some(0.0), Some(20.0), Some(40.0), Some(80.0)];
    const FONT_SIZES: &[f32] = &[12.0, 20.0, 32.0];

    let (database, request) = golden_fonts();
    let mut rng = DeterministicRng(0x4e45_5841_5549_323b);
    for case_index in 0..256 {
        let mut text = String::from(TOKENS[case_index % TOKENS.len()]);
        let token_count = 1 + rng.index(12);
        for _ in 1..token_count {
            text.push_str(TOKENS[rng.index(TOKENS.len())]);
        }
        let direction = if case_index % 2 == 0 {
            TextDirection::LeftToRight
        } else {
            TextDirection::RightToLeft
        };
        let style = ParagraphStyle::new(request.clone(), FONT_SIZES[case_index % FONT_SIZES.len()])
            .expect("corpus style")
            .with_default_direction(direction);
        let width = WIDTHS[case_index % WIDTHS.len()]
            .map_or_else(ParagraphWidth::unbounded, |width| {
                ParagraphWidth::at_most(width).expect("corpus width")
            });

        let first = layout_paragraph(&database, &text, &style, width)
            .unwrap_or_else(|error| panic!("corpus case {case_index} failed: {error}; {text:?}"));
        let second = layout_paragraph(&database, &text, &style, width)
            .unwrap_or_else(|error| panic!("repeat case {case_index} failed: {error}; {text:?}"));

        assert_eq!(
            first, second,
            "corpus case {case_index} was not deterministic"
        );
        assert_snapshot_invariants(&first);
    }
}

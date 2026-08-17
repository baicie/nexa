//! Immutable paragraph layout snapshots in logical pixels.

use std::error::Error;
use std::fmt;

use read_fonts::tables::os2::SelectionFlags;
use read_fonts::TableProvider;
use unicode_script::Script;

use crate::bidi::BidiAnalysis;
use crate::font_fallback::is_default_ignorable_for_shaping;
use crate::line_breaking::hard_break_start;
use crate::{
    line_break_opportunities, shape_text, FontDatabase, FontDatabaseRevision, FontId, FontRequest,
    GlyphPosition, GlyphVector, LineBreakKind, ShapeError, ShapedGlyph, ShapedRun, TextDirection,
    TextIndexMap, Utf8Offset, Utf8Range,
};

/// Width constraint for paragraph layout.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParagraphWidth {
    max_width: Option<f32>,
}

impl ParagraphWidth {
    #[must_use]
    pub const fn unbounded() -> Self {
        Self { max_width: None }
    }

    pub fn at_most(max_width: f32) -> Result<Self, ParagraphError> {
        if max_width.is_finite() && max_width >= 0.0 {
            Ok(Self {
                max_width: Some(max_width),
            })
        } else {
            Err(ParagraphError::InvalidWidth { width: max_width })
        }
    }

    #[must_use]
    pub const fn max_width(self) -> Option<f32> {
        self.max_width
    }
}

/// Font and direction inputs reused by paragraph caches.
#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphStyle {
    font_request: FontRequest,
    font_size: f32,
    default_direction: Option<TextDirection>,
}

impl ParagraphStyle {
    pub fn new(font_request: FontRequest, font_size: f32) -> Result<Self, ParagraphError> {
        if !font_size.is_finite() || font_size <= 0.0 {
            return Err(ParagraphError::InvalidFontSize { font_size });
        }
        Ok(Self {
            font_request,
            font_size,
            default_direction: None,
        })
    }

    #[must_use]
    pub const fn with_default_direction(mut self, direction: TextDirection) -> Self {
        self.default_direction = Some(direction);
        self
    }

    #[must_use]
    pub const fn font_request(&self) -> &FontRequest {
        &self.font_request
    }

    #[must_use]
    pub const fn font_size(&self) -> f32 {
        self.font_size
    }

    #[must_use]
    pub const fn default_direction(&self) -> Option<TextDirection> {
        self.default_direction
    }
}

/// Logical paragraph dimensions.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TextSize {
    width: f32,
    height: f32,
}

impl TextSize {
    #[must_use]
    pub const fn width(self) -> f32 {
        self.width
    }

    #[must_use]
    pub const fn height(self) -> f32 {
        self.height
    }
}

/// Logical-pixel bounds in a paragraph snapshot.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TextRect {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

impl TextRect {
    #[must_use]
    pub const fn x(self) -> f32 {
        self.x
    }

    #[must_use]
    pub const fn y(self) -> f32 {
        self.y
    }

    #[must_use]
    pub const fn width(self) -> f32 {
        self.width
    }

    #[must_use]
    pub const fn height(self) -> f32 {
        self.height
    }
}

/// Which visual side of a logical boundary a caret belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CaretAffinity {
    Upstream,
    Downstream,
}

/// Visual direction used for horizontal caret navigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HorizontalDirection {
    Left,
    Right,
}

/// A legal caret location on one laid-out line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaretStop {
    offset: Utf8Offset,
    affinity: CaretAffinity,
    x: f32,
}

impl CaretStop {
    #[must_use]
    pub const fn offset(self) -> Utf8Offset {
        self.offset
    }

    #[must_use]
    pub const fn affinity(self) -> CaretAffinity {
        self.affinity
    }

    #[must_use]
    pub const fn x(self) -> f32 {
        self.x
    }
}

/// Result of mapping a point in paragraph coordinates to a legal text caret.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextHit {
    offset: Utf8Offset,
    affinity: CaretAffinity,
    line: usize,
}

impl TextHit {
    #[must_use]
    pub(crate) const fn new(offset: Utf8Offset, affinity: CaretAffinity, line: usize) -> Self {
        Self {
            offset,
            affinity,
            line,
        }
    }

    #[must_use]
    pub const fn offset(self) -> Utf8Offset {
        self.offset
    }

    #[must_use]
    pub const fn affinity(self) -> CaretAffinity {
        self.affinity
    }

    #[must_use]
    pub const fn line(self) -> usize {
        self.line
    }
}

/// A positioned glyph ready for conversion into a backend-neutral display command.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PositionedGlyph {
    glyph_id: u16,
    cluster_utf8: Utf8Offset,
    x: f32,
    y: f32,
    position: GlyphPosition,
}

impl PositionedGlyph {
    #[must_use]
    pub const fn glyph_id(self) -> u16 {
        self.glyph_id
    }

    #[must_use]
    pub const fn cluster_utf8(self) -> Utf8Offset {
        self.cluster_utf8
    }

    #[must_use]
    pub const fn x(self) -> f32 {
        self.x
    }

    #[must_use]
    pub const fn y(self) -> f32 {
        self.y
    }

    #[must_use]
    pub const fn position(self) -> GlyphPosition {
        self.position
    }
}

/// Visually ordered glyphs sharing one font/script/direction.
#[derive(Debug, Clone, PartialEq)]
pub struct PositionedRun {
    range: Utf8Range,
    font_id: FontId,
    font_size: f32,
    direction: TextDirection,
    script: Script,
    glyphs: Vec<PositionedGlyph>,
    advance: GlyphVector,
}

impl PositionedRun {
    #[must_use]
    pub const fn range(&self) -> Utf8Range {
        self.range
    }

    #[must_use]
    pub const fn font_id(&self) -> FontId {
        self.font_id
    }

    #[must_use]
    pub const fn font_size(&self) -> f32 {
        self.font_size
    }

    #[must_use]
    pub const fn direction(&self) -> TextDirection {
        self.direction
    }

    #[must_use]
    pub const fn script(&self) -> Script {
        self.script
    }

    #[must_use]
    pub fn glyphs(&self) -> &[PositionedGlyph] {
        &self.glyphs
    }

    #[must_use]
    pub const fn advance(&self) -> GlyphVector {
        self.advance
    }
}

/// Visual bounds and source range for one shaped cluster.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClusterMapEntry {
    range: Utf8Range,
    bounds: TextRect,
    direction: TextDirection,
    unsafe_to_break: bool,
}

impl ClusterMapEntry {
    #[must_use]
    pub const fn range(self) -> Utf8Range {
        self.range
    }

    #[must_use]
    pub const fn bounds(self) -> TextRect {
        self.bounds
    }

    #[must_use]
    pub const fn direction(self) -> TextDirection {
        self.direction
    }

    #[must_use]
    pub const fn unsafe_to_break(self) -> bool {
        self.unsafe_to_break
    }
}

/// Font-derived metrics and measured width for one line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineMetrics {
    top: f32,
    baseline: f32,
    ascent: f32,
    descent: f32,
    leading: f32,
    advance: f32,
    overflows: bool,
}

impl LineMetrics {
    #[must_use]
    pub const fn top(self) -> f32 {
        self.top
    }

    #[must_use]
    pub const fn baseline(self) -> f32 {
        self.baseline
    }

    #[must_use]
    pub const fn ascent(self) -> f32 {
        self.ascent
    }

    #[must_use]
    pub const fn descent(self) -> f32 {
        self.descent
    }

    #[must_use]
    pub const fn leading(self) -> f32 {
        self.leading
    }

    #[must_use]
    pub const fn advance(self) -> f32 {
        self.advance
    }

    #[must_use]
    pub const fn overflows(self) -> bool {
        self.overflows
    }

    #[must_use]
    pub const fn height(self) -> f32 {
        self.ascent + self.descent + self.leading
    }
}

/// One logical source slice laid out as a visual line.
#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphLine {
    source_range: Utf8Range,
    content_range: Utf8Range,
    break_kind: LineBreakKind,
    metrics: LineMetrics,
    runs: Vec<PositionedRun>,
    clusters: Vec<ClusterMapEntry>,
    caret_stops: Vec<CaretStop>,
}

impl ParagraphLine {
    #[must_use]
    pub const fn source_range(&self) -> Utf8Range {
        self.source_range
    }

    #[must_use]
    pub const fn content_range(&self) -> Utf8Range {
        self.content_range
    }

    #[must_use]
    pub const fn break_kind(&self) -> LineBreakKind {
        self.break_kind
    }

    #[must_use]
    pub const fn metrics(&self) -> LineMetrics {
        self.metrics
    }

    #[must_use]
    pub fn runs(&self) -> &[PositionedRun] {
        &self.runs
    }

    #[must_use]
    pub fn clusters(&self) -> &[ClusterMapEntry] {
        &self.clusters
    }

    #[must_use]
    pub fn caret_stops(&self) -> &[CaretStop] {
        &self.caret_stops
    }
}

/// Immutable, self-contained result shared by layout, paint, and hit testing.
#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphSnapshot {
    index_map: TextIndexMap,
    font_revision: FontDatabaseRevision,
    size: TextSize,
    lines: Vec<ParagraphLine>,
}

impl ParagraphSnapshot {
    #[must_use]
    pub fn text(&self) -> &str {
        self.index_map.text()
    }

    #[must_use]
    pub const fn index_map(&self) -> &TextIndexMap {
        &self.index_map
    }

    #[must_use]
    pub const fn font_revision(&self) -> FontDatabaseRevision {
        self.font_revision
    }

    #[must_use]
    pub const fn size(&self) -> TextSize {
        self.size
    }

    #[must_use]
    pub fn lines(&self) -> &[ParagraphLine] {
        &self.lines
    }

    /// Convert paragraph-local coordinates to the nearest grapheme-safe caret.
    #[must_use]
    pub fn hit_test(&self, x: f32, y: f32) -> Option<TextHit> {
        if self.lines.is_empty() || !x.is_finite() || !y.is_finite() {
            return None;
        }
        let line_index = self
            .lines
            .iter()
            .position(|line| {
                let top = line.metrics.top();
                let bottom = top + line.metrics.height();
                y >= top && y < bottom
            })
            .unwrap_or_else(|| {
                if y < self.lines[0].metrics.top() {
                    0
                } else {
                    self.lines.len() - 1
                }
            });
        let line = &self.lines[line_index];
        let stop = line.caret_stops.iter().min_by(|left, right| {
            (left.x - x)
                .abs()
                .total_cmp(&(right.x - x).abs())
                .then_with(|| left.offset.cmp(&right.offset))
        })?;
        Some(TextHit::new(stop.offset, stop.affinity, line_index))
    }

    /// Return a one-pixel caret rectangle for a grapheme-safe UTF-8 offset.
    #[must_use]
    pub fn caret_bounds(&self, offset: Utf8Offset, affinity: CaretAffinity) -> Option<TextRect> {
        let exact = self.lines.iter().find_map(|line| {
            line.caret_stops
                .iter()
                .find(|stop| stop.offset == offset && stop.affinity == affinity)
                .map(|stop| (line, stop))
        });
        let (line, stop) = exact.or_else(|| {
            self.lines.iter().find_map(|line| {
                line.caret_stops
                    .iter()
                    .find(|stop| stop.offset == offset)
                    .map(|stop| (line, stop))
            })
        })?;
        Some(TextRect {
            x: stop.x,
            y: line.metrics.top(),
            width: 1.0,
            height: line.metrics.height(),
        })
    }

    /// Return the next legal caret in visual left/right order. The method
    /// keeps logical offsets and bidi affinity together, so callers do not
    /// have to infer a visual move from grapheme indices.
    #[must_use]
    pub(crate) fn adjacent_caret(
        &self,
        offset: Utf8Offset,
        affinity: CaretAffinity,
        direction: HorizontalDirection,
    ) -> Option<TextHit> {
        let (line_index, stop_index) =
            self.lines.iter().enumerate().find_map(|(line, value)| {
                value
                    .caret_stops
                    .iter()
                    .position(|stop| stop.offset == offset && stop.affinity == affinity)
                    .map(|index| (line, index))
                    .or_else(|| {
                        value
                            .caret_stops
                            .iter()
                            .position(|stop| stop.offset == offset)
                            .map(|index| (line, index))
                    })
            })?;

        let (target_line, target_index) = match direction {
            HorizontalDirection::Left if stop_index > 0 => (line_index, stop_index - 1),
            HorizontalDirection::Right
                if stop_index + 1 < self.lines[line_index].caret_stops.len() =>
            {
                (line_index, stop_index + 1)
            }
            HorizontalDirection::Left if line_index > 0 => {
                let line = &self.lines[line_index - 1];
                (line_index - 1, line.caret_stops.len().saturating_sub(1))
            }
            HorizontalDirection::Right if line_index + 1 < self.lines.len() => (line_index + 1, 0),
            _ => (line_index, stop_index),
        };
        let stop = self.lines.get(target_line)?.caret_stops.get(target_index)?;
        Some(TextHit::new(stop.offset, stop.affinity, target_line))
    }

    /// Map a source selection to per-line rectangles using shaped cluster
    /// bounds. Selection never splits a cluster in the returned geometry.
    #[must_use]
    pub fn selection_rects(&self, range: Utf8Range) -> Vec<TextRect> {
        if range.source_len() != self.index_map.text().len() || range.is_empty() {
            return Vec::new();
        }
        let mut rects = Vec::new();
        for line in &self.lines {
            let mut segment: Option<(f32, f32)> = None;
            for cluster in &line.clusters {
                if cluster.range.intersection(range).is_some() {
                    let left = cluster.bounds.x();
                    let right = left + cluster.bounds.width();
                    if let Some((segment_left, segment_right)) = &mut segment {
                        *segment_left = segment_left.min(left);
                        *segment_right = segment_right.max(right);
                    } else {
                        segment = Some((left, right));
                    }
                } else if let Some((left, right)) = segment.take() {
                    rects.push(TextRect {
                        x: left,
                        y: line.metrics.top(),
                        width: (right - left).max(0.0),
                        height: line.metrics.height(),
                    });
                }
            }
            if let Some((left, right)) = segment {
                rects.push(TextRect {
                    x: left,
                    y: line.metrics.top(),
                    width: (right - left).max(0.0),
                    height: line.metrics.height(),
                });
            }
        }
        rects
    }
}

/// Paragraph validation, shaping, or font-metric failure.
#[derive(Debug, Clone, PartialEq)]
pub enum ParagraphError {
    InvalidWidth { width: f32 },
    InvalidFontSize { font_size: f32 },
    MissingPrimaryFont,
    MissingFontSource { font_id: FontId },
    InvalidFontSource { font_id: FontId },
    NonFiniteFontMetrics { font_id: FontId },
    NonFiniteGeometry,
    Shape(ShapeError),
}

impl fmt::Display for ParagraphError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidWidth { width } => {
                write!(
                    formatter,
                    "paragraph width must be finite and non-negative, got {width}"
                )
            }
            Self::InvalidFontSize { font_size } => {
                write!(
                    formatter,
                    "font size must be finite and positive, got {font_size}"
                )
            }
            Self::MissingPrimaryFont => formatter.write_str("paragraph has no primary font"),
            Self::MissingFontSource { font_id } => {
                write!(formatter, "font {} has no shared source", font_id.get())
            }
            Self::InvalidFontSource { font_id } => {
                write!(formatter, "font {} source is not parseable", font_id.get())
            }
            Self::NonFiniteFontMetrics { font_id } => {
                write!(
                    formatter,
                    "font {} produced invalid line metrics",
                    font_id.get()
                )
            }
            Self::NonFiniteGeometry => {
                formatter.write_str("paragraph produced non-finite geometry")
            }
            Self::Shape(error) => error.fmt(formatter),
        }
    }
}

impl Error for ParagraphError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Shape(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ShapeError> for ParagraphError {
    fn from(error: ShapeError) -> Self {
        Self::Shape(error)
    }
}

/// Shapes and lays out one self-contained paragraph source.
pub fn layout_paragraph(
    database: &FontDatabase,
    text: impl Into<String>,
    style: &ParagraphStyle,
    width: ParagraphWidth,
) -> Result<ParagraphSnapshot, ParagraphError> {
    let text = text.into();
    let index_map = TextIndexMap::new(text.clone());
    let bidi_analysis = BidiAnalysis::new(&text, style.default_direction());
    let primary_font = database
        .resolve(style.font_request())
        .ok_or(ParagraphError::MissingPrimaryFont)?;
    let primary_metrics = font_metrics(database, primary_font, style.font_size())?;
    let shaped = shape_text(
        database,
        &text,
        style.font_request(),
        style.font_size(),
        style.default_direction(),
    )?;
    let shaped_runs: Vec<_> = shaped
        .paragraphs
        .iter()
        .flat_map(|paragraph| &paragraph.runs)
        .collect();
    let clusters = collect_clusters(&shaped_runs, &index_map);
    let opportunities = line_break_opportunities(&text);
    let specs = wrapped_line_specs(
        &text,
        hard_line_specs(&text, &opportunities),
        &opportunities,
        &clusters,
        width,
    );
    let mut lines = Vec::new();
    let mut top = 0.0;
    let mut paragraph_width: f32 = 0.0;

    for spec in specs {
        let line_clusters: Vec<_> = clusters
            .iter()
            .filter(|cluster| range_contains(spec.content_range, cluster.range))
            .collect();
        let metrics = line_font_metrics(database, &line_clusters, primary_metrics)?;
        let line_height = metrics.ascent + metrics.descent + metrics.leading;
        if !line_height.is_finite() || line_height <= 0.0 {
            return Err(ParagraphError::NonFiniteGeometry);
        }
        let baseline = top + metrics.ascent;
        if !baseline.is_finite() {
            return Err(ParagraphError::NonFiniteGeometry);
        }
        let visual_clusters =
            reorder_line_clusters(&bidi_analysis, spec.content_range, &line_clusters);
        let (runs, cluster_map, caret_stops, advance) =
            position_clusters(&visual_clusters, &index_map, top, baseline, line_height)?;
        if !advance.is_finite() {
            return Err(ParagraphError::NonFiniteGeometry);
        }
        let overflows = width
            .max_width()
            .is_some_and(|max_width| advance > max_width);
        let caret_stops = if line_clusters.is_empty() {
            line_edge_carets(spec.content_range, advance)
        } else {
            caret_stops
        };
        let line_metrics = LineMetrics {
            top,
            baseline,
            ascent: metrics.ascent,
            descent: metrics.descent,
            leading: metrics.leading,
            advance,
            overflows,
        };
        top += line_metrics.height();
        if !top.is_finite() {
            return Err(ParagraphError::NonFiniteGeometry);
        }
        paragraph_width = paragraph_width.max(advance);
        if !paragraph_width.is_finite() {
            return Err(ParagraphError::NonFiniteGeometry);
        }
        lines.push(ParagraphLine {
            source_range: spec.source_range,
            content_range: spec.content_range,
            break_kind: spec.break_kind,
            metrics: line_metrics,
            runs,
            clusters: cluster_map,
            caret_stops,
        });
    }

    if !top.is_finite() || !paragraph_width.is_finite() {
        return Err(ParagraphError::NonFiniteGeometry);
    }

    Ok(ParagraphSnapshot {
        index_map,
        font_revision: database.revision(),
        size: TextSize {
            width: paragraph_width,
            height: top,
        },
        lines,
    })
}

#[derive(Debug, Clone, Copy)]
struct LineSpec {
    source_range: Utf8Range,
    content_range: Utf8Range,
    break_kind: LineBreakKind,
}

#[derive(Debug, Clone, Copy)]
struct FontMetrics {
    ascent: f32,
    descent: f32,
    leading: f32,
}

#[derive(Debug, Clone)]
struct ClusterRecord {
    range: Utf8Range,
    font_id: FontId,
    font_size: f32,
    script: Script,
    glyphs: Vec<ShapedGlyph>,
    advance: f32,
    unsafe_to_break: bool,
}

#[derive(Debug, Clone, Copy)]
struct VisualCluster<'a> {
    cluster: &'a ClusterRecord,
    direction: TextDirection,
    visual_run: usize,
}

type PositionedLine = (
    Vec<PositionedRun>,
    Vec<ClusterMapEntry>,
    Vec<CaretStop>,
    f32,
);

fn hard_line_specs(text: &str, opportunities: &[crate::LineBreakOpportunity]) -> Vec<LineSpec> {
    let mut specs = Vec::new();
    let mut start = 0;
    for opportunity in opportunities {
        match opportunity.kind() {
            LineBreakKind::Soft => {}
            LineBreakKind::Hard => {
                let end = opportunity.offset().get();
                let content_end = hard_break_start(text, end).unwrap_or(end);
                specs.push(LineSpec {
                    source_range: Utf8Range::validated(start, end, text.len()),
                    content_range: Utf8Range::validated(start, content_end, text.len()),
                    break_kind: LineBreakKind::Hard,
                });
                start = end;
            }
            LineBreakKind::EndOfText => specs.push(LineSpec {
                source_range: Utf8Range::validated(start, text.len(), text.len()),
                content_range: Utf8Range::validated(start, text.len(), text.len()),
                break_kind: LineBreakKind::EndOfText,
            }),
        }
    }
    specs
}

fn wrapped_line_specs(
    text: &str,
    hard_specs: Vec<LineSpec>,
    opportunities: &[crate::LineBreakOpportunity],
    clusters: &[ClusterRecord],
    width: ParagraphWidth,
) -> Vec<LineSpec> {
    let Some(max_width) = width.max_width() else {
        return hard_specs;
    };
    let mut wrapped = Vec::new();
    for hard_spec in hard_specs {
        if hard_spec.content_range.is_empty() {
            wrapped.push(hard_spec);
            continue;
        }
        let content_end = hard_spec.content_range.end().get();
        let mut candidates: Vec<_> = opportunities
            .iter()
            .filter(|opportunity| opportunity.kind() == LineBreakKind::Soft)
            .map(|opportunity| opportunity.offset().get())
            .filter(|offset| {
                *offset > hard_spec.content_range.start().get()
                    && *offset < content_end
                    && is_safe_break(*offset, clusters)
            })
            .collect();
        candidates.push(content_end);

        let mut start = hard_spec.content_range.start().get();
        while start < content_end {
            let remaining: Vec<_> = candidates
                .iter()
                .copied()
                .filter(|offset| *offset > start)
                .collect();
            let fitting = remaining.iter().copied().take_while(|offset| {
                range_advance(start, *offset, clusters) <= max_width + f32::EPSILON
            });
            let end = fitting
                .last()
                .or_else(|| remaining.first().copied())
                .unwrap_or(content_end);
            let is_final = end == content_end;
            wrapped.push(LineSpec {
                source_range: Utf8Range::validated(
                    start,
                    if is_final {
                        hard_spec.source_range.end().get()
                    } else {
                        end
                    },
                    text.len(),
                ),
                content_range: Utf8Range::validated(start, end, text.len()),
                break_kind: if is_final {
                    hard_spec.break_kind
                } else {
                    LineBreakKind::Soft
                },
            });
            start = end;
        }
    }
    wrapped
}

fn collect_clusters(runs: &[&ShapedRun], index_map: &TextIndexMap) -> Vec<ClusterRecord> {
    let source_len = index_map.text().len();
    let mut clusters = Vec::new();
    for run in runs {
        let mut starts: Vec<_> = run
            .glyphs
            .iter()
            .map(|glyph| glyph.cluster_utf8.get())
            .collect();
        starts.sort_unstable();
        starts.dedup();
        for (index, start) in starts.iter().copied().enumerate() {
            let end = starts
                .get(index + 1)
                .copied()
                .unwrap_or_else(|| run.range.end().get());
            let glyphs: Vec<_> = run
                .glyphs
                .iter()
                .copied()
                .filter(|glyph| glyph.cluster_utf8.get() == start)
                .collect();
            let advance = glyphs
                .iter()
                .map(|glyph| glyph.position.x_advance)
                .sum::<f32>();
            clusters.push(ClusterRecord {
                range: Utf8Range::validated(start, end, source_len),
                font_id: run.font_id,
                font_size: run.font_size,
                script: run.script,
                unsafe_to_break: glyphs.iter().any(|glyph| glyph.unsafe_to_break),
                glyphs,
                advance,
            });
        }
    }
    synthesize_default_ignorable_clusters(&mut clusters, runs, index_map);
    clusters.sort_unstable_by_key(|cluster| cluster.range);
    clusters
}

fn synthesize_default_ignorable_clusters(
    clusters: &mut Vec<ClusterRecord>,
    runs: &[&ShapedRun],
    index_map: &TextIndexMap,
) {
    let source_len = index_map.text().len();
    for boundary in index_map.boundaries() {
        let range = Utf8Range::validated(boundary.utf8_start, boundary.utf8_end, source_len);
        let grapheme = range.slice(index_map.text()).unwrap_or_default();
        if !grapheme.chars().all(is_default_ignorable_for_shaping)
            || clusters
                .iter()
                .any(|cluster| cluster.range.start().get() == range.start().get())
        {
            continue;
        }

        let Some(run) = runs.iter().find(|run| range_contains(run.range, range)) else {
            continue;
        };
        if let Some(cluster) = clusters.iter_mut().find(|cluster| {
            cluster.range.start().get() < range.start().get()
                && range.end().get() <= cluster.range.end().get()
        }) {
            cluster.range =
                Utf8Range::validated(cluster.range.start().get(), range.start().get(), source_len);
        }
        clusters.push(ClusterRecord {
            range,
            font_id: run.font_id,
            font_size: run.font_size,
            script: run.script,
            glyphs: Vec::new(),
            advance: 0.0,
            unsafe_to_break: false,
        });
    }
}

fn reorder_line_clusters<'a>(
    bidi_analysis: &BidiAnalysis<'_>,
    line: Utf8Range,
    clusters: &[&'a ClusterRecord],
) -> Vec<VisualCluster<'a>> {
    let visual_runs = bidi_analysis.visual_runs_for_line(line);
    let mut visual_clusters = Vec::with_capacity(clusters.len());

    for (visual_run, run) in visual_runs.into_iter().enumerate() {
        let run_clusters = clusters
            .iter()
            .copied()
            .filter(|cluster| range_contains(run.range, cluster.range));
        if run.direction == TextDirection::RightToLeft {
            visual_clusters.extend(run_clusters.rev().map(|cluster| VisualCluster {
                cluster,
                direction: run.direction,
                visual_run,
            }));
        } else {
            visual_clusters.extend(run_clusters.map(|cluster| VisualCluster {
                cluster,
                direction: run.direction,
                visual_run,
            }));
        }
    }

    debug_assert_eq!(visual_clusters.len(), clusters.len());
    visual_clusters
}

fn is_safe_break(offset: usize, clusters: &[ClusterRecord]) -> bool {
    !clusters.iter().any(|cluster| {
        cluster.range.start().get() == offset && cluster.unsafe_to_break
            || cluster.range.start().get() < offset && offset < cluster.range.end().get()
    })
}

fn range_advance(start: usize, end: usize, clusters: &[ClusterRecord]) -> f32 {
    clusters
        .iter()
        .filter(|cluster| start <= cluster.range.start().get() && cluster.range.end().get() <= end)
        .map(|cluster| cluster.advance)
        .sum()
}

fn font_metrics(
    database: &FontDatabase,
    font_id: FontId,
    font_size: f32,
) -> Result<FontMetrics, ParagraphError> {
    let descriptor = database
        .face(font_id)
        .ok_or(ParagraphError::MissingPrimaryFont)?;
    let source = descriptor
        .source()
        .ok_or(ParagraphError::MissingFontSource { font_id })?;
    let font = source
        .font_ref()
        .ok_or(ParagraphError::InvalidFontSource { font_id })?;
    let head = font
        .head()
        .map_err(|_| ParagraphError::InvalidFontSource { font_id })?;
    let hhea = font
        .hhea()
        .map_err(|_| ParagraphError::InvalidFontSource { font_id })?;
    let os2 = font.os2().ok();
    let use_typographic_metrics = os2.as_ref().is_some_and(|table| {
        table.version() >= 4
            && table
                .fs_selection()
                .contains(SelectionFlags::USE_TYPO_METRICS)
    });
    let (mut ascender, mut descender, mut line_gap) = if use_typographic_metrics {
        let table = os2.as_ref().expect("typographic metrics require OS/2");
        (
            table.s_typo_ascender(),
            table.s_typo_descender(),
            table.s_typo_line_gap(),
        )
    } else {
        (
            hhea.ascender().to_i16(),
            hhea.descender().to_i16(),
            hhea.line_gap().to_i16(),
        )
    };
    if !use_typographic_metrics && (ascender == 0 || descender == 0) {
        if let Some(table) = &os2 {
            if table.s_typo_ascender() != 0 || table.s_typo_descender() != 0 {
                ascender = table.s_typo_ascender();
                descender = table.s_typo_descender();
                line_gap = table.s_typo_line_gap();
            } else {
                ascender = i16::try_from(table.us_win_ascent()).unwrap_or(i16::MAX);
                descender = -i16::try_from(table.us_win_descent()).unwrap_or(i16::MAX);
                line_gap = 0;
            }
        }
    }
    let scale = font_size / head.units_per_em() as f32;
    let metrics = FontMetrics {
        ascent: (ascender as f32 * scale).max(0.0),
        descent: (-(descender as f32) * scale).max(0.0),
        leading: (line_gap as f32 * scale).max(0.0),
    };
    if !metrics.ascent.is_finite()
        || !metrics.descent.is_finite()
        || !metrics.leading.is_finite()
        || !(metrics.ascent + metrics.descent + metrics.leading).is_finite()
        || metrics.ascent + metrics.descent + metrics.leading <= 0.0
    {
        return Err(ParagraphError::NonFiniteFontMetrics { font_id });
    }
    Ok(metrics)
}

fn line_font_metrics(
    database: &FontDatabase,
    clusters: &[&ClusterRecord],
    primary: FontMetrics,
) -> Result<FontMetrics, ParagraphError> {
    let mut metrics: Option<FontMetrics> = None;
    for cluster in clusters {
        let candidate = font_metrics(database, cluster.font_id, cluster.font_size)?;
        if let Some(current) = &mut metrics {
            current.ascent = current.ascent.max(candidate.ascent);
            current.descent = current.descent.max(candidate.descent);
            current.leading = current.leading.max(candidate.leading);
        } else {
            metrics = Some(candidate);
        }
    }
    Ok(metrics.unwrap_or(primary))
}

fn position_clusters(
    clusters: &[VisualCluster<'_>],
    index_map: &TextIndexMap,
    top: f32,
    baseline: f32,
    line_height: f32,
) -> Result<PositionedLine, ParagraphError> {
    let mut positioned = Vec::with_capacity(clusters.len());
    let mut cluster_map = Vec::with_capacity(clusters.len());
    let mut caret_stops = Vec::new();
    let mut cursor = 0.0;
    let mut previous_visual_run = None;
    for visual_cluster in clusters {
        let cluster = visual_cluster.cluster;
        let start = cursor;
        let glyphs = cluster
            .glyphs
            .iter()
            .map(|glyph| {
                let positioned_glyph = PositionedGlyph {
                    glyph_id: glyph.glyph_id,
                    cluster_utf8: glyph.cluster_utf8,
                    x: cursor + glyph.position.x_offset,
                    y: baseline + glyph.position.y_offset,
                    position: glyph.position,
                };
                cursor += glyph.position.x_advance;
                if !positioned_glyph.x.is_finite()
                    || !positioned_glyph.y.is_finite()
                    || !cursor.is_finite()
                {
                    return Err(ParagraphError::NonFiniteGeometry);
                }
                Ok(positioned_glyph)
            })
            .collect::<Result<Vec<_>, ParagraphError>>()?;
        let advance = cursor - start;
        if !advance.is_finite() {
            return Err(ParagraphError::NonFiniteGeometry);
        }
        append_positioned_run(
            &mut positioned,
            cluster,
            visual_cluster.direction,
            glyphs,
            advance,
            previous_visual_run == Some(visual_cluster.visual_run),
        );
        previous_visual_run = Some(visual_cluster.visual_run);
        cluster_map.push(ClusterMapEntry {
            range: cluster.range,
            bounds: TextRect {
                x: start,
                y: top,
                width: advance,
                height: line_height,
            },
            direction: visual_cluster.direction,
            unsafe_to_break: cluster.unsafe_to_break,
        });
        append_cluster_carets(
            &mut caret_stops,
            cluster,
            index_map,
            start,
            advance,
            visual_cluster.direction,
        );
        if !caret_stops.iter().all(|caret| caret.x().is_finite()) {
            return Err(ParagraphError::NonFiniteGeometry);
        }
    }
    caret_stops.sort_by(|left, right| left.x.total_cmp(&right.x));
    Ok((positioned, cluster_map, caret_stops, cursor))
}

fn append_positioned_run(
    runs: &mut Vec<PositionedRun>,
    cluster: &ClusterRecord,
    direction: TextDirection,
    glyphs: Vec<PositionedGlyph>,
    advance: f32,
    same_visual_run: bool,
) {
    if glyphs.is_empty() {
        return;
    }
    if let Some(previous) = runs.last_mut().filter(|_| same_visual_run) {
        let logically_contiguous = match direction {
            TextDirection::LeftToRight => previous.range.end().get() == cluster.range.start().get(),
            TextDirection::RightToLeft => cluster.range.end().get() == previous.range.start().get(),
        };
        if previous.font_id == cluster.font_id
            && previous.font_size == cluster.font_size
            && previous.direction == direction
            && previous.script == cluster.script
            && logically_contiguous
        {
            previous.range = Utf8Range::validated(
                previous
                    .range
                    .start()
                    .get()
                    .min(cluster.range.start().get()),
                previous.range.end().get().max(cluster.range.end().get()),
                cluster.range.source_len(),
            );
            previous.glyphs.extend(glyphs);
            previous.advance.x += advance;
            return;
        }
    }

    runs.push(PositionedRun {
        range: cluster.range,
        font_id: cluster.font_id,
        font_size: cluster.font_size,
        direction,
        script: cluster.script,
        glyphs,
        advance: GlyphVector { x: advance, y: 0.0 },
    });
}

fn append_cluster_carets(
    carets: &mut Vec<CaretStop>,
    cluster: &ClusterRecord,
    index_map: &TextIndexMap,
    x: f32,
    width: f32,
    direction: TextDirection,
) {
    let mut offsets: Vec<_> = index_map
        .boundaries()
        .iter()
        .map(|boundary| boundary.utf8_start)
        .filter(|offset| {
            cluster.range.start().get() <= *offset && *offset < cluster.range.end().get()
        })
        .collect();
    offsets.push(cluster.range.end().get());
    offsets.sort_unstable();
    offsets.dedup();
    let intervals = offsets.len().saturating_sub(1).max(1) as f32;
    for (index, offset) in offsets.into_iter().enumerate() {
        let progress = index as f32 / intervals;
        let caret_x = match direction {
            TextDirection::LeftToRight => x + width * progress,
            TextDirection::RightToLeft => x + width * (1.0 - progress),
        };
        carets.push(CaretStop {
            offset: Utf8Offset::validated(offset, index_map.text().len()),
            affinity: if index == 0 {
                CaretAffinity::Downstream
            } else {
                CaretAffinity::Upstream
            },
            x: caret_x,
        });
    }
}

fn line_edge_carets(range: Utf8Range, advance: f32) -> Vec<CaretStop> {
    let start = CaretStop {
        offset: range.start(),
        affinity: CaretAffinity::Downstream,
        x: 0.0,
    };
    if range.is_empty() {
        vec![start]
    } else {
        vec![
            start,
            CaretStop {
                offset: range.end(),
                affinity: CaretAffinity::Upstream,
                x: advance,
            },
        ]
    }
}

fn range_contains(outer: Utf8Range, inner: Utf8Range) -> bool {
    outer.source_len() == inner.source_len()
        && outer.start().get() <= inner.start().get()
        && inner.end().get() <= outer.end().get()
}

#[cfg(test)]
mod hit_tests {
    use super::*;

    fn snapshot() -> ParagraphSnapshot {
        let text = "abc";
        let source = Utf8Range::new(text, 0, text.len()).expect("range");
        let clusters = (0..3)
            .map(|index| ClusterMapEntry {
                range: Utf8Range::new(text, index, index + 1).expect("cluster"),
                bounds: TextRect {
                    x: index as f32 * 10.0,
                    y: 0.0,
                    width: 10.0,
                    height: 20.0,
                },
                direction: TextDirection::LeftToRight,
                unsafe_to_break: false,
            })
            .collect();
        ParagraphSnapshot {
            index_map: TextIndexMap::new(text),
            font_revision: FontDatabaseRevision::default(),
            size: TextSize {
                width: 30.0,
                height: 20.0,
            },
            lines: vec![ParagraphLine {
                source_range: source,
                content_range: source,
                break_kind: LineBreakKind::EndOfText,
                metrics: LineMetrics {
                    top: 0.0,
                    baseline: 16.0,
                    ascent: 16.0,
                    descent: 4.0,
                    leading: 0.0,
                    advance: 30.0,
                    overflows: false,
                },
                runs: Vec::new(),
                clusters,
                caret_stops: vec![
                    CaretStop {
                        offset: Utf8Offset::validated(0, 3),
                        affinity: CaretAffinity::Downstream,
                        x: 0.0,
                    },
                    CaretStop {
                        offset: Utf8Offset::validated(1, 3),
                        affinity: CaretAffinity::Upstream,
                        x: 10.0,
                    },
                    CaretStop {
                        offset: Utf8Offset::validated(2, 3),
                        affinity: CaretAffinity::Upstream,
                        x: 20.0,
                    },
                    CaretStop {
                        offset: Utf8Offset::validated(3, 3),
                        affinity: CaretAffinity::Upstream,
                        x: 30.0,
                    },
                ],
            }],
        }
    }

    #[test]
    fn hit_test_snaps_to_nearest_caret_and_selection_uses_cluster_bounds() {
        let paragraph = snapshot();
        let hit = paragraph.hit_test(17.0, 8.0).expect("hit");
        assert_eq!(hit.offset().get(), 2);
        assert_eq!(hit.line(), 0);
        let range = Utf8Range::new(paragraph.text(), 0, 2).expect("selection");
        let rects = paragraph.selection_rects(range);
        assert_eq!(rects.len(), 1);
        assert_eq!(rects[0].width(), 20.0);
        assert_eq!(
            paragraph
                .caret_bounds(hit.offset(), hit.affinity())
                .unwrap()
                .x(),
            20.0
        );
    }

    #[test]
    fn caret_bounds_prefers_the_requested_affinity_across_visual_lines() {
        let mut paragraph = snapshot();
        let boundary = Utf8Offset::validated(1, paragraph.text().len());
        let mut first = paragraph.lines[0].clone();
        first.caret_stops = vec![CaretStop {
            offset: boundary,
            affinity: CaretAffinity::Upstream,
            x: 30.0,
        }];
        let mut second = first.clone();
        second.metrics.top = 20.0;
        second.metrics.baseline = 36.0;
        second.caret_stops = vec![CaretStop {
            offset: boundary,
            affinity: CaretAffinity::Downstream,
            x: 0.0,
        }];
        paragraph.lines = vec![first, second];
        paragraph.size.height = 40.0;

        let upstream = paragraph
            .caret_bounds(boundary, CaretAffinity::Upstream)
            .expect("upstream caret");
        let downstream = paragraph
            .caret_bounds(boundary, CaretAffinity::Downstream)
            .expect("downstream caret");

        assert_eq!(upstream.y(), 0.0);
        assert_eq!(downstream.y(), 20.0);
    }
}

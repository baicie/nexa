//! Taffy Flexbox layout backend for Nexa UI (Slice 4 / ADR-004 §6.2).

use nui_core::{
    Arena, ColorRgba, DisplayGlyph, DisplayList, FlexDirection, GlyphRun, InteractionStateToken,
    LayoutRect, NodeId, NodeType,
};
use nui_text::{FontWeight, ParagraphError};
use taffy::geometry::Point;
use taffy::prelude::*;
use taffy::style::Overflow;
use taffy::TaffyTree;

use nui_core::VERSION as CORE_VERSION;

mod paragraph_cache;

pub use paragraph_cache::{ParagraphCache, TextWidthConstraint, DEFAULT_PARAGRAPH_CACHE_CAPACITY};

#[must_use]
pub fn backend_name() -> &'static str {
    "taffy"
}

#[must_use]
pub fn core_version() -> &'static str {
    CORE_VERSION
}

#[derive(Debug, Clone)]
struct MeasureCtx {
    nui_id: NodeId,
    text: Option<String>,
    font_size: f32,
    font_weight: u32,
}

/// Failure raised while building or measuring a Taffy layout tree.
#[derive(Debug)]
pub enum LayoutError {
    InvalidViewport { width: f32, height: f32 },
    Taffy(taffy::TaffyError),
    Text(ParagraphError),
}

impl std::fmt::Display for LayoutError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidViewport { width, height } => {
                write!(
                    formatter,
                    "viewport must be finite and non-negative, got {width}x{height}"
                )
            }
            Self::Taffy(error) => error.fmt(formatter),
            Self::Text(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for LayoutError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Taffy(error) => Some(error),
            Self::Text(error) => Some(error),
            Self::InvalidViewport { .. } => None,
        }
    }
}

impl From<taffy::TaffyError> for LayoutError {
    fn from(error: taffy::TaffyError) -> Self {
        Self::Taffy(error)
    }
}

impl From<ParagraphError> for LayoutError {
    fn from(error: ParagraphError) -> Self {
        Self::Text(error)
    }
}

/// Observable work completed by one successful layout pass.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LayoutPassStats {
    node_count: u32,
}

impl LayoutPassStats {
    #[must_use]
    pub const fn node_count(self) -> u32 {
        self.node_count
    }
}

/// Layout `root` into the viewport (logical pixels) via Taffy Flexbox.
///
/// Writes absolute coordinates into each node's [`LayoutRect`].
pub fn layout_tree(arena: &mut Arena, root: NodeId, viewport_width: f32, viewport_height: f32) {
    let mut cache = ParagraphCache::empty();
    let _ = layout_tree_with_cache(arena, root, viewport_width, viewport_height, &mut cache);
}

/// Layouts `root` while measuring text through cached paragraph snapshots.
pub fn layout_tree_with_cache(
    arena: &mut Arena,
    root: NodeId,
    viewport_width: f32,
    viewport_height: f32,
    cache: &mut ParagraphCache,
) -> Result<(), LayoutError> {
    layout_tree_with_cache_stats(arena, root, viewport_width, viewport_height, cache).map(|_| ())
}

/// Layouts `root` and returns the real Arena nodes included in the pass.
pub fn layout_tree_with_cache_stats(
    arena: &mut Arena,
    root: NodeId,
    viewport_width: f32,
    viewport_height: f32,
    cache: &mut ParagraphCache,
) -> Result<LayoutPassStats, LayoutError> {
    cache.begin_layout_pass();

    if !viewport_width.is_finite()
        || viewport_width < 0.0
        || !viewport_height.is_finite()
        || viewport_height < 0.0
    {
        return Err(LayoutError::InvalidViewport {
            width: viewport_width,
            height: viewport_height,
        });
    }

    let mut tree: TaffyTree<MeasureCtx> = TaffyTree::new();

    let mut stats = LayoutPassStats::default();
    let taffy_root = build_node(
        &mut tree,
        arena,
        root,
        true,
        viewport_width,
        viewport_height,
        &mut stats,
    )?;

    let available = Size {
        width: AvailableSpace::Definite(viewport_width),
        height: AvailableSpace::Definite(viewport_height),
    };

    let mut measure_error = None;
    let compute_result = tree.compute_layout_with_measure(
        taffy_root,
        available,
        |known_dimensions, available_space, _node_id, node_context, _style| {
            if let (Some(w), Some(h)) = (known_dimensions.width, known_dimensions.height) {
                return Size {
                    width: w,
                    height: h,
                };
            }
            let Some(ctx) = node_context else {
                return Size {
                    width: known_dimensions.width.unwrap_or(0.0),
                    height: known_dimensions.height.unwrap_or(0.0),
                };
            };
            let Some(text) = ctx.text.as_deref() else {
                return Size {
                    width: known_dimensions.width.unwrap_or(0.0),
                    height: known_dimensions.height.unwrap_or(0.0),
                };
            };
            let width = known_dimensions
                .width
                .map(TextWidthConstraint::Definite)
                .unwrap_or_else(|| match available_space.width {
                    AvailableSpace::Definite(width) => TextWidthConstraint::Definite(width),
                    AvailableSpace::MinContent => TextWidthConstraint::MinContent,
                    AvailableSpace::MaxContent => TextWidthConstraint::MaxContent,
                });
            let weight = u16::try_from(ctx.font_weight.clamp(1, 1000))
                .expect("clamped font weight fits u16");
            let font_style = cache
                .font_style()
                .with_weight(FontWeight::new(weight).expect("clamped font weight is valid"));
            match cache.snapshot_resource_with_style(text, ctx.font_size, font_style, width) {
                Ok((resource_id, snapshot)) => {
                    cache.record_snapshot_for_node(ctx.nui_id, resource_id);
                    Size {
                        width: known_dimensions.width.unwrap_or(snapshot.size().width()),
                        height: known_dimensions.height.unwrap_or(snapshot.size().height()),
                    }
                }
                Err(error) => {
                    measure_error = Some(error);
                    Size {
                        width: known_dimensions.width.unwrap_or(0.0),
                        height: known_dimensions.height.unwrap_or(0.0),
                    }
                }
            }
        },
    );
    if let Err(error) = compute_result {
        cache.discard_layout_pass();
        return Err(LayoutError::Taffy(error));
    }

    write_layouts(&tree, arena, taffy_root, 0.0, 0.0);
    if let Some(error) = measure_error {
        cache.discard_layout_pass();
        return Err(LayoutError::Text(error));
    }
    Ok(stats)
}

/// Builds a display-list snapshot whose text commands come from the same
/// paragraph cache used by [`layout_tree_with_cache`].
pub fn display_list_with_cache(
    arena: &Arena,
    root: NodeId,
    cache: &mut ParagraphCache,
) -> Result<DisplayList, LayoutError> {
    display_list_with_cache_and_interactions(arena, root, cache, |_| None)
}

/// Builds the cached text snapshot while resolving additive interaction state
/// for interactive nodes in the same immutable frame.
pub fn display_list_with_cache_and_interactions(
    arena: &Arena,
    root: NodeId,
    cache: &mut ParagraphCache,
    interaction_state: impl FnMut(NodeId) -> Option<InteractionStateToken>,
) -> Result<DisplayList, LayoutError> {
    display_list_with_cache_and_interactions_and_overrides(
        arena,
        root,
        cache,
        interaction_state,
        |_, _, _| None,
    )
}

/// Builds a cached display list while allowing a caller-owned text source and
/// color override. Editable controls use this to shape placeholders through
/// the same paragraph and glyph pipeline without changing their actual value.
pub fn display_list_with_cache_and_interactions_and_overrides(
    arena: &Arena,
    root: NodeId,
    cache: &mut ParagraphCache,
    interaction_state: impl FnMut(NodeId) -> Option<InteractionStateToken>,
    mut text_override: impl FnMut(NodeId, &str, ColorRgba) -> Option<(String, ColorRgba)>,
) -> Result<DisplayList, LayoutError> {
    DisplayList::try_from_arena_with_glyph_runs_and_interactions(
        arena,
        root,
        interaction_state,
        |node, source, rect, color, font_size, font_weight| {
            let weight =
                u16::try_from(font_weight.clamp(1, 1000)).expect("clamped font weight fits u16");
            let font_style = cache
                .font_style()
                .with_weight(FontWeight::new(weight).expect("clamped font weight is valid"));
            let paint_override = text_override(node, source, color);
            let (paint_source, paint_color) = paint_override
                .as_ref()
                .map_or((source, color), |(source, color)| (source.as_str(), *color));
            let snapshot = if paint_override.is_none() {
                if let Some(snapshot) = cache.snapshot_for_node(node) {
                    snapshot
                } else {
                    let (resource_id, snapshot) = cache.snapshot_resource_with_style(
                        paint_source,
                        font_size,
                        font_style,
                        TextWidthConstraint::Definite(rect.width),
                    )?;
                    cache.record_snapshot_for_node(node, resource_id);
                    snapshot
                }
            } else {
                let (resource_id, snapshot) = cache.snapshot_resource_with_style(
                    paint_source,
                    font_size,
                    font_style,
                    TextWidthConstraint::Definite(rect.width),
                )?;
                let _ = resource_id;
                snapshot
            };
            let mut runs = Vec::new();
            for line in snapshot.lines() {
                for positioned_run in line.runs() {
                    let glyphs = positioned_run
                        .glyphs()
                        .iter()
                        .map(|glyph| DisplayGlyph {
                            glyph_id: glyph.glyph_id(),
                            x: rect.x + glyph.x(),
                            y: rect.y + glyph.y(),
                        })
                        .collect::<Vec<_>>();
                    if glyphs.is_empty() {
                        continue;
                    }
                    runs.push(GlyphRun {
                        font_id: positioned_run.font_id().get(),
                        font_size: positioned_run.font_size(),
                        color: paint_color,
                        glyphs,
                    });
                }
            }
            Ok(runs)
        },
    )
    .map_err(LayoutError::Text)
}

fn to_align(align: nui_core::Align) -> AlignItems {
    match align {
        nui_core::Align::Start => AlignItems::FLEX_START,
        nui_core::Align::Center => AlignItems::CENTER,
        nui_core::Align::End => AlignItems::FLEX_END,
        nui_core::Align::Stretch => AlignItems::STRETCH,
    }
}

fn to_justify(align: nui_core::Align) -> JustifyContent {
    match align {
        nui_core::Align::Start => JustifyContent::FLEX_START,
        nui_core::Align::Center => JustifyContent::CENTER,
        nui_core::Align::End => JustifyContent::FLEX_END,
        // Stretch is not meaningful for justify; fall back to start.
        nui_core::Align::Stretch => JustifyContent::FLEX_START,
    }
}

fn to_taffy_style(
    style: &nui_core::Style,
    node_type: NodeType,
    is_root: bool,
    viewport_width: f32,
    viewport_height: f32,
) -> Style {
    let mut t_style = Style {
        display: Display::Flex,
        flex_direction: match style.flex_direction {
            FlexDirection::Column => taffy::FlexDirection::Column,
            FlexDirection::Row => taffy::FlexDirection::Row,
        },
        align_items: Some(to_align(style.align_items)),
        justify_content: Some(to_justify(style.justify_content)),
        flex_grow: style.flex_grow,
        gap: Size {
            width: length(style.gap),
            height: length(style.gap),
        },
        padding: Rect {
            left: length(style.padding),
            right: length(style.padding),
            top: length(style.padding),
            bottom: length(style.padding),
        },
        ..Style::DEFAULT
    };

    if node_type == NodeType::Scroll {
        t_style.overflow = Point {
            x: Overflow::Hidden,
            y: Overflow::Hidden,
        };
        t_style.scrollbar_width = 0.0;
    }

    let width = if is_root {
        Some(style.width.unwrap_or(viewport_width))
    } else {
        style.width
    };
    let height = if is_root {
        Some(style.height.unwrap_or(viewport_height))
    } else {
        style.height
    };

    t_style.size = Size {
        width: width.map_or_else(Dimension::auto, length),
        height: height.map_or_else(Dimension::auto, length),
    };
    t_style.min_size = Size {
        width: style.min_width.map_or_else(Dimension::auto, length),
        height: style.min_height.map_or_else(Dimension::auto, length),
    };

    t_style
}

fn build_node(
    tree: &mut TaffyTree<MeasureCtx>,
    arena: &Arena,
    id: NodeId,
    is_root: bool,
    viewport_width: f32,
    viewport_height: f32,
    stats: &mut LayoutPassStats,
) -> Result<taffy::NodeId, taffy::TaffyError> {
    let Some(node) = arena.get(id) else {
        return tree.new_leaf(Style::DEFAULT);
    };
    stats.node_count = stats.node_count.saturating_add(1);

    let t_style = to_taffy_style(
        &node.style,
        node.node_type,
        is_root,
        viewport_width,
        viewport_height,
    );

    let ctx = MeasureCtx {
        nui_id: id,
        text: node.text.clone(),
        font_size: node.style.font_size,
        font_weight: node.style.font_weight,
    };

    let children = node.children.clone();
    let node_type = node.node_type;

    if children.is_empty() || node_type == NodeType::Text {
        return tree.new_leaf_with_context(t_style, ctx);
    }

    let mut child_ids = Vec::with_capacity(children.len());
    for child in &children {
        child_ids.push(build_node(
            tree,
            arena,
            *child,
            false,
            viewport_width,
            viewport_height,
            stats,
        )?);
    }
    let parent = tree.new_with_children(t_style, &child_ids)?;
    tree.set_node_context(parent, Some(ctx))?;
    Ok(parent)
}

fn write_layouts(
    tree: &TaffyTree<MeasureCtx>,
    arena: &mut Arena,
    taffy_id: taffy::NodeId,
    parent_abs_x: f32,
    parent_abs_y: f32,
) {
    let Ok(layout) = tree.layout(taffy_id) else {
        return;
    };
    let abs_x = parent_abs_x + layout.location.x;
    let abs_y = parent_abs_y + layout.location.y;

    if let Some(ctx) = tree.get_node_context(taffy_id) {
        if let Some(node) = arena.get_mut(ctx.nui_id) {
            node.layout = LayoutRect {
                x: abs_x,
                y: abs_y,
                width: layout.size.width,
                height: layout.size.height,
            };
        }
    }

    if let Ok(children) = tree.children(taffy_id) {
        for child in children {
            write_layouts(tree, arena, child, abs_x, abs_y);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use nui_core::{ColorRgba, DisplayCommand, InteractionStateToken, Style};
    use nui_text::{
        FontFaceDescriptor, FontRequest, FontSource, FontStyle, FontWeight, GlyphCoverage, Script,
    };

    #[test]
    fn backend_is_taffy() {
        assert_eq!(backend_name(), "taffy");
        assert!(!core_version().is_empty());
    }

    #[test]
    fn column_stacks_with_gap() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                padding: 10.0,
                gap: 8.0,
                flex_direction: FlexDirection::Column,
                width: Some(200.0),
                ..Style::default()
            },
        );

        let a = arena.create(NodeType::Text);
        arena.set_text(a, "Hi");
        arena.set_style(
            a,
            Style {
                font_size: 20.0,
                ..Style::default()
            },
        );
        arena.insert_child(root, a);

        let b = arena.create(NodeType::View);
        arena.set_style(
            b,
            Style {
                width: Some(80.0),
                height: Some(40.0),
                background: Some(ColorRgba::rgb(0, 0, 255)),
                ..Style::default()
            },
        );
        arena.insert_child(root, b);

        layout_tree(&mut arena, root, 200.0, 400.0);

        let a_l = arena.get(a).unwrap().layout;
        let b_l = arena.get(b).unwrap().layout;

        assert!((a_l.y - 10.0).abs() < 0.5, "a.y={}, expected ~10", a_l.y);
        assert!(
            (b_l.y - (a_l.y + a_l.height + 8.0)).abs() < 0.5,
            "b.y={}, expected ~{}",
            b_l.y,
            a_l.y + a_l.height + 8.0
        );
    }

    #[test]
    fn layout_stats_count_reachable_arena_nodes() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let container = arena.create(NodeType::View);
        let text = arena.create(NodeType::Text);
        arena.insert_child(root, container);
        arena.insert_child(container, text);
        let mut cache = ParagraphCache::empty();

        let stats =
            layout_tree_with_cache_stats(&mut arena, root, 100.0, 100.0, &mut cache).unwrap();

        assert_eq!(stats.node_count(), 3);
    }

    #[test]
    fn text_measure_uses_the_paragraph_snapshot_metrics() {
        let mut database = nui_text::FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Ahem Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("Hi ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        let mut cache = ParagraphCache::new(database, FontRequest::new(["Ahem Fixture"]));

        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(200.0),
                height: Some(100.0),
                ..Style::default()
            },
        );
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "Hi");
        arena.set_style(
            text,
            Style {
                font_size: 20.0,
                ..Style::default()
            },
        );
        arena.insert_child(root, text);

        layout_tree_with_cache(&mut arena, root, 200.0, 100.0, &mut cache)
            .expect("fixture paragraph measures");
        let layout = arena.get(text).unwrap().layout;
        assert!((layout.height - 20.0).abs() < 0.01);
        assert!((layout.width - 40.0).abs() < 0.01);
        assert!(!cache.is_empty());
    }

    #[test]
    fn text_measure_uses_each_nodes_font_weight() {
        let mut database = nui_text::FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Weight Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("A ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        database.register_face(
            FontFaceDescriptor::new(
                "Weight Fixture",
                FontStyle::default().with_weight(FontWeight::BOLD),
                GlyphCoverage::from_chars("A ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        let mut cache = ParagraphCache::new(database, FontRequest::new(["Weight Fixture"]));
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(200.0),
                height: Some(100.0),
                ..Style::default()
            },
        );
        let regular = arena.create(NodeType::Text);
        arena.set_text(regular, "A");
        arena.set_style(
            regular,
            Style {
                font_size: 20.0,
                font_weight: 400,
                ..Style::default()
            },
        );
        let bold = arena.create(NodeType::Text);
        arena.set_text(bold, "A");
        arena.set_style(
            bold,
            Style {
                font_size: 20.0,
                font_weight: 700,
                ..Style::default()
            },
        );
        arena.insert_child(root, regular);
        arena.insert_child(root, bold);

        layout_tree_with_cache(&mut arena, root, 200.0, 100.0, &mut cache)
            .expect("weighted paragraphs measure");

        assert!(cache.len() >= 2);
    }

    #[test]
    fn display_list_uses_paragraph_glyph_positions_and_font_identity() {
        let mut database = nui_text::FontDatabase::new();
        let font_id = database.register_face(
            FontFaceDescriptor::new(
                "Ahem Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("Hi ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        let mut cache = ParagraphCache::new(database, FontRequest::new(["Ahem Fixture"]));
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(100.0),
                height: Some(40.0),
                ..Style::default()
            },
        );
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "Hi");
        arena.set_style(
            text,
            Style {
                font_size: 20.0,
                ..Style::default()
            },
        );
        arena.insert_child(root, text);

        layout_tree_with_cache(&mut arena, root, 100.0, 40.0, &mut cache).unwrap();
        let bounds = arena.get(text).unwrap().layout;
        let list = display_list_with_cache(&arena, root, &mut cache).unwrap();

        assert!(matches!(
            list.commands(),
            [
                DisplayCommand::TextBox { node, rect, .. },
                DisplayCommand::GlyphRun {
                    node: glyph_node,
                    run,
                },
            ] if *node == text
                && *glyph_node == text
                && *rect == bounds
                && run.font_id == font_id.get()
                && run.glyphs.len() == 2
                && run.glyphs[0].x == bounds.x
                && run.glyphs[0].y > bounds.y
        ));
        assert!(!list
            .commands()
            .iter()
            .any(|command| matches!(command, DisplayCommand::Text { .. })));
    }

    #[test]
    fn cached_display_list_preserves_interaction_tokens() {
        let mut arena = Arena::new();
        let button = arena.create(NodeType::View);
        arena.get_mut(button).expect("button").layout = LayoutRect {
            width: 80.0,
            height: 32.0,
            ..LayoutRect::default()
        };
        arena.get_mut(button).expect("button").style.background =
            Some(ColorRgba::rgb(0x1f, 0x6f, 0xeb));
        let mut cache = ParagraphCache::empty();

        let list = display_list_with_cache_and_interactions(&arena, button, &mut cache, |node| {
            (node == button).then_some(InteractionStateToken::FOCUSED)
        })
        .expect("state-aware display list");

        assert!(list
            .commands()
            .iter()
            .any(|command| matches!(command, DisplayCommand::StrokeRect { .. })));
    }

    #[test]
    fn display_list_reuses_snapshot_recorded_during_layout_measurement() {
        let mut database = nui_text::FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Ahem Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("A ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        let mut cache = ParagraphCache::new(database, FontRequest::new(["Ahem Fixture"]));
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(40.0),
                height: Some(40.0),
                flex_direction: FlexDirection::Row,
                ..Style::default()
            },
        );
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "A A A");
        arena.set_style(
            text,
            Style {
                font_size: 20.0,
                ..Style::default()
            },
        );
        arena.insert_child(root, text);

        layout_tree_with_cache(&mut arena, root, 40.0, 40.0, &mut cache).unwrap();
        let measured_snapshot = cache
            .snapshot_for_node(text)
            .expect("layout records the measured snapshot for the text node");
        let measured_resource_id = cache
            .resource_id_for_node(text)
            .expect("layout records the paragraph resource identity");
        cache.clear_retained_entries_for_test();
        assert!(cache.is_empty());

        display_list_with_cache(&arena, root, &mut cache).unwrap();

        let painted_snapshot = cache
            .snapshot_for_node(text)
            .expect("paint preserves the measured snapshot for the text node");
        let painted_resource_id = cache
            .resource_id_for_node(text)
            .expect("paint preserves the paragraph resource identity");
        assert_eq!(measured_resource_id, painted_resource_id);
        assert!(
            Arc::ptr_eq(&measured_snapshot, &painted_snapshot),
            "paint must use the exact Arc<ParagraphSnapshot> recorded by layout"
        );
        assert_eq!(
            cache.len(),
            0,
            "paint must not shape another snapshot from the final node width"
        );
    }

    #[test]
    fn failed_layout_pass_discards_snapshots_from_the_previous_frame() {
        let mut database = nui_text::FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Ahem Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("A ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        let mut cache = ParagraphCache::new(database, FontRequest::new(["Ahem Fixture"]));
        let mut arena = Arena::new();
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "A");
        arena.set_style(
            text,
            Style {
                font_size: 20.0,
                ..Style::default()
            },
        );

        layout_tree_with_cache(&mut arena, text, 40.0, 40.0, &mut cache).unwrap();
        assert!(cache.snapshot_for_node(text).is_some());

        let error = layout_tree_with_cache(&mut arena, text, f32::NAN, 40.0, &mut cache)
            .expect_err("invalid viewport must reject the frame");

        assert!(matches!(error, LayoutError::InvalidViewport { .. }));
        assert!(
            cache.snapshot_for_node(text).is_none(),
            "a failed layout pass must not expose the previous frame's snapshot"
        );
    }
}

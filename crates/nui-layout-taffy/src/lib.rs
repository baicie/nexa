//! Taffy Flexbox layout backend for Nexa UI (Slice 4 / ADR-004 §6.2).

use nui_core::layout::measure_text;
use nui_core::{Arena, FlexDirection, LayoutRect, NodeId, NodeType};
use taffy::geometry::Point;
use taffy::prelude::*;
use taffy::style::Overflow;
use taffy::TaffyTree;

use nui_core::VERSION as CORE_VERSION;

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
}

/// Layout `root` into the viewport (logical pixels) via Taffy Flexbox.
///
/// Writes absolute coordinates into each node's [`LayoutRect`].
pub fn layout_tree(arena: &mut Arena, root: NodeId, viewport_width: f32, viewport_height: f32) {
    let mut tree: TaffyTree<MeasureCtx> = TaffyTree::new();

    let Ok(taffy_root) = build_node(
        &mut tree,
        arena,
        root,
        true,
        viewport_width,
        viewport_height,
    ) else {
        return;
    };

    let available = Size {
        width: AvailableSpace::Definite(viewport_width),
        height: AvailableSpace::Definite(viewport_height),
    };

    if tree
        .compute_layout_with_measure(
            taffy_root,
            available,
            |known_dimensions, _available_space, _node_id, node_context, _style| {
                if let (Some(w), Some(h)) = (known_dimensions.width, known_dimensions.height) {
                    return Size {
                        width: w,
                        height: h,
                    };
                }
                let Some(ctx) = node_context else {
                    return Size::ZERO;
                };
                if let Some(text) = ctx.text.as_deref() {
                    let (tw, th) = measure_text(text, ctx.font_size);
                    Size {
                        width: known_dimensions.width.unwrap_or(tw),
                        height: known_dimensions.height.unwrap_or(th),
                    }
                } else {
                    Size {
                        width: known_dimensions.width.unwrap_or(0.0),
                        height: known_dimensions.height.unwrap_or(0.0),
                    }
                }
            },
        )
        .is_err()
    {
        return;
    }

    write_layouts(&tree, arena, taffy_root, 0.0, 0.0);
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
) -> Result<taffy::NodeId, taffy::TaffyError> {
    let Some(node) = arena.get(id) else {
        return tree.new_leaf(Style::DEFAULT);
    };

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
    use super::*;
    use nui_core::{ColorRgba, Style};

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
}

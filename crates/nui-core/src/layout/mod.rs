//! Hand-rolled Flexbox subset retained for unit tests / comparison.
//!
//! Production layout uses `nui-layout-taffy::layout_tree` (Slice 4).

use crate::style::FlexDirection;
use crate::tree::{Arena, LayoutRect, NodeId, NodeType};

/// Legacy hand layout (Slice 1). Prefer `nui_layout_taffy::layout_tree`.
pub fn layout_tree(arena: &mut Arena, root: NodeId, viewport_width: f32, viewport_height: f32) {
    layout_node(arena, root, 0.0, 0.0, viewport_width, viewport_height);
}

fn layout_node(
    arena: &mut Arena,
    id: NodeId,
    x: f32,
    y: f32,
    max_width: f32,
    max_height: f32,
) -> LayoutRect {
    let (node_type, style, text, children) = {
        let Some(node) = arena.get(id) else {
            return LayoutRect::default();
        };
        (
            node.node_type,
            node.style.clone(),
            node.text.clone(),
            node.children.clone(),
        )
    };

    if node_type == NodeType::Text {
        let content = text.as_deref().unwrap_or("");
        let (tw, th) = measure_text(content, style.font_size);
        let width = style.width.unwrap_or(tw).min(max_width.max(0.0));
        let height = style.height.unwrap_or(th);
        let rect = LayoutRect {
            x,
            y,
            width,
            height,
        };
        if let Some(node) = arena.get_mut(id) {
            node.layout = rect;
        }
        return rect;
    }

    let padding = style.padding;
    let gap = style.gap;
    let preferred_w = style.width.unwrap_or(max_width);
    let preferred_h = style.height.unwrap_or(max_height);
    let inner_max_w = (preferred_w - padding * 2.0).max(0.0);
    let inner_max_h = (preferred_h - padding * 2.0).max(0.0);

    let mut child_rects = Vec::with_capacity(children.len());
    let mut cursor_x = x + padding;
    let mut cursor_y = y + padding;

    for (index, child) in children.iter().enumerate() {
        if index > 0 {
            match style.flex_direction {
                FlexDirection::Column => cursor_y += gap,
                FlexDirection::Row => cursor_x += gap,
            }
        }

        let rect = layout_node(arena, *child, cursor_x, cursor_y, inner_max_w, inner_max_h);
        match style.flex_direction {
            FlexDirection::Column => cursor_y = rect.y + rect.height,
            FlexDirection::Row => cursor_x = rect.x + rect.width,
        }
        child_rects.push(rect);
    }

    let (content_w, content_h) = match style.flex_direction {
        FlexDirection::Column => {
            let w = child_rects.iter().map(|r| r.width).fold(0.0_f32, f32::max);
            let h = if child_rects.is_empty() {
                0.0
            } else {
                child_rects.iter().map(|r| r.height).sum::<f32>()
                    + gap * (child_rects.len().saturating_sub(1) as f32)
            };
            (w, h)
        }
        FlexDirection::Row => {
            let h = child_rects.iter().map(|r| r.height).fold(0.0_f32, f32::max);
            let w = if child_rects.is_empty() {
                0.0
            } else {
                child_rects.iter().map(|r| r.width).sum::<f32>()
                    + gap * (child_rects.len().saturating_sub(1) as f32)
            };
            (w, h)
        }
    };

    let width = style.width.unwrap_or(content_w + padding * 2.0);
    let height = style.height.unwrap_or(content_h + padding * 2.0);

    let rect = LayoutRect {
        x,
        y,
        width,
        height,
    };
    if let Some(node) = arena.get_mut(id) {
        node.layout = rect;
    }
    rect
}

/// Approximate text metrics without Skia (Slice 1). Good enough for Counter.
#[must_use]
pub fn measure_text(text: &str, font_size: f32) -> (f32, f32) {
    let width = text.chars().count() as f32 * font_size * 0.55;
    let height = font_size * 1.25;
    (width.max(1.0), height.max(1.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::style::{ColorRgba, Style};
    use crate::tree::NodeType;

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

        assert!((a_l.y - 10.0).abs() < 0.1);
        assert!((b_l.y - (a_l.y + a_l.height + 8.0)).abs() < 0.1);
    }
}

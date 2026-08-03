//! Input hit-testing against laid-out nodes.

use crate::tree::{Arena, NodeId, NodeType};

/// Return the front-most clickable node under `(x, y)` in logical pixels.
#[must_use]
pub fn hit_test(arena: &Arena, root: NodeId, x: f32, y: f32) -> Option<NodeId> {
    hit_test_node(arena, root, x, y)
}

/// Front-most Scroll node under `(x, y)`, if any.
#[must_use]
pub fn hit_scroll(arena: &Arena, root: NodeId, x: f32, y: f32) -> Option<NodeId> {
    hit_scroll_node(arena, root, x, y)
}

fn hit_test_node(arena: &Arena, id: NodeId, x: f32, y: f32) -> Option<NodeId> {
    let node = arena.get(id)?;
    if !node.layout.contains(x, y) {
        return None;
    }

    let (child_x, child_y) = if node.node_type == NodeType::Scroll {
        (x, y + node.style.scroll_offset_y)
    } else {
        (x, y)
    };

    for child in node.children.iter().rev() {
        if let Some(hit) = hit_test_node(arena, *child, child_x, child_y) {
            return Some(hit);
        }
    }

    if node.clickable {
        Some(id)
    } else {
        None
    }
}

fn hit_scroll_node(arena: &Arena, id: NodeId, x: f32, y: f32) -> Option<NodeId> {
    let node = arena.get(id)?;
    if !node.layout.contains(x, y) {
        return None;
    }

    let (child_x, child_y) = if node.node_type == NodeType::Scroll {
        (x, y + node.style.scroll_offset_y)
    } else {
        (x, y)
    };

    for child in node.children.iter().rev() {
        if let Some(hit) = hit_scroll_node(arena, *child, child_x, child_y) {
            return Some(hit);
        }
    }

    if node.node_type == NodeType::Scroll {
        Some(id)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::layout_tree;
    use crate::style::{ColorRgba, FlexDirection, Style};
    use crate::tree::{Arena, NodeType};

    #[test]
    fn hits_clickable_child() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                width: Some(200.0),
                height: Some(200.0),
                padding: 0.0,
                flex_direction: FlexDirection::Column,
                ..Style::default()
            },
        );

        let button = arena.create(NodeType::View);
        arena.set_style(
            button,
            Style {
                width: Some(100.0),
                height: Some(40.0),
                background: Some(ColorRgba::rgb(0, 0, 255)),
                ..Style::default()
            },
        );
        arena.set_clickable(button, true);
        arena.insert_child(root, button);

        layout_tree(&mut arena, root, 200.0, 200.0);

        assert_eq!(hit_test(&arena, root, 10.0, 10.0), Some(button));
        assert_eq!(hit_test(&arena, root, 150.0, 10.0), None);
    }
}

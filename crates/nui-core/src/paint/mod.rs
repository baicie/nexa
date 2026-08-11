//! Backend-neutral display-list derivation.
//!
//! The list is an immutable snapshot of the visual tree. Renderer crates may
//! consume it, but Core never stores or exposes Skia/winit objects here.

use std::convert::Infallible;

use crate::{Arena, ColorRgba, InteractionStateToken, LayoutRect, NodeId, NodeType, ResourceId};

/// One positioned glyph in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayGlyph {
    pub glyph_id: u16,
    pub x: f32,
    pub y: f32,
}

/// Backend-neutral glyphs sharing one font face, size, and color.
///
/// `font_id` is a CPU font-resource identity. Render backends resolve it
/// through their resource input instead of selecting or shaping a font again.
#[derive(Debug, Clone, PartialEq)]
pub struct GlyphRun {
    pub font_id: u64,
    pub font_size: f32,
    pub color: ColorRgba,
    pub glyphs: Vec<DisplayGlyph>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DisplayCommand {
    PushOpacity {
        opacity: f32,
    },
    PopOpacity,
    FillRect {
        rect: LayoutRect,
        color: ColorRgba,
        radius: f32,
    },
    StrokeRect {
        rect: LayoutRect,
        color: ColorRgba,
        radius: f32,
        width: f32,
    },
    ClipRect {
        rect: LayoutRect,
    },
    RestoreClip,
    Image {
        node: NodeId,
        resource_id: Option<ResourceId>,
        rect: LayoutRect,
    },
    Text {
        node: NodeId,
        rect: LayoutRect,
        text: String,
        color: ColorRgba,
        font_size: f32,
        font_weight: u32,
    },
    /// Text-node bounds retained for focused overlays such as caret and
    /// placeholder paint. Production text content is carried by `GlyphRun`.
    TextBox {
        node: NodeId,
        rect: LayoutRect,
        text: String,
        font_size: f32,
        font_weight: u32,
    },
    GlyphRun {
        node: NodeId,
        run: GlyphRun,
    },
}

/// Immutable commands for one visual-tree snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayList {
    commands: Vec<DisplayCommand>,
}

impl DisplayList {
    #[must_use]
    pub fn from_arena(arena: &Arena, root: NodeId) -> Self {
        Self::from_arena_with_interactions(arena, root, |_| None)
    }

    #[must_use]
    pub fn from_arena_with_interactions(
        arena: &Arena,
        root: NodeId,
        interaction_state: impl FnMut(NodeId) -> Option<InteractionStateToken>,
    ) -> Self {
        match Self::try_from_arena(
            arena,
            root,
            interaction_state,
            |node, text, rect, color, font_size, font_weight| {
                Ok::<_, Infallible>(vec![DisplayCommand::Text {
                    node,
                    rect,
                    text: text.to_owned(),
                    color,
                    font_size,
                    font_weight,
                }])
            },
        ) {
            Ok(list) => list,
            Err(never) => match never {},
        }
    }

    /// Derives a display list while delegating text shaping to a higher layer.
    ///
    /// Core owns traversal, opacity, and clip ordering. The callback receives
    /// the effective text bounds after scroll offsets and returns already
    /// positioned glyph runs without exposing a text or renderer dependency.
    pub fn try_from_arena_with_glyph_runs<E>(
        arena: &Arena,
        root: NodeId,
        glyph_runs: impl FnMut(
            NodeId,
            &str,
            LayoutRect,
            ColorRgba,
            f32,
            u32,
        ) -> Result<Vec<GlyphRun>, E>,
    ) -> Result<Self, E> {
        Self::try_from_arena_with_glyph_runs_and_interactions(arena, root, |_| None, glyph_runs)
    }

    pub fn try_from_arena_with_glyph_runs_and_interactions<E>(
        arena: &Arena,
        root: NodeId,
        interaction_state: impl FnMut(NodeId) -> Option<InteractionStateToken>,
        mut glyph_runs: impl FnMut(
            NodeId,
            &str,
            LayoutRect,
            ColorRgba,
            f32,
            u32,
        ) -> Result<Vec<GlyphRun>, E>,
    ) -> Result<Self, E> {
        Self::try_from_arena(
            arena,
            root,
            interaction_state,
            |node, text, rect, color, font_size, font_weight| {
                let runs = glyph_runs(node, text, rect, color, font_size, font_weight)?;
                let mut commands = Vec::with_capacity(runs.len() + 1);
                commands.push(DisplayCommand::TextBox {
                    node,
                    rect,
                    text: text.to_owned(),
                    font_size,
                    font_weight,
                });
                commands.extend(
                    runs.into_iter()
                        .map(|run| DisplayCommand::GlyphRun { node, run }),
                );
                Ok(commands)
            },
        )
    }

    #[must_use]
    pub fn commands(&self) -> &[DisplayCommand] {
        &self.commands
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    fn try_from_arena<E>(
        arena: &Arena,
        root: NodeId,
        mut interaction_state: impl FnMut(NodeId) -> Option<InteractionStateToken>,
        mut text_commands: impl FnMut(
            NodeId,
            &str,
            LayoutRect,
            ColorRgba,
            f32,
            u32,
        ) -> Result<Vec<DisplayCommand>, E>,
    ) -> Result<Self, E> {
        let mut commands = Vec::new();
        try_append_node(
            arena,
            root,
            0.0,
            &mut commands,
            &mut interaction_state,
            &mut text_commands,
        )?;
        Ok(Self { commands })
    }
}

fn try_append_node<E>(
    arena: &Arena,
    id: NodeId,
    offset_y: f32,
    commands: &mut Vec<DisplayCommand>,
    interaction_state: &mut impl FnMut(NodeId) -> Option<InteractionStateToken>,
    text_commands: &mut impl FnMut(
        NodeId,
        &str,
        LayoutRect,
        ColorRgba,
        f32,
        u32,
    ) -> Result<Vec<DisplayCommand>, E>,
) -> Result<(), E> {
    let Some(node) = arena.get(id) else {
        return Ok(());
    };
    let mut rect = node.layout;
    rect.y += offset_y;
    let resolved = node
        .style
        .resolve_interaction(interaction_state(id).unwrap_or(InteractionStateToken::IDLE));
    let opacity = resolved.opacity;
    let has_opacity_scope = opacity < 1.0;
    if has_opacity_scope {
        commands.push(DisplayCommand::PushOpacity { opacity });
    }
    if let Some(color) = resolved.background {
        commands.push(DisplayCommand::FillRect {
            rect,
            color,
            radius: node.style.border_radius,
        });
    }
    match node.node_type {
        NodeType::Image => commands.push(DisplayCommand::Image {
            node: id,
            resource_id: node.image_resource,
            rect,
        }),
        NodeType::Text => commands.extend(text_commands(
            id,
            node.text.as_deref().unwrap_or_default(),
            rect,
            node.style.color,
            node.style.font_size,
            node.style.font_weight,
        )?),
        NodeType::Root | NodeType::View | NodeType::Scroll => {}
    }

    if node.node_type == NodeType::Scroll {
        commands.push(DisplayCommand::ClipRect { rect });
    }
    let child_offset_y = if node.node_type == NodeType::Scroll {
        offset_y - node.style.scroll_offset_y
    } else {
        offset_y
    };
    let children = node.children.clone();
    for child in children {
        try_append_node(
            arena,
            child,
            child_offset_y,
            commands,
            interaction_state,
            text_commands,
        )?;
    }
    if node.node_type == NodeType::Scroll {
        commands.push(DisplayCommand::RestoreClip);
    }
    if let Some(outline) = resolved.outline {
        commands.push(DisplayCommand::StrokeRect {
            rect,
            color: outline.color,
            radius: node.style.border_radius,
            width: outline.width,
        });
    }
    if has_opacity_scope {
        commands.push(DisplayCommand::PopOpacity);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use super::{DisplayCommand, DisplayGlyph, DisplayList, GlyphRun};
    use crate::{
        Arena, ColorRgba, InteractionStateToken, LayoutRect, NodeType, ResourceStore, Style,
    };

    #[test]
    fn derives_backend_neutral_snapshot_in_tree_order() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.set_style(
            root,
            Style {
                background: Some(ColorRgba::rgb(0x10, 0x20, 0x30)),
                ..Style::default()
            },
        );
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "Hello");
        arena.set_style(
            text,
            Style {
                font_size: 20.0,
                ..Style::default()
            },
        );
        arena.insert_child(root, text);
        arena.get_mut(root).unwrap().layout = LayoutRect {
            width: 120.0,
            height: 40.0,
            ..LayoutRect::default()
        };
        arena.get_mut(text).unwrap().layout = LayoutRect {
            width: 50.0,
            height: 24.0,
            ..LayoutRect::default()
        };

        let list = DisplayList::from_arena(&arena, root);
        assert_eq!(list.commands().len(), 2);
        assert!(matches!(
            list.commands()[0],
            DisplayCommand::FillRect { .. }
        ));
        assert!(matches!(list.commands()[1], DisplayCommand::Text { .. }));
        assert_eq!(list, DisplayList::from_arena(&arena, root));
    }

    #[test]
    fn interaction_state_changes_background_and_emits_focus_outline() {
        let mut arena = Arena::new();
        let button = arena.create(NodeType::View);
        let base = ColorRgba::rgb(0x20, 0x40, 0x80);
        arena.get_mut(button).unwrap().style = Style {
            background: Some(base),
            ..Style::default()
        };
        arena.get_mut(button).unwrap().layout = LayoutRect {
            width: 80.0,
            height: 32.0,
            ..LayoutRect::default()
        };

        let hovered = DisplayList::from_arena_with_interactions(&arena, button, |node| {
            (node == button).then_some(InteractionStateToken::HOVERED)
        });
        assert!(matches!(
            hovered.commands(),
            [DisplayCommand::FillRect { color, .. }] if *color != base
        ));

        let focused = DisplayList::from_arena_with_interactions(&arena, button, |node| {
            (node == button).then_some(InteractionStateToken::FOCUSED)
        });
        assert!(focused
            .commands()
            .iter()
            .any(|command| matches!(command, DisplayCommand::StrokeRect { .. })));
    }

    #[test]
    fn scroll_snapshot_contains_balanced_clip_commands() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::Scroll);
        arena.get_mut(root).unwrap().layout = LayoutRect {
            width: 100.0,
            height: 100.0,
            ..LayoutRect::default()
        };
        let image = arena.create(NodeType::Image);
        arena.insert_child(root, image);
        let list = DisplayList::from_arena(&arena, root);
        assert!(matches!(
            list.commands()[0],
            DisplayCommand::ClipRect { .. }
        ));
        assert!(matches!(list.commands()[1], DisplayCommand::Image { .. }));
        assert!(matches!(list.commands()[2], DisplayCommand::RestoreClip));
    }

    #[test]
    fn image_command_carries_the_bound_cpu_resource_identity() {
        let mut resources = ResourceStore::new();
        let resource_id = resources.insert("fixture pixels");
        let mut arena = Arena::new();
        let image = arena.create(NodeType::Image);
        assert!(arena.set_image_resource(image, Some(resource_id)));

        let list = DisplayList::from_arena(&arena, image);

        assert!(matches!(
            list.commands(),
            [DisplayCommand::Image {
                node,
                resource_id: Some(bound),
                ..
            }] if *node == image && *bound == resource_id
        ));
    }

    #[test]
    fn scroll_snapshot_offsets_descendants_without_moving_clip() {
        let mut arena = Arena::new();
        let scroll = arena.create(NodeType::Scroll);
        let scroll_node = arena.get_mut(scroll).unwrap();
        scroll_node.layout = LayoutRect {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 60.0,
        };
        scroll_node.style.scroll_offset_y = 12.0;
        let image = arena.create(NodeType::Image);
        arena.get_mut(image).unwrap().layout = LayoutRect {
            x: 10.0,
            y: 50.0,
            width: 24.0,
            height: 24.0,
        };
        arena.insert_child(scroll, image);

        let list = DisplayList::from_arena(&arena, scroll);

        assert!(matches!(
            list.commands()[0],
            DisplayCommand::ClipRect {
                rect: LayoutRect { y: 20.0, .. }
            }
        ));
        assert!(matches!(
            list.commands()[1],
            DisplayCommand::Image {
                rect: LayoutRect { y: 38.0, .. },
                ..
            }
        ));
    }

    #[test]
    fn opacity_scope_wraps_node_contents_and_nested_clip() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.get_mut(root).unwrap().style.opacity = 0.5;
        let scroll = arena.create(NodeType::Scroll);
        let image = arena.create(NodeType::Image);
        arena.insert_child(root, scroll);
        arena.insert_child(scroll, image);

        let list = DisplayList::from_arena(&arena, root);

        assert!(matches!(
            list.commands(),
            [
                DisplayCommand::PushOpacity { opacity: 0.5 },
                DisplayCommand::ClipRect { .. },
                DisplayCommand::Image { .. },
                DisplayCommand::RestoreClip,
                DisplayCommand::PopOpacity,
            ]
        ));
    }

    #[test]
    fn disabled_scope_wraps_the_entire_node_subtree_at_half_opacity() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.get_mut(root).unwrap().style.disabled = true;
        let image = arena.create(NodeType::Image);
        arena.insert_child(root, image);

        let list = DisplayList::from_arena(&arena, root);

        assert!(matches!(
            list.commands(),
            [
                DisplayCommand::PushOpacity { opacity: 0.5 },
                DisplayCommand::Image { node, .. },
                DisplayCommand::PopOpacity,
            ] if *node == image
        ));
    }

    #[test]
    fn disabled_opacity_multiplies_the_explicit_node_opacity() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let root_style = &mut arena.get_mut(root).unwrap().style;
        root_style.disabled = true;
        root_style.opacity = 0.4;
        let image = arena.create(NodeType::Image);
        arena.insert_child(root, image);

        let list = DisplayList::from_arena(&arena, root);

        assert!(matches!(
            list.commands(),
            [
                DisplayCommand::PushOpacity { opacity },
                DisplayCommand::Image { node, .. },
                DisplayCommand::PopOpacity,
            ] if (*opacity - 0.2).abs() < f32::EPSILON && *node == image
        ));
    }

    #[test]
    fn glyph_builder_preserves_clip_order_and_effective_scroll_coordinates() {
        let mut arena = Arena::new();
        let scroll = arena.create(NodeType::Scroll);
        arena.get_mut(scroll).unwrap().layout = LayoutRect {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 60.0,
        };
        arena.get_mut(scroll).unwrap().style.scroll_offset_y = 12.0;
        let text = arena.create(NodeType::Text);
        arena.set_text(text, "A");
        arena.get_mut(text).unwrap().layout = LayoutRect {
            x: 10.0,
            y: 50.0,
            width: 24.0,
            height: 24.0,
        };
        arena.insert_child(scroll, text);

        let list = DisplayList::try_from_arena_with_glyph_runs(
            &arena,
            scroll,
            |node, source, rect, color, font_size, _| {
                assert_eq!(node, text);
                assert_eq!(source, "A");
                assert_eq!(rect.y, 38.0);
                Ok::<_, Infallible>(vec![GlyphRun {
                    font_id: 7,
                    font_size,
                    color,
                    glyphs: vec![DisplayGlyph {
                        glyph_id: 3,
                        x: rect.x,
                        y: rect.y + 16.0,
                    }],
                }])
            },
        )
        .unwrap();

        assert!(matches!(
            list.commands(),
            [
                DisplayCommand::ClipRect { .. },
                DisplayCommand::TextBox { node, rect, .. },
                DisplayCommand::GlyphRun {
                    node: glyph_node,
                    run: GlyphRun { font_id: 7, .. },
                },
                DisplayCommand::RestoreClip,
            ] if *node == text && *glyph_node == text && rect.y == 38.0
        ));
    }
}

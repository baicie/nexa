use crate::semantics::Semantics;
use crate::semantics::{SemanticAction, SemanticRole};
use crate::tree::{Arena, LayoutRect, Node, NodeId, NodeType};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SemanticState {
    pub disabled: bool,
    pub checked: Option<bool>,
    pub focused: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticNode {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    pub role: SemanticRole,
    pub name: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub state: SemanticState,
    pub bounds: LayoutRect,
    pub actions: Vec<SemanticAction>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SemanticTreeSnapshot {
    pub nodes: Vec<SemanticNode>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SemanticTreeDiff {
    pub added: Vec<SemanticNode>,
    pub removed: Vec<NodeId>,
    pub updated: Vec<SemanticNode>,
}

impl SemanticTreeDiff {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.updated.is_empty()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.added
            .len()
            .saturating_add(self.removed.len())
            .saturating_add(self.updated.len())
    }
}

impl SemanticTreeSnapshot {
    #[must_use]
    pub fn from_arena(arena: &Arena, root: NodeId, focused: Option<NodeId>) -> Self {
        Self::derive(arena, root, focused)
    }

    #[must_use]
    pub fn derive(arena: &Arena, root: NodeId, focused: Option<NodeId>) -> Self {
        Self::derive_with_defaults(arena, root, focused, |_, _| None)
    }

    /// Derive a tree while allowing the owner of the visual tree to provide
    /// component defaults. Explicit `Node::semantics` always wins over the
    /// callback result; returning `None` keeps a visual node non-semantic.
    #[must_use]
    pub fn derive_with_defaults(
        arena: &Arena,
        root: NodeId,
        focused: Option<NodeId>,
        mut default_semantics: impl FnMut(NodeId, &Node) -> Option<Semantics>,
    ) -> Self {
        let mut deriver = SemanticTreeDeriver {
            arena,
            focused,
            default_semantics: &mut default_semantics,
            nodes: Vec::new(),
        };
        deriver.derive_node(root, 0.0, None, None);
        Self {
            nodes: deriver.nodes,
        }
    }

    #[must_use]
    pub fn node(&self, id: NodeId) -> Option<&SemanticNode> {
        self.nodes.iter().find(|node| node.id == id)
    }

    #[must_use]
    pub fn nodes(&self) -> &[SemanticNode] {
        &self.nodes
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    #[must_use]
    pub fn diff(&self, next: &Self) -> SemanticTreeDiff {
        let old_by_id = self
            .nodes
            .iter()
            .enumerate()
            .map(|(index, node)| (node.id, (index, node)))
            .collect::<std::collections::HashMap<_, _>>();
        let new_by_id = next
            .nodes
            .iter()
            .map(|node| (node.id, node))
            .collect::<std::collections::HashMap<_, _>>();

        let added = next
            .nodes
            .iter()
            .filter(|node| !old_by_id.contains_key(&node.id))
            .cloned()
            .collect();
        let updated = next
            .nodes
            .iter()
            .filter(|node| {
                old_by_id
                    .get(&node.id)
                    .is_some_and(|(_, previous)| *previous != *node)
            })
            .cloned()
            .collect();
        let mut removed = self
            .nodes
            .iter()
            .filter(|node| !new_by_id.contains_key(&node.id))
            .map(|node| node.id)
            .collect::<Vec<_>>();
        removed
            .sort_by_key(|id| std::cmp::Reverse(old_by_id.get(id).map_or(0, |(index, _)| *index)));

        SemanticTreeDiff {
            added,
            removed,
            updated,
        }
    }
}

struct SemanticTreeDeriver<'arena, 'callback, F> {
    arena: &'arena Arena,
    focused: Option<NodeId>,
    default_semantics: &'callback mut F,
    nodes: Vec<SemanticNode>,
}

impl<F> SemanticTreeDeriver<'_, '_, F>
where
    F: FnMut(NodeId, &Node) -> Option<Semantics>,
{
    fn derive_node(
        &mut self,
        id: NodeId,
        offset_y: f32,
        clip: Option<LayoutRect>,
        parent: Option<NodeId>,
    ) {
        let Some(node) = self.arena.get(id) else {
            return;
        };
        let mut bounds = node.layout;
        bounds.y += offset_y;
        let visible_bounds = clip.map_or(bounds, |clip| intersect(bounds, clip));
        let semantics = node
            .semantics
            .clone()
            .or_else(|| (self.default_semantics)(id, node));
        let included =
            semantics.is_some() && visible_bounds.width > 0.0 && visible_bounds.height > 0.0;
        if let Some(semantics) = semantics {
            if included {
                self.nodes.push(SemanticNode {
                    id,
                    parent,
                    role: semantics.role,
                    name: semantics.label.clone(),
                    value: semantics.value.clone(),
                    description: semantics.description.clone(),
                    state: SemanticState {
                        disabled: semantics.disabled,
                        checked: semantics.checked,
                        focused: self.focused == Some(id),
                    },
                    bounds: visible_bounds,
                    actions: canonical_actions(&semantics.actions),
                });
            }
        }

        let child_parent = included.then_some(id).or(parent);
        let child_clip = if node.node_type == NodeType::Scroll {
            Some(clip.map_or(bounds, |ancestor| intersect(bounds, ancestor)))
        } else {
            clip
        };
        let child_offset_y = if node.node_type == NodeType::Scroll {
            offset_y - node.style.scroll_offset_y
        } else {
            offset_y
        };
        let children = node.children.clone();
        for child in children {
            self.derive_node(child, child_offset_y, child_clip, child_parent);
        }
    }
}

fn canonical_actions(actions: &[SemanticAction]) -> Vec<SemanticAction> {
    [
        SemanticAction::Invoke,
        SemanticAction::Focus,
        SemanticAction::SetValue,
    ]
    .into_iter()
    .filter(|action| actions.contains(action))
    .collect()
}

fn intersect(first: LayoutRect, second: LayoutRect) -> LayoutRect {
    let left = first.x.max(second.x);
    let top = first.y.max(second.y);
    let right = (first.x + first.width).min(second.x + second.width);
    let bottom = (first.y + first.height).min(second.y + second.height);
    LayoutRect {
        x: left,
        y: top,
        width: (right - left).max(0.0),
        height: (bottom - top).max(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SemanticAction, Semantics};

    fn rect(x: f32, y: f32, width: f32, height: f32) -> LayoutRect {
        LayoutRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn derives_explicit_nodes_in_visual_preorder_and_skips_nonsemantic_ancestors() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let visual = arena.create(NodeType::View);
        let first = arena.create(NodeType::Text);
        let second = arena.create(NodeType::Text);
        arena.insert_child(root, visual);
        arena.insert_child(visual, first);
        arena.insert_child(visual, second);
        arena.get_mut(root).unwrap().layout = rect(0.0, 0.0, 200.0, 100.0);
        arena.get_mut(visual).unwrap().layout = rect(10.0, 10.0, 180.0, 80.0);
        arena.get_mut(first).unwrap().layout = rect(20.0, 20.0, 50.0, 20.0);
        arena.get_mut(second).unwrap().layout = rect(20.0, 50.0, 60.0, 20.0);
        arena.get_mut(first).unwrap().semantics = Some(Semantics::text("First"));
        arena.get_mut(second).unwrap().semantics = Some(Semantics::text("Second"));

        let snapshot = SemanticTreeSnapshot::derive(&arena, root, None);
        assert_eq!(
            snapshot
                .nodes
                .iter()
                .map(|node| node.id)
                .collect::<Vec<_>>(),
            [first, second]
        );
        assert_eq!(snapshot.nodes[0].parent, None);
        assert_eq!(snapshot.nodes[1].parent, None);
    }

    #[test]
    fn applies_scroll_offset_and_clips_bounds_to_visible_viewport() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let scroll = arena.create(NodeType::Scroll);
        let child = arena.create(NodeType::Text);
        arena.insert_child(root, scroll);
        arena.insert_child(scroll, child);
        arena.get_mut(root).unwrap().layout = rect(0.0, 0.0, 100.0, 100.0);
        arena.get_mut(scroll).unwrap().layout = rect(10.0, 10.0, 80.0, 40.0);
        arena.get_mut(scroll).unwrap().style.scroll_offset_y = 20.0;
        arena.get_mut(child).unwrap().layout = rect(10.0, 30.0, 80.0, 40.0);
        arena.get_mut(child).unwrap().semantics = Some(Semantics::text("Clipped"));

        let snapshot = SemanticTreeSnapshot::derive(&arena, root, None);
        assert_eq!(snapshot.nodes[0].bounds, rect(10.0, 10.0, 80.0, 40.0));
        assert_eq!(snapshot.nodes[0].parent, None);
    }

    #[test]
    fn carries_focus_disabled_checked_and_actions_state() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let button = arena.create(NodeType::View);
        arena.insert_child(root, button);
        arena.get_mut(button).unwrap().layout = rect(0.0, 0.0, 40.0, 20.0);
        arena.get_mut(button).unwrap().semantics = Some(Semantics {
            role: SemanticRole::Button,
            label: Some("Save".to_owned()),
            disabled: true,
            checked: Some(true),
            actions: vec![SemanticAction::Invoke],
            ..Semantics::default()
        });
        let snapshot = SemanticTreeSnapshot::derive(&arena, root, Some(button));
        assert!(snapshot.nodes[0].state.disabled);
        assert_eq!(snapshot.nodes[0].state.checked, Some(true));
        assert!(snapshot.nodes[0].state.focused);
        assert_eq!(snapshot.nodes[0].actions, [SemanticAction::Invoke]);
    }

    #[test]
    fn component_defaults_fill_missing_nodes_but_explicit_semantics_win() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let defaulted = arena.create(NodeType::View);
        let explicit = arena.create(NodeType::View);
        let skipped = arena.create(NodeType::View);
        for id in [root, defaulted, explicit, skipped] {
            arena.get_mut(id).unwrap().layout = rect(0.0, 0.0, 40.0, 20.0);
        }
        arena.insert_child(root, defaulted);
        arena.insert_child(root, explicit);
        arena.insert_child(root, skipped);
        arena.get_mut(explicit).unwrap().semantics = Some(Semantics::text("Explicit"));

        let snapshot = SemanticTreeSnapshot::derive_with_defaults(&arena, root, None, |id, _| {
            (id == defaulted).then(|| Semantics::button("Default"))
        });

        assert_eq!(snapshot.nodes.len(), 2);
        assert_eq!(snapshot.node(defaulted).unwrap().role, SemanticRole::Button);
        assert_eq!(
            snapshot.node(defaulted).unwrap().name.as_deref(),
            Some("Default")
        );
        assert_eq!(snapshot.node(explicit).unwrap().role, SemanticRole::Text);
        assert_eq!(
            snapshot.node(explicit).unwrap().name.as_deref(),
            Some("Explicit")
        );
        assert!(snapshot.node(skipped).is_none());
    }

    #[test]
    fn diff_is_deterministic_and_removes_children_before_parents() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let parent = arena.create(NodeType::View);
        let child = arena.create(NodeType::Text);
        arena.insert_child(root, parent);
        arena.insert_child(parent, child);
        for id in [root, parent, child] {
            arena.get_mut(id).unwrap().layout = rect(0.0, 0.0, 20.0, 20.0);
        }
        arena.get_mut(parent).unwrap().semantics = Some(Semantics::text("Parent"));
        arena.get_mut(child).unwrap().semantics = Some(Semantics::text("Child"));
        let before = SemanticTreeSnapshot::derive(&arena, root, None);
        arena
            .get_mut(parent)
            .unwrap()
            .semantics
            .as_mut()
            .unwrap()
            .label = Some("Changed".to_owned());
        arena.remove(child);
        let after = SemanticTreeSnapshot::derive(&arena, root, None);
        let diff = before.diff(&after);
        assert_eq!(diff.removed, [child]);
        assert_eq!(diff.updated.len(), 1);
        assert_eq!(diff.updated[0].id, parent);
        assert!(after.diff(&after).is_empty());
    }
}

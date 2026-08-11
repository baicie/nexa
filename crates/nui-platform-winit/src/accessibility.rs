use std::collections::{HashMap, HashSet};

use accesskit::{
    Action, ActionData, ActionRequest, Affine, Node, NodeId as AccessKitNodeId, Rect, Role, Tree,
    TreeId, TreeUpdate,
};
use nui_core::{NodeId, SemanticAction, SemanticNode, SemanticRole, SemanticTreeSnapshot};

const ROOT_ID: AccessKitNodeId = AccessKitNodeId(0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessibilityActionRequest {
    pub target: NodeId,
    pub action: SemanticAction,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AccessibilityViewport {
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

impl AccessibilityViewport {
    #[must_use]
    pub const fn new(width: f64, height: f64, scale_factor: f64) -> Self {
        Self {
            width,
            height,
            scale_factor,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AccessibilityTree {
    title: String,
    previous: Option<SemanticTreeSnapshot>,
    previous_viewport: Option<AccessibilityViewport>,
}

impl AccessibilityTree {
    pub(crate) fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            previous: None,
            previous_viewport: None,
        }
    }

    pub(crate) fn full_update(
        &mut self,
        snapshot: &SemanticTreeSnapshot,
        viewport: AccessibilityViewport,
    ) -> TreeUpdate {
        self.previous = Some(snapshot.clone());
        self.previous_viewport = Some(viewport);

        let children = semantic_children(snapshot);
        let mut nodes = Vec::with_capacity(snapshot.nodes.len().saturating_add(1));
        nodes.push((ROOT_ID, self.root_node(viewport, &children)));
        nodes.extend(snapshot.nodes.iter().map(|semantic| {
            (
                accesskit_id(semantic.id),
                convert_node(semantic, children.get(&Some(semantic.id))),
            )
        }));
        let mut tree = Tree::new(ROOT_ID);
        tree.toolkit_name = Some("Nexa UI".to_owned());
        tree.toolkit_version = Some(env!("CARGO_PKG_VERSION").to_owned());
        TreeUpdate {
            nodes,
            tree: Some(tree),
            tree_id: TreeId::ROOT,
            focus: semantic_focus(snapshot),
        }
    }

    pub(crate) fn incremental_update(
        &mut self,
        snapshot: &SemanticTreeSnapshot,
        viewport: AccessibilityViewport,
    ) -> Option<TreeUpdate> {
        let Some(previous) = self.previous.clone() else {
            return Some(self.full_update(snapshot, viewport));
        };
        let previous_viewport = self.previous_viewport;
        let old_children = semantic_children(&previous);
        let new_children = semantic_children(snapshot);
        let old_by_id = previous
            .nodes
            .iter()
            .map(|node| (node.id, node))
            .collect::<HashMap<_, _>>();
        let new_by_id = snapshot
            .nodes
            .iter()
            .map(|node| (node.id, node))
            .collect::<HashMap<_, _>>();

        let mut changed_nodes = snapshot
            .nodes
            .iter()
            .filter(|node| {
                old_by_id
                    .get(&node.id)
                    .is_none_or(|previous| semantic_payload_changed(previous, node))
            })
            .map(|node| node.id)
            .collect::<HashSet<_>>();
        let mut root_changed = previous_viewport != Some(viewport);
        let parents = old_children
            .keys()
            .chain(new_children.keys())
            .copied()
            .collect::<HashSet<_>>();
        for parent in parents {
            if old_children.get(&parent) == new_children.get(&parent) {
                continue;
            }
            match parent {
                Some(parent) if new_by_id.contains_key(&parent) => {
                    changed_nodes.insert(parent);
                }
                Some(_) => {}
                None => root_changed = true,
            }
        }

        let old_focus = semantic_focus(&previous);
        let focus = semantic_focus(snapshot);
        let focus_changed = old_focus != focus;
        self.previous = Some(snapshot.clone());
        self.previous_viewport = Some(viewport);
        if !root_changed && changed_nodes.is_empty() && !focus_changed {
            return None;
        }

        let mut nodes = Vec::with_capacity(changed_nodes.len() + usize::from(root_changed));
        if root_changed {
            nodes.push((ROOT_ID, self.root_node(viewport, &new_children)));
        }
        nodes.extend(
            snapshot
                .nodes
                .iter()
                .filter(|node| changed_nodes.contains(&node.id))
                .map(|semantic| {
                    (
                        accesskit_id(semantic.id),
                        convert_node(semantic, new_children.get(&Some(semantic.id))),
                    )
                }),
        );
        Some(TreeUpdate {
            nodes,
            tree: None,
            tree_id: TreeId::ROOT,
            focus,
        })
    }

    pub(crate) fn reset(&mut self) {
        self.previous = None;
        self.previous_viewport = None;
    }

    fn root_node(
        &self,
        viewport: AccessibilityViewport,
        children: &HashMap<Option<NodeId>, Vec<NodeId>>,
    ) -> Node {
        let mut root = Node::new(Role::Window);
        root.set_label(self.title.clone());
        root.set_bounds(Rect {
            x0: 0.0,
            y0: 0.0,
            x1: viewport.width,
            y1: viewport.height,
        });
        root.set_transform(Affine::scale(viewport.scale_factor));
        root.set_children(
            children
                .get(&None)
                .into_iter()
                .flatten()
                .copied()
                .map(accesskit_id)
                .collect::<Vec<_>>(),
        );
        root
    }
}

pub(crate) fn normalize_action_request(
    request: ActionRequest,
) -> Option<AccessibilityActionRequest> {
    if request.target_tree != TreeId::ROOT || request.target_node == ROOT_ID {
        return None;
    }
    let (action, value) = match (request.action, request.data) {
        (Action::Click, None) => (SemanticAction::Invoke, None),
        (Action::Focus, None) => (SemanticAction::Focus, None),
        (Action::SetValue, Some(ActionData::Value(value))) => {
            (SemanticAction::SetValue, Some(value.into()))
        }
        _ => return None,
    };
    Some(AccessibilityActionRequest {
        target: NodeId::from_raw(request.target_node.0),
        action,
        value,
    })
}

fn accesskit_id(id: NodeId) -> AccessKitNodeId {
    AccessKitNodeId(id.raw())
}

fn semantic_focus(snapshot: &SemanticTreeSnapshot) -> AccessKitNodeId {
    snapshot
        .nodes
        .iter()
        .find(|node| node.state.focused)
        .map_or(ROOT_ID, |node| accesskit_id(node.id))
}

fn semantic_children(snapshot: &SemanticTreeSnapshot) -> HashMap<Option<NodeId>, Vec<NodeId>> {
    let mut children = HashMap::<Option<NodeId>, Vec<NodeId>>::new();
    for node in &snapshot.nodes {
        children.entry(node.parent).or_default().push(node.id);
    }
    children
}

fn semantic_payload_changed(previous: &SemanticNode, next: &SemanticNode) -> bool {
    previous.role != next.role
        || previous.name != next.name
        || previous.value != next.value
        || previous.description != next.description
        || previous.state.disabled != next.state.disabled
        || previous.state.checked != next.state.checked
        || previous.bounds != next.bounds
        || previous.actions != next.actions
}

fn convert_node(semantic: &SemanticNode, children: Option<&Vec<NodeId>>) -> Node {
    let mut node = Node::new(match semantic.role {
        SemanticRole::None => Role::GenericContainer,
        SemanticRole::Button => Role::Button,
        SemanticRole::Text => Role::Label,
        SemanticRole::Image => Role::Image,
        SemanticRole::TextInput => Role::TextInput,
        SemanticRole::Scroll => Role::ScrollView,
        SemanticRole::Header => Role::Heading,
    });
    if let Some(name) = &semantic.name {
        node.set_label(name.clone());
    }
    if let Some(value) = semantic.value.as_ref().or_else(|| {
        (semantic.role == SemanticRole::Text)
            .then_some(semantic.name.as_ref())
            .flatten()
    }) {
        node.set_value(value.clone());
    }
    if let Some(description) = &semantic.description {
        node.set_description(description.clone());
    }
    if semantic.state.disabled {
        node.set_disabled();
    }
    if let Some(checked) = semantic.state.checked {
        node.set_toggled(checked.into());
    }
    node.set_bounds(Rect {
        x0: f64::from(semantic.bounds.x),
        y0: f64::from(semantic.bounds.y),
        x1: f64::from(semantic.bounds.x + semantic.bounds.width),
        y1: f64::from(semantic.bounds.y + semantic.bounds.height),
    });
    for action in &semantic.actions {
        node.add_action(match action {
            SemanticAction::Invoke => Action::Click,
            SemanticAction::Focus => Action::Focus,
            SemanticAction::SetValue => Action::SetValue,
        });
    }
    node.set_children(
        children
            .into_iter()
            .flatten()
            .copied()
            .map(accesskit_id)
            .collect::<Vec<_>>(),
    );
    node
}

#[cfg(test)]
mod tests {
    use accesskit::{Action, ActionData, ActionRequest, Role, Toggled, TreeId};
    use nui_core::{
        LayoutRect, SemanticAction, SemanticNode, SemanticRole, SemanticState, SemanticTreeSnapshot,
    };

    use super::{
        normalize_action_request, AccessKitNodeId, AccessibilityTree, AccessibilityViewport,
        ROOT_ID,
    };

    fn node(id: u32, parent: Option<u32>, role: SemanticRole, name: &str) -> SemanticNode {
        SemanticNode {
            id: nui_core::NodeId::new(id, 1),
            parent: parent.map(|parent| nui_core::NodeId::new(parent, 1)),
            role,
            name: Some(name.to_owned()),
            value: None,
            description: None,
            state: SemanticState::default(),
            bounds: LayoutRect {
                x: id as f32 * 10.0,
                y: id as f32 * 5.0,
                width: 80.0,
                height: 24.0,
            },
            actions: Vec::new(),
        }
    }

    fn find(update: &accesskit::TreeUpdate, id: nui_core::NodeId) -> &accesskit::Node {
        update
            .nodes
            .iter()
            .find_map(|(candidate, node)| (*candidate == AccessKitNodeId(id.raw())).then_some(node))
            .expect("converted node")
    }

    #[test]
    fn g3b04_converter_builds_complete_tree_with_roles_fields_actions_focus_and_scale() {
        let mut button = node(1, None, SemanticRole::Button, "Save");
        button.state.checked = Some(true);
        button.state.focused = true;
        button.actions = vec![SemanticAction::Invoke, SemanticAction::Focus];
        let text = node(2, Some(1), SemanticRole::Text, "Save note");
        let mut input = node(3, None, SemanticRole::TextInput, "Title");
        input.value = Some("Draft".to_owned());
        input.description = Some("Document title".to_owned());
        input.state.disabled = true;
        input.actions = vec![SemanticAction::Focus, SemanticAction::SetValue];
        let snapshot = SemanticTreeSnapshot {
            nodes: vec![button.clone(), text.clone(), input.clone()],
        };

        let viewport = AccessibilityViewport::new(320.0, 200.0, 2.0);
        let update = AccessibilityTree::new("Notes").full_update(&snapshot, viewport);

        assert_eq!(update.tree.as_ref().map(|tree| tree.root), Some(ROOT_ID));
        assert_eq!(update.focus, AccessKitNodeId(button.id.raw()));
        assert_eq!(update.nodes.len(), 4);
        let root = update
            .nodes
            .iter()
            .find_map(|(id, node)| (*id == ROOT_ID).then_some(node))
            .expect("synthetic root");
        assert_eq!(root.role(), Role::Window);
        assert_eq!(root.label(), Some("Notes"));
        assert_eq!(
            root.children(),
            &[
                AccessKitNodeId(button.id.raw()),
                AccessKitNodeId(input.id.raw())
            ]
        );
        assert_eq!(root.transform(), Some(&accesskit::Affine::scale(2.0)));

        let converted_button = find(&update, button.id);
        assert_eq!(converted_button.role(), Role::Button);
        assert_eq!(
            converted_button.bounds(),
            Some(accesskit::Rect {
                x0: 10.0,
                y0: 5.0,
                x1: 90.0,
                y1: 29.0,
            })
        );
        assert_eq!(converted_button.toggled(), Some(Toggled::True));
        assert!(converted_button.supports_action(Action::Click));
        assert!(converted_button.supports_action(Action::Focus));
        assert_eq!(
            converted_button.children(),
            &[AccessKitNodeId(text.id.raw())]
        );

        let converted_text = find(&update, text.id);
        assert_eq!(converted_text.role(), Role::Label);
        assert_eq!(converted_text.value(), Some("Save note"));

        let converted_input = find(&update, input.id);
        assert_eq!(converted_input.role(), Role::TextInput);
        assert_eq!(converted_input.label(), Some("Title"));
        assert_eq!(converted_input.value(), Some("Draft"));
        assert_eq!(converted_input.description(), Some("Document title"));
        assert!(converted_input.is_disabled());
        assert!(converted_input.supports_action(Action::SetValue));
    }

    #[test]
    fn g3b05_role_name_query_is_coordinate_free() {
        let mut save = node(1, None, SemanticRole::Button, "Save");
        save.actions = vec![SemanticAction::Invoke];
        let mut title = node(2, None, SemanticRole::TextInput, "Title");
        title.value = Some("Draft".to_owned());
        title.actions = vec![SemanticAction::Focus, SemanticAction::SetValue];
        let update = AccessibilityTree::new("Notes").full_update(
            &SemanticTreeSnapshot {
                nodes: vec![save, title],
            },
            AccessibilityViewport::new(320.0, 200.0, 1.0),
        );

        let save_node = update
            .nodes
            .iter()
            .find_map(|(_, node)| {
                (node.role() == Role::Button && node.label() == Some("Save")).then_some(node)
            })
            .expect("Save button is addressable by role and name");
        assert!(save_node.supports_action(Action::Click));

        let title_node = update
            .nodes
            .iter()
            .find_map(|(_, node)| {
                (node.role() == Role::TextInput && node.label() == Some("Title")).then_some(node)
            })
            .expect("Title input is addressable by role and name");
        assert!(title_node.supports_action(Action::Focus));
        assert!(title_node.supports_action(Action::SetValue));
    }

    #[test]
    fn g3b04_converter_maps_image_scroll_header_and_none_roles() {
        let image = node(1, None, SemanticRole::Image, "Cover");
        let scroll = node(2, None, SemanticRole::Scroll, "Notes");
        let header = node(3, None, SemanticRole::Header, "Today");
        let generic = node(4, None, SemanticRole::None, "Container");
        let snapshot = SemanticTreeSnapshot {
            nodes: vec![
                image.clone(),
                scroll.clone(),
                header.clone(),
                generic.clone(),
            ],
        };

        let update = AccessibilityTree::new("Notes")
            .full_update(&snapshot, AccessibilityViewport::new(320.0, 200.0, 1.0));

        assert_eq!(find(&update, image.id).role(), Role::Image);
        assert_eq!(find(&update, scroll.id).role(), Role::ScrollView);
        assert_eq!(find(&update, header.id).role(), Role::Heading);
        assert_eq!(find(&update, generic.id).role(), Role::GenericContainer);
    }

    #[test]
    fn g3b04_converter_adds_child_and_resends_its_parent() {
        let parent = node(1, None, SemanticRole::Scroll, "Notes");
        let child = node(2, Some(1), SemanticRole::Text, "Draft");
        let before = SemanticTreeSnapshot {
            nodes: vec![parent.clone()],
        };
        let after = SemanticTreeSnapshot {
            nodes: vec![parent.clone(), child.clone()],
        };
        let viewport = AccessibilityViewport::new(320.0, 200.0, 1.0);
        let mut tree = AccessibilityTree::new("Notes");
        tree.full_update(&before, viewport);

        let update = tree
            .incremental_update(&after, viewport)
            .expect("child addition update");

        assert_eq!(
            update.nodes.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            [
                AccessKitNodeId(parent.id.raw()),
                AccessKitNodeId(child.id.raw())
            ]
        );
        assert_eq!(
            find(&update, parent.id).children(),
            &[AccessKitNodeId(child.id.raw())]
        );
    }

    #[test]
    fn g3b04_converter_updates_parent_children_when_a_semantic_child_is_removed() {
        let parent = node(1, None, SemanticRole::Scroll, "Notes");
        let child = node(2, Some(1), SemanticRole::Text, "Draft");
        let before = SemanticTreeSnapshot {
            nodes: vec![parent.clone(), child],
        };
        let after = SemanticTreeSnapshot {
            nodes: vec![parent.clone()],
        };
        let viewport = AccessibilityViewport::new(320.0, 200.0, 1.0);
        let mut tree = AccessibilityTree::new("Notes");
        tree.full_update(&before, viewport);

        let update = tree
            .incremental_update(&after, viewport)
            .expect("child removal update");

        assert_eq!(update.tree, None);
        assert_eq!(update.nodes.len(), 1);
        assert!(find(&update, parent.id).children().is_empty());
    }

    #[test]
    fn g3b04_converter_updates_synthetic_root_when_a_top_level_node_is_removed() {
        let first = node(1, None, SemanticRole::Text, "First");
        let second = node(2, None, SemanticRole::Text, "Second");
        let before = SemanticTreeSnapshot {
            nodes: vec![first.clone(), second],
        };
        let after = SemanticTreeSnapshot {
            nodes: vec![first.clone()],
        };
        let viewport = AccessibilityViewport::new(320.0, 200.0, 1.0);
        let mut tree = AccessibilityTree::new("Notes");
        tree.full_update(&before, viewport);

        let update = tree
            .incremental_update(&after, viewport)
            .expect("top-level removal update");

        assert_eq!(update.nodes.len(), 1);
        assert_eq!(update.nodes[0].0, ROOT_ID);
        assert_eq!(
            update.nodes[0].1.children(),
            &[AccessKitNodeId(first.id.raw())]
        );
    }

    #[test]
    fn g3b04_converter_field_update_only_replaces_the_changed_node() {
        let first = node(1, None, SemanticRole::Text, "First");
        let second = node(2, None, SemanticRole::Text, "Second");
        let before = SemanticTreeSnapshot {
            nodes: vec![first.clone(), second.clone()],
        };
        let mut changed = second;
        changed.name = Some("Changed".to_owned());
        let after = SemanticTreeSnapshot {
            nodes: vec![first, changed.clone()],
        };
        let viewport = AccessibilityViewport::new(320.0, 200.0, 1.0);
        let mut tree = AccessibilityTree::new("Notes");
        tree.full_update(&before, viewport);

        let update = tree
            .incremental_update(&after, viewport)
            .expect("field update");

        assert_eq!(update.nodes.len(), 1);
        assert_eq!(update.nodes[0].0, AccessKitNodeId(changed.id.raw()));
        assert_eq!(update.nodes[0].1.value(), Some("Changed"));
    }

    #[test]
    fn g3b04_converter_returns_none_for_an_unchanged_snapshot_and_viewport() {
        let snapshot = SemanticTreeSnapshot {
            nodes: vec![node(1, None, SemanticRole::Text, "Note")],
        };
        let viewport = AccessibilityViewport::new(320.0, 200.0, 1.0);
        let mut tree = AccessibilityTree::new("Notes");
        tree.full_update(&snapshot, viewport);

        assert_eq!(tree.incremental_update(&snapshot, viewport), None);
    }

    #[test]
    fn g3b04_converter_focus_falls_back_to_root_without_resending_nodes() {
        let mut focused = node(1, None, SemanticRole::Button, "Save");
        focused.state.focused = true;
        let before = SemanticTreeSnapshot {
            nodes: vec![focused.clone()],
        };
        focused.state.focused = false;
        let after = SemanticTreeSnapshot {
            nodes: vec![focused],
        };
        let viewport = AccessibilityViewport::new(320.0, 200.0, 1.0);
        let mut tree = AccessibilityTree::new("Notes");
        tree.full_update(&before, viewport);

        let update = tree
            .incremental_update(&after, viewport)
            .expect("focus-only update");

        assert_eq!(update.focus, ROOT_ID);
        assert!(update.nodes.is_empty());
    }

    #[test]
    fn g3b04_converter_viewport_or_scale_change_only_resends_the_root() {
        let snapshot = SemanticTreeSnapshot {
            nodes: vec![node(1, None, SemanticRole::Text, "Note")],
        };
        let mut tree = AccessibilityTree::new("Notes");
        tree.full_update(&snapshot, AccessibilityViewport::new(320.0, 200.0, 1.0));

        let update = tree
            .incremental_update(&snapshot, AccessibilityViewport::new(640.0, 400.0, 2.0))
            .expect("root geometry update");

        assert_eq!(update.nodes.len(), 1);
        assert_eq!(update.nodes[0].0, ROOT_ID);
        assert_eq!(
            update.nodes[0].1.transform(),
            Some(&accesskit::Affine::scale(2.0))
        );
        assert_eq!(
            update.nodes[0].1.bounds(),
            Some(accesskit::Rect {
                x0: 0.0,
                y0: 0.0,
                x1: 640.0,
                y1: 400.0,
            })
        );
    }

    #[test]
    fn g3b04_converter_reset_requires_another_complete_tree() {
        let snapshot = SemanticTreeSnapshot {
            nodes: vec![node(1, None, SemanticRole::Text, "Note")],
        };
        let viewport = AccessibilityViewport::new(320.0, 200.0, 1.0);
        let mut tree = AccessibilityTree::new("Notes");
        tree.full_update(&snapshot, viewport);
        tree.reset();

        let update = tree
            .incremental_update(&snapshot, viewport)
            .expect("full tree after reset");

        assert!(update.tree.is_some());
        assert_eq!(update.nodes.len(), 2);
    }

    #[test]
    fn g3b04_converter_normalizes_supported_actions_and_rejects_invalid_data() {
        let target = nui_core::NodeId::new(7, 3);
        let set_value = normalize_action_request(ActionRequest {
            action: Action::SetValue,
            target_tree: TreeId::ROOT,
            target_node: AccessKitNodeId(target.raw()),
            data: Some(ActionData::Value("New title".into())),
        })
        .expect("supported SetValue");
        assert_eq!(set_value.target, target);
        assert_eq!(set_value.action, SemanticAction::SetValue);
        assert_eq!(set_value.value.as_deref(), Some("New title"));

        for request in [
            ActionRequest {
                action: Action::SetValue,
                target_tree: TreeId::ROOT,
                target_node: AccessKitNodeId(target.raw()),
                data: None,
            },
            ActionRequest {
                action: Action::Click,
                target_tree: TreeId::ROOT,
                target_node: ROOT_ID,
                data: None,
            },
            ActionRequest {
                action: Action::Blur,
                target_tree: TreeId::ROOT,
                target_node: AccessKitNodeId(target.raw()),
                data: None,
            },
        ] {
            assert_eq!(normalize_action_request(request), None);
        }
    }
}

//! Deterministic single-window focus state and keyboard traversal.

use std::collections::HashMap;

use crate::tree::{Arena, NodeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FocusRegistration {
    pub tab_index: i32,
    pub enabled: bool,
}

#[derive(Debug, Default, Clone)]
pub struct FocusManager {
    registrations: HashMap<NodeId, FocusRegistration>,
    focused: Option<NodeId>,
    chain: Vec<NodeId>,
}

impl FocusManager {
    /// Register or update a focusable node. Negative tab indices stay
    /// registered for explicit focus but are excluded from keyboard traversal.
    pub fn register(&mut self, node: NodeId, tab_index: i32, enabled: bool) {
        self.registrations
            .insert(node, FocusRegistration { tab_index, enabled });
    }

    /// Remove a registration. Call [`Self::reconcile`] after the corresponding
    /// tree mutation to recover focus to the next eligible node.
    pub fn unregister(&mut self, node: NodeId) {
        self.registrations.remove(&node);
    }

    pub fn set_enabled(&mut self, node: NodeId, enabled: bool) -> bool {
        let Some(registration) = self.registrations.get_mut(&node) else {
            return false;
        };
        registration.enabled = enabled;
        true
    }

    #[must_use]
    pub fn registration(&self, node: NodeId) -> Option<FocusRegistration> {
        self.registrations.get(&node).copied()
    }

    pub fn request_focus(&mut self, node: NodeId, arena: &Arena, root: Option<NodeId>) -> bool {
        let _ = self.reconcile(arena, root);
        let can_focus = self
            .registrations
            .get(&node)
            .is_some_and(|registration| registration.enabled)
            && self.document_order(arena, root).contains(&node);
        if !can_focus {
            return false;
        }
        self.focused = Some(node);
        true
    }

    /// Reconcile registrations with the live tree and recover a deleted or
    /// disabled focus target from the previous chain snapshot.
    pub fn reconcile(&mut self, arena: &Arena, root: Option<NodeId>) -> Option<NodeId> {
        let previous_chain = std::mem::take(&mut self.chain);
        let previous_focus = self.focused;
        let chain = self.ordered_chain(arena, root);
        self.focused = match previous_focus {
            Some(focused) if chain.contains(&focused) => Some(focused),
            Some(focused) => previous_chain
                .iter()
                .position(|candidate| *candidate == focused)
                .and_then(|index| {
                    chain
                        .get(index)
                        .copied()
                        .or_else(|| chain.get(..index)?.iter().next_back().copied())
                }),
            None => None,
        };
        self.chain = chain;
        self.focused
    }

    pub fn focus_next(&mut self, arena: &Arena, root: Option<NodeId>) -> Option<NodeId> {
        let _ = self.reconcile(arena, root);
        let chain = self.chain.clone();
        if chain.is_empty() {
            self.focused = None;
            return None;
        }
        let next = self
            .focused
            .and_then(|focused| chain.iter().position(|node| *node == focused))
            .map_or(0, |index| (index + 1) % chain.len());
        self.focused = Some(chain[next]);
        self.focused
    }

    pub fn focus_previous(&mut self, arena: &Arena, root: Option<NodeId>) -> Option<NodeId> {
        let _ = self.reconcile(arena, root);
        if self.chain.is_empty() {
            self.focused = None;
            return None;
        }
        let previous = self
            .focused
            .and_then(|focused| self.chain.iter().position(|node| *node == focused))
            .map_or(self.chain.len() - 1, |index| {
                if index == 0 {
                    self.chain.len() - 1
                } else {
                    index - 1
                }
            });
        self.focused = Some(self.chain[previous]);
        self.focused
    }

    pub fn clear_focus(&mut self) -> Option<NodeId> {
        self.focused.take()
    }

    #[must_use]
    pub fn focused(&self) -> Option<NodeId> {
        self.focused
    }

    #[must_use]
    pub fn chain(&self) -> &[NodeId] {
        &self.chain
    }

    fn ordered_chain(&self, arena: &Arena, root: Option<NodeId>) -> Vec<NodeId> {
        let document_order = self.document_order(arena, root);
        let mut positive = Vec::new();
        let mut normal = Vec::new();
        for node in document_order {
            let Some(registration) = self.registrations.get(&node) else {
                continue;
            };
            if !registration.enabled || registration.tab_index < 0 {
                continue;
            }
            if registration.tab_index > 0 {
                positive.push((registration.tab_index, node));
            } else {
                normal.push(node);
            }
        }
        positive.sort_by_key(|(tab_index, _)| *tab_index);
        positive
            .into_iter()
            .map(|(_, node)| node)
            .chain(normal)
            .collect()
    }

    fn document_order(&self, arena: &Arena, root: Option<NodeId>) -> Vec<NodeId> {
        let mut document_order = Vec::new();
        let mut stack = root.into_iter().collect::<Vec<_>>();
        while let Some(node) = stack.pop() {
            let Some(value) = arena.get(node) else {
                continue;
            };
            document_order.push(node);
            stack.extend(value.children.iter().rev().copied());
        }
        document_order
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::NodeType;

    fn tree() -> (Arena, NodeId, NodeId, NodeId, NodeId) {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let first = arena.create(NodeType::View);
        let second = arena.create(NodeType::View);
        let third = arena.create(NodeType::View);
        arena.insert_child(root, first);
        arena.insert_child(root, second);
        arena.insert_child(root, third);
        (arena, root, first, second, third)
    }

    #[test]
    fn tab_chain_filters_disabled_and_negative_entries_and_orders_positive_indices() {
        let (arena, root, first, second, third) = tree();
        let mut manager = FocusManager::default();
        manager.register(first, 2, true);
        manager.register(second, 1, true);
        manager.register(third, 0, true);
        manager.register(root, -1, true);
        manager.register(NodeId::new(99, 1), 0, true);

        assert_eq!(manager.reconcile(&arena, Some(root)), None);
        assert_eq!(manager.chain(), &[second, first, third]);

        manager.unregister(third);
        manager.register(third, 0, false);
        manager.reconcile(&arena, Some(root));
        assert_eq!(manager.chain(), &[second, first]);
    }

    #[test]
    fn next_and_previous_focus_wrap_deterministically() {
        let (arena, root, first, second, third) = tree();
        let mut manager = FocusManager::default();
        for node in [first, second, third] {
            manager.register(node, 0, true);
        }

        assert_eq!(manager.focus_next(&arena, Some(root)), Some(first));
        assert_eq!(manager.focus_next(&arena, Some(root)), Some(second));
        assert_eq!(manager.focus_previous(&arena, Some(root)), Some(first));
        assert_eq!(manager.focus_previous(&arena, Some(root)), Some(third));
    }

    #[test]
    fn deleting_focused_node_prefers_next_then_previous_then_clear() {
        let (mut arena, root, first, second, third) = tree();
        let mut manager = FocusManager::default();
        for node in [first, second, third] {
            manager.register(node, 0, true);
        }
        assert!(manager.request_focus(second, &arena, Some(root)));

        arena.remove(second);
        assert_eq!(manager.reconcile(&arena, Some(root)), Some(third));
        assert_eq!(manager.focused(), Some(third));

        arena.remove(third);
        assert_eq!(manager.reconcile(&arena, Some(root)), Some(first));
        assert_eq!(manager.focused(), Some(first));

        arena.remove(first);
        assert_eq!(manager.reconcile(&arena, Some(root)), None);
        assert_eq!(manager.focused(), None);
    }

    #[test]
    fn negative_tab_index_can_receive_explicit_focus_but_is_not_in_tab_chain() {
        let (arena, root, first, second, _) = tree();
        let mut manager = FocusManager::default();
        manager.register(first, -1, true);
        manager.register(second, 0, true);

        assert!(manager.request_focus(first, &arena, Some(root)));
        assert_eq!(manager.focused(), Some(first));
        assert_eq!(manager.chain(), &[second]);
        assert_eq!(manager.focus_next(&arena, Some(root)), Some(second));
    }
}

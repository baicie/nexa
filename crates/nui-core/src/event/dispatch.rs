//! Capture/target/bubble dispatch and pointer capture state.

use std::collections::{HashMap, HashSet};

use crate::tree::{Arena, NodeId};

use super::PropagationPhase;
use crate::protocol::ui::PropagationState;

#[derive(Debug, Clone, Default)]
pub struct PointerCapture {
    captures: HashMap<u32, NodeId>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DispatchResult {
    pub target: Option<NodeId>,
    pub visits: Vec<(NodeId, PropagationPhase)>,
    pub propagation: PropagationState,
}

#[derive(Debug, Default, Clone)]
pub struct EventDispatcher {
    pointer_capture: PointerCapture,
}

impl PointerCapture {
    pub fn set(&mut self, pointer_id: u32, node: NodeId, arena: &Arena) -> bool {
        if arena.get(node).is_none() {
            return false;
        }
        self.captures.insert(pointer_id, node);
        true
    }

    pub fn release(&mut self, pointer_id: u32) -> Option<NodeId> {
        self.captures.remove(&pointer_id)
    }

    pub fn target(
        &mut self,
        pointer_id: u32,
        hit_target: Option<NodeId>,
        arena: &Arena,
    ) -> Option<NodeId> {
        if let Some(captured) = self.captures.get(&pointer_id).copied() {
            if arena.get(captured).is_some() {
                return Some(captured);
            }
            self.captures.remove(&pointer_id);
        }
        hit_target.filter(|node| arena.get(*node).is_some())
    }

    pub fn captured(&self, pointer_id: u32) -> Option<NodeId> {
        self.captures.get(&pointer_id).copied()
    }
}

impl EventDispatcher {
    pub fn set_pointer_capture(&mut self, pointer_id: u32, node: NodeId, arena: &Arena) -> bool {
        self.pointer_capture.set(pointer_id, node, arena)
    }

    pub fn release_pointer_capture(&mut self, pointer_id: u32) -> Option<NodeId> {
        self.pointer_capture.release(pointer_id)
    }

    pub fn dispatch(
        &mut self,
        arena: &Arena,
        hit_target: Option<NodeId>,
        pointer_id: Option<u32>,
        mut listener: impl FnMut(NodeId, PropagationPhase, &mut PropagationState),
    ) -> DispatchResult {
        let target = pointer_id
            .and_then(|pointer_id| self.pointer_capture.target(pointer_id, hit_target, arena))
            .or_else(|| {
                pointer_id
                    .is_none()
                    .then_some(hit_target)
                    .flatten()
                    .filter(|node| arena.get(*node).is_some())
            });
        let mut propagation = PropagationState {
            phase: PropagationPhase::Capture,
            default_prevented: false,
            propagation_stopped: false,
            immediate_propagation_stopped: false,
        };
        let mut visits = Vec::new();

        if let Some(target) = target {
            let path = event_path(arena, target);
            if !path.is_empty() {
                for node in path.iter().take(path.len().saturating_sub(1)) {
                    if propagation.propagation_stopped || propagation.immediate_propagation_stopped
                    {
                        break;
                    }
                    propagation.phase = PropagationPhase::Capture;
                    visits.push((*node, propagation.phase));
                    listener(*node, propagation.phase, &mut propagation);
                }

                if !propagation.propagation_stopped && !propagation.immediate_propagation_stopped {
                    propagation.phase = PropagationPhase::Target;
                    visits.push((target, propagation.phase));
                    listener(target, propagation.phase, &mut propagation);
                }

                if !propagation.propagation_stopped && !propagation.immediate_propagation_stopped {
                    for node in path[..path.len().saturating_sub(1)].iter().rev() {
                        if propagation.propagation_stopped
                            || propagation.immediate_propagation_stopped
                        {
                            break;
                        }
                        propagation.phase = PropagationPhase::Bubble;
                        visits.push((*node, propagation.phase));
                        listener(*node, propagation.phase, &mut propagation);
                    }
                }

                if !propagation.default_prevented {
                    propagation.phase = PropagationPhase::DefaultAction;
                    visits.push((target, propagation.phase));
                    listener(target, propagation.phase, &mut propagation);
                }
            }
        }

        DispatchResult {
            target,
            visits,
            propagation,
        }
    }

    pub fn captured_pointer(&self, pointer_id: u32) -> Option<NodeId> {
        self.pointer_capture.captured(pointer_id)
    }
}

/// Return the live ancestor path in dispatch order (root first, target last).
#[must_use]
pub fn event_path(arena: &Arena, target: NodeId) -> Vec<NodeId> {
    if arena.get(target).is_none() {
        return Vec::new();
    }
    let mut reverse = vec![target];
    let mut visited = HashSet::new();
    visited.insert(target);
    let mut current = arena.get(target).and_then(|node| node.parent);
    while let Some(node) = current {
        if !visited.insert(node) || arena.get(node).is_none() {
            break;
        }
        reverse.push(node);
        current = arena.get(node).and_then(|value| value.parent);
    }
    reverse.reverse();
    reverse
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::NodeType;

    fn tree() -> (Arena, NodeId, NodeId, NodeId) {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let parent = arena.create(NodeType::View);
        let target = arena.create(NodeType::View);
        arena.insert_child(root, parent);
        arena.insert_child(parent, target);
        (arena, root, parent, target)
    }

    #[test]
    fn dispatches_capture_target_bubble_and_default_action_in_order() {
        let (arena, root, parent, target) = tree();
        let mut dispatcher = EventDispatcher::default();
        let mut trace = Vec::new();
        let result = dispatcher.dispatch(&arena, Some(target), None, |node, phase, _state| {
            trace.push((node, phase));
        });

        let expected = vec![
            (root, PropagationPhase::Capture),
            (parent, PropagationPhase::Capture),
            (target, PropagationPhase::Target),
            (parent, PropagationPhase::Bubble),
            (root, PropagationPhase::Bubble),
            (target, PropagationPhase::DefaultAction),
        ];
        assert_eq!(trace, expected);
        assert_eq!(result.visits, expected);
        assert!(!result.propagation.default_prevented);
    }

    #[test]
    fn stop_propagation_stops_dispatch_but_does_not_cancel_default_action() {
        let (arena, root, parent, target) = tree();
        let mut dispatcher = EventDispatcher::default();
        let mut trace = Vec::new();
        let result = dispatcher.dispatch(&arena, Some(target), None, |node, phase, state| {
            trace.push((node, phase));
            if node == parent && phase == PropagationPhase::Capture {
                state.propagation_stopped = true;
            }
        });

        assert_eq!(
            trace,
            vec![
                (root, PropagationPhase::Capture),
                (parent, PropagationPhase::Capture),
                (target, PropagationPhase::DefaultAction),
            ]
        );
        assert_eq!(result.propagation.phase, PropagationPhase::DefaultAction);
        assert!(result.propagation.propagation_stopped);
    }

    #[test]
    fn prevent_default_skips_default_action() {
        let (arena, _, _, target) = tree();
        let mut dispatcher = EventDispatcher::default();
        let result = dispatcher.dispatch(&arena, Some(target), None, |_node, phase, state| {
            if phase == PropagationPhase::Target {
                state.default_prevented = true;
            }
        });
        assert!(result
            .visits
            .iter()
            .all(|(_, phase)| *phase != PropagationPhase::DefaultAction));
        assert!(result.propagation.default_prevented);
    }

    #[test]
    fn immediate_stop_skips_remaining_path_and_keeps_default_action_available() {
        let (arena, root, parent, target) = tree();
        let mut dispatcher = EventDispatcher::default();
        let result = dispatcher.dispatch(&arena, Some(target), None, |node, phase, state| {
            if node == root && phase == PropagationPhase::Capture {
                state.immediate_propagation_stopped = true;
                state.propagation_stopped = true;
            }
        });
        assert_eq!(
            result.visits,
            vec![
                (root, PropagationPhase::Capture),
                (target, PropagationPhase::DefaultAction),
            ]
        );
        assert!(!result.visits.contains(&(parent, PropagationPhase::Capture)));
        assert!(result.propagation.immediate_propagation_stopped);
    }

    #[test]
    fn pointer_capture_overrides_hit_target_until_release_and_rejects_stale_nodes() {
        let (mut arena, _, _, target) = tree();
        let other = arena.create(NodeType::View);
        let mut dispatcher = EventDispatcher::default();
        assert!(dispatcher.set_pointer_capture(7, target, &arena));
        assert_eq!(dispatcher.captured_pointer(7), Some(target));

        let result = dispatcher.dispatch(&arena, Some(other), Some(7), |_node, _phase, _state| {});
        assert_eq!(result.target, Some(target));
        assert_eq!(dispatcher.release_pointer_capture(7), Some(target));
        let result = dispatcher.dispatch(&arena, Some(other), Some(7), |_node, _phase, _state| {});
        assert_eq!(result.target, Some(other));

        arena.remove(target);
        assert!(!dispatcher.set_pointer_capture(8, target, &arena));
        assert_eq!(
            dispatcher
                .dispatch(&arena, Some(other), Some(7), |_node, _phase, _state| {})
                .target,
            Some(other)
        );
    }
}

//! Validated, atomic batches of Host tree mutations.
//!
//! A batch is validated against a shadow Arena before it is applied to the
//! active Arena. `Created` references make create-then-insert sequences
//! expressible without exposing provisional native handles.

use crate::{Arena, NodeId, NodeType, PropertyId, ResourceId, Semantics, Style, TreeMutationError};

/// A node reference inside a batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NodeRef {
    Existing(NodeId),
    Created(u32),
}

/// Commands accepted by the first application-runtime batch contract.
#[derive(Debug, Clone, PartialEq)]
pub enum MutationCommand {
    Create {
        node_type: NodeType,
    },
    Insert {
        child: NodeRef,
        parent: NodeRef,
        before: Option<NodeRef>,
    },
    Remove {
        node: NodeRef,
    },
    SetText {
        node: NodeRef,
        text: String,
    },
    SetProperty {
        node: NodeRef,
        property: PropertyId,
        value: f64,
    },
    ClearProperty {
        node: NodeRef,
        property: PropertyId,
    },
    SetStyle {
        node: NodeRef,
        style: Style,
    },
    SetClickable {
        node: NodeRef,
        clickable: bool,
    },
    RegisterButton {
        node: NodeRef,
    },
    SetImageResource {
        node: NodeRef,
        resource_id: Option<ResourceId>,
    },
    SetSemantics {
        node: NodeRef,
        semantics: Semantics,
    },
    ClearSemantics {
        node: NodeRef,
    },
}

/// Dirty bits returned by a successful commit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct DirtyFlags(u32);

impl DirtyFlags {
    pub const TREE: Self = Self(1 << 0);
    pub const LAYOUT: Self = Self(1 << 1);
    pub const PAINT: Self = Self(1 << 2);
    pub const SEMANTICS: Self = Self(1 << 3);

    #[must_use]
    pub const fn empty() -> Self {
        Self(0)
    }

    #[must_use]
    pub const fn bits(self) -> u32 {
        self.0
    }

    #[must_use]
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

/// A sequence-numbered batch owned by one Arena/runtime session.
#[derive(Debug, Clone, PartialEq)]
pub struct MutationBatch {
    sequence: u64,
    owner: u64,
    commands: Vec<MutationCommand>,
}

impl MutationBatch {
    #[must_use]
    pub fn new(sequence: u64, owner: u64) -> Self {
        Self {
            sequence,
            owner,
            commands: Vec::new(),
        }
    }

    #[must_use]
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    #[must_use]
    pub const fn owner(&self) -> u64 {
        self.owner
    }

    #[must_use]
    pub fn commands(&self) -> &[MutationCommand] {
        &self.commands
    }

    pub fn push(&mut self, command: MutationCommand) {
        self.commands.push(command);
    }

    /// Validate the entire command list against a shadow Arena.
    pub fn validate(&self, arena: &Arena) -> Result<ValidatedMutationBatch, MutationError> {
        if self.owner != arena.owner() {
            return Err(MutationError::OwnerMismatch {
                expected: arena.owner(),
                actual: self.owner,
            });
        }

        let mut shadow = arena.clone();
        let mut created = Vec::new();
        for command in &self.commands {
            apply_command(&mut shadow, command, &mut created)?;
        }

        Ok(ValidatedMutationBatch {
            batch: self.clone(),
            created,
        })
    }
}

/// A batch that passed complete validation and can be applied atomically.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedMutationBatch {
    batch: MutationBatch,
    created: Vec<NodeId>,
}

impl ValidatedMutationBatch {
    #[must_use]
    pub fn created(&self) -> &[NodeId] {
        &self.created
    }

    /// Revalidate against the active Arena, then apply without fallible
    /// operations. Revalidation detects changes between validation and commit.
    pub fn apply(self, arena: &mut Arena) -> Result<MutationReceipt, MutationError> {
        let current = self.batch.validate(arena)?;
        if current.created != self.created {
            return Err(MutationError::PlanInvalidated);
        }

        let mut created = Vec::new();
        for command in &self.batch.commands {
            apply_command(arena, command, &mut created)?;
        }
        debug_assert_eq!(created, self.created);

        let dirty = self
            .batch
            .commands
            .iter()
            .fold(DirtyFlags::empty(), |flags, command| {
                flags.union(command_dirty_flags(command))
            });

        Ok(MutationReceipt {
            sequence: self.batch.sequence,
            owner: self.batch.owner,
            created,
            dirty,
            command_count: self.batch.commands.len() as u32,
        })
    }
}

/// Receipt returned after a successful batch commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationReceipt {
    pub sequence: u64,
    pub owner: u64,
    pub created: Vec<NodeId>,
    pub dirty: DirtyFlags,
    pub command_count: u32,
}

/// Reasons a batch cannot be committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationError {
    OwnerMismatch { expected: u64, actual: u64 },
    InvalidCreatedRef(u32),
    InvalidNodeType(u32),
    InvalidButtonNode { node: NodeId, actual: NodeType },
    InvalidPropertyId(u32),
    InvalidPropertyValue(PropertyId),
    InvalidSemantics,
    SequenceExhausted { sequence: u64 },
    StaleNode(NodeId),
    Tree(TreeMutationError),
    PlanInvalidated,
}

fn resolve(arena: &Arena, created: &[NodeId], reference: NodeRef) -> Result<NodeId, MutationError> {
    let node = match reference {
        NodeRef::Existing(node) => node,
        NodeRef::Created(index) => *created
            .get(index as usize)
            .ok_or(MutationError::InvalidCreatedRef(index))?,
    };
    if arena.get(node).is_none() {
        return Err(MutationError::StaleNode(node));
    }
    Ok(node)
}

fn apply_command(
    arena: &mut Arena,
    command: &MutationCommand,
    created: &mut Vec<NodeId>,
) -> Result<(), MutationError> {
    match command {
        MutationCommand::Create { node_type } => {
            created.push(arena.create(*node_type));
        }
        MutationCommand::Insert {
            child,
            parent,
            before,
        } => {
            let child = resolve(arena, created, *child)?;
            let parent = resolve(arena, created, *parent)?;
            let before = before
                .map(|reference| resolve(arena, created, reference))
                .transpose()?;
            arena
                .try_insert_child_before(parent, child, before)
                .map_err(MutationError::Tree)?;
        }
        MutationCommand::Remove { node } => {
            let node = resolve(arena, created, *node)?;
            arena.remove(node);
        }
        MutationCommand::SetText { node, text } => {
            let node = resolve(arena, created, *node)?;
            arena.set_text(node, text.clone());
        }
        MutationCommand::SetProperty {
            node,
            property,
            value,
        } => {
            if !value.is_finite() {
                return Err(MutationError::InvalidPropertyValue(*property));
            }
            let node = resolve(arena, created, *node)?;
            let Some(target) = arena.get_mut(node) else {
                return Err(MutationError::StaleNode(node));
            };
            target.style.set_property(*property, *value);
        }
        MutationCommand::ClearProperty { node, property } => {
            let node = resolve(arena, created, *node)?;
            let Some(target) = arena.get_mut(node) else {
                return Err(MutationError::StaleNode(node));
            };
            target.style.clear_property(*property);
        }
        MutationCommand::SetStyle { node, style } => {
            let node = resolve(arena, created, *node)?;
            arena.set_style(node, style.clone());
        }
        MutationCommand::SetClickable { node, clickable } => {
            let node = resolve(arena, created, *node)?;
            arena.set_clickable(node, *clickable);
        }
        MutationCommand::RegisterButton { node } => {
            let node = resolve(arena, created, *node)?;
            let Some(target) = arena.get_mut(node) else {
                return Err(MutationError::StaleNode(node));
            };
            if target.node_type != NodeType::View {
                return Err(MutationError::InvalidButtonNode {
                    node,
                    actual: target.node_type,
                });
            }
            target.is_button = true;
        }
        MutationCommand::SetImageResource { node, resource_id } => {
            let node = resolve(arena, created, *node)?;
            if !arena.set_image_resource(node, *resource_id) {
                return Err(MutationError::StaleNode(node));
            }
        }
        MutationCommand::SetSemantics { node, semantics } => {
            let node = resolve(arena, created, *node)?;
            let Some(target) = arena.get_mut(node) else {
                return Err(MutationError::StaleNode(node));
            };
            target.semantics = Some(semantics.clone());
        }
        MutationCommand::ClearSemantics { node } => {
            let node = resolve(arena, created, *node)?;
            let Some(target) = arena.get_mut(node) else {
                return Err(MutationError::StaleNode(node));
            };
            target.semantics = None;
        }
    }
    Ok(())
}

const fn command_dirty_flags(command: &MutationCommand) -> DirtyFlags {
    match command {
        MutationCommand::Create { .. }
        | MutationCommand::Insert { .. }
        | MutationCommand::Remove { .. } => DirtyFlags::TREE
            .union(DirtyFlags::LAYOUT)
            .union(DirtyFlags::PAINT)
            .union(DirtyFlags::SEMANTICS),
        MutationCommand::SetText { .. } => DirtyFlags::LAYOUT
            .union(DirtyFlags::PAINT)
            .union(DirtyFlags::SEMANTICS),
        MutationCommand::SetProperty {
            property: PropertyId::Disabled,
            ..
        }
        | MutationCommand::ClearProperty {
            property: PropertyId::Disabled,
            ..
        } => DirtyFlags::PAINT.union(DirtyFlags::SEMANTICS),
        MutationCommand::SetProperty { .. } | MutationCommand::ClearProperty { .. } => {
            DirtyFlags::LAYOUT.union(DirtyFlags::PAINT)
        }
        MutationCommand::SetStyle { .. } => DirtyFlags::LAYOUT.union(DirtyFlags::PAINT),
        MutationCommand::SetImageResource { .. } => DirtyFlags::PAINT,
        MutationCommand::SetClickable { .. }
        | MutationCommand::RegisterButton { .. }
        | MutationCommand::SetSemantics { .. }
        | MutationCommand::ClearSemantics { .. } => DirtyFlags::SEMANTICS,
    }
}

#[cfg(test)]
mod tests {
    use super::{DirtyFlags, MutationBatch, MutationCommand, MutationError, NodeRef};
    use crate::{Arena, NodeType, PropertyId, SemanticRole, Semantics, Style};

    #[test]
    fn validate_then_apply_creates_and_inserts_atomically() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let mut batch = MutationBatch::new(7, arena.owner());
        batch.push(MutationCommand::Create {
            node_type: NodeType::Text,
        });
        batch.push(MutationCommand::SetText {
            node: NodeRef::Created(0),
            text: "hello".to_owned(),
        });
        batch.push(MutationCommand::Insert {
            child: NodeRef::Created(0),
            parent: NodeRef::Existing(root),
            before: None,
        });

        let validated = batch.validate(&arena).expect("valid batch");
        assert!(arena.get(root).expect("root").children.is_empty());
        let receipt = validated.apply(&mut arena).expect("commit");
        let created = receipt.created[0];
        assert_eq!(arena.get(root).expect("root").children, vec![created]);
        assert_eq!(
            arena.get(created).and_then(|node| node.text.as_deref()),
            Some("hello")
        );
        assert_eq!(receipt.sequence, 7);
        assert_eq!(receipt.command_count, 3);
        assert!(receipt.dirty.contains(DirtyFlags::TREE));
        assert!(receipt.dirty.contains(DirtyFlags::LAYOUT));
    }

    #[test]
    fn failed_command_leaves_active_arena_unchanged() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let stale = arena.create(NodeType::View);
        arena.destroy(stale);
        let mut batch = MutationBatch::new(1, arena.owner());
        batch.push(MutationCommand::SetStyle {
            node: NodeRef::Existing(root),
            style: Style::default(),
        });
        batch.push(MutationCommand::Insert {
            child: NodeRef::Existing(root),
            parent: NodeRef::Existing(stale),
            before: None,
        });

        assert!(matches!(
            batch.validate(&arena),
            Err(MutationError::StaleNode(_))
        ));
        assert!(arena.get(root).expect("root").children.is_empty());
        assert_eq!(arena.get(root).expect("root").style.width, None);
    }

    #[test]
    fn owner_mismatch_is_rejected_before_shadow_work() {
        let arena = Arena::new();
        let batch = MutationBatch::new(1, arena.owner() + 1);
        assert_eq!(
            batch.validate(&arena),
            Err(MutationError::OwnerMismatch {
                expected: arena.owner(),
                actual: arena.owner() + 1,
            })
        );
    }

    #[test]
    fn stale_created_reference_is_rejected() {
        let arena = Arena::new();
        let mut batch = MutationBatch::new(1, arena.owner());
        batch.push(MutationCommand::SetClickable {
            node: NodeRef::Created(0),
            clickable: true,
        });
        assert_eq!(
            batch.validate(&arena),
            Err(MutationError::InvalidCreatedRef(0))
        );
    }

    #[test]
    fn property_commands_share_style_coercion_and_defaults() {
        let mut arena = Arena::new();
        let node = arena.create(NodeType::View);
        let mut batch = MutationBatch::new(11, arena.owner());
        batch.push(MutationCommand::SetProperty {
            node: NodeRef::Existing(node),
            property: PropertyId::Opacity,
            value: 0.25,
        });
        batch.push(MutationCommand::ClearProperty {
            node: NodeRef::Existing(node),
            property: PropertyId::Opacity,
        });
        let receipt = batch.validate(&arena).unwrap().apply(&mut arena).unwrap();
        assert_eq!(arena.get(node).unwrap().style.opacity, 1.0);
        assert!(receipt.dirty.contains(DirtyFlags::PAINT));
        assert!(receipt.dirty.contains(DirtyFlags::LAYOUT));
    }

    #[test]
    fn disabled_property_changes_paint_and_semantics_without_relayout() {
        let mut arena = Arena::new();
        let node = arena.create(NodeType::View);
        let mut batch = MutationBatch::new(12, arena.owner());
        batch.push(MutationCommand::SetProperty {
            node: NodeRef::Existing(node),
            property: PropertyId::Disabled,
            value: 1.0,
        });

        let receipt = batch.validate(&arena).unwrap().apply(&mut arena).unwrap();

        assert!(receipt.dirty.contains(DirtyFlags::PAINT));
        assert!(receipt.dirty.contains(DirtyFlags::SEMANTICS));
        assert!(!receipt.dirty.contains(DirtyFlags::LAYOUT));
    }

    #[test]
    fn register_button_is_atomic_and_only_marks_semantics_dirty() {
        let mut arena = Arena::new();
        let node = arena.create(NodeType::View);
        let mut batch = MutationBatch::new(13, arena.owner());
        batch.push(MutationCommand::RegisterButton {
            node: NodeRef::Existing(node),
        });

        let validated = batch.validate(&arena).expect("valid button registration");
        assert!(!arena.get(node).expect("node").is_button);

        let receipt = validated.apply(&mut arena).expect("register button");

        assert!(arena.get(node).expect("node").is_button);
        assert_eq!(receipt.dirty, DirtyFlags::SEMANTICS);
    }

    #[test]
    fn register_button_rejects_non_view_nodes() {
        let mut arena = Arena::new();
        let text = arena.create(NodeType::Text);
        let mut batch = MutationBatch::new(14, arena.owner());
        batch.push(MutationCommand::RegisterButton {
            node: NodeRef::Existing(text),
        });

        assert_eq!(
            batch.validate(&arena),
            Err(MutationError::InvalidButtonNode {
                node: text,
                actual: NodeType::Text,
            })
        );
        assert!(!arena.get(text).expect("text").is_button);
    }

    #[test]
    fn set_semantics_is_visible_only_after_commit_and_only_marks_semantics_dirty() {
        let mut arena = Arena::new();
        let node = arena.create(NodeType::View);
        let semantics = Semantics::button("Save");
        let mut batch = MutationBatch::new(13, arena.owner());
        batch.push(MutationCommand::SetSemantics {
            node: NodeRef::Existing(node),
            semantics: semantics.clone(),
        });

        let validated = batch.validate(&arena).expect("valid semantics batch");
        assert_eq!(arena.get(node).expect("node").semantics, None);

        let receipt = validated.apply(&mut arena).expect("commit semantics");

        assert_eq!(arena.get(node).expect("node").semantics, Some(semantics));
        assert_eq!(receipt.dirty, DirtyFlags::SEMANTICS);
    }

    #[test]
    fn clear_semantics_is_visible_only_after_commit_and_only_marks_semantics_dirty() {
        let mut arena = Arena::new();
        let node = arena.create(NodeType::Text);
        let original = Semantics::text("Status");
        arena.get_mut(node).expect("node").semantics = Some(original.clone());
        let mut batch = MutationBatch::new(14, arena.owner());
        batch.push(MutationCommand::ClearSemantics {
            node: NodeRef::Existing(node),
        });

        let validated = batch.validate(&arena).expect("valid semantics batch");
        assert_eq!(arena.get(node).expect("node").semantics, Some(original));

        let receipt = validated.apply(&mut arena).expect("clear semantics");

        assert_eq!(arena.get(node).expect("node").semantics, None);
        assert_eq!(receipt.dirty, DirtyFlags::SEMANTICS);
    }

    #[test]
    fn stale_semantics_command_rolls_back_the_entire_validated_batch() {
        let mut arena = Arena::new();
        let valid = arena.create(NodeType::View);
        let stale = arena.create(NodeType::View);
        let mut batch = MutationBatch::new(15, arena.owner());
        batch.push(MutationCommand::SetSemantics {
            node: NodeRef::Existing(valid),
            semantics: Semantics {
                role: SemanticRole::Header,
                label: Some("Account".to_owned()),
                ..Semantics::default()
            },
        });
        batch.push(MutationCommand::ClearSemantics {
            node: NodeRef::Existing(stale),
        });

        let validated = batch.validate(&arena).expect("initially valid batch");
        arena.destroy(stale);

        assert_eq!(
            validated.apply(&mut arena),
            Err(MutationError::StaleNode(stale))
        );
        assert_eq!(arena.get(valid).expect("valid node").semantics, None);
    }
}

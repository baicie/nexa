//! Validated, atomic batches of Host tree mutations.
//!
//! A batch is validated against a shadow Arena before it is applied to the
//! active Arena. `Created` references make create-then-insert sequences
//! expressible without exposing provisional native handles.

use crate::{Arena, NodeId, NodeType, Style, TreeMutationError};

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
    SetStyle {
        node: NodeRef,
        style: Style,
    },
    SetClickable {
        node: NodeRef,
        clickable: bool,
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

    const fn union(self, other: Self) -> Self {
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
        MutationCommand::SetStyle { node, style } => {
            let node = resolve(arena, created, *node)?;
            arena.set_style(node, style.clone());
        }
        MutationCommand::SetClickable { node, clickable } => {
            let node = resolve(arena, created, *node)?;
            arena.set_clickable(node, *clickable);
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
        MutationCommand::SetStyle { .. } => DirtyFlags::LAYOUT.union(DirtyFlags::PAINT),
        MutationCommand::SetClickable { .. } => DirtyFlags::SEMANTICS,
    }
}

#[cfg(test)]
mod tests {
    use super::{DirtyFlags, MutationBatch, MutationCommand, MutationError, NodeRef};
    use crate::{Arena, NodeType, Style};

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
}

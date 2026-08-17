//! Shared Host session state (tree + click / input tokens).

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use nui_app_runtime::{ErrorSupervisor, FrameMetricsObserver};
use nui_core::protocol::ui::{
    Rect as ProtocolRect, TextInputState as ProtocolTextInputState, TextRange as ProtocolTextRange,
    TextSelection as ProtocolTextSelection, WindowLifecycleEvent,
};
use nui_core::{
    hit_test, Arena, ColorRgba, CompositionEvent, CompositionKind, DirtyFlags, DisplayList,
    EventContext, EventDispatcher, EventId, EventModifiers, FocusManager, InteractionModel,
    LayoutRect, MutationBatch, MutationCommand, MutationError, MutationReceipt, Node, NodeId,
    NodeRef, NodeType, PropagationPhase, PropagationState, PropertyId, ResourceId, ResourceStore,
    SemanticTreeDiff, SemanticTreeSnapshot, Semantics, TreeMutationError,
};
use nui_layout_taffy::{
    display_list_with_cache_and_interactions_and_overrides, layout_tree_with_cache, LayoutError,
    ParagraphCache,
};
use nui_render_skia::{
    decode_image_file, paint_display_list, FocusedPaint, FontPaint, ImagePaint, PaintHints,
};
use nui_text::{
    CaretAffinity, CommandOutcome, EditError, FontDatabase, FontId, FontRequest,
    HorizontalDirection, KeyCommand, KeyModifiers, NavigationKey, TextAreaController, TextIndexMap,
    Utf16Range, Utf8Range, VerticalDirection,
};

use crate::frame_metrics::FrameMetricsState;
use crate::window::HostWindowApp;
use crate::{CallbackHandle, ListenerKey};

/// UI events delivered while the native window loop runs.
#[derive(Debug, Clone)]
pub enum HostUiEvent {
    Click {
        node: NodeId,
        callback: Option<CallbackHandle>,
    },
    Change {
        node: NodeId,
        value: String,
        callback: Option<CallbackHandle>,
    },
    Submit {
        node: NodeId,
        value: String,
        callback: Option<CallbackHandle>,
    },
    Composition {
        node: NodeId,
        event: CompositionEvent,
        callback: Option<CallbackHandle>,
    },
    WindowLifecycle {
        node: NodeId,
        event: WindowLifecycleEvent,
        callback: Option<CallbackHandle>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPropertyError {
    StaleNode {
        node: NodeId,
        current_generation: Option<u32>,
    },
    InvalidProperty(PropertyId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostListenerError {
    StaleNode {
        node: NodeId,
        current_generation: Option<u32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostTextInputError {
    StaleNode {
        node: NodeId,
        current_generation: Option<u32>,
    },
    NotTextInput {
        node: NodeId,
    },
    InvalidUtf16Range {
        start: u32,
        end: u32,
        utf16_length: usize,
    },
    TextTooLong {
        utf16_length: usize,
    },
    LayoutUnavailable {
        node: NodeId,
    },
    RevisionMismatch {
        expected: u64,
        actual: u64,
    },
    RevisionExhausted,
}

impl std::fmt::Display for HostTextInputError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StaleNode { node, .. } => write!(formatter, "stale text input node {node:?}"),
            Self::NotTextInput { node } => write!(formatter, "node {node:?} is not a text input"),
            Self::InvalidUtf16Range {
                start,
                end,
                utf16_length,
            } => write!(
                formatter,
                "UTF-16 range {start}..{end} is not a grapheme boundary in text of length {utf16_length}"
            ),
            Self::TextTooLong { utf16_length } => write!(
                formatter,
                "text input UTF-16 length {utf16_length} exceeds the v1 protocol range"
            ),
            Self::LayoutUnavailable { node } => {
                write!(formatter, "text layout is unavailable for node {node:?}")
            }
            Self::RevisionMismatch { expected, actual } => write!(
                formatter,
                "text input revision {expected} is stale; current revision is {actual}"
            ),
            Self::RevisionExhausted => formatter.write_str("text input revision exhausted"),
        }
    }
}

impl std::error::Error for HostTextInputError {}

/// Invalid process-level font configuration rejected before Host startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostFontConfigError {
    EmptyDatabase,
    UnresolvedDefaultFont,
    MissingDefaultFontSource { font_id: FontId },
    SystemFontDiscovery,
}

impl std::fmt::Display for HostFontConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyDatabase => formatter.write_str("font database must not be empty"),
            Self::UnresolvedDefaultFont => {
                formatter.write_str("default font request does not resolve to a registered face")
            }
            Self::MissingDefaultFontSource { font_id } => write!(
                formatter,
                "default font {} has no shared font source",
                font_id.get()
            ),
            Self::SystemFontDiscovery => {
                formatter.write_str("system font discovery returned no usable fonts")
            }
        }
    }
}

impl std::error::Error for HostFontConfigError {}

#[derive(Debug, Clone)]
pub(crate) struct InputField {
    pub(crate) text_node: NodeId,
    pub(crate) placeholder: String,
    pub(crate) editor: TextAreaController,
    pub(crate) multiline: bool,
    pub(crate) caret_affinity: CaretAffinity,
}

struct ParagraphInputGeometry {
    text_node: NodeId,
    caret_rect: LayoutRect,
    selection_rects: Vec<LayoutRect>,
}

/// Decoded local image attached to an Image node.
#[derive(Debug, Clone)]
pub(crate) struct ImageAsset {
    pub(crate) path: String,
    pub(crate) resource_id: ResourceId,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixels: Arc<[u32]>,
    pub(crate) inferred_width: bool,
    pub(crate) inferred_height: bool,
}

/// Generation-bearing CPU image resources. The store keeps decoded pixels
/// shared across nodes and paints; backend uploads are keyed by `raw_id`.
#[derive(Debug, Clone)]
pub(crate) struct ImageResource {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixels: Arc<[u32]>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ImageResourceStore {
    resources: ResourceStore<ImageResource>,
    paths: HashMap<String, ResourceId>,
}

impl ImageResourceStore {
    pub(crate) fn get_or_load(
        &mut self,
        path: &str,
        load: impl FnOnce() -> (u32, u32, Vec<u32>),
    ) -> (ResourceId, ImageResource) {
        if let Some(&resource_id) = self.paths.get(path) {
            if let Some(existing) = self.resources.get(resource_id) {
                return (resource_id, existing.clone());
            }
        }
        let (width, height, pixels) = load();
        let resource = ImageResource {
            width,
            height,
            pixels: Arc::from(pixels),
        };
        let resource_id = self.resources.insert(resource.clone());
        self.paths.insert(path.to_owned(), resource_id);
        (resource_id, resource)
    }

    pub(crate) fn absorb_high_watermark(&mut self, other: &Self) {
        self.resources
            .absorb_generation_high_watermark(&other.resources);
    }

    pub(crate) fn clear(&mut self) {
        self.resources.clear();
        self.paths.clear();
    }

    pub(crate) fn retain_referenced(&mut self, referenced: impl IntoIterator<Item = ResourceId>) {
        let referenced = referenced
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let stale = self
            .resources
            .iter()
            .filter_map(|(id, _)| (!referenced.contains(&id)).then_some(id))
            .collect::<Vec<_>>();
        for id in stale {
            self.resources.remove(id);
        }
        self.paths
            .retain(|_, resource_id| self.resources.get(*resource_id).is_some());
    }
}

/// Host-side state staged alongside a [`MutationBatch`]. The active `HostInner`
/// remains untouched until the batch validates and commits.
#[derive(Debug, Clone)]
pub(crate) struct PendingMutations {
    pub(crate) batch: MutationBatch,
    pub(crate) base_revision: u64,
    pub(crate) failure: Option<MutationError>,
    pub(crate) extra_dirty: DirtyFlags,
    pub(crate) preview: Arena,
    pub(crate) root: Option<NodeId>,
    pub(crate) click_tokens: HashMap<u64, u64>,
    pub(crate) change_tokens: HashMap<u64, u64>,
    pub(crate) submit_tokens: HashMap<u64, u64>,
    pub(crate) v1_listeners: HashMap<ListenerKey, CallbackHandle>,
    pub(crate) inputs: HashMap<u64, InputField>,
    pub(crate) interactions: HashMap<u64, InteractionModel>,
    pub(crate) focus: FocusManager,
    pub(crate) focused: Option<NodeId>,
    pub(crate) focus_anchor: Option<NodeId>,
    pub(crate) images: HashMap<u64, ImageAsset>,
    pub(crate) created: HashMap<u64, u32>,
    pub(crate) created_ids: Vec<NodeId>,
    pub(crate) removed_nodes: Vec<NodeId>,
    pub(crate) removed_listeners: Vec<CallbackHandle>,
    pub(crate) image_resources: ImageResourceStore,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CommitActivity {
    pub(crate) attempts: u64,
    pub(crate) commits: u64,
    pub(crate) mutation_commands: u64,
}

#[derive(Debug, Default)]
pub(crate) struct HostInner {
    pub(crate) arena: Arena,
    /// Last semantic snapshot successfully derived by a window frame.
    pub(crate) semantic_snapshot: SemanticTreeSnapshot,
    /// Shared paragraph snapshots used by every layout pass in this session.
    pub(crate) text_cache: ParagraphCache,
    /// First created root-ish view; used as layout root when present.
    pub(crate) root: Option<NodeId>,
    /// node.raw() → opaque callback token (Perry closure ptr as u64).
    pub(crate) click_tokens: HashMap<u64, u64>,
    pub(crate) change_tokens: HashMap<u64, u64>,
    pub(crate) submit_tokens: HashMap<u64, u64>,
    /// Stable v1 listener bindings. Closure pointers live in the FFI session;
    /// this map only records which callback handle owns each target.
    pub(crate) v1_listeners: HashMap<ListenerKey, CallbackHandle>,
    /// Focusable input containers (View) → text child + caret.
    pub(crate) inputs: HashMap<u64, InputField>,
    pub(crate) interactions: HashMap<u64, InteractionModel>,
    pub(crate) focus: FocusManager,
    pub(crate) focused: Option<NodeId>,
    pub(crate) event_dispatcher: EventDispatcher,
    pub(crate) pending_ui_events: VecDeque<HostUiEvent>,
    pub(crate) next_event_timestamp: u64,
    pub(crate) pointer_pressed_target: Option<NodeId>,
    /// Image node.raw() → decoded bitmap (may be empty on load failure).
    pub(crate) images: HashMap<u64, ImageAsset>,
    pub(crate) image_resources: ImageResourceStore,
    /// Mutations queued by the FFI path. Direct Rust HostOps retain their
    /// legacy immediate behavior for compatibility with existing native tests.
    pub(crate) pending: Option<PendingMutations>,
    pub(crate) next_sequence: u64,
    pub(crate) active_revision: u64,
    pub(crate) last_removed_nodes: Vec<NodeId>,
    pub(crate) last_removed_listeners: Vec<CallbackHandle>,
    pub(crate) commit_activity: CommitActivity,
}

/// Opaque Host session driving the Slice 1 node tree from HostOps.
#[derive(Clone, Debug, Default)]
pub struct NuiHost {
    pub(crate) inner: Arc<Mutex<HostInner>>,
    errors: ErrorSupervisor,
    metrics: FrameMetricsObserver,
}

fn default_semantics(
    arena: &Arena,
    inputs: &HashMap<u64, InputField>,
    id: NodeId,
    node: &Node,
) -> Option<Semantics> {
    if let Some(field) = inputs.get(&id.raw()) {
        return Some(Semantics {
            role: nui_core::SemanticRole::TextInput,
            label: (!field.placeholder.is_empty()).then(|| field.placeholder.clone()),
            value: Some(field.editor.value().to_owned()),
            disabled: node.style.disabled,
            actions: vec![
                nui_core::SemanticAction::Focus,
                nui_core::SemanticAction::SetValue,
            ],
            ..Semantics::default()
        });
    }

    if node.node_type == NodeType::Text {
        let suppressed = node.parent.is_some_and(|parent| {
            inputs.contains_key(&parent.raw())
                || arena.get(parent).is_some_and(|parent| parent.is_button)
        });
        if suppressed {
            return None;
        }
        let text = node.text.as_deref().unwrap_or_default();
        return (!text.is_empty()).then(|| Semantics::text(text));
    }

    if node.is_button {
        let label = first_text_descendant(arena, id).unwrap_or_else(|| "Button".to_owned());
        return Some(Semantics {
            disabled: node.style.disabled,
            ..Semantics::button(label)
        });
    }

    match node.node_type {
        NodeType::Image => Some(Semantics {
            role: nui_core::SemanticRole::Image,
            ..Semantics::default()
        }),
        NodeType::Scroll => Some(Semantics {
            role: nui_core::SemanticRole::Scroll,
            ..Semantics::default()
        }),
        NodeType::Root | NodeType::View | NodeType::Text => None,
    }
}

fn first_text_descendant(arena: &Arena, id: NodeId) -> Option<String> {
    let node = arena.get(id)?;
    for child in node.children.iter().copied() {
        let child_node = arena.get(child)?;
        if child_node.node_type == NodeType::Text {
            if let Some(text) = child_node.text.as_deref().filter(|text| !text.is_empty()) {
                return Some(text.to_owned());
            }
        }
        if let Some(text) = first_text_descendant(arena, child) {
            return Some(text);
        }
    }
    None
}

impl NuiHost {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a Host with process-level fonts shared by every layout pass.
    /// Window resets retain the database and discard only paragraph snapshots.
    pub fn with_fonts(
        database: FontDatabase,
        default_request: FontRequest,
    ) -> Result<Self, HostFontConfigError> {
        if database.is_empty() {
            return Err(HostFontConfigError::EmptyDatabase);
        }
        let font_id = database
            .resolve(&default_request)
            .ok_or(HostFontConfigError::UnresolvedDefaultFont)?;
        if database
            .face(font_id)
            .and_then(|face| face.source())
            .is_none()
        {
            return Err(HostFontConfigError::MissingDefaultFontSource { font_id });
        }

        Ok(Self {
            inner: Arc::new(Mutex::new(HostInner {
                text_cache: ParagraphCache::new(database, default_request),
                ..HostInner::default()
            })),
            errors: ErrorSupervisor::default(),
            metrics: FrameMetricsObserver::default(),
        })
    }

    /// Creates a Host using the bounded platform font discovery backend.
    pub fn with_system_fonts() -> Result<Self, HostFontConfigError> {
        let (database, default_request) = nui_text::system_font_database()
            .map_err(|_| HostFontConfigError::SystemFontDiscovery)?;
        Self::with_fonts(database, default_request)
    }

    /// Process-runtime diagnostics shared by Host and platform clones.
    #[must_use]
    pub fn error_supervisor(&self) -> ErrorSupervisor {
        self.errors.clone()
    }

    /// Process-runtime frame diagnostics shared by Host and platform clones.
    #[must_use]
    pub fn frame_metrics_observer(&self) -> FrameMetricsObserver {
        self.metrics.clone()
    }

    /// Whether this Host has at least one process-level font face configured.
    #[must_use]
    pub fn has_font_configuration(&self) -> bool {
        !self
            .inner
            .lock()
            .expect("host inner")
            .text_cache
            .database()
            .is_empty()
    }

    /// Clear all state owned by the current app/window session while retaining
    /// allocator generations already exposed by committed or pending nodes.
    /// Every platform-side clone observes the reset through the shared Arc.
    pub fn reset(&self) {
        let mut inner = self.inner.lock().expect("host inner");
        let pending_preview = inner.pending.take().map(|pending| pending.preview);
        inner.arena.reset_for_new_owner(pending_preview.as_ref());
        inner.root = None;
        inner.click_tokens.clear();
        inner.change_tokens.clear();
        inner.submit_tokens.clear();
        inner.v1_listeners.clear();
        inner.inputs.clear();
        inner.interactions.clear();
        inner.focus = FocusManager::default();
        inner.focused = None;
        inner.event_dispatcher = EventDispatcher::default();
        inner.pending_ui_events.clear();
        inner.next_event_timestamp = 0;
        inner.pointer_pressed_target = None;
        inner.images.clear();
        inner.image_resources.clear();
        inner.next_sequence = 0;
        inner.active_revision = 0;
        inner.last_removed_nodes.clear();
        inner.last_removed_listeners.clear();
        inner.commit_activity = CommitActivity::default();
        inner.semantic_snapshot = SemanticTreeSnapshot::default();
        inner.text_cache.clear();
    }

    /// Stable owner identity for callback/task scope checks.
    #[must_use]
    pub fn owner(&self) -> u64 {
        self.inner.lock().expect("host inner").arena.owner()
    }

    pub(crate) fn mark_active_changed(inner: &mut HostInner) {
        inner.active_revision = inner.active_revision.saturating_add(1);
    }

    pub(crate) fn size_root_for_viewport(
        inner: &mut HostInner,
        root: NodeId,
        logical_w: f32,
        logical_h: f32,
    ) {
        if let Some(node) = inner.arena.get_mut(root) {
            node.style.width = Some(logical_w);
            node.style.height = Some(logical_h);
            if node.style.background.is_none() {
                node.style.background = Some(ColorRgba::rgb(0xF4, 0xF6, 0xF8));
            }
        }
    }

    pub(crate) fn update_semantic_snapshot(
        inner: &mut HostInner,
        root: Option<NodeId>,
    ) -> SemanticTreeDiff {
        let next = root.map_or_else(SemanticTreeSnapshot::default, |root| {
            let arena = &inner.arena;
            let inputs = &inner.inputs;
            SemanticTreeSnapshot::derive_with_defaults(arena, root, inner.focused, |id, node| {
                default_semantics(arena, inputs, id, node)
            })
        });
        let diff = inner.semantic_snapshot.diff(&next);
        inner.semantic_snapshot = next;
        diff
    }

    fn sync_pending_disabled(pending: &mut PendingMutations, node: NodeId, disabled: bool) {
        if let Some(state) = pending.interactions.get_mut(&node.raw()) {
            state.set_disabled(disabled);
        }
        if pending.focus.set_enabled(node, !disabled) {
            let restored_anchor = !disabled
                && pending.focus_anchor == Some(node)
                && pending
                    .focus
                    .request_focus(node, &pending.preview, pending.root);
            pending.focused = if restored_anchor {
                Some(node)
            } else {
                pending.focus.reconcile(&pending.preview, pending.root)
            };
            for (raw, state) in &mut pending.interactions {
                state.set_focused(pending.focused.is_some_and(|focused| focused.raw() == *raw));
            }
        }
    }

    fn sync_active_disabled(inner: &mut HostInner, node: NodeId, disabled: bool) {
        if let Some(state) = inner.interactions.get_mut(&node.raw()) {
            state.set_disabled(disabled);
        }
        if disabled && inner.pointer_pressed_target == Some(node) {
            inner.pointer_pressed_target = None;
            inner.event_dispatcher.release_pointer_capture(1);
        }
        if inner.focus.set_enabled(node, !disabled) {
            let arena = inner.arena.clone();
            let next = inner.focus.reconcile(&arena, inner.root);
            transition_focus(inner, next);
        }
    }

    fn new_pending(inner: &HostInner, sequence: u64) -> PendingMutations {
        PendingMutations {
            batch: MutationBatch::new(sequence, inner.arena.owner()),
            base_revision: inner.active_revision,
            failure: None,
            extra_dirty: DirtyFlags::empty(),
            preview: inner.arena.clone(),
            root: inner.root,
            click_tokens: inner.click_tokens.clone(),
            change_tokens: inner.change_tokens.clone(),
            submit_tokens: inner.submit_tokens.clone(),
            v1_listeners: inner.v1_listeners.clone(),
            inputs: inner.inputs.clone(),
            interactions: inner.interactions.clone(),
            focus: inner.focus.clone(),
            focused: inner.focused,
            focus_anchor: inner.focused,
            images: inner.images.clone(),
            created: HashMap::new(),
            created_ids: Vec::new(),
            removed_nodes: Vec::new(),
            removed_listeners: Vec::new(),
            image_resources: inner.image_resources.clone(),
        }
    }

    fn ensure_pending(inner: &mut HostInner) -> &mut PendingMutations {
        if inner.pending.is_none() {
            inner.next_sequence = inner.next_sequence.saturating_add(1).max(1);
            inner.pending = Some(Self::new_pending(inner, inner.next_sequence));
        }
        inner.pending.as_mut().expect("pending initialized")
    }

    /// Establish the per-window metrics baseline. Mount commits completed
    /// before `run` are outside Scheduler ticks and must not be attributed to
    /// the first idle tick after the initial platform-driven paint.
    fn prepare_window_session(&self) -> Option<(NodeId, u64)> {
        let mut inner = self.inner.lock().expect("host inner");
        let root = inner.root?;
        inner.commit_activity = CommitActivity::default();
        Some((root, inner.arena.owner()))
    }

    fn stage_command(
        inner: &mut HostInner,
        command: MutationCommand,
    ) -> Result<MutationReceipt, MutationError> {
        let mut pending = if let Some(pending) = inner.pending.take() {
            pending
        } else {
            inner.next_sequence = inner.next_sequence.saturating_add(1).max(1);
            Self::new_pending(inner, inner.next_sequence)
        };
        if let Some(error) = pending.failure {
            inner.pending = Some(pending);
            return Err(error);
        }
        let previous_batch = pending.batch.clone();
        pending.batch.push(command);
        let validated = match pending.batch.validate(&inner.arena) {
            Ok(validated) => validated,
            Err(error) => {
                pending.batch = previous_batch;
                pending.failure = Some(error);
                inner.pending = Some(pending);
                return Err(error);
            }
        };
        let mut preview = inner.arena.clone();
        let receipt = match validated.apply(&mut preview) {
            Ok(receipt) => receipt,
            Err(error) => {
                pending.batch = previous_batch;
                pending.failure = Some(error);
                inner.pending = Some(pending);
                return Err(error);
            }
        };
        pending.preview = preview;
        pending.created = receipt
            .created
            .iter()
            .enumerate()
            .map(|(index, id)| (id.raw(), index as u32))
            .collect();
        pending.created_ids = receipt.created.clone();
        inner.pending = Some(pending);
        Ok(receipt)
    }

    fn pending_ref(pending: &PendingMutations, node: NodeId) -> NodeRef {
        pending
            .created
            .get(&node.raw())
            .copied()
            .map(NodeRef::Created)
            .unwrap_or(NodeRef::Existing(node))
    }

    fn pending_ref_checked(
        pending: &PendingMutations,
        node: NodeId,
    ) -> Result<NodeRef, MutationError> {
        let reference = Self::pending_ref(pending, node);
        if pending.preview.get(node).is_none() {
            return Err(MutationError::StaleNode(node));
        }
        Ok(reference)
    }

    fn collect_subtree(arena: &Arena, node: NodeId) -> Vec<NodeId> {
        let mut result = Vec::new();
        let mut stack = vec![node];
        while let Some(current) = stack.pop() {
            let Some(value) = arena.get(current) else {
                continue;
            };
            result.push(current);
            stack.extend(value.children.iter().copied());
        }
        result
    }

    fn clear_pending_state(pending: &mut PendingMutations, nodes: &[NodeId]) {
        for node in nodes {
            let raw = node.raw();
            let keys: Vec<_> = pending
                .v1_listeners
                .keys()
                .filter(|key| key.node_raw == raw)
                .copied()
                .collect();
            for key in keys {
                if let Some(handle) = pending.v1_listeners.remove(&key) {
                    pending.removed_listeners.push(handle);
                }
            }
            pending.click_tokens.remove(&raw);
            pending.change_tokens.remove(&raw);
            pending.submit_tokens.remove(&raw);
            pending.inputs.remove(&raw);
            pending.interactions.remove(&raw);
            pending.focus.unregister(*node);
            pending.images.remove(&raw);
            if pending.root == Some(*node) {
                pending.root = None;
            }
            pending.removed_nodes.push(*node);
        }
        let _ = pending.focus.reconcile(&pending.preview, pending.root);
        pending.focused = pending.focus.focused();
        let referenced = pending
            .images
            .values()
            .map(|asset| asset.resource_id)
            .collect::<Vec<_>>();
        pending.image_resources.retain_referenced(referenced);
    }

    fn stage_node_command(
        &self,
        make: impl FnOnce(&PendingMutations) -> Result<MutationCommand, MutationError>,
    ) -> Result<MutationReceipt, MutationError> {
        let mut inner = self.inner.lock().expect("host inner");
        let command = {
            let pending = Self::ensure_pending(&mut inner);
            if let Some(error) = pending.failure {
                return Err(error);
            }
            match make(pending) {
                Ok(command) => command,
                Err(error) => {
                    pending.failure = Some(error);
                    return Err(error);
                }
            }
        };
        Self::stage_command(&mut inner, command)
    }

    /// Whether the FFI has queued mutations that are not yet visible in the
    /// active arena.
    #[must_use]
    pub fn has_pending_batch(&self) -> bool {
        self.inner.lock().expect("host inner").pending.is_some()
    }

    /// Discard a rejected implicit batch. The active Arena and metadata were
    /// never changed. Allocator generations from the shadow are retained so
    /// provisional handles already returned over FFI can never be reused.
    pub fn abort_pending(&self) {
        let mut inner = self.inner.lock().expect("host inner");
        if let Some(pending) = inner.pending.take() {
            inner
                .arena
                .absorb_generation_high_watermark(&pending.preview);
            inner
                .image_resources
                .absorb_high_watermark(&pending.image_resources);
        }
    }

    /// Mark the current implicit FFI batch invalid when decoding fails before
    /// a typed [`MutationCommand`] can be constructed.
    pub fn poison_pending(&self, error: MutationError) {
        let mut inner = self.inner.lock().expect("host inner");
        Self::ensure_pending(&mut inner).failure = Some(error);
    }

    /// Create a provisional node in the shadow arena. The returned handle is
    /// stable for the batch and becomes active only after commit.
    pub fn queue_create_node(&self, node_type: NodeType) -> Result<NodeId, MutationError> {
        let mut inner = self.inner.lock().expect("host inner");
        let receipt = Self::stage_command(&mut inner, MutationCommand::Create { node_type })?;
        let node = *receipt
            .created
            .last()
            .ok_or(MutationError::PlanInvalidated)?;
        let pending = inner.pending.as_mut().expect("pending initialized");
        if pending.root.is_none()
            && matches!(
                node_type,
                NodeType::Root | NodeType::View | NodeType::Scroll
            )
        {
            pending.root = Some(node);
        }
        Ok(node)
    }

    /// Queue creation of a text node, preserving the immediate Host API's
    /// create-plus-initial-text behavior.
    pub fn queue_create_text(&self, text: &str) -> Result<NodeId, MutationError> {
        let node = self.queue_create_node(NodeType::Text)?;
        self.queue_set_text(node, text)?;
        Ok(node)
    }

    pub fn queue_insert_before(
        &self,
        child: NodeId,
        parent: NodeId,
        before: Option<NodeId>,
    ) -> Result<(), MutationError> {
        self.stage_node_command(|pending| {
            Ok(MutationCommand::Insert {
                child: Self::pending_ref_checked(pending, child)?,
                parent: Self::pending_ref_checked(pending, parent)?,
                before: before
                    .map(|node| Self::pending_ref_checked(pending, node))
                    .transpose()?,
            })
        })
        .map(|_| ())
    }

    pub fn queue_remove(&self, node: NodeId) -> Result<(), MutationError> {
        let mut inner = self.inner.lock().expect("host inner");
        let nodes = {
            let pending = Self::ensure_pending(&mut inner);
            if let Some(error) = pending.failure {
                return Err(error);
            }
            let nodes = Self::collect_subtree(&pending.preview, node);
            let reference = match Self::pending_ref_checked(pending, node) {
                Ok(reference) => reference,
                Err(error) => {
                    pending.failure = Some(error);
                    return Err(error);
                }
            };
            (nodes, reference)
        };
        let receipt = Self::stage_command(&mut inner, MutationCommand::Remove { node: nodes.1 })?;
        let pending = inner.pending.as_mut().expect("pending initialized");
        Self::clear_pending_state(pending, &nodes.0);
        let _ = receipt;
        Ok(())
    }

    pub fn queue_set_text(&self, node: NodeId, text: &str) -> Result<(), MutationError> {
        self.stage_node_command(|pending| {
            Ok(MutationCommand::SetText {
                node: Self::pending_ref_checked(pending, node)?,
                text: text.to_owned(),
            })
        })
        .map(|_| ())?;
        let mut inner = self.inner.lock().expect("host inner");
        if let Some(pending) = inner.pending.as_mut() {
            for field in pending.inputs.values_mut() {
                if field.text_node == node && field.editor.value() != text {
                    field.editor = TextAreaController::new(text);
                    field.caret_affinity = if text.is_empty() {
                        CaretAffinity::Downstream
                    } else {
                        CaretAffinity::Upstream
                    };
                }
            }
        }
        Ok(())
    }

    pub fn queue_set_number(
        &self,
        node: NodeId,
        property: PropertyId,
        value: f64,
    ) -> Result<(), MutationError> {
        self.stage_node_command(|pending| {
            Ok(MutationCommand::SetProperty {
                node: Self::pending_ref_checked(pending, node)?,
                property,
                value,
            })
        })
        .map(|_| ())?;
        if property == PropertyId::Disabled {
            let mut inner = self.inner.lock().expect("host inner");
            let pending = Self::ensure_pending(&mut inner);
            Self::sync_pending_disabled(pending, node, value >= 0.5);
        }
        Ok(())
    }

    pub fn queue_clear_property(
        &self,
        node: NodeId,
        property: PropertyId,
    ) -> Result<(), MutationError> {
        self.stage_node_command(|pending| {
            Ok(MutationCommand::ClearProperty {
                node: Self::pending_ref_checked(pending, node)?,
                property,
            })
        })
        .map(|_| ())?;
        if property == PropertyId::Disabled {
            let mut inner = self.inner.lock().expect("host inner");
            let pending = Self::ensure_pending(&mut inner);
            Self::sync_pending_disabled(pending, node, false);
        }
        Ok(())
    }

    pub fn queue_set_semantics(
        &self,
        node: NodeId,
        semantics: Semantics,
    ) -> Result<(), MutationError> {
        self.stage_node_command(|pending| {
            Ok(MutationCommand::SetSemantics {
                node: Self::pending_ref_checked(pending, node)?,
                semantics,
            })
        })
        .map(|_| ())
    }

    pub fn queue_clear_semantics(&self, node: NodeId) -> Result<(), MutationError> {
        self.stage_node_command(|pending| {
            Ok(MutationCommand::ClearSemantics {
                node: Self::pending_ref_checked(pending, node)?,
            })
        })
        .map(|_| ())
    }

    pub fn queue_register_button(&self, node: NodeId) -> Result<(), MutationError> {
        self.stage_node_command(|pending| {
            Ok(MutationCommand::RegisterButton {
                node: Self::pending_ref_checked(pending, node)?,
            })
        })
        .map(|_| ())
    }

    pub fn queue_set_clickable(&self, node: NodeId, clickable: bool) -> Result<(), MutationError> {
        self.stage_node_command(|pending| {
            Ok(MutationCommand::SetClickable {
                node: Self::pending_ref_checked(pending, node)?,
                clickable,
            })
        })
        .map(|_| ())?;
        let mut inner = self.inner.lock().expect("host inner");
        let pending = Self::ensure_pending(&mut inner);
        if clickable {
            pending.interactions.entry(node.raw()).or_default();
        } else {
            pending.interactions.remove(&node.raw());
        }
        Ok(())
    }

    pub fn queue_add_click_listener(&self, node: NodeId, token: u64) -> Result<(), MutationError> {
        self.queue_set_clickable(node, true)?;
        let mut inner = self.inner.lock().expect("host inner");
        let pending = Self::ensure_pending(&mut inner);
        pending.click_tokens.insert(node.raw(), token);
        let disabled = pending
            .preview
            .get(node)
            .is_some_and(|value| value.style.disabled);
        pending
            .interactions
            .entry(node.raw())
            .or_default()
            .set_disabled(disabled);
        pending.focus.register(node, 0, !disabled);
        pending.focused = pending.focus.reconcile(&pending.preview, pending.root);
        Ok(())
    }

    pub fn queue_add_change_listener(&self, node: NodeId, token: u64) -> Result<(), MutationError> {
        self.queue_set_clickable(node, true)?;
        let mut inner = self.inner.lock().expect("host inner");
        Self::ensure_pending(&mut inner)
            .change_tokens
            .insert(node.raw(), token);
        Ok(())
    }

    pub fn queue_add_submit_listener(&self, node: NodeId, token: u64) -> Result<(), MutationError> {
        self.queue_set_clickable(node, true)?;
        let mut inner = self.inner.lock().expect("host inner");
        Self::ensure_pending(&mut inner)
            .submit_tokens
            .insert(node.raw(), token);
        Ok(())
    }

    /// Queue a composite Input registration. The text value/caret and
    /// clickable state become active together with the tree batch.
    pub fn queue_register_input(
        &self,
        container: NodeId,
        text_node: NodeId,
        placeholder: &str,
    ) -> Result<(), MutationError> {
        let mut inner = self.inner.lock().expect("host inner");
        let (field, container_ref) = {
            let pending = Self::ensure_pending(&mut inner);
            if let Some(error) = pending.failure {
                return Err(error);
            }
            let container_ref = match Self::pending_ref_checked(pending, container) {
                Ok(reference) => reference,
                Err(error) => {
                    pending.failure = Some(error);
                    return Err(error);
                }
            };
            if let Err(error) = Self::pending_ref_checked(pending, text_node) {
                pending.failure = Some(error);
                return Err(error);
            }
            let multiline = pending
                .preview
                .get(container)
                .is_some_and(|node| node.node_type == NodeType::Scroll);
            let value = pending
                .preview
                .get(text_node)
                .and_then(|node| node.text.as_ref())
                .cloned()
                .unwrap_or_default();
            let caret_affinity = if value.is_empty() {
                CaretAffinity::Downstream
            } else {
                CaretAffinity::Upstream
            };
            (
                InputField {
                    text_node,
                    placeholder: placeholder.to_owned(),
                    editor: TextAreaController::new(value),
                    multiline,
                    caret_affinity,
                },
                container_ref,
            )
        };
        let receipt = Self::stage_command(
            &mut inner,
            MutationCommand::SetClickable {
                node: container_ref,
                clickable: true,
            },
        )?;
        let pending = inner.pending.as_mut().expect("pending initialized");
        pending.inputs.insert(container.raw(), field);
        pending.interactions.entry(container.raw()).or_default();
        pending.focus.register(container, 0, true);
        let _ = pending.focus.reconcile(&pending.preview, pending.root);
        pending.focused = pending.focus.focused();
        pending.extra_dirty = pending
            .extra_dirty
            .union(DirtyFlags::PAINT)
            .union(DirtyFlags::SEMANTICS);
        let _ = receipt;
        Ok(())
    }

    /// Queue an image attachment for a pending node. Decoding still happens
    /// eagerly, but the asset map and inferred dimensions switch at commit.
    pub fn queue_set_image(&self, node: NodeId, path: &str) -> Result<(), MutationError> {
        if path.is_empty() {
            let mut inner = self.inner.lock().expect("host inner");
            let (node_ref, clear_width, clear_height) = {
                let pending = Self::ensure_pending(&mut inner);
                let node_ref = Self::pending_ref_checked(pending, node)?;
                let previous = pending.images.remove(&node.raw());
                (
                    node_ref,
                    previous.as_ref().is_some_and(|asset| asset.inferred_width),
                    previous.as_ref().is_some_and(|asset| asset.inferred_height),
                )
            };
            if clear_width {
                Self::stage_command(
                    &mut inner,
                    MutationCommand::ClearProperty {
                        node: node_ref,
                        property: PropertyId::Width,
                    },
                )?;
            }
            if clear_height {
                Self::stage_command(
                    &mut inner,
                    MutationCommand::ClearProperty {
                        node: node_ref,
                        property: PropertyId::Height,
                    },
                )?;
            }
            Self::stage_command(
                &mut inner,
                MutationCommand::SetImageResource {
                    node: node_ref,
                    resource_id: None,
                },
            )?;
            inner
                .pending
                .as_mut()
                .expect("pending initialized")
                .extra_dirty = inner
                .pending
                .as_ref()
                .expect("pending initialized")
                .extra_dirty
                .union(DirtyFlags::PAINT);
            let pending = inner.pending.as_mut().expect("pending initialized");
            let referenced = pending
                .images
                .values()
                .map(|asset| asset.resource_id)
                .collect::<Vec<_>>();
            pending.image_resources.retain_referenced(referenced);
            return Ok(());
        }
        let mut inner = self.inner.lock().expect("host inner");
        let (node_ref, set_width, set_height) = {
            let pending = Self::ensure_pending(&mut inner);
            if let Some(error) = pending.failure {
                return Err(error);
            }
            let node_ref = match Self::pending_ref_checked(pending, node) {
                Ok(reference) => reference,
                Err(error) => {
                    pending.failure = Some(error);
                    return Err(error);
                }
            };
            let Some(current) = pending.preview.get(node) else {
                let error = MutationError::StaleNode(node);
                pending.failure = Some(error);
                return Err(error);
            };
            (
                node_ref,
                current.style.width.is_none(),
                current.style.height.is_none(),
            )
        };
        let (resource_id, resource) = {
            let pending = inner.pending.as_mut().expect("pending initialized");
            pending.image_resources.get_or_load(path, || {
                decode_image_file(path).unwrap_or((64, 64, Vec::new()))
            })
        };
        let width = resource.width;
        let height = resource.height;
        if set_width {
            Self::stage_command(
                &mut inner,
                MutationCommand::SetProperty {
                    node: node_ref,
                    property: PropertyId::Width,
                    value: width as f64,
                },
            )?;
        }
        if set_height {
            Self::stage_command(
                &mut inner,
                MutationCommand::SetProperty {
                    node: node_ref,
                    property: PropertyId::Height,
                    value: height as f64,
                },
            )?;
        }
        let resource_id = {
            let pending = inner.pending.as_mut().expect("pending initialized");
            pending.images.insert(
                node.raw(),
                ImageAsset {
                    path: path.to_owned(),
                    resource_id,
                    width,
                    height,
                    pixels: Arc::clone(&resource.pixels),
                    inferred_width: set_width,
                    inferred_height: set_height,
                },
            );
            resource_id
        };
        Self::stage_command(
            &mut inner,
            MutationCommand::SetImageResource {
                node: node_ref,
                resource_id: Some(resource_id),
            },
        )?;
        let pending = inner.pending.as_mut().expect("pending initialized");
        pending.extra_dirty = pending.extra_dirty.union(DirtyFlags::PAINT);
        let referenced = pending
            .images
            .values()
            .map(|asset| asset.resource_id)
            .collect::<Vec<_>>();
        pending.image_resources.retain_referenced(referenced);
        Ok(())
    }

    pub fn queue_add_event_listener(
        &self,
        node: NodeId,
        event: EventId,
        callback: CallbackHandle,
    ) -> Result<Option<CallbackHandle>, HostListenerError> {
        let mut inner = self.inner.lock().expect("host inner");
        let key = ListenerKey::new(node.raw(), event as u32);
        let previous = {
            let pending = Self::ensure_pending(&mut inner);
            if pending.failure.is_some() {
                return Err(HostListenerError::StaleNode {
                    node,
                    current_generation: pending.preview.current_generation(node.slot()),
                });
            }
            if pending.preview.get(node).is_none() {
                pending.failure = Some(MutationError::StaleNode(node));
                return Err(HostListenerError::StaleNode {
                    node,
                    current_generation: pending.preview.current_generation(node.slot()),
                });
            }
            pending.v1_listeners.get(&key).copied()
        };
        let node_ref = inner
            .pending
            .as_ref()
            .map(|pending| Self::pending_ref(pending, node))
            .expect("pending initialized");
        Self::stage_command(
            &mut inner,
            MutationCommand::SetClickable {
                node: node_ref,
                clickable: true,
            },
        )
        .map_err(|_| HostListenerError::StaleNode {
            node,
            current_generation: inner
                .pending
                .as_ref()
                .and_then(|pending| pending.preview.current_generation(node.slot())),
        })?;
        let pending = inner.pending.as_mut().expect("pending initialized");
        pending.v1_listeners.insert(key, callback);
        let disabled = pending
            .preview
            .get(node)
            .is_some_and(|value| value.style.disabled);
        pending
            .interactions
            .entry(node.raw())
            .or_default()
            .set_disabled(disabled);
        if event == EventId::Click {
            pending.focus.register(node, 0, !disabled);
            pending.focused = pending.focus.reconcile(&pending.preview, pending.root);
        }
        Ok(previous)
    }

    pub fn queue_remove_event_listener(
        &self,
        node: NodeId,
        event: EventId,
        callback: CallbackHandle,
    ) -> bool {
        let mut inner = self.inner.lock().expect("host inner");
        let key = ListenerKey::new(node.raw(), event as u32);
        let (node_ref, still_interactive) = {
            let pending = Self::ensure_pending(&mut inner);
            if pending.failure.is_some() {
                return false;
            }
            if pending.v1_listeners.get(&key).copied() != Some(callback) {
                return false;
            }
            pending.v1_listeners.remove(&key);
            let still_interactive = pending
                .v1_listeners
                .keys()
                .any(|other| other.node_raw == node.raw())
                || pending.click_tokens.contains_key(&node.raw())
                || pending.change_tokens.contains_key(&node.raw())
                || pending.submit_tokens.contains_key(&node.raw())
                || pending.inputs.contains_key(&node.raw());
            let still_focusable = pending.inputs.contains_key(&node.raw())
                || pending.click_tokens.contains_key(&node.raw())
                || pending
                    .v1_listeners
                    .contains_key(&ListenerKey::new(node.raw(), EventId::Click as u32));
            if !still_interactive {
                pending.interactions.remove(&node.raw());
            }
            if !still_focusable {
                pending.focus.unregister(node);
                pending.focused = pending.focus.reconcile(&pending.preview, pending.root);
                for (raw, state) in &mut pending.interactions {
                    state.set_focused(pending.focused.is_some_and(|focused| focused.raw() == *raw));
                }
            }
            (Self::pending_ref(pending, node), still_interactive)
        };
        let result = Self::stage_command(
            &mut inner,
            MutationCommand::SetClickable {
                node: node_ref,
                clickable: still_interactive,
            },
        );
        result.is_ok()
    }

    /// Commit all queued commands and staged host metadata atomically.
    pub fn commit_pending(&self) -> Result<Option<MutationReceipt>, MutationError> {
        let mut inner = self.inner.lock().expect("host inner");
        if inner.pending.is_none() {
            return Ok(None);
        }
        inner.commit_activity.attempts = inner.commit_activity.attempts.saturating_add(1);
        let pending = inner.pending.as_ref().expect("pending batch exists");
        if let Some(error) = pending.failure {
            return Err(error);
        }
        if pending.batch.sequence() > u64::from(u32::MAX) {
            return Err(MutationError::SequenceExhausted {
                sequence: pending.batch.sequence(),
            });
        }
        if pending.base_revision != inner.active_revision {
            return Err(MutationError::PlanInvalidated);
        }
        let batch = pending.batch.clone();
        let extra_dirty = pending.extra_dirty;
        let validated = batch.validate(&inner.arena)?;
        if validated.created() != inner.pending.as_ref().expect("pending batch").created_ids {
            return Err(MutationError::PlanInvalidated);
        }
        // Apply to a clone first. `ValidatedMutationBatch::apply` revalidates
        // the active arena and is fallible; keeping the active arena and
        // pending metadata untouched until it succeeds makes commit atomic
        // even if a plan is invalidated between validation and application.
        let mut next_arena = inner.arena.clone();
        let mut receipt = validated.apply(&mut next_arena)?;
        receipt.dirty = receipt.dirty.union(extra_dirty);
        let pending = inner.pending.take().expect("pending batch exists");
        inner.arena = next_arena;
        inner.root = pending.root;
        inner.click_tokens = pending.click_tokens;
        inner.change_tokens = pending.change_tokens;
        inner.submit_tokens = pending.submit_tokens;
        inner.v1_listeners = pending.v1_listeners;
        inner.inputs = pending.inputs;
        inner.interactions = pending.interactions;
        inner.focus = pending.focus;
        transition_focus(&mut inner, pending.focused);
        if inner.pointer_pressed_target.is_some_and(|target| {
            inner.arena.get(target).is_none()
                || inner
                    .interactions
                    .get(&target.raw())
                    .is_some_and(|state| state.state() == nui_core::InteractionState::Disabled)
        }) {
            inner.pointer_pressed_target = None;
            inner.event_dispatcher.release_pointer_capture(1);
        }
        inner.images = pending.images;
        inner.image_resources = pending.image_resources;
        inner.last_removed_nodes = pending.removed_nodes;
        inner.last_removed_listeners = pending.removed_listeners;
        inner.commit_activity.commits = inner.commit_activity.commits.saturating_add(1);
        inner.commit_activity.mutation_commands = inner
            .commit_activity
            .mutation_commands
            .saturating_add(u64::from(receipt.command_count));
        Self::mark_active_changed(&mut inner);
        Ok(Some(receipt))
    }

    #[cfg(test)]
    pub(crate) fn take_commit_activity(&self) -> CommitActivity {
        let mut inner = self.inner.lock().expect("host inner");
        std::mem::take(&mut inner.commit_activity)
    }

    /// Drain listener handles invalidated by the most recent queued commit.
    pub fn take_last_removed_listener_handles(&self) -> Vec<CallbackHandle> {
        let mut inner = self.inner.lock().expect("host inner");
        std::mem::take(&mut inner.last_removed_listeners)
    }

    /// Drain node handles invalidated by the most recent queued commit.
    pub fn take_last_removed_nodes(&self) -> Vec<NodeId> {
        let mut inner = self.inner.lock().expect("host inner");
        std::mem::take(&mut inner.last_removed_nodes)
    }

    #[must_use]
    pub fn create_node(&self, node_type: NodeType) -> NodeId {
        let mut inner = self.inner.lock().expect("host inner");
        let id = inner.arena.create(node_type);
        let can_be_root = match node_type {
            NodeType::Root | NodeType::View | NodeType::Scroll => true,
            NodeType::Text | NodeType::Image => false,
        };
        if inner.root.is_none() && can_be_root {
            inner.root = Some(id);
        }
        Self::mark_active_changed(&mut inner);
        id
    }

    #[must_use]
    pub fn create_text(&self, text: &str) -> NodeId {
        let mut inner = self.inner.lock().expect("host inner");
        let id = inner.arena.create(NodeType::Text);
        inner.arena.set_text(id, text);
        Self::mark_active_changed(&mut inner);
        id
    }

    pub fn insert(&self, child: NodeId, parent: NodeId) {
        let _ = self.try_insert_before(child, parent, None);
    }

    pub fn insert_before(&self, child: NodeId, parent: NodeId, before: Option<NodeId>) {
        let _ = self.try_insert_before(child, parent, before);
    }

    /// Validate and apply a tree insertion without partially changing links.
    pub fn try_insert(&self, child: NodeId, parent: NodeId) -> Result<(), TreeMutationError> {
        self.try_insert_before(child, parent, None)
    }

    /// Validate and apply a tree insertion without partially changing links.
    pub fn try_insert_before(
        &self,
        child: NodeId,
        parent: NodeId,
        before: Option<NodeId>,
    ) -> Result<(), TreeMutationError> {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.try_insert_child_before(parent, child, before)?;
        if inner.root.is_none() {
            inner.root = Some(parent);
        }
        Self::mark_active_changed(&mut inner);
        Ok(())
    }

    pub fn detach(&self, parent: NodeId, child: NodeId) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.detach_child(parent, child);
        Self::mark_active_changed(&mut inner);
    }

    pub fn remove(&self, node: NodeId) -> Vec<CallbackHandle> {
        let mut inner = self.inner.lock().expect("host inner");
        let mut removed_listeners = Vec::new();
        let mut stack = vec![node];
        while let Some(id) = stack.pop() {
            if let Some(n) = inner.arena.get(id) {
                stack.extend(n.children.iter().copied());
            }
            let raw = id.raw();
            let keys: Vec<_> = inner
                .v1_listeners
                .keys()
                .filter(|key| key.node_raw == raw)
                .copied()
                .collect();
            for key in keys {
                if let Some(handle) = inner.v1_listeners.remove(&key) {
                    removed_listeners.push(handle);
                }
            }
            inner.click_tokens.remove(&raw);
            inner.change_tokens.remove(&raw);
            inner.submit_tokens.remove(&raw);
            inner.inputs.remove(&raw);
            inner.interactions.remove(&raw);
            inner.focus.unregister(id);
            inner.images.remove(&raw);
            if inner.pointer_pressed_target == Some(id) {
                inner.pointer_pressed_target = None;
            }
        }
        if inner.root == Some(node) {
            inner.root = None;
        }
        let referenced = inner
            .images
            .values()
            .map(|asset| asset.resource_id)
            .collect::<Vec<_>>();
        inner.image_resources.retain_referenced(referenced);
        inner.arena.remove(node);
        let root = inner.root;
        let arena = inner.arena.clone();
        let _ = inner.focus.reconcile(&arena, root);
        let focused = inner.focus.focused();
        transition_focus(&mut inner, focused);
        Self::mark_active_changed(&mut inner);
        removed_listeners
    }

    pub fn set_text(&self, node: NodeId, text: &str) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_text(node, text);
        // A changed controlled value replaces editor state and moves the caret
        // to the end; an event echo of the current value preserves selection.
        for field in inner.inputs.values_mut() {
            if field.text_node == node && field.editor.value() != text {
                field.editor = TextAreaController::new(text);
                field.caret_affinity = if text.is_empty() {
                    CaretAffinity::Downstream
                } else {
                    CaretAffinity::Upstream
                };
            }
        }
        Self::mark_active_changed(&mut inner);
    }

    pub fn set_number(&self, node: NodeId, property: PropertyId, value: f64) {
        let mut inner = self.inner.lock().expect("host inner");
        {
            let Some(n) = inner.arena.get_mut(node) else {
                return;
            };
            n.style.set_property(property, value);
        }
        if property == PropertyId::Disabled {
            Self::sync_active_disabled(&mut inner, node, value >= 0.5);
        }
        Self::mark_active_changed(&mut inner);
    }

    /// Clear a property and restore its protocol-declared default/unset value.
    pub fn clear_property(
        &self,
        node: NodeId,
        property: PropertyId,
    ) -> Result<(), HostPropertyError> {
        let mut inner = self.inner.lock().expect("host inner");
        {
            let Some(n) = inner.arena.get_mut(node) else {
                return Err(HostPropertyError::StaleNode {
                    node,
                    current_generation: inner.arena.current_generation(node.slot()),
                });
            };
            n.style.clear_property(property);
        }
        if property == PropertyId::Disabled {
            Self::sync_active_disabled(&mut inner, node, false);
        }
        Self::mark_active_changed(&mut inner);
        Ok(())
    }

    pub fn add_click_listener(&self, node: NodeId, token: u64) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_clickable(node, true);
        inner.click_tokens.insert(node.raw(), token);
        let disabled = inner
            .arena
            .get(node)
            .is_some_and(|value| value.style.disabled);
        inner
            .interactions
            .entry(node.raw())
            .or_default()
            .set_disabled(disabled);
        inner.focus.register(node, 0, !disabled);
        let root = inner.root;
        let arena = inner.arena.clone();
        let focused = inner.focus.reconcile(&arena, root);
        transition_focus(&mut inner, focused);
        Self::mark_active_changed(&mut inner);
    }

    /// Register a composite Input: `container` (View) + `text_node` (Text child).
    pub fn register_input(&self, container: NodeId, text_node: NodeId, placeholder: &str) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_clickable(container, true);
        let value = inner
            .arena
            .get(text_node)
            .and_then(|n| n.text.as_ref())
            .cloned()
            .unwrap_or_default();
        let multiline = inner
            .arena
            .get(container)
            .is_some_and(|node| node.node_type == NodeType::Scroll);
        let caret_affinity = if value.is_empty() {
            CaretAffinity::Downstream
        } else {
            CaretAffinity::Upstream
        };
        inner.inputs.insert(
            container.raw(),
            InputField {
                text_node,
                placeholder: placeholder.to_owned(),
                editor: TextAreaController::new(value),
                multiline,
                caret_affinity,
            },
        );
        inner.interactions.entry(container.raw()).or_default();
        inner.focus.register(container, 0, true);
        let root = inner.root;
        let arena = inner.arena.clone();
        let _ = inner.focus.reconcile(&arena, root);
        let focused = inner.focus.focused();
        transition_focus(&mut inner, focused);
        Self::mark_active_changed(&mut inner);
    }

    /// Return the committed editor state using UTF-16 offsets at the protocol boundary.
    pub fn text_input_state(
        &self,
        container: NodeId,
    ) -> Result<ProtocolTextInputState, HostTextInputError> {
        let mut inner = self.inner.lock().expect("host inner");
        Self::validate_text_input(&inner, container)?;
        let bounds = Self::composition_bounds_from_inner(&mut inner, container)?;
        let field = inner
            .inputs
            .get(&container.raw())
            .expect("validated text input");
        let value = field.editor.value();
        let utf16_length = value.encode_utf16().count();
        let surrounding_end = u32::try_from(utf16_length)
            .map_err(|_| HostTextInputError::TextTooLong { utf16_length })?;
        let selection = field.editor.utf16_selection();
        let selection_anchor = u32::try_from(selection.anchor)
            .map_err(|_| HostTextInputError::TextTooLong { utf16_length })?;
        let selection_focus = u32::try_from(selection.focus)
            .map_err(|_| HostTextInputError::TextTooLong { utf16_length })?;
        let composition = protocol_composition_range(&field.editor, utf16_length)?;

        Ok(ProtocolTextInputState {
            text: value.to_owned(),
            surrounding_text: ProtocolTextRange {
                start: 0,
                end: surrounding_end,
            },
            selection: ProtocolTextSelection {
                anchor: selection_anchor,
                focus: selection_focus,
            },
            composition,
            composition_bounds: bounds,
            revision: field.editor.revision().to_string(),
        })
    }

    /// Replace a protocol UTF-16 range without splitting an extended grapheme.
    pub fn replace_text_input(
        &self,
        container: NodeId,
        range: ProtocolTextRange,
        text: &str,
    ) -> Result<(), HostTextInputError> {
        let mut inner = self.inner.lock().expect("host inner");
        Self::validate_text_input(&inner, container)?;
        let (text_node, next) = {
            let field = inner
                .inputs
                .get_mut(&container.raw())
                .expect("validated text input");
            let text = normalized_input_text(text, field.multiline);
            let utf16_length = field.editor.value().encode_utf16().count();
            let start = usize::try_from(range.start).expect("u32 fits usize");
            let end = usize::try_from(range.end).expect("u32 fits usize");
            field
                .editor
                .replace_utf16_range(Utf16Range { start, end }, &text, None)
                .map_err(|error| {
                    Self::map_text_edit_error(error, range.start, range.end, utf16_length)
                })?;
            field.caret_affinity = CaretAffinity::Downstream;
            (field.text_node, field.editor.value().to_owned())
        };
        inner.arena.set_text(text_node, next);
        Self::mark_active_changed(&mut inner);
        Ok(())
    }

    /// Return the current caret rectangle in window logical coordinates.
    pub fn composition_bounds(
        &self,
        container: NodeId,
    ) -> Result<ProtocolRect, HostTextInputError> {
        let mut inner = self.inner.lock().expect("host inner");
        Self::validate_text_input(&inner, container)?;
        Self::composition_bounds_from_inner(&mut inner, container)
    }

    fn validate_text_input(inner: &HostInner, container: NodeId) -> Result<(), HostTextInputError> {
        if inner.arena.get(container).is_none() {
            return Err(HostTextInputError::StaleNode {
                node: container,
                current_generation: inner.arena.current_generation(container.slot()),
            });
        }
        if !inner.inputs.contains_key(&container.raw()) {
            return Err(HostTextInputError::NotTextInput { node: container });
        }
        Ok(())
    }

    fn composition_bounds_from_inner(
        inner: &mut HostInner,
        container: NodeId,
    ) -> Result<ProtocolRect, HostTextInputError> {
        let geometry = Self::paragraph_input_geometry_from_inner(inner, container)?;
        let (origin_x, origin_y) = effective_layout_origin(&inner.arena, geometry.text_node)
            .ok_or(HostTextInputError::LayoutUnavailable { node: container })?;
        Ok(ProtocolRect {
            x: f64::from(origin_x + geometry.caret_rect.x),
            y: f64::from(origin_y + geometry.caret_rect.y),
            width: f64::from(geometry.caret_rect.width),
            height: f64::from(geometry.caret_rect.height),
        })
    }

    fn paragraph_input_geometry_from_inner(
        inner: &mut HostInner,
        container: NodeId,
    ) -> Result<ParagraphInputGeometry, HostTextInputError> {
        let (text_node, value, selection, caret_affinity) = {
            let field = inner
                .inputs
                .get(&container.raw())
                .expect("validated text input");
            (
                field.text_node,
                field.editor.value().to_owned(),
                field.editor.selection(),
                field.caret_affinity,
            )
        };
        let snapshot = inner
            .text_cache
            .snapshot_for_node(text_node)
            .filter(|snapshot| snapshot.text() == value)
            .ok_or(HostTextInputError::LayoutUnavailable { node: container })?;
        let index_map = TextIndexMap::new(&value);
        let utf8_offset = index_map
            .grapheme_to_utf8(selection.focus.0)
            .ok_or(HostTextInputError::LayoutUnavailable { node: container })?;
        let offset = Utf8Range::new(snapshot.text(), utf8_offset, utf8_offset)
            .expect("editor caret is a validated UTF-8 boundary")
            .start();
        let bounds = snapshot
            .caret_bounds(offset, caret_affinity)
            .or_else(|| {
                let fallback = match caret_affinity {
                    CaretAffinity::Upstream => CaretAffinity::Downstream,
                    CaretAffinity::Downstream => CaretAffinity::Upstream,
                };
                snapshot.caret_bounds(offset, fallback)
            })
            .ok_or(HostTextInputError::LayoutUnavailable { node: container })?;
        let selection = selection.range();
        let selection_start = index_map
            .grapheme_to_utf8(selection.start.0)
            .ok_or(HostTextInputError::LayoutUnavailable { node: container })?;
        let selection_end = index_map
            .grapheme_to_utf8(selection.end.0)
            .ok_or(HostTextInputError::LayoutUnavailable { node: container })?;
        let selection_range = Utf8Range::new(snapshot.text(), selection_start, selection_end)
            .expect("editor selection is a validated UTF-8 range");
        let selection_rects = snapshot
            .selection_rects(selection_range)
            .into_iter()
            .map(|rect| LayoutRect {
                x: rect.x(),
                y: rect.y(),
                width: rect.width(),
                height: rect.height(),
            })
            .collect();
        Ok(ParagraphInputGeometry {
            text_node,
            caret_rect: LayoutRect {
                x: bounds.x(),
                y: bounds.y(),
                width: bounds.width(),
                height: bounds.height(),
            },
            selection_rects,
        })
    }

    fn map_text_edit_error(
        error: EditError,
        start: u32,
        end: u32,
        utf16_length: usize,
    ) -> HostTextInputError {
        match error {
            EditError::InvalidRange { .. } | EditError::InvalidUtf16Range { .. } => {
                HostTextInputError::InvalidUtf16Range {
                    start,
                    end,
                    utf16_length,
                }
            }
            EditError::StaleRevision { expected, actual } => {
                HostTextInputError::RevisionMismatch { expected, actual }
            }
            EditError::RevisionExhausted => HostTextInputError::RevisionExhausted,
        }
    }

    pub fn add_change_listener(&self, node: NodeId, token: u64) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_clickable(node, true);
        inner.change_tokens.insert(node.raw(), token);
        inner.interactions.entry(node.raw()).or_default();
        Self::mark_active_changed(&mut inner);
    }

    pub fn add_submit_listener(&self, node: NodeId, token: u64) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_clickable(node, true);
        inner.submit_tokens.insert(node.raw(), token);
        inner.interactions.entry(node.raw()).or_default();
        Self::mark_active_changed(&mut inner);
    }

    /// Register one stable v1 listener, replacing any prior v1 listener for
    /// the same `(node,event)` target.
    pub fn add_event_listener(
        &self,
        node: NodeId,
        event: EventId,
        callback: CallbackHandle,
    ) -> Result<Option<CallbackHandle>, HostListenerError> {
        let mut inner = self.inner.lock().expect("host inner");
        if inner.arena.get(node).is_none() {
            return Err(HostListenerError::StaleNode {
                node,
                current_generation: inner.arena.current_generation(node.slot()),
            });
        }
        let key = ListenerKey::new(node.raw(), event as u32);
        let previous = inner.v1_listeners.insert(key, callback);
        inner.arena.set_clickable(node, true);
        inner.interactions.entry(node.raw()).or_default();
        if event == EventId::Click {
            inner.focus.register(node, 0, true);
            let root = inner.root;
            let arena = inner.arena.clone();
            let _ = inner.focus.reconcile(&arena, root);
        }
        Self::mark_active_changed(&mut inner);
        Ok(previous)
    }

    /// Remove a stable v1 listener if it still owns the target. A replacement
    /// or an already-removed callback is an idempotent no-op.
    pub fn remove_event_listener(
        &self,
        node: NodeId,
        event: EventId,
        callback: CallbackHandle,
    ) -> bool {
        let mut inner = self.inner.lock().expect("host inner");
        let key = ListenerKey::new(node.raw(), event as u32);
        if inner.v1_listeners.get(&key).copied() != Some(callback) {
            return false;
        }
        inner.v1_listeners.remove(&key);
        let still_interactive = inner
            .v1_listeners
            .keys()
            .any(|other| other.node_raw == node.raw())
            || inner.click_tokens.contains_key(&node.raw())
            || inner.change_tokens.contains_key(&node.raw())
            || inner.submit_tokens.contains_key(&node.raw())
            || inner.inputs.contains_key(&node.raw());
        let still_focusable = inner.inputs.contains_key(&node.raw())
            || inner.click_tokens.contains_key(&node.raw())
            || inner
                .v1_listeners
                .contains_key(&ListenerKey::new(node.raw(), EventId::Click as u32));
        inner.arena.set_clickable(node, still_interactive);
        if !still_interactive {
            inner.interactions.remove(&node.raw());
        }
        if !still_focusable {
            inner.focus.unregister(node);
            let arena = inner.arena.clone();
            let root = inner.root;
            let focused = inner.focus.reconcile(&arena, root);
            transition_focus(&mut inner, focused);
        }
        Self::mark_active_changed(&mut inner);
        true
    }

    /// Return the callback currently bound to a node/event target.
    #[must_use]
    pub fn event_listener(&self, node: NodeId, event: EventId) -> Option<CallbackHandle> {
        let inner = self.inner.lock().expect("host inner");
        inner
            .v1_listeners
            .get(&ListenerKey::new(node.raw(), event as u32))
            .copied()
    }

    /// Check a wire node handle without exposing the arena internals.
    #[must_use]
    pub fn has_node(&self, node: NodeId) -> bool {
        self.inner
            .lock()
            .expect("host inner")
            .arena
            .get(node)
            .is_some()
    }

    /// Return the committed explicit semantics attached to a visual node.
    #[must_use]
    pub fn semantics(&self, node: NodeId) -> Option<Semantics> {
        self.inner
            .lock()
            .expect("host inner")
            .arena
            .get(node)
            .and_then(|node| node.semantics.clone())
    }

    /// Derive a snapshot from committed visual-tree state. Pending mutation
    /// previews are intentionally excluded until [`Self::commit_pending`].
    #[must_use]
    pub fn semantic_snapshot(&self) -> SemanticTreeSnapshot {
        let inner = self.inner.lock().expect("host inner");
        inner
            .root
            .map_or_else(SemanticTreeSnapshot::default, |root| {
                let arena = &inner.arena;
                let inputs = &inner.inputs;
                SemanticTreeSnapshot::derive_with_defaults(
                    arena,
                    root,
                    inner.focused,
                    |id, node| default_semantics(arena, inputs, id, node),
                )
            })
    }

    /// Compare the committed semantic tree with a caller-owned snapshot.
    #[must_use]
    pub fn semantic_diff(&self, previous: &SemanticTreeSnapshot) -> SemanticTreeDiff {
        previous.diff(&self.semantic_snapshot())
    }

    /// Return the current generation for a wire slot for structured stale
    /// handle diagnostics.
    #[must_use]
    pub fn current_generation(&self, slot: u32) -> Option<u32> {
        self.inner
            .lock()
            .expect("host inner")
            .arena
            .current_generation(slot)
    }

    /// Load a local image file onto an Image node.
    ///
    /// On failure stores an empty asset and applies a 64×64 placeholder size when
    /// the node has no explicit width/height.
    pub fn set_image(&self, node: NodeId, path: &str) {
        if path.is_empty() {
            let mut inner = self.inner.lock().expect("host inner");
            let previous = inner.images.remove(&node.raw());
            if let Some(asset) = previous {
                if let Some(n) = inner.arena.get_mut(node) {
                    if asset.inferred_width {
                        n.style.width = None;
                    }
                    if asset.inferred_height {
                        n.style.height = None;
                    }
                }
            }
            inner.arena.set_image_resource(node, None);
            let referenced = inner
                .images
                .values()
                .map(|asset| asset.resource_id)
                .collect::<Vec<_>>();
            inner.image_resources.retain_referenced(referenced);
            Self::mark_active_changed(&mut inner);
            return;
        }
        let mut inner = self.inner.lock().expect("host inner");
        let (resource_id, resource) = inner.image_resources.get_or_load(path, || {
            decode_image_file(path).unwrap_or((64, 64, Vec::new()))
        });
        let width = resource.width;
        let height = resource.height;
        let (inferred_width, inferred_height) = inner
            .arena
            .get(node)
            .map(|n| (n.style.width.is_none(), n.style.height.is_none()))
            .unwrap_or((false, false));
        if let Some(n) = inner.arena.get_mut(node) {
            if inferred_width {
                n.style.width = Some(width as f32);
            }
            if inferred_height {
                n.style.height = Some(height as f32);
            }
        }
        inner.arena.set_image_resource(node, Some(resource_id));
        inner.images.insert(
            node.raw(),
            ImageAsset {
                path: path.to_owned(),
                resource_id,
                width,
                height,
                pixels: Arc::clone(&resource.pixels),
                inferred_width,
                inferred_height,
            },
        );
        let referenced = inner
            .images
            .values()
            .map(|asset| asset.resource_id)
            .collect::<Vec<_>>();
        inner.image_resources.retain_referenced(referenced);
        Self::mark_active_changed(&mut inner);
    }

    /// Path used for load; retained for diagnostics / future reload.
    #[must_use]
    pub fn image_path(&self, node: NodeId) -> Option<String> {
        let inner = self.inner.lock().expect("host inner");
        inner.images.get(&node.raw()).map(|a| a.path.clone())
    }

    #[must_use]
    pub fn click_token(&self, node: NodeId) -> Option<u64> {
        let inner = self.inner.lock().expect("host inner");
        inner.click_tokens.get(&node.raw()).copied()
    }

    #[must_use]
    pub fn root(&self) -> Option<NodeId> {
        self.inner.lock().expect("host inner").root
    }

    /// Ensure root fills the viewport before layout.
    pub fn prepare_root_size(&self, logical_w: f32, logical_h: f32) {
        let mut inner = self.inner.lock().expect("host inner");
        let Some(root) = inner.root else {
            return;
        };
        Self::size_root_for_viewport(&mut inner, root, logical_w, logical_h);
        Self::mark_active_changed(&mut inner);
    }

    pub fn layout(&self, logical_w: f32, logical_h: f32) {
        let layout_error = {
            let mut inner = self.inner.lock().expect("host inner");
            let Some(root) = inner.root else {
                return;
            };
            Self::size_root_for_viewport(&mut inner, root, logical_w, logical_h);
            let error = {
                let inner = &mut *inner;
                let (arena, text_cache) = (&mut inner.arena, &mut inner.text_cache);
                layout_tree_with_cache(arena, root, logical_w, logical_h, text_cache).err()
            };
            Self::mark_active_changed(&mut inner);
            error
        };
        if let Some(error) = layout_error {
            self.errors
                .report(crate::frame_nexa_error("layout", error.to_string()));
        }
    }

    pub fn paint(
        &self,
        pixels: &mut [u32],
        width: u32,
        height: u32,
        scale: f64,
    ) -> Result<(), String> {
        let frame = {
            let mut inner = self.inner.lock().expect("host inner");
            let Some(root) = inner.root else {
                return Err("nui host has no root node".to_owned());
            };
            let display_result =
                { display_list_from_inner(&mut inner, root).map_err(|error| error.to_string()) };
            display_result.map(|display_list| (display_list, paint_hints_from_inner(&mut inner)))
        };
        let (display_list, hints) = match frame {
            Ok(frame) => frame,
            Err(error) => {
                self.errors
                    .report(crate::frame_nexa_error("layout", error.clone()));
                return Err(error);
            }
        };
        paint_display_list(&display_list, pixels, width, height, scale, Some(&hints))
            .map_err(|error| error.to_string())
    }

    #[must_use]
    pub fn hit_clickable(&self, logical_x: f32, logical_y: f32) -> Option<NodeId> {
        let inner = self.inner.lock().expect("host inner");
        let root = inner.root?;
        hit_test(&inner.arena, root, logical_x, logical_y)
    }

    /// Run the native window. Callback receives clicks / input change / submit.
    /// Return `true` to request a redraw.
    pub fn run<F>(&self, title: &str, on_event: F) -> Result<(), String>
    where
        F: FnMut(HostUiEvent) -> bool + 'static,
    {
        let host = self.clone();
        self.run_with_tick(title, on_event, move || match host.commit_pending() {
            Ok(Some(receipt)) => receipt.dirty.bits() != 0,
            Ok(None) => false,
            Err(error) => {
                host.errors
                    .report(crate::mutation_nexa_error(error, "commit"));
                eprintln!("nui commit rejected: {error:?}");
                false
            }
        })
    }

    /// Run the native window with a callback invoked once after each
    /// dispatcher tick. The Perry FFI uses this hook to commit the complete
    /// event batch and clean up invalidated callback handles.
    pub fn run_with_tick<F, G>(
        &self,
        title: &str,
        on_event: F,
        after_events: G,
    ) -> Result<(), String>
    where
        F: FnMut(HostUiEvent) -> bool + 'static,
        G: FnMut() -> bool + 'static,
    {
        self.run_with_lifecycle(title, on_event, after_events, || {})
    }

    /// Run the native window with explicit pre-destruction lifecycle
    /// notification. The close hook runs before the platform drops its window
    /// and surface; session reset completes after this method returns.
    pub fn run_with_lifecycle<F, G, H>(
        &self,
        title: &str,
        on_event: F,
        after_events: G,
        on_close: H,
    ) -> Result<(), String>
    where
        F: FnMut(HostUiEvent) -> bool + 'static,
        G: FnMut() -> bool + 'static,
        H: FnMut() + 'static,
    {
        self.run_with_lifecycle_v1(title, on_event, after_events, on_close)
            .map_err(|error| error.message)
    }

    /// Typed lifecycle entry point used by the stable v1 run envelope.
    #[allow(clippy::result_large_err)]
    pub fn run_with_lifecycle_v1<F, G, H>(
        &self,
        title: &str,
        on_event: F,
        after_events: G,
        on_close: H,
    ) -> Result<(), nui_core::protocol::common::NexaError>
    where
        F: FnMut(HostUiEvent) -> bool + 'static,
        G: FnMut() -> bool + 'static,
        H: FnMut() + 'static,
    {
        self.run_with_runtime_hooks_v1(
            title,
            on_event,
            after_events,
            |_| {},
            |_| false,
            || false,
            on_close,
        )
    }

    /// Typed lifecycle entry point with optional Application Runtime hooks.
    /// System completion receives the live Scheduler and therefore can prove
    /// that Task settlement occurs only in `SystemCompletion`.
    #[allow(clippy::result_large_err, clippy::too_many_arguments)]
    pub fn run_with_runtime_hooks_v1<F, G, I, S, M, H>(
        &self,
        title: &str,
        on_event: F,
        after_events: G,
        install_runtime_waker: I,
        system_completion: S,
        framework_microtasks: M,
        on_close: H,
    ) -> Result<(), nui_core::protocol::common::NexaError>
    where
        F: FnMut(HostUiEvent) -> bool + 'static,
        G: FnMut() -> bool + 'static,
        I: FnMut(nui_platform_winit::RuntimeWaker) + 'static,
        S: FnMut(&nui_app_runtime::Scheduler) -> bool + 'static,
        M: FnMut() -> bool + 'static,
        H: FnMut() + 'static,
    {
        if let Some(fatal) = self.errors.fatal_error() {
            return Err(fatal);
        }
        let (root, session_id) = match self.prepare_window_session() {
            Some(session) => session,
            None => {
                let error = crate::operation_state_nexa_error(
                    "run",
                    "nui host has no root node - create/insert first",
                );
                self.errors.report(error.clone());
                return Err(error);
            }
        };
        let app = HostWindowApp {
            shared: Arc::clone(&self.inner),
            root,
            errors: self.errors.clone(),
            dispatcher: nui_app_runtime::Dispatcher::new(),
            accessibility_dispatcher: nui_app_runtime::Dispatcher::new(),
            scheduler: nui_app_runtime::Scheduler::new(),
            install_runtime_waker: Box::new(install_runtime_waker),
            system_completion: Box::new(system_completion),
            framework_microtasks: Box::new(framework_microtasks),
            on_event: Box::new(on_event),
            after_events: Box::new(after_events),
            on_close: Box::new(on_close),
            viewport: (640.0, 420.0),
            redraw_pending: false,
            render_cache: nui_render_skia::BackendResourceCache::new(),
            window_lifecycle: crate::window::WindowLifecycleState::default(),
            frame_metrics: FrameMetricsState::for_session(self.metrics.clone(), session_id),
        };
        match nui_platform_winit::run_app(title, app) {
            Ok(()) => self.errors.fatal_error().map_or(Ok(()), Err),
            Err(error) => {
                if let Some(fatal) = self.errors.fatal_error() {
                    Err(fatal)
                } else {
                    let structured = crate::platform_run_nexa_error(&error);
                    self.errors.report(structured.clone());
                    Err(structured)
                }
            }
        }
    }
}

pub(crate) fn display_list_from_inner(
    inner: &mut HostInner,
    root: NodeId,
) -> Result<DisplayList, LayoutError> {
    let interaction_tokens = inner
        .interactions
        .iter()
        .map(|(node, state)| (*node, state.token()))
        .collect::<HashMap<_, _>>();
    let placeholders = inner
        .inputs
        .values()
        .filter(|field| !field.placeholder.is_empty())
        .map(|field| (field.text_node, field.placeholder.clone()))
        .collect::<HashMap<_, _>>();
    display_list_with_cache_and_interactions_and_overrides(
        &inner.arena,
        root,
        &mut inner.text_cache,
        |node| interaction_tokens.get(&node.raw()).copied(),
        |node, source, _| {
            source.is_empty().then(|| {
                placeholders
                    .get(&node)
                    .cloned()
                    .map(|placeholder| (placeholder, ColorRgba::rgb(0x9c, 0xa3, 0xaf)))
            })?
        },
    )
}

/// Return the focused editor's paragraph-derived caret rectangle for the
/// platform IME adapter. Non-editor focus and unavailable layout intentionally
/// produce `None`, allowing the platform to disable candidate positioning.
pub(crate) fn focused_composition_bounds_from_inner(inner: &mut HostInner) -> Option<ProtocolRect> {
    let focused = inner.focused?;
    if !inner.inputs.contains_key(&focused.raw()) {
        return None;
    }
    NuiHost::composition_bounds_from_inner(inner, focused).ok()
}

/// Return the visual origin used by Display List traversal for one node.
/// Vertical Scroll ancestors offset descendants without changing Arena layout.
pub(crate) fn effective_layout_origin(arena: &Arena, node: NodeId) -> Option<(f32, f32)> {
    let node = arena.get(node)?;
    let (x, mut y) = (node.layout.x, node.layout.y);
    let mut parent = node.parent;
    while let Some(parent_id) = parent {
        let ancestor = arena.get(parent_id)?;
        if ancestor.node_type == NodeType::Scroll {
            y -= ancestor.style.scroll_offset_y;
        }
        parent = ancestor.parent;
    }
    Some((x, y))
}

pub(crate) fn paint_hints_from_inner(inner: &mut HostInner) -> PaintHints {
    let focused = inner.focused.and_then(|focused| {
        let text_node = inner
            .inputs
            .get(&focused.raw())
            .map(|field| field.text_node)?;
        let geometry = NuiHost::paragraph_input_geometry_from_inner(inner, focused).ok();
        let (caret_rect, selection_rects) = geometry.map_or_else(
            || (None, Vec::new()),
            |geometry| (Some(geometry.caret_rect), geometry.selection_rects),
        );
        Some(FocusedPaint {
            text_node,
            caret_rect,
            selection_rects,
        })
    });
    let images = inner
        .images
        .values()
        .map(|asset| ImagePaint {
            resource_id: asset.resource_id,
            width: asset.width,
            height: asset.height,
            pixels: Arc::clone(&asset.pixels),
        })
        .collect();
    let fonts = inner
        .text_cache
        .database()
        .source_faces()
        .map(|(font_id, source)| FontPaint {
            font_id: font_id.get(),
            bytes: source.shared_bytes(),
            face_index: source.face_index(),
        })
        .collect();
    PaintHints {
        focused,
        images,
        fonts,
    }
}

pub(crate) fn read_input_value(inner: &HostInner, container: NodeId) -> String {
    let Some(field) = inner.inputs.get(&container.raw()) else {
        return String::new();
    };
    inner
        .arena
        .get(field.text_node)
        .and_then(|n| n.text.clone())
        .unwrap_or_default()
}

fn normalized_input_text(text: &str, multiline: bool) -> Cow<'_, str> {
    if multiline || (!text.contains('\r') && !text.contains('\n')) {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(
            text.chars()
                .filter(|value| !matches!(value, '\r' | '\n'))
                .collect(),
        )
    }
}

fn normalized_single_line_utf16_offset(text: &str, offset: usize) -> Option<usize> {
    if offset == 0 {
        return Some(0);
    }
    let mut source_offset = 0;
    let mut normalized_offset = 0;
    for value in text.chars() {
        let width = value.len_utf16();
        source_offset += width;
        if !matches!(value, '\r' | '\n') {
            normalized_offset += width;
        }
        if source_offset == offset {
            return Some(normalized_offset);
        }
        if source_offset > offset {
            return None;
        }
    }
    (source_offset == offset).then_some(normalized_offset)
}

fn normalized_preedit<'a>(
    text: &'a str,
    selection: Option<Utf16Range>,
    multiline: bool,
) -> Option<(Cow<'a, str>, Option<Utf16Range>)> {
    let normalized = normalized_input_text(text, multiline);
    if multiline || matches!(normalized, Cow::Borrowed(_)) {
        return Some((normalized, selection));
    }
    let selection = match selection {
        Some(selection) => Some(Utf16Range {
            start: normalized_single_line_utf16_offset(text, selection.start)?,
            end: normalized_single_line_utf16_offset(text, selection.end)?,
        }),
        None => None,
    };
    Some((normalized, selection))
}

pub(crate) fn insert_text_at_caret(inner: &mut HostInner, text: &str) -> Option<(NodeId, String)> {
    let focused = inner.focused?;
    let field = inner.inputs.get_mut(&focused.raw())?;
    let text = normalized_input_text(text, field.multiline);
    field.editor.commit_composition(&text).ok()?;
    field.caret_affinity = CaretAffinity::Downstream;
    let text_node = field.text_node;
    let next = field.editor.value().to_owned();
    inner.arena.set_text(text_node, next.clone());
    NuiHost::mark_active_changed(inner);
    Some((focused, next))
}

/// Replace the complete committed value for an accessibility SetValue action.
/// Composition is deliberately rejected by the caller until the native IME
/// transaction has settled; the action must not silently discard preedit.
pub(crate) fn replace_input_value_at_node(
    inner: &mut HostInner,
    node: NodeId,
    text: &str,
) -> Option<String> {
    let (text_node, next) = {
        let field = inner.inputs.get_mut(&node.raw())?;
        if field.editor.composition().is_some() {
            return None;
        }
        let text = normalized_input_text(text, field.multiline);
        let end = field.editor.value().encode_utf16().count();
        field
            .editor
            .replace_utf16_range(Utf16Range { start: 0, end }, &text, None)
            .ok()?;
        field.caret_affinity = CaretAffinity::Downstream;
        (field.text_node, field.editor.value().to_owned())
    };
    inner.arena.set_text(text_node, next.clone());
    NuiHost::mark_active_changed(inner);
    Some(next)
}

pub(crate) fn update_composition_at_focused(
    inner: &mut HostInner,
    text: &str,
    selection: Option<Utf16Range>,
) -> Option<(NodeId, String)> {
    let focused = inner.focused?;
    let (started, text_node, next, selection, preedit) = {
        let field = inner.inputs.get_mut(&focused.raw())?;
        let (text, selection) = normalized_preedit(text, selection, field.multiline)?;
        let started = field.editor.composition().is_none();
        field
            .editor
            .update_composition_with_selection(&text, selection)
            .ok()?;
        field.caret_affinity = CaretAffinity::Downstream;
        (
            started,
            field.text_node,
            field.editor.value().to_owned(),
            field
                .editor
                .composition_selection()
                .expect("composition update keeps selection"),
            text.into_owned(),
        )
    };
    inner.arena.set_text(text_node, next.clone());
    if started {
        queue_composition_event(
            inner,
            focused,
            CompositionKind::Start,
            String::new(),
            Utf16Range { start: 0, end: 0 },
        );
    }
    queue_composition_event(inner, focused, CompositionKind::Update, preedit, selection);
    NuiHost::mark_active_changed(inner);
    Some((focused, next))
}

pub(crate) fn start_composition_at_focused(inner: &mut HostInner) -> Option<(NodeId, bool)> {
    let focused = inner.focused?;
    let field = inner.inputs.get_mut(&focused.raw())?;
    let started = field.editor.composition().is_none();
    field.editor.start_composition();
    if started {
        queue_composition_event(
            inner,
            focused,
            CompositionKind::Start,
            String::new(),
            Utf16Range { start: 0, end: 0 },
        );
    }
    Some((focused, started))
}

fn protocol_composition_range(
    editor: &TextAreaController,
    utf16_length: usize,
) -> Result<Option<ProtocolTextRange>, HostTextInputError> {
    editor
        .composition_utf16_range()
        .map(|composition| {
            Ok(ProtocolTextRange {
                start: u32::try_from(composition.start)
                    .map_err(|_| HostTextInputError::TextTooLong { utf16_length })?,
                end: u32::try_from(composition.end)
                    .map_err(|_| HostTextInputError::TextTooLong { utf16_length })?,
            })
        })
        .transpose()
}

fn queue_composition_event(
    inner: &mut HostInner,
    node: NodeId,
    kind: CompositionKind,
    text: String,
    selection: Utf16Range,
) {
    let arena = inner.arena.clone();
    let mut event_dispatcher = std::mem::take(&mut inner.event_dispatcher);
    let mut target_propagation = None;
    let _ = event_dispatcher.dispatch(&arena, Some(node), None, |visited, phase, state| {
        if visited == node && phase == PropagationPhase::Target {
            target_propagation = Some(state.clone());
        }
    });
    inner.event_dispatcher = event_dispatcher;
    inner.next_event_timestamp = inner.next_event_timestamp.saturating_add(1).max(1);
    let callback = inner
        .v1_listeners
        .get(&ListenerKey::new(node.raw(), EventId::Composition as u32))
        .copied();
    let event = CompositionEvent {
        kind,
        text,
        selection_start: u32::try_from(selection.start).unwrap_or(u32::MAX),
        selection_end: u32::try_from(selection.end).unwrap_or(u32::MAX),
        context: EventContext {
            window_id: 1,
            target: Some(nui_core::protocol::common::HandleRef {
                slot: node.slot(),
                generation: node.generation(),
            }),
            timestamp: inner.next_event_timestamp.to_string(),
            modifiers: EventModifiers {
                shift: false,
                control: false,
                alt: false,
                meta: false,
                caps_lock: false,
                num_lock: false,
            },
            propagation: target_propagation.unwrap_or(PropagationState {
                phase: PropagationPhase::Target,
                default_prevented: false,
                propagation_stopped: false,
                immediate_propagation_stopped: false,
            }),
        },
    };
    inner.pending_ui_events.push_back(HostUiEvent::Composition {
        node,
        event,
        callback,
    });
}

pub(crate) fn take_pending_ui_events(inner: &mut HostInner) -> VecDeque<HostUiEvent> {
    std::mem::take(&mut inner.pending_ui_events)
}

fn cancel_composition_at_node(inner: &mut HostInner, node: NodeId) -> Option<bool> {
    let (had_composition, state_changed, value_changed, text_node, next) = {
        let field = inner.inputs.get_mut(&node.raw())?;
        let had_composition = field.editor.composition().is_some();
        let value_changed = field.editor.cancel_composition().ok()?;
        (
            had_composition,
            had_composition || value_changed,
            value_changed,
            field.text_node,
            field.editor.value().to_owned(),
        )
    };
    if value_changed {
        inner.arena.set_text(text_node, next);
    }
    if had_composition {
        queue_composition_event(
            inner,
            node,
            CompositionKind::Cancel,
            String::new(),
            Utf16Range { start: 0, end: 0 },
        );
    }
    Some(state_changed)
}

pub(crate) fn transition_focus(inner: &mut HostInner, next: Option<NodeId>) -> bool {
    let previous = inner.focused;
    let focus_changed = previous != next;
    let composition_changed = focus_changed
        && previous.is_some_and(|node| cancel_composition_at_node(inner, node).unwrap_or(false));
    inner.focused = next;

    let mut interaction_changed = false;
    for (raw, state) in &mut inner.interactions {
        let previous_state = *state;
        state.set_focused(next.is_some_and(|node| node.raw() == *raw));
        interaction_changed |= *state != previous_state;
    }

    focus_changed || composition_changed || interaction_changed
}

pub(crate) fn cancel_composition_at_focused(inner: &mut HostInner) -> Option<bool> {
    let focused = inner.focused?;
    let changed = cancel_composition_at_node(inner, focused)?;
    if changed {
        NuiHost::mark_active_changed(inner);
    }
    Some(changed)
}

pub(crate) fn commit_composition_at_focused(
    inner: &mut HostInner,
    text: &str,
) -> Option<(NodeId, String)> {
    let focused = inner.focused?;
    let field = inner.inputs.get(&focused.raw())?;
    let had_composition = field.editor.composition().is_some();
    let text = normalized_input_text(text, field.multiline);
    if text.is_empty() && !had_composition {
        return None;
    }
    let result = insert_text_at_caret(inner, &text)?;
    if had_composition {
        let selection = text.encode_utf16().count();
        queue_composition_event(
            inner,
            focused,
            CompositionKind::Commit,
            text.into_owned(),
            Utf16Range {
                start: selection,
                end: selection,
            },
        );
    }
    Some(result)
}

pub(crate) fn backspace_at_caret(inner: &mut HostInner) -> Option<(NodeId, String)> {
    let focused = inner.focused?;
    let field = inner.inputs.get_mut(&focused.raw())?;
    if !matches!(
        KeyCommand::Backspace.apply(&mut field.editor, KeyModifiers::none(), field.multiline,),
        Ok(CommandOutcome::Changed)
    ) {
        return None;
    }
    field.caret_affinity = CaretAffinity::Downstream;
    let text_node = field.text_node;
    let next = field.editor.value().to_owned();
    inner.arena.set_text(text_node, next.clone());
    NuiHost::mark_active_changed(inner);
    Some((focused, next))
}

/// Apply one named keyboard command to the focused Input and return the
/// resulting state transition. Selection-only moves have no Change event but
/// still cause a repaint so the caret/selection overlay stays current.
pub(crate) fn apply_input_command(
    inner: &mut HostInner,
    command: KeyCommand,
    modifiers: KeyModifiers,
) -> Option<(NodeId, CommandOutcome, bool, Option<String>)> {
    let focused = inner.focused?;
    let field = inner.inputs.get_mut(&focused.raw())?;
    let before_selection = field.editor.selection();
    let before_revision = field.editor.revision();
    let outcome = command
        .apply(&mut field.editor, modifiers, field.multiline)
        .ok()?;
    if before_selection != field.editor.selection() || before_revision != field.editor.revision() {
        field.caret_affinity = match command {
            KeyCommand::Navigate(NavigationKey::Left | NavigationKey::Home) => {
                CaretAffinity::Downstream
            }
            KeyCommand::Navigate(NavigationKey::Right | NavigationKey::End) => {
                CaretAffinity::Upstream
            }
            KeyCommand::Enter => CaretAffinity::Downstream,
            KeyCommand::Backspace | KeyCommand::Delete | KeyCommand::Unhandled => {
                CaretAffinity::Downstream
            }
        };
    }
    let visual_changed =
        before_selection != field.editor.selection() || before_revision != field.editor.revision();
    let value = matches!(outcome, CommandOutcome::Changed).then(|| field.editor.value().to_owned());
    if let Some(value) = value.as_ref() {
        inner.arena.set_text(field.text_node, value.clone());
        NuiHost::mark_active_changed(inner);
    }
    Some((focused, outcome, visual_changed, value))
}

/// Apply paragraph-aware visual Left/Right navigation to the focused editor.
/// A non-extended move first collapses an existing selection, matching the
/// platform editing contract without stepping past the collapsed edge.
pub(crate) fn apply_horizontal_input_command(
    inner: &mut HostInner,
    direction: HorizontalDirection,
    extend: bool,
) -> Option<(NodeId, bool)> {
    let focused = inner.focused?;
    let (text_node, affinity, selection) = inner.inputs.get(&focused.raw()).map(|field| {
        (
            field.text_node,
            field.caret_affinity,
            field.editor.selection(),
        )
    })?;
    if !extend && !selection.is_collapsed() {
        let field = inner.inputs.get_mut(&focused.raw())?;
        field
            .editor
            .collapse_selection(matches!(direction, HorizontalDirection::Right));
        field.caret_affinity = match direction {
            HorizontalDirection::Left => CaretAffinity::Downstream,
            HorizontalDirection::Right => CaretAffinity::Upstream,
        };
        let _ = ensure_input_caret_visible(inner, focused);
        return Some((focused, true));
    }

    let snapshot = inner.text_cache.snapshot_for_node(text_node)?;
    let selection_changed = {
        let field = inner.inputs.get_mut(&focused.raw())?;
        let before = field.editor.selection();
        let hit = field
            .editor
            .move_horizontal_in_snapshot(&snapshot, affinity, direction, extend)
            .ok()?;
        field.caret_affinity = hit.affinity();
        before != field.editor.selection()
    };
    let scroll_changed = ensure_input_caret_visible(inner, focused).unwrap_or(false);
    Some((focused, selection_changed || scroll_changed))
}

/// Apply snapshot-aware Up/Down navigation to a multiline input. The
/// controller retains preferred x across consecutive vertical commands.
pub(crate) fn apply_vertical_input_command(
    inner: &mut HostInner,
    direction: VerticalDirection,
    extend: bool,
) -> Option<(NodeId, bool)> {
    let focused = inner.focused?;
    let (text_node, affinity, multiline) = inner
        .inputs
        .get(&focused.raw())
        .map(|field| (field.text_node, field.caret_affinity, field.multiline))?;
    if !multiline {
        return None;
    }
    let snapshot = inner.text_cache.snapshot_for_node(text_node);
    let selection_changed = {
        let field = inner.inputs.get_mut(&focused.raw())?;
        let before = field.editor.selection();
        if let Some(snapshot) = snapshot {
            let hit = field
                .editor
                .move_vertical_in_snapshot(&snapshot, affinity, direction, extend)
                .ok()?;
            field.caret_affinity = hit.affinity();
        } else {
            field.editor.move_vertical(direction, extend).ok()?;
            field.caret_affinity = CaretAffinity::Downstream;
        }
        before != field.editor.selection()
    };
    let scroll_changed = ensure_input_caret_visible(inner, focused).unwrap_or(false);
    Some((focused, selection_changed || scroll_changed))
}

/// Apply snapshot-aware Home/End navigation to one visual line.
pub(crate) fn apply_line_edge_input_command(
    inner: &mut HostInner,
    to_end: bool,
    extend: bool,
) -> Option<(NodeId, bool)> {
    let focused = inner.focused?;
    let (text_node, affinity, multiline) = inner
        .inputs
        .get(&focused.raw())
        .map(|field| (field.text_node, field.caret_affinity, field.multiline))?;
    if !multiline {
        return None;
    }
    let snapshot = inner.text_cache.snapshot_for_node(text_node);
    let selection_changed = {
        let field = inner.inputs.get_mut(&focused.raw())?;
        let before = field.editor.selection();
        if let Some(snapshot) = snapshot {
            let hit = field
                .editor
                .move_to_line_edge_in_snapshot(&snapshot, affinity, to_end, extend)
                .ok()?;
            field.caret_affinity = hit.affinity();
        } else if to_end {
            field.editor.move_end(extend).ok()?;
            field.caret_affinity = CaretAffinity::Upstream;
        } else {
            field.editor.move_home(extend).ok()?;
            field.caret_affinity = CaretAffinity::Downstream;
        }
        before != field.editor.selection()
    };
    let scroll_changed = ensure_input_caret_visible(inner, focused).unwrap_or(false);
    Some((focused, selection_changed || scroll_changed))
}

/// Keep a multiline caret inside its Scroll viewport using paragraph-local
/// geometry. Returns `None` when layout has not produced a current snapshot.
pub(crate) fn ensure_input_caret_visible(inner: &mut HostInner, container: NodeId) -> Option<bool> {
    let field = inner.inputs.get(&container.raw())?;
    if !field.multiline {
        return Some(false);
    }
    let geometry = NuiHost::paragraph_input_geometry_from_inner(inner, container).ok()?;
    let snapshot = inner.text_cache.snapshot_for_node(geometry.text_node)?;
    let container_node = inner.arena.get(container)?;
    if container_node.node_type != NodeType::Scroll {
        return Some(false);
    }
    let text_layout = inner.arena.get(geometry.text_node)?.layout;
    let viewport = container_node.layout;
    let padding = container_node.style.padding.max(0.0);
    let current = container_node.style.scroll_offset_y.max(0.0);
    let content_origin_y = text_layout.y - viewport.y;
    let caret_top = content_origin_y + geometry.caret_rect.y;
    let caret_bottom = caret_top + geometry.caret_rect.height;
    let visible_top = current + padding;
    let visible_bottom = current + (viewport.height - padding).max(padding);
    let next = if caret_top < visible_top {
        caret_top - padding
    } else if caret_bottom > visible_bottom {
        caret_bottom - (viewport.height - padding).max(padding)
    } else {
        current
    };
    let content_bottom = content_origin_y + snapshot.size().height() + padding;
    let max_offset = (content_bottom - viewport.height).max(0.0);
    let next = next.clamp(0.0, max_offset);
    if (next - current).abs() < f32::EPSILON {
        return Some(false);
    }
    inner.arena.get_mut(container)?.style.scroll_offset_y = next;
    NuiHost::mark_active_changed(inner);
    Some(true)
}

/// Pack RGBA into the u32 form accepted by [`NuiHost::set_number`] for colors.
#[must_use]
pub fn pack_rgba(r: u8, g: u8, b: u8, a: u8) -> u32 {
    ((r as u32) << 24) | ((g as u32) << 16) | ((b as u32) << 8) | (a as u32)
}

#[cfg(test)]
mod lifecycle_tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use nui_core::protocol::common::ErrorSeverity;
    use nui_text::{
        FontDatabase, FontFaceDescriptor, FontRequest, FontSource, FontStyle, GlyphCoverage, Script,
    };

    use super::*;

    fn text_input_host() -> NuiHost {
        let mut database = FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Ahem Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("ABHHi e\u{301}".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        database.register_face(
            FontFaceDescriptor::new(
                "Emoji Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("✍🏽‍✍️😀".chars()),
            )
            .unwrap()
            .with_scripts([Script::Common])
            .with_source(
                FontSource::new(Arc::<[u8]>::from(font_test_data::NOTO_HANDWRITING_SBIX), 0)
                    .unwrap(),
            ),
        );
        NuiHost::with_fonts(
            database,
            FontRequest::new(["Ahem Fixture", "Emoji Fixture"]),
        )
        .expect("valid text input font configuration")
    }

    fn mounted_input(host: &NuiHost, value: &str) -> (NodeId, NodeId) {
        let root = host.create_node(NodeType::View);
        let text = host.create_text(value);
        host.set_number(root, PropertyId::Padding, 7.0);
        host.set_number(text, PropertyId::FontSize, 20.0);
        host.insert(text, root);
        host.register_input(root, text, "placeholder");
        host.layout(200.0, 80.0);
        (root, text)
    }

    #[test]
    fn window_root_tracks_each_viewport_resize() {
        let host = text_input_host();
        let root = host.create_node(NodeType::Root);
        let content = host.create_node(NodeType::View);
        host.set_number(root, PropertyId::AlignItems, 3.0);
        host.set_number(content, PropertyId::FlexGrow, 1.0);
        host.insert(content, root);

        host.layout(640.0, 420.0);
        {
            let inner = host.inner.lock().expect("host inner");
            let root_layout = inner.arena.get(root).expect("root").layout;
            assert_eq!((root_layout.width, root_layout.height), (640.0, 420.0));
        }

        host.layout(900.0, 600.0);
        let inner = host.inner.lock().expect("host inner");
        let root_layout = inner.arena.get(root).expect("root").layout;
        let content_layout = inner.arena.get(content).expect("content").layout;
        assert_eq!((root_layout.width, root_layout.height), (900.0, 600.0));
        assert_eq!(
            (content_layout.width, content_layout.height),
            (900.0, 600.0)
        );
    }

    #[test]
    fn view_host_root_tracks_each_viewport_resize() {
        let host = text_input_host();
        let root = host.create_node(NodeType::View);

        host.layout(640.0, 420.0);
        host.layout(900.0, 600.0);

        let inner = host.inner.lock().expect("host inner");
        let root_layout = inner.arena.get(root).expect("root").layout;
        assert_eq!((root_layout.width, root_layout.height), (900.0, 600.0));
    }

    #[test]
    fn text_input_state_uses_utf16_offsets_and_decimal_revision() {
        let host = text_input_host();
        let (input, _) = mounted_input(&host, "A✍🏽‍✍️B");

        let state = host.text_input_state(input).expect("text input state");

        assert_eq!(state.text, "A✍🏽‍✍️B");
        assert_eq!(state.surrounding_text.start, 0);
        assert_eq!(state.surrounding_text.end, 8);
        assert_eq!(state.selection.anchor, 8);
        assert_eq!(state.selection.focus, 8);
        assert_eq!(state.composition, None);
        assert_eq!(state.revision, "0");
    }

    #[test]
    fn text_input_state_exposes_active_composition_as_utf16() {
        let host = text_input_host();
        let (input, _) = mounted_input(&host, "A");
        {
            let mut inner = host.inner.lock().expect("host inner");
            inner.focused = Some(input);
            update_composition_at_focused(&mut inner, "Hi", None).expect("active preedit");
        }
        host.layout(200.0, 80.0);

        let state = host.text_input_state(input).expect("composition state");

        assert_eq!(state.text, "AHi");
        assert_eq!(state.selection.anchor, 3);
        assert_eq!(state.selection.focus, 3);
        assert_eq!(
            state.composition,
            Some(ProtocolTextRange { start: 1, end: 3 })
        );
        assert_eq!(state.revision, "1");
    }

    #[test]
    fn text_input_state_keeps_exact_combining_composition_and_emoji_selection() {
        let host = text_input_host();
        let (input, _) = mounted_input(&host, "e");
        let (value, selection, composition) = {
            let mut inner = host.inner.lock().expect("host inner");
            inner.focused = Some(input);
            update_composition_at_focused(
                &mut inner,
                "\u{301}A✍🏽‍✍️B",
                Some(Utf16Range { start: 2, end: 8 }),
            )
            .expect("active combining and emoji preedit");
            let field = inner.inputs.get(&input.raw()).expect("input field");
            (
                field.editor.value().to_owned(),
                field.editor.utf16_selection(),
                protocol_composition_range(
                    &field.editor,
                    field.editor.value().encode_utf16().count(),
                )
                .expect("protocol composition range"),
            )
        };

        assert_eq!(value, "e\u{301}A✍🏽‍✍️B");
        assert_eq!(selection.anchor, 3);
        assert_eq!(selection.focus, 9);
        assert_eq!(composition, Some(ProtocolTextRange { start: 1, end: 10 }));
    }

    #[test]
    fn replace_text_input_is_grapheme_safe_at_the_utf16_boundary() {
        let host = text_input_host();
        let (input, _) = mounted_input(&host, "A😀B");

        assert!(matches!(
            host.replace_text_input(
                input,
                nui_core::protocol::ui::TextRange { start: 2, end: 2 },
                "X",
            ),
            Err(HostTextInputError::InvalidUtf16Range {
                start: 2,
                end: 2,
                utf16_length: 4,
            })
        ));
        host.replace_text_input(
            input,
            nui_core::protocol::ui::TextRange { start: 1, end: 3 },
            "H",
        )
        .expect("replace emoji range");
        host.layout(200.0, 80.0);

        let state = host.text_input_state(input).expect("updated state");
        assert_eq!(state.text, "AHB");
        assert_eq!(state.selection.anchor, 2);
        assert_eq!(state.selection.focus, 2);
        assert_eq!(state.revision, "1");
    }

    #[test]
    fn single_line_preedit_remaps_utf16_selection_after_stripping_crlf() {
        let (text, selection) =
            normalized_preedit("\r😀\n", Some(Utf16Range { start: 1, end: 3 }), false)
                .expect("valid UTF-16 selection");
        assert_eq!(text, "😀");
        assert_eq!(selection, Some(Utf16Range { start: 0, end: 2 }));
        assert!(
            normalized_preedit("\r😀\n", Some(Utf16Range { start: 2, end: 3 }), false,).is_none()
        );
    }

    #[test]
    fn queued_controlled_value_echo_preserves_editor_selection_and_revision() {
        let host = text_input_host();
        let (input, text_node) = mounted_input(&host, "AB");
        {
            let mut inner = host.inner.lock().expect("host inner");
            inner.focused = Some(input);
            inner
                .inputs
                .get_mut(&input.raw())
                .expect("input")
                .editor
                .set_caret(1, false)
                .expect("middle caret");
            let (_, value) = insert_text_at_caret(&mut inner, "H").expect("native edit");
            assert_eq!(value, "AHB");
        }

        host.queue_set_text(text_node, "AHB")
            .expect("queue controlled echo");
        host.commit_pending().expect("commit controlled echo");

        let inner = host.inner.lock().expect("host inner");
        let editor = &inner.inputs.get(&input.raw()).expect("input").editor;
        assert_eq!(editor.value(), "AHB");
        assert_eq!(editor.selection().anchor.0, 2);
        assert_eq!(editor.selection().focus.0, 2);
        assert_eq!(editor.revision(), 1);
    }

    #[test]
    fn composition_bounds_use_paragraph_caret_geometry_and_absolute_layout_origin() {
        let host = text_input_host();
        let (input, _) = mounted_input(&host, "Hi");

        let bounds = host
            .composition_bounds(input)
            .expect("composition bounds from layout snapshot");

        assert!((bounds.x - 47.0).abs() < 0.01, "x={}", bounds.x);
        assert!((bounds.y - 7.0).abs() < 0.01, "y={}", bounds.y);
        assert!((bounds.width - 1.0).abs() < 0.01);
        assert!((bounds.height - 20.0).abs() < 0.01);
    }

    #[test]
    fn focused_paint_uses_the_text_input_clients_paragraph_caret_geometry() {
        let host = text_input_host();
        let (input, text_node) = mounted_input(&host, "Hi");
        {
            let mut inner = host.inner.lock().expect("host inner");
            inner.focused = Some(input);
        }
        let expected = host
            .composition_bounds(input)
            .expect("text input client caret bounds");

        let (caret, text_origin) = {
            let mut inner = host.inner.lock().expect("host inner");
            let caret = paint_hints_from_inner(&mut inner)
                .focused
                .expect("focused input paint")
                .caret_rect
                .expect("paragraph caret geometry");
            let text = inner.arena.get(text_node).expect("text node");
            (caret, (text.layout.x, text.layout.y))
        };

        assert!((f64::from(text_origin.0 + caret.x) - expected.x).abs() < 0.01);
        assert!((f64::from(text_origin.1 + caret.y) - expected.y).abs() < 0.01);
        assert!((f64::from(caret.width) - expected.width).abs() < 0.01);
        assert!((f64::from(caret.height) - expected.height).abs() < 0.01);
    }

    #[test]
    fn empty_input_placeholder_is_shaped_into_the_production_display_list() {
        let host = text_input_host();
        let (input, text_node) = mounted_input(&host, "");
        host.register_input(input, text_node, "Hi");

        let display_list = {
            let mut inner = host.inner.lock().expect("host inner");
            assert_eq!(inner.focused, None);
            display_list_from_inner(&mut inner, input).expect("placeholder display list")
        };

        assert!(display_list.commands().iter().any(|command| {
            matches!(
                command,
                nui_core::DisplayCommand::GlyphRun { node, run }
                    if *node == text_node
                        && run.color == ColorRgba::rgb(0x9c, 0xa3, 0xaf)
                        && !run.glyphs.is_empty()
            )
        }));
    }

    #[test]
    fn focused_paint_uses_paragraph_selection_rects_for_a_reversed_editor_selection() {
        let host = text_input_host();
        let (input, _) = mounted_input(&host, "AB");
        let selection_rects = {
            let mut inner = host.inner.lock().expect("host inner");
            inner.focused = Some(input);
            inner
                .inputs
                .get_mut(&input.raw())
                .expect("input")
                .editor
                .set_selection(nui_text::TextSelection::new(1, 0))
                .expect("reversed selection");
            paint_hints_from_inner(&mut inner)
                .focused
                .expect("focused input paint")
                .selection_rects
        };

        assert_eq!(selection_rects.len(), 1);
        assert!((selection_rects[0].x - 0.0).abs() < 0.01);
        assert!((selection_rects[0].y - 0.0).abs() < 0.01);
        assert!((selection_rects[0].width - 20.0).abs() < 0.01);
        assert!((selection_rects[0].height - 20.0).abs() < 0.01);
    }

    #[test]
    fn text_input_client_bounds_apply_ancestor_scroll_offset_to_local_caret_geometry() {
        let host = text_input_host();
        let scroll = host.create_node(NodeType::Scroll);
        let input = host.create_node(NodeType::View);
        let text = host.create_text("Hi");
        host.set_number(scroll, PropertyId::Width, 200.0);
        host.set_number(scroll, PropertyId::Height, 40.0);
        host.set_number(scroll, PropertyId::ScrollOffsetY, 10.0);
        host.set_number(input, PropertyId::Height, 80.0);
        host.set_number(input, PropertyId::Padding, 7.0);
        host.set_number(text, PropertyId::FontSize, 20.0);
        host.insert(input, scroll);
        host.insert(text, input);
        host.register_input(input, text, "placeholder");
        host.layout(200.0, 40.0);
        {
            let mut inner = host.inner.lock().expect("host inner");
            inner.focused = Some(input);
        }

        let bounds = host
            .composition_bounds(input)
            .expect("scrolled composition bounds");
        let (caret, text_layout_y) = {
            let mut inner = host.inner.lock().expect("host inner");
            let caret = paint_hints_from_inner(&mut inner)
                .focused
                .expect("focused input paint")
                .caret_rect
                .expect("paragraph caret geometry");
            let text_layout_y = inner.arena.get(text).expect("text node").layout.y;
            (caret, text_layout_y)
        };

        assert!((bounds.y - f64::from(text_layout_y - 10.0 + caret.y)).abs() < 0.01);
    }

    #[test]
    fn click_listener_registers_a_button_in_the_tab_chain() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);
        host.add_click_listener(button, 7);

        let mut inner = host.inner.lock().expect("host inner");
        let arena = inner.arena.clone();
        assert_eq!(inner.focus.focus_next(&arena, Some(root)), Some(button));
    }

    #[test]
    fn removing_the_last_immediate_click_listener_clears_interaction_and_focus() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);
        let callback = CallbackHandle::new(3, 1);
        host.add_event_listener(button, EventId::Click, callback)
            .expect("click listener");
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(button, &arena, Some(root)));
            let focused = inner.focus.focused();
            transition_focus(&mut inner, focused);
        }

        assert!(host.remove_event_listener(button, EventId::Click, callback));

        let inner = host.inner.lock().expect("host inner");
        assert!(!inner.arena.get(button).expect("button").clickable);
        assert!(!inner.interactions.contains_key(&button.raw()));
        assert_eq!(inner.focus.registration(button), None);
        assert_eq!(inner.focused, None);
    }

    #[test]
    fn queued_last_click_listener_removal_switches_focus_only_after_commit() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);
        let callback = CallbackHandle::new(4, 1);
        host.queue_add_event_listener(button, EventId::Click, callback)
            .expect("queued click listener");
        host.commit_pending().expect("add commit");
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(button, &arena, Some(root)));
            let focused = inner.focus.focused();
            transition_focus(&mut inner, focused);
        }

        assert!(host.queue_remove_event_listener(button, EventId::Click, callback));
        {
            let inner = host.inner.lock().expect("host inner");
            assert!(inner.arena.get(button).expect("button").clickable);
            assert!(inner.interactions.contains_key(&button.raw()));
            assert_eq!(inner.focused, Some(button));
        }

        host.commit_pending().expect("remove commit");

        let inner = host.inner.lock().expect("host inner");
        assert!(!inner.arena.get(button).expect("button").clickable);
        assert!(!inner.interactions.contains_key(&button.raw()));
        assert_eq!(inner.focus.registration(button), None);
        assert_eq!(inner.focused, None);
    }

    #[test]
    fn queued_disabled_before_click_listener_keeps_the_button_disabled() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);

        host.queue_set_number(button, PropertyId::Disabled, 1.0)
            .expect("queue disabled");
        host.queue_add_event_listener(button, EventId::Click, CallbackHandle::new(7, 1))
            .expect("queue click listener");
        host.commit_pending().expect("commit disabled button");

        let mut inner = host.inner.lock().expect("host inner");
        assert_eq!(
            inner
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Disabled)
        );
        assert_eq!(
            inner.focus.registration(button),
            Some(nui_core::FocusRegistration {
                tab_index: 0,
                enabled: false,
            })
        );
        let arena = inner.arena.clone();
        assert_eq!(inner.focus.focus_next(&arena, Some(root)), None);
    }

    #[test]
    fn queued_click_listener_before_disabled_updates_button_state_and_focusability() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);

        host.queue_add_event_listener(button, EventId::Click, CallbackHandle::new(7, 1))
            .expect("queue click listener");
        host.queue_set_number(button, PropertyId::Disabled, 1.0)
            .expect("queue disabled");
        host.commit_pending().expect("commit disabled button");

        let mut inner = host.inner.lock().expect("host inner");
        assert_eq!(
            inner
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Disabled)
        );
        assert_eq!(
            inner.focus.registration(button),
            Some(nui_core::FocusRegistration {
                tab_index: 0,
                enabled: false,
            })
        );
        let arena = inner.arena.clone();
        assert_eq!(inner.focus.focus_next(&arena, Some(root)), None);
    }

    #[test]
    fn queued_clear_disabled_restores_button_interaction_and_tab_focus() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);
        host.queue_add_event_listener(button, EventId::Click, CallbackHandle::new(7, 1))
            .expect("queue click listener");
        host.queue_set_number(button, PropertyId::Disabled, 1.0)
            .expect("queue disabled");
        host.commit_pending().expect("commit disabled button");

        host.queue_clear_property(button, PropertyId::Disabled)
            .expect("queue disabled clear");
        host.commit_pending().expect("commit disabled clear");

        let mut inner = host.inner.lock().expect("host inner");
        assert_eq!(
            inner
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Idle)
        );
        assert!(inner
            .interactions
            .get_mut(&button.raw())
            .is_some_and(nui_core::InteractionModel::keyboard_invoke));
        assert_eq!(
            inner.focus.registration(button),
            Some(nui_core::FocusRegistration {
                tab_index: 0,
                enabled: true,
            })
        );
        let arena = inner.arena.clone();
        assert_eq!(inner.focus.focus_next(&arena, Some(root)), Some(button));
    }

    #[test]
    fn queued_disabled_round_trip_preserves_the_committed_button_focus() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);
        host.add_click_listener(button, 7);
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert_eq!(inner.focus.focus_next(&arena, Some(root)), Some(button));
            let focused = inner.focus.focused();
            transition_focus(&mut inner, focused);
        }

        host.queue_set_number(button, PropertyId::Disabled, 1.0)
            .expect("queue disabled");
        host.queue_set_number(button, PropertyId::Disabled, 0.0)
            .expect("queue re-enabled");
        host.commit_pending().expect("commit enabled button");

        let inner = host.inner.lock().expect("host inner");
        assert!(!inner.arena.get(button).expect("button").style.disabled);
        assert_eq!(inner.focused, Some(button));
        assert_eq!(
            inner
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Focused)
        );
    }

    #[test]
    fn image_resources_reuse_generation_ids_and_shared_cpu_pixels() {
        let mut store = ImageResourceStore::default();
        let pixels = Arc::<[u32]>::from(vec![0xffff0000]);
        let (first_id, first_resource) =
            store.get_or_load("fixture.png", || (1, 1, pixels.iter().copied().collect()));
        let (second_id, second_resource) =
            store.get_or_load("fixture.png", || panic!("path hit must not invoke decoder"));

        assert_eq!(first_id, second_id);
        assert!(Arc::ptr_eq(&first_resource.pixels, &second_resource.pixels));
        assert_eq!(first_id.generation(), 1);
    }

    #[test]
    fn image_resource_clear_and_release_preserve_generation_history() {
        let mut store = ImageResourceStore::default();
        let (first_id, _) = store.get_or_load("fixture.png", || (1, 1, vec![0xffff0000]));

        store.retain_referenced(std::iter::empty());
        let (replacement_id, _) = store.get_or_load("fixture.png", || (1, 1, vec![0xff00ff00]));

        assert_eq!(replacement_id.slot(), first_id.slot());
        assert!(replacement_id.generation() > first_id.generation());
        assert!(store.resources.get(first_id).is_none());

        store.clear();
        let (after_reset_id, _) = store.get_or_load("fixture.png", || (1, 1, vec![0xff0000ff]));
        assert_ne!(after_reset_id, replacement_id);
        assert!(store.resources.get(replacement_id).is_none());
    }

    #[test]
    fn reset_replaces_the_owner_and_clears_all_session_state() {
        let host = NuiHost::new();
        let first_owner = host.owner();
        let root = host.create_node(NodeType::View);
        let text = host.create_text("draft");
        let image = host.create_node(NodeType::Image);
        host.insert(text, root);
        host.insert(image, root);
        host.register_input(root, text, "placeholder");
        host.add_click_listener(root, 11);
        host.add_change_listener(root, 12);
        host.add_submit_listener(root, 13);
        host.add_event_listener(root, EventId::Click, CallbackHandle::new(7, 3))
            .expect("listener");
        host.set_image(image, "missing-reset-fixture.png");
        host.inner.lock().expect("host inner").focused = Some(root);
        let provisional = host
            .queue_create_node(NodeType::View)
            .expect("pending node");
        let shared_clone = host.clone();

        host.reset();

        let second_owner = host.owner();
        assert_ne!(second_owner, first_owner);
        assert_eq!(host.root(), None);
        assert!(!host.has_node(root));
        assert!(!host.has_pending_batch());
        assert_eq!(host.click_token(root), None);
        assert_eq!(host.event_listener(root, EventId::Click), None);
        assert_eq!(host.image_path(image), None);
        assert_eq!(shared_clone.owner(), second_owner);
        assert_eq!(shared_clone.root(), None);
        {
            let inner = host.inner.lock().expect("host inner");
            assert!(inner.click_tokens.is_empty());
            assert!(inner.change_tokens.is_empty());
            assert!(inner.submit_tokens.is_empty());
            assert!(inner.v1_listeners.is_empty());
            assert!(inner.inputs.is_empty());
            assert!(inner.images.is_empty());
            assert_eq!(inner.focused, None);
        }

        let mut replacements = Vec::new();
        for _ in 0..=provisional.slot() {
            replacements.push(host.create_node(NodeType::View));
        }
        let root_replacement = replacements
            .iter()
            .find(|node| node.slot() == root.slot())
            .expect("root slot reused");
        let provisional_replacement = replacements
            .iter()
            .find(|node| node.slot() == provisional.slot())
            .expect("provisional slot reused");
        assert_ne!(root_replacement.generation(), root.generation());
        assert_ne!(
            provisional_replacement.generation(),
            provisional.generation()
        );
        assert!(!host.has_node(NodeId::from_raw(root.raw())));
        assert!(!host.has_node(NodeId::from_raw(provisional.raw())));

        host.queue_create_node(NodeType::View)
            .expect("first reset batch");
        let receipt = host
            .commit_pending()
            .expect("first reset commit")
            .expect("reset batch receipt");
        assert_eq!(receipt.sequence, 1);
    }

    #[test]
    fn abort_does_not_reuse_a_provisional_node_generation() {
        let host = NuiHost::new();
        let provisional = host.queue_create_node(NodeType::View).expect("provisional");

        host.abort_pending();

        let replacement = host.queue_create_node(NodeType::View).expect("replacement");
        assert_eq!(replacement.slot(), provisional.slot());
        assert_ne!(replacement.generation(), provisional.generation());
        assert!(!host.has_node(NodeId::from_raw(provisional.raw())));
    }

    #[test]
    fn queued_semantics_set_and_clear_are_visible_only_after_commit() {
        let host = NuiHost::new();
        let node = host.create_node(NodeType::View);
        let semantics = Semantics::button("Save");

        host.queue_set_semantics(node, semantics.clone())
            .expect("queue semantics");
        {
            let inner = host.inner.lock().expect("host inner");
            assert_eq!(inner.arena.get(node).expect("active node").semantics, None);
            assert_eq!(
                inner
                    .pending
                    .as_ref()
                    .expect("pending batch")
                    .preview
                    .get(node)
                    .expect("preview node")
                    .semantics,
                Some(semantics.clone())
            );
        }

        let set_receipt = host
            .commit_pending()
            .expect("set commit")
            .expect("set receipt");
        assert_eq!(set_receipt.dirty.bits(), DirtyFlags::SEMANTICS.bits());
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get(node)
                .expect("active node")
                .semantics,
            Some(semantics.clone())
        );

        host.queue_clear_semantics(node).expect("queue clear");
        {
            let inner = host.inner.lock().expect("host inner");
            assert_eq!(
                inner.arena.get(node).expect("active node").semantics,
                Some(semantics)
            );
            assert_eq!(
                inner
                    .pending
                    .as_ref()
                    .expect("pending batch")
                    .preview
                    .get(node)
                    .expect("preview node")
                    .semantics,
                None
            );
        }

        let clear_receipt = host
            .commit_pending()
            .expect("clear commit")
            .expect("clear receipt");
        assert_eq!(clear_receipt.dirty.bits(), DirtyFlags::SEMANTICS.bits());
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get(node)
                .expect("active node")
                .semantics,
            None
        );
    }

    #[test]
    fn stale_semantics_command_rejects_the_entire_pending_batch() {
        let host = NuiHost::new();
        let node = host.create_node(NodeType::View);
        let stale = host.create_node(NodeType::View);
        host.remove(stale);

        host.queue_set_semantics(node, Semantics::button("Save"))
            .expect("queue valid semantics");
        assert_eq!(
            host.queue_clear_semantics(stale),
            Err(MutationError::StaleNode(stale))
        );
        assert_eq!(host.commit_pending(), Err(MutationError::StaleNode(stale)));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get(node)
                .expect("active node")
                .semantics,
            None
        );
    }

    #[test]
    fn semantic_snapshot_and_diff_only_observe_committed_arena_state() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let child = host.create_node(NodeType::Text);
        host.insert(child, root);
        {
            let mut inner = host.inner.lock().expect("host inner");
            inner.arena.get_mut(root).expect("root").layout = nui_core::LayoutRect {
                width: 100.0,
                height: 40.0,
                ..nui_core::LayoutRect::default()
            };
            inner.arena.get_mut(child).expect("child").layout = nui_core::LayoutRect {
                width: 50.0,
                height: 20.0,
                ..nui_core::LayoutRect::default()
            };
        }

        let empty = host.semantic_snapshot();
        host.queue_set_semantics(child, Semantics::text("Draft"))
            .expect("queue semantics");
        assert!(host.semantic_snapshot().nodes.is_empty());

        host.commit_pending()
            .expect("commit semantics")
            .expect("receipt");
        let committed = host.semantic_snapshot();
        assert_eq!(committed.nodes.len(), 1);
        assert_eq!(committed.nodes[0].name.as_deref(), Some("Draft"));
        assert_eq!(empty.diff(&committed).added.len(), 1);

        host.queue_set_semantics(child, Semantics::text("Saved"))
            .expect("queue update");
        assert_eq!(
            host.semantic_snapshot().nodes[0].name.as_deref(),
            Some("Draft")
        );
        host.commit_pending()
            .expect("commit update")
            .expect("receipt");
        let updated = host.semantic_diff(&committed);
        assert_eq!(updated.added.len(), 0);
        assert_eq!(updated.removed.len(), 0);
        assert_eq!(updated.updated.len(), 1);
        assert_eq!(updated.updated[0].name.as_deref(), Some("Saved"));
    }

    #[test]
    fn semantic_snapshot_derives_button_text_and_input_defaults_with_live_state() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let text = host.create_text("Welcome");
        let button = host.create_node(NodeType::View);
        let button_text = host.create_text("Save");
        let input = host.create_node(NodeType::View);
        let input_text = host.create_text("draft");
        host.insert(text, root);
        host.insert(button, root);
        host.insert(button_text, button);
        host.insert(input, root);
        host.insert(input_text, input);
        host.add_click_listener(button, 1);
        host.register_input(input, input_text, "Title");
        for node in [root, text, button, button_text, input, input_text] {
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get_mut(node)
                .expect("node")
                .layout = nui_core::LayoutRect {
                width: 100.0,
                height: 24.0,
                ..nui_core::LayoutRect::default()
            };
        }
        host.queue_register_button(button)
            .expect("register button semantics");
        host.commit_pending()
            .expect("button registration commit")
            .expect("button registration receipt");

        let mut inner = host.inner.lock().expect("host inner");
        let arena = inner.arena.clone();
        let root_id = inner.root;
        assert!(inner.focus.request_focus(button, &arena, root_id));
        let focused = inner.focus.focused();
        transition_focus(&mut inner, focused);
        drop(inner);

        let snapshot = host.semantic_snapshot();
        assert_eq!(snapshot.len(), 3);
        let welcome = snapshot.node(text).expect("text semantics");
        assert_eq!(welcome.role, nui_core::SemanticRole::Text);
        assert_eq!(welcome.name.as_deref(), Some("Welcome"));

        let button_node = snapshot.node(button).expect("button semantics");
        assert_eq!(button_node.role, nui_core::SemanticRole::Button);
        assert_eq!(button_node.name.as_deref(), Some("Save"));
        assert_eq!(button_node.actions, [nui_core::SemanticAction::Invoke]);
        assert!(button_node.state.focused);

        let input_node = snapshot.node(input).expect("input semantics");
        assert_eq!(input_node.role, nui_core::SemanticRole::TextInput);
        assert_eq!(input_node.name.as_deref(), Some("Title"));
        assert_eq!(input_node.value.as_deref(), Some("draft"));
        assert_eq!(
            input_node.actions,
            [
                nui_core::SemanticAction::Focus,
                nui_core::SemanticAction::SetValue
            ]
        );

        host.set_number(button, PropertyId::Disabled, 1.0);
        host.set_text(button_text, "Save changes");
        host.set_text(input_text, "updated");
        let mut inner = host.inner.lock().expect("host inner");
        let arena = inner.arena.clone();
        let root = inner.root;
        assert!(inner.focus.request_focus(input, &arena, root));
        let focused = inner.focus.focused();
        transition_focus(&mut inner, focused);
        drop(inner);

        let next = host.semantic_snapshot();
        assert!(next.node(button).expect("button").state.disabled);
        assert_eq!(
            next.node(button).expect("button").name.as_deref(),
            Some("Save changes")
        );
        assert!(next.node(input).expect("input").state.focused);
        assert_eq!(
            next.node(input).expect("input").value.as_deref(),
            Some("updated")
        );

        host.set_number(input, PropertyId::Disabled, 1.0);
        let disabled = host.semantic_snapshot();
        assert!(disabled.node(input).expect("input").state.disabled);
        assert!(!disabled.node(input).expect("input").state.focused);
    }

    #[test]
    fn semantic_snapshot_derives_text_area_from_the_shared_editor_registry() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let text_area = host.create_node(NodeType::Scroll);
        let text = host.create_text("First line\n第二行");
        host.insert(text_area, root);
        host.insert(text, text_area);
        host.register_input(text_area, text, "Body");
        for node in [root, text_area, text] {
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get_mut(node)
                .expect("node")
                .layout = nui_core::LayoutRect {
                width: 180.0,
                height: 80.0,
                ..nui_core::LayoutRect::default()
            };
        }

        let snapshot = host.semantic_snapshot();
        let editor = snapshot.node(text_area).expect("text area semantics");
        assert_eq!(editor.role, nui_core::SemanticRole::TextInput);
        assert_eq!(editor.name.as_deref(), Some("Body"));
        assert_eq!(editor.value.as_deref(), Some("First line\n第二行"));
        assert_eq!(
            editor.actions,
            [
                nui_core::SemanticAction::Focus,
                nui_core::SemanticAction::SetValue
            ]
        );
        assert!(snapshot.node(text).is_none());
    }

    #[test]
    fn semantic_snapshot_derives_image_and_scroll_roles_without_overriding_text_area() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let image = host.create_node(NodeType::Image);
        let scroll = host.create_node(NodeType::Scroll);
        host.insert(image, root);
        host.insert(scroll, root);
        for node in [root, image, scroll] {
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get_mut(node)
                .expect("node")
                .layout = nui_core::LayoutRect {
                width: 180.0,
                height: 80.0,
                ..nui_core::LayoutRect::default()
            };
        }

        let snapshot = host.semantic_snapshot();
        let image_node = snapshot.node(image).expect("image semantics");
        assert_eq!(image_node.role, nui_core::SemanticRole::Image);
        assert_eq!(image_node.name, None);
        assert!(image_node.actions.is_empty());

        let scroll_node = snapshot.node(scroll).expect("scroll semantics");
        assert_eq!(scroll_node.role, nui_core::SemanticRole::Scroll);
        assert_eq!(scroll_node.name, None);
        assert!(scroll_node.actions.is_empty());
    }

    #[test]
    fn registered_button_without_listener_restores_defaults_after_explicit_clear() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        let label = host.create_text("Save");
        host.insert(button, root);
        host.insert(label, button);
        for node in [root, button, label] {
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get_mut(node)
                .expect("node")
                .layout = nui_core::LayoutRect {
                width: 100.0,
                height: 24.0,
                ..nui_core::LayoutRect::default()
            };
        }

        host.queue_register_button(button).expect("register button");
        let pending = host.semantic_snapshot();
        assert!(pending.node(button).is_none());
        assert_eq!(
            pending.node(label).expect("text before commit").role,
            nui_core::SemanticRole::Text
        );
        host.commit_pending()
            .expect("button commit")
            .expect("button receipt");

        let defaults = host.semantic_snapshot();
        let default_button = defaults.node(button).expect("default button semantics");
        assert_eq!(default_button.role, nui_core::SemanticRole::Button);
        assert_eq!(default_button.name.as_deref(), Some("Save"));
        assert_eq!(default_button.actions, [nui_core::SemanticAction::Invoke]);
        assert!(defaults.node(label).is_none());

        host.queue_set_semantics(
            button,
            Semantics {
                role: nui_core::SemanticRole::Header,
                label: Some("Explicit save heading".to_owned()),
                ..Semantics::default()
            },
        )
        .expect("queue explicit semantics");
        assert_eq!(
            host.semantic_snapshot().node(button).unwrap().role,
            nui_core::SemanticRole::Button
        );
        host.commit_pending()
            .expect("explicit commit")
            .expect("explicit receipt");
        assert_eq!(
            host.semantic_snapshot().node(button).unwrap().role,
            nui_core::SemanticRole::Header
        );

        host.queue_clear_semantics(button).expect("queue clear");
        assert_eq!(
            host.semantic_snapshot().node(button).unwrap().role,
            nui_core::SemanticRole::Header
        );
        host.commit_pending()
            .expect("clear commit")
            .expect("clear receipt");
        let restored = host.semantic_snapshot();
        assert_eq!(
            restored.node(button).expect("restored button").role,
            nui_core::SemanticRole::Button
        );
        assert!(restored.node(label).is_none());
    }

    #[test]
    fn clickable_view_does_not_inherit_button_semantics() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let clickable = host.create_node(NodeType::View);
        let text = host.create_text("Custom click target");
        host.insert(clickable, root);
        host.insert(text, clickable);
        host.add_click_listener(clickable, 1);
        for node in [root, clickable, text] {
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get_mut(node)
                .expect("node")
                .layout = nui_core::LayoutRect {
                width: 100.0,
                height: 24.0,
                ..nui_core::LayoutRect::default()
            };
        }

        let snapshot = host.semantic_snapshot();
        assert!(snapshot.node(clickable).is_none());
        assert_eq!(
            snapshot.node(text).expect("text semantics").role,
            nui_core::SemanticRole::Text
        );
    }

    #[test]
    fn registered_button_uses_fallback_label_after_click_listener_removal() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);
        for node in [root, button] {
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get_mut(node)
                .expect("node")
                .layout = nui_core::LayoutRect {
                width: 100.0,
                height: 24.0,
                ..nui_core::LayoutRect::default()
            };
        }
        let callback = CallbackHandle::new(7, 1);
        host.queue_register_button(button).expect("register button");
        host.queue_add_event_listener(button, EventId::Click, callback)
            .expect("add click listener");
        host.commit_pending()
            .expect("registration commit")
            .expect("registration receipt");

        assert_eq!(
            host.semantic_snapshot()
                .node(button)
                .expect("button semantics")
                .name
                .as_deref(),
            Some("Button")
        );
        assert!(host.queue_remove_event_listener(button, EventId::Click, callback));
        host.commit_pending()
            .expect("listener removal commit")
            .expect("listener removal receipt");

        let snapshot = host.semantic_snapshot();
        assert_eq!(
            snapshot.node(button).expect("button semantics").role,
            nui_core::SemanticRole::Button
        );
        assert_eq!(
            snapshot
                .node(button)
                .expect("button semantics")
                .name
                .as_deref(),
            Some("Button")
        );
        assert!(
            !host
                .inner
                .lock()
                .expect("host inner")
                .arena
                .get(button)
                .expect("button")
                .clickable
        );
    }

    #[test]
    fn stale_button_registration_rejects_the_entire_pending_batch() {
        let host = NuiHost::new();
        let valid = host.create_node(NodeType::View);
        let stale = host.create_node(NodeType::View);
        host.remove(stale);

        host.queue_register_button(valid)
            .expect("queue valid button registration");
        assert_eq!(
            host.queue_register_button(stale),
            Err(MutationError::StaleNode(stale))
        );
        assert_eq!(host.commit_pending(), Err(MutationError::StaleNode(stale)));
        assert!(
            !host
                .inner
                .lock()
                .expect("host inner")
                .arena
                .get(valid)
                .expect("valid node")
                .is_button
        );
    }

    #[test]
    fn commit_activity_counts_actual_receipts_and_failed_attempts_once() {
        let host = NuiHost::new();
        assert_eq!(host.commit_pending(), Ok(None));
        assert_eq!(host.take_commit_activity(), CommitActivity::default());

        host.queue_create_node(NodeType::View).expect("queued node");
        let receipt = host
            .commit_pending()
            .expect("successful commit")
            .expect("commit receipt");
        assert_eq!(
            host.take_commit_activity(),
            CommitActivity {
                attempts: 1,
                commits: 1,
                mutation_commands: u64::from(receipt.command_count),
            }
        );
        assert_eq!(host.take_commit_activity(), CommitActivity::default());

        host.queue_create_node(NodeType::View)
            .expect("failed batch");
        host.inner
            .lock()
            .expect("host inner")
            .pending
            .as_mut()
            .expect("pending batch")
            .failure = Some(MutationError::PlanInvalidated);
        assert_eq!(host.commit_pending(), Err(MutationError::PlanInvalidated));
        assert_eq!(
            host.take_commit_activity(),
            CommitActivity {
                attempts: 1,
                commits: 0,
                mutation_commands: 0,
            }
        );
    }

    #[test]
    fn window_session_baseline_excludes_pre_run_mount_commits() {
        let host = NuiHost::new();
        let root = host.queue_create_node(NodeType::View).expect("mount root");
        host.queue_set_number(root, PropertyId::Width, 16.0)
            .expect("mount width");
        host.commit_pending().expect("mount commit");
        assert_ne!(
            host.inner.lock().expect("host inner").commit_activity,
            CommitActivity::default()
        );

        let (prepared_root, session_id) = host.prepare_window_session().expect("window session");

        assert_eq!(prepared_root, root);
        assert_eq!(session_id, host.owner());
        assert_eq!(
            host.inner.lock().expect("host inner").commit_activity,
            CommitActivity::default()
        );
    }

    #[test]
    fn error_diagnostics_are_shared_by_clones_and_survive_window_reset() {
        let host = NuiHost::new();
        let clone = host.clone();
        host.error_supervisor()
            .report(crate::frame_nexa_error("paint", "display list failed"));

        host.reset();

        let history = clone.error_supervisor().history();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].severity, ErrorSeverity::FrameFailure);
        assert_eq!(history[0].operation, "paint");
    }

    #[test]
    fn injected_paragraph_metrics_drive_layout_and_fonts_survive_reset() {
        let mut database = FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Ahem Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("Hi ".chars()),
            )
            .unwrap()
            .with_scripts([Script::Latin])
            .with_source(FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0).unwrap()),
        );
        let revision = database.revision();
        let host = NuiHost::with_fonts(database, FontRequest::new(["Ahem Fixture"]))
            .expect("valid font configuration");

        let root = host.create_node(NodeType::View);
        let text = host.create_text("Hi");
        host.set_number(text, PropertyId::FontSize, 20.0);
        host.insert(text, root);
        host.layout(200.0, 100.0);
        let mut pixels = vec![0_u32; 200 * 100];
        host.paint(&mut pixels, 200, 100, 1.0)
            .expect("source-backed glyph paint");
        assert!(pixels.iter().any(|&pixel| pixel != 0xfff4f6f8));

        {
            let inner = host.inner.lock().expect("host inner");
            let layout = inner.arena.get(text).unwrap().layout;
            assert!((layout.width - 40.0).abs() < 0.01);
            assert!((layout.height - 20.0).abs() < 0.01);
            assert_eq!(inner.text_cache.database().len(), 1);
            assert_eq!(inner.text_cache.database().revision(), revision);
            assert!(!inner.text_cache.is_empty());
        }
        assert!(host.error_supervisor().history().is_empty());

        host.reset();
        {
            let inner = host.inner.lock().expect("host inner");
            assert_eq!(inner.text_cache.database().len(), 1);
            assert_eq!(inner.text_cache.database().revision(), revision);
            assert!(inner.text_cache.is_empty());
        }

        let root = host.create_node(NodeType::View);
        let text = host.create_text("Hi");
        host.set_number(text, PropertyId::FontSize, 20.0);
        host.insert(text, root);
        host.layout(200.0, 100.0);

        let inner = host.inner.lock().expect("host inner");
        let layout = inner.arena.get(text).unwrap().layout;
        assert!((layout.width - 40.0).abs() < 0.01);
        assert!((layout.height - 20.0).abs() < 0.01);
    }

    #[test]
    fn layout_failure_is_reported_after_the_host_lock_is_released() {
        let host = NuiHost::new();
        let _root = host.create_node(NodeType::View);
        let shared = Arc::clone(&host.inner);
        let sink_observed_unlocked_host = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&sink_observed_unlocked_host);
        host.error_supervisor().set_sink(Some(Arc::new(move |_| {
            observed.store(shared.try_lock().is_ok(), Ordering::SeqCst);
        })));

        host.layout(-1.0, 100.0);

        assert!(sink_observed_unlocked_host.load(Ordering::SeqCst));
        let supervisor = host.error_supervisor();
        let history = supervisor.history();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].severity, ErrorSeverity::FrameFailure);
        assert_eq!(history[0].operation, "layout");
        assert_eq!(history[0].name, "PLATFORM_FAILURE");
        assert!(history[0].retryable);
        assert!(history[0].message.contains("viewport"));
        assert_eq!(supervisor.counts().frame_failures, 1);
    }

    #[test]
    fn font_configuration_rejects_empty_or_source_less_defaults() {
        assert_eq!(
            NuiHost::with_fonts(FontDatabase::new(), FontRequest::default()).unwrap_err(),
            HostFontConfigError::EmptyDatabase
        );

        let mut database = FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Metadata Only",
                FontStyle::default(),
                GlyphCoverage::from_chars("A".chars()),
            )
            .unwrap(),
        );
        assert!(matches!(
            NuiHost::with_fonts(database, FontRequest::new(["Metadata Only"])),
            Err(HostFontConfigError::MissingDefaultFontSource { .. })
        ));
    }

    #[test]
    fn run_without_a_root_returns_and_reports_a_structured_operation_error() {
        let host = NuiHost::new();
        let shared = Arc::clone(&host.inner);
        let sink_observed_unlocked_host = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&sink_observed_unlocked_host);
        host.error_supervisor().set_sink(Some(Arc::new(move |_| {
            observed.store(shared.try_lock().is_ok(), Ordering::SeqCst);
        })));

        let error = host
            .run_with_lifecycle_v1("test", |_| false, || false, || {})
            .expect_err("run must reject a missing root");

        assert_eq!(
            error.severity,
            nui_core::protocol::common::ErrorSeverity::RecoverableOperation
        );
        assert_eq!(error.name, "INVALID_STATE");
        assert_eq!(error.operation, "run");
        assert_eq!(host.error_supervisor().history(), [error]);
        assert!(sink_observed_unlocked_host.load(Ordering::SeqCst));
    }
}

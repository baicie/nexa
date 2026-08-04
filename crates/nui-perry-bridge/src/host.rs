//! Shared Host session state (tree + click / input tokens).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use nui_core::{
    hit_test, Align, Arena, ColorRgba, FlexDirection, NodeId, NodeType, PropertyId, Style,
    TreeMutationError,
};
use nui_layout_taffy::layout_tree;
use nui_render_skia::{decode_image_file, paint_tree, FocusedPaint, ImagePaint, PaintHints};

use crate::window::HostWindowApp;

/// UI events delivered while the native window loop runs.
#[derive(Debug, Clone)]
pub enum HostUiEvent {
    Click(NodeId),
    Change { node: NodeId, value: String },
    Submit { node: NodeId, value: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPropertyError {
    StaleNode(NodeId),
    InvalidProperty(PropertyId),
}

#[derive(Debug, Clone)]
pub(crate) struct InputField {
    pub(crate) text_node: NodeId,
    pub(crate) placeholder: String,
    pub(crate) caret: usize,
}

/// Decoded local image attached to an Image node.
#[derive(Debug, Clone)]
pub(crate) struct ImageAsset {
    pub(crate) path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixels: Vec<u32>,
}

#[derive(Debug, Default)]
pub(crate) struct HostInner {
    pub(crate) arena: Arena,
    /// First created root-ish view; used as layout root when present.
    pub(crate) root: Option<NodeId>,
    /// node.raw() → opaque callback token (Perry closure ptr as u64).
    pub(crate) click_tokens: HashMap<u64, u64>,
    pub(crate) change_tokens: HashMap<u64, u64>,
    pub(crate) submit_tokens: HashMap<u64, u64>,
    /// Focusable input containers (View) → text child + caret.
    pub(crate) inputs: HashMap<u64, InputField>,
    pub(crate) focused: Option<NodeId>,
    /// Image node.raw() → decoded bitmap (may be empty on load failure).
    pub(crate) images: HashMap<u64, ImageAsset>,
}

/// Opaque Host session driving the Slice 1 node tree from HostOps.
#[derive(Clone, Debug, Default)]
pub struct NuiHost {
    pub(crate) inner: Arc<Mutex<HostInner>>,
}

impl NuiHost {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
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
        id
    }

    #[must_use]
    pub fn create_text(&self, text: &str) -> NodeId {
        let mut inner = self.inner.lock().expect("host inner");
        let id = inner.arena.create(NodeType::Text);
        inner.arena.set_text(id, text);
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
        Ok(())
    }

    pub fn detach(&self, parent: NodeId, child: NodeId) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.detach_child(parent, child);
    }

    pub fn remove(&self, node: NodeId) {
        let mut inner = self.inner.lock().expect("host inner");
        let mut stack = vec![node];
        while let Some(id) = stack.pop() {
            if let Some(n) = inner.arena.get(id) {
                stack.extend(n.children.iter().copied());
            }
            let raw = id.raw();
            inner.click_tokens.remove(&raw);
            inner.change_tokens.remove(&raw);
            inner.submit_tokens.remove(&raw);
            inner.inputs.remove(&raw);
            inner.images.remove(&raw);
            if inner.focused == Some(id) {
                inner.focused = None;
            }
        }
        if inner.root == Some(node) {
            inner.root = None;
        }
        inner.arena.remove(node);
    }

    pub fn set_text(&self, node: NodeId, text: &str) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_text(node, text);
        // Keep caret at end when JS drives a controlled value.
        for field in inner.inputs.values_mut() {
            if field.text_node == node {
                field.caret = text.chars().count();
            }
        }
    }

    pub fn set_number(&self, node: NodeId, property: PropertyId, value: f64) {
        let mut inner = self.inner.lock().expect("host inner");
        let Some(n) = inner.arena.get_mut(node) else {
            return;
        };
        let v = value as f32;
        match property {
            PropertyId::Width => n.style.width = Some(v),
            PropertyId::Height => n.style.height = Some(v),
            PropertyId::MinWidth => n.style.min_width = Some(v.max(0.0)),
            PropertyId::MinHeight => n.style.min_height = Some(v.max(0.0)),
            PropertyId::Padding => n.style.padding = v,
            PropertyId::Gap => n.style.gap = v,
            PropertyId::FlexDirection => {
                n.style.flex_direction = if value >= 0.5 {
                    FlexDirection::Row
                } else {
                    FlexDirection::Column
                };
            }
            PropertyId::AlignItems => n.style.align_items = Align::from_f64(value),
            PropertyId::JustifyContent => n.style.justify_content = Align::from_f64(value),
            PropertyId::FlexGrow => n.style.flex_grow = v.max(0.0),
            PropertyId::BorderRadius => n.style.border_radius = v,
            PropertyId::Opacity => n.style.opacity = v.clamp(0.0, 1.0),
            PropertyId::FontSize => n.style.font_size = v,
            PropertyId::FontWeight => {
                n.style.font_weight = value.max(0.0).min(u32::MAX as f64) as u32
            }
            PropertyId::BackgroundColor => {
                n.style.background = Some(color_from_u32(value as u32));
            }
            PropertyId::TextColor => {
                n.style.color = color_from_u32(value as u32);
            }
            PropertyId::ScrollOffsetY => {
                n.style.scroll_offset_y = v.max(0.0);
            }
        }
    }

    /// Clear a property and restore its protocol-declared default/unset value.
    pub fn clear_property(
        &self,
        node: NodeId,
        property: PropertyId,
    ) -> Result<(), HostPropertyError> {
        let mut inner = self.inner.lock().expect("host inner");
        let Some(n) = inner.arena.get_mut(node) else {
            return Err(HostPropertyError::StaleNode(node));
        };
        let defaults = Style::default();
        match property {
            PropertyId::Width => n.style.width = defaults.width,
            PropertyId::Height => n.style.height = defaults.height,
            PropertyId::MinWidth => n.style.min_width = defaults.min_width,
            PropertyId::MinHeight => n.style.min_height = defaults.min_height,
            PropertyId::Padding => n.style.padding = defaults.padding,
            PropertyId::Gap => n.style.gap = defaults.gap,
            PropertyId::FlexDirection => n.style.flex_direction = defaults.flex_direction,
            PropertyId::AlignItems => n.style.align_items = defaults.align_items,
            PropertyId::JustifyContent => n.style.justify_content = defaults.justify_content,
            PropertyId::BackgroundColor => n.style.background = defaults.background,
            PropertyId::BorderRadius => n.style.border_radius = defaults.border_radius,
            PropertyId::Opacity => n.style.opacity = defaults.opacity,
            PropertyId::FontSize => n.style.font_size = defaults.font_size,
            PropertyId::FontWeight => n.style.font_weight = defaults.font_weight,
            PropertyId::TextColor => n.style.color = defaults.color,
            PropertyId::ScrollOffsetY => n.style.scroll_offset_y = defaults.scroll_offset_y,
            PropertyId::FlexGrow => n.style.flex_grow = defaults.flex_grow,
        }
        Ok(())
    }

    pub fn add_click_listener(&self, node: NodeId, token: u64) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_clickable(node, true);
        inner.click_tokens.insert(node.raw(), token);
    }

    /// Register a composite Input: `container` (View) + `text_node` (Text child).
    pub fn register_input(&self, container: NodeId, text_node: NodeId, placeholder: &str) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_clickable(container, true);
        let caret = inner
            .arena
            .get(text_node)
            .and_then(|n| n.text.as_ref())
            .map(|t| t.chars().count())
            .unwrap_or(0);
        inner.inputs.insert(
            container.raw(),
            InputField {
                text_node,
                placeholder: placeholder.to_owned(),
                caret,
            },
        );
    }

    pub fn add_change_listener(&self, node: NodeId, token: u64) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_clickable(node, true);
        inner.change_tokens.insert(node.raw(), token);
    }

    pub fn add_submit_listener(&self, node: NodeId, token: u64) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_clickable(node, true);
        inner.submit_tokens.insert(node.raw(), token);
    }

    /// Load a local image file onto an Image node.
    ///
    /// On failure stores an empty asset and applies a 64×64 placeholder size when
    /// the node has no explicit width/height.
    pub fn set_image(&self, node: NodeId, path: &str) {
        let decoded = decode_image_file(path);
        let mut inner = self.inner.lock().expect("host inner");
        let (width, height, pixels) = match decoded {
            Some((w, h, px)) => (w, h, px),
            None => (64, 64, Vec::new()),
        };
        if let Some(n) = inner.arena.get_mut(node) {
            if n.style.width.is_none() {
                n.style.width = Some(width as f32);
            }
            if n.style.height.is_none() {
                n.style.height = Some(height as f32);
            }
        }
        inner.images.insert(
            node.raw(),
            ImageAsset {
                path: path.to_owned(),
                width,
                height,
                pixels,
            },
        );
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
        if let Some(node) = inner.arena.get_mut(root) {
            if node.style.width.is_none() {
                node.style.width = Some(logical_w);
            }
            if node.style.height.is_none() {
                node.style.height = Some(logical_h);
            }
            if node.style.background.is_none() {
                node.style.background = Some(ColorRgba::rgb(0xF4, 0xF6, 0xF8));
            }
        }
    }

    pub fn layout(&self, logical_w: f32, logical_h: f32) {
        let mut inner = self.inner.lock().expect("host inner");
        let Some(root) = inner.root else {
            return;
        };
        if let Some(node) = inner.arena.get_mut(root) {
            if node.style.width.is_none() {
                node.style.width = Some(logical_w);
            }
            if node.style.height.is_none() {
                node.style.height = Some(logical_h);
            }
            if node.style.background.is_none() {
                node.style.background = Some(ColorRgba::rgb(0xF4, 0xF6, 0xF8));
            }
        }
        layout_tree(&mut inner.arena, root, logical_w, logical_h);
    }

    pub fn paint(
        &self,
        pixels: &mut [u32],
        width: u32,
        height: u32,
        scale: f64,
    ) -> Result<(), String> {
        let inner = self.inner.lock().expect("host inner");
        let root = inner.root.ok_or("nui host has no root node")?;
        let hints = paint_hints_from_inner(&inner);
        paint_tree(
            &inner.arena,
            root,
            pixels,
            width,
            height,
            scale,
            Some(&hints),
        )
        .map_err(|e| e.to_string())
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
        let root = self
            .inner
            .lock()
            .expect("host inner")
            .root
            .ok_or("nui host has no root node — create/insert first")?;
        let app = HostWindowApp {
            shared: Arc::clone(&self.inner),
            root,
            on_event: Box::new(on_event),
            viewport: (640.0, 420.0),
        };
        nui_platform_winit::run_app(title, app).map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub(crate) fn paint_hints_from_inner(inner: &HostInner) -> PaintHints {
    let focused = inner.focused.and_then(|focused| {
        let field = inner.inputs.get(&focused.raw())?;
        Some(FocusedPaint {
            text_node: field.text_node,
            caret: field.caret,
            placeholder: field.placeholder.clone(),
        })
    });
    let images = inner
        .images
        .iter()
        .map(|(&raw, asset)| ImagePaint {
            node: NodeId::from_raw(raw),
            width: asset.width,
            height: asset.height,
            pixels: asset.pixels.clone(),
        })
        .collect();
    PaintHints { focused, images }
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

pub(crate) fn insert_text_at_caret(inner: &mut HostInner, text: &str) -> Option<(NodeId, String)> {
    let focused = inner.focused?;
    let field = inner.inputs.get_mut(&focused.raw())?;
    let current = inner
        .arena
        .get(field.text_node)
        .and_then(|n| n.text.clone())
        .unwrap_or_default();
    let mut chars: Vec<char> = current.chars().collect();
    let caret = field.caret.min(chars.len());
    for (i, ch) in text.chars().enumerate() {
        chars.insert(caret + i, ch);
    }
    field.caret = caret + text.chars().count();
    let next: String = chars.into_iter().collect();
    inner.arena.set_text(field.text_node, next.clone());
    Some((focused, next))
}

pub(crate) fn backspace_at_caret(inner: &mut HostInner) -> Option<(NodeId, String)> {
    let focused = inner.focused?;
    let field = inner.inputs.get_mut(&focused.raw())?;
    if field.caret == 0 {
        return None;
    }
    let current = inner
        .arena
        .get(field.text_node)
        .and_then(|n| n.text.clone())
        .unwrap_or_default();
    let mut chars: Vec<char> = current.chars().collect();
    let idx = field.caret - 1;
    if idx >= chars.len() {
        return None;
    }
    chars.remove(idx);
    field.caret = idx;
    let next: String = chars.into_iter().collect();
    inner.arena.set_text(field.text_node, next.clone());
    Some((focused, next))
}

pub(crate) fn color_from_u32(rgba: u32) -> ColorRgba {
    ColorRgba {
        r: ((rgba >> 24) & 0xff) as u8,
        g: ((rgba >> 16) & 0xff) as u8,
        b: ((rgba >> 8) & 0xff) as u8,
        a: (rgba & 0xff) as u8,
    }
}

/// Pack RGBA into the u32 form accepted by [`NuiHost::set_number`] for colors.
#[must_use]
pub fn pack_rgba(r: u8, g: u8, b: u8, a: u8) -> u32 {
    ((r as u32) << 24) | ((g as u32) << 16) | ((b as u32) << 8) | (a as u32)
}

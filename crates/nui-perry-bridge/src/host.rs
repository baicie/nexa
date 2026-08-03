//! Shared Host session state (tree + click tokens).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use nui_core::{
    hit_test, Arena, ColorRgba, FlexDirection, NodeId, NodeType, PropertyId,
};
use nui_layout_taffy::layout_tree;
use nui_render_skia::paint_tree;

use crate::window::HostWindowApp;

#[derive(Debug, Default)]
pub(crate) struct HostInner {
    pub(crate) arena: Arena,
    /// First created root-ish view; used as layout root when present.
    pub(crate) root: Option<NodeId>,
    /// node.raw() → opaque callback token (Perry closure ptr as u64).
    pub(crate) click_tokens: HashMap<u64, u64>,
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
        if inner.root.is_none()
            && matches!(node_type, NodeType::Root | NodeType::View | NodeType::Scroll)
        {
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
        self.insert_before(child, parent, None);
    }

    pub fn insert_before(&self, child: NodeId, parent: NodeId, before: Option<NodeId>) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.insert_child_before(parent, child, before);
        if inner.root.is_none() {
            inner.root = Some(parent);
        }
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
            inner.click_tokens.remove(&id.raw());
        }
        if inner.root == Some(node) {
            inner.root = None;
        }
        inner.arena.remove(node);
    }

    pub fn set_text(&self, node: NodeId, text: &str) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_text(node, text);
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
            PropertyId::Padding => n.style.padding = v,
            PropertyId::Gap => n.style.gap = v,
            PropertyId::FlexDirection => {
                n.style.flex_direction = if value >= 0.5 {
                    FlexDirection::Row
                } else {
                    FlexDirection::Column
                };
            }
            PropertyId::BorderRadius => n.style.border_radius = v,
            PropertyId::FontSize => n.style.font_size = v,
            PropertyId::BackgroundColor => {
                n.style.background = Some(color_from_u32(value as u32));
            }
            PropertyId::TextColor => {
                n.style.color = color_from_u32(value as u32);
            }
            PropertyId::ScrollOffsetY => {
                n.style.scroll_offset_y = v.max(0.0);
            }
            _ => {}
        }
    }

    pub fn add_click_listener(&self, node: NodeId, token: u64) {
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.set_clickable(node, true);
        inner.click_tokens.insert(node.raw(), token);
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
        paint_tree(&inner.arena, root, pixels, width, height, scale).map_err(|e| e.to_string())
    }

    #[must_use]
    pub fn hit_clickable(&self, logical_x: f32, logical_y: f32) -> Option<NodeId> {
        let inner = self.inner.lock().expect("host inner");
        let root = inner.root?;
        hit_test(&inner.arena, root, logical_x, logical_y)
    }

    /// Run the native window. `on_click` receives the clickable node id.
    /// Return `true` from `on_click` to request a redraw.
    ///
    /// Shares the same arena with HostOps so Perry callbacks can mutate text
    /// while the event loop is running.
    pub fn run<F>(&self, title: &str, on_click: F) -> Result<(), String>
    where
        F: FnMut(NodeId) -> bool + 'static,
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
            on_click: Box::new(on_click),
            viewport: (640.0, 420.0),
        };
        nui_platform_winit::run_app(title, app).map_err(|e| e.to_string())?;
        Ok(())
    }
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

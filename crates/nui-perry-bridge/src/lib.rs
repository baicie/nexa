//! NUI Host engine used by the Perry native-library wrapper.
//!
//! This crate intentionally does **not** depend on `perry-ffi`, so the
//! workspace can test HostOps without linking Perry. The `packages/nui-host`
//! crate owns `#[no_mangle]` exports and Perry ABI types.
//!
//! Tree state is `Arc`-shared so Perry click callbacks can `set_text` while
//! the window event loop owns the same arena (Slice 2→3 fix).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use nui_core::{
    hit_scroll, hit_test, Arena, ColorRgba, FlexDirection, NodeId, NodeType, PropertyId,
};
use nui_layout_taffy::layout_tree;
use nui_platform_winit::{run_app, WindowApp};
use nui_render_skia::paint_tree;

#[derive(Debug, Default)]
struct HostInner {
    arena: Arena,
    /// First created root-ish view; used as layout root when present.
    root: Option<NodeId>,
    /// node.raw() → opaque callback token (Perry closure ptr as u64).
    click_tokens: HashMap<u64, u64>,
}

/// Opaque Host session driving the Slice 1 node tree from HostOps.
#[derive(Clone, Debug, Default)]
pub struct NuiHost {
    inner: Arc<Mutex<HostInner>>,
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
        let mut inner = self.inner.lock().expect("host inner");
        inner.arena.insert_child(parent, child);
        if inner.root.is_none() {
            inner.root = Some(parent);
        }
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
        run_app(title, app).map_err(|e| e.to_string())?;
        Ok(())
    }
}

struct HostWindowApp {
    shared: Arc<Mutex<HostInner>>,
    root: NodeId,
    on_click: Box<dyn FnMut(NodeId) -> bool>,
    viewport: (f32, f32),
}

impl WindowApp for HostWindowApp {
    fn paint(&mut self, pixels: &mut [u32], width: u32, height: u32, scale: f64) {
        let scale = scale.max(0.5);
        let logical_w = (width as f64 / scale) as f32;
        let logical_h = (height as f64 / scale) as f32;
        self.viewport = (logical_w, logical_h);
        let mut inner = self.shared.lock().expect("host inner");
        if let Some(node) = inner.arena.get_mut(self.root) {
            node.style.width = Some(logical_w);
            node.style.height = Some(logical_h);
        }
        layout_tree(&mut inner.arena, self.root, logical_w, logical_h);
        if let Err(err) = paint_tree(&inner.arena, self.root, pixels, width, height, scale) {
            eprintln!("nui paint failed: {err}");
        }
    }

    fn pointer_pressed(&mut self, x: f64, y: f64, scale: f64) -> bool {
        let scale = scale.max(0.5);
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        let hit = {
            let mut inner = self.shared.lock().expect("host inner");
            layout_tree(
                &mut inner.arena,
                self.root,
                self.viewport.0,
                self.viewport.1,
            );
            let Some(hit) = hit_test(&inner.arena, self.root, lx, ly) else {
                return false;
            };
            if !inner.click_tokens.contains_key(&hit.raw()) {
                return false;
            }
            hit
        };
        // Release the lock before invoking Perry callbacks (they may set_text).
        (self.on_click)(hit)
    }

    fn wheel_scrolled(&mut self, x: f64, y: f64, delta_y: f64, scale: f64) -> bool {
        let scale = scale.max(0.5);
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        let mut inner = self.shared.lock().expect("host inner");
        layout_tree(
            &mut inner.arena,
            self.root,
            self.viewport.0,
            self.viewport.1,
        );
        let Some(scroll) = hit_scroll(&inner.arena, self.root, lx, ly) else {
            return false;
        };
        let Some(node) = inner.arena.get(scroll) else {
            return false;
        };
        let viewport_h = node.layout.height;
        let top = node.layout.y;
        let child_ids = node.children.clone();
        let content_bottom = child_ids
            .iter()
            .filter_map(|c| inner.arena.get(*c))
            .map(|c| c.layout.y + c.layout.height)
            .fold(top, f32::max);
        let max_offset = (content_bottom - top - viewport_h).max(0.0);
        let Some(node) = inner.arena.get_mut(scroll) else {
            return false;
        };
        // Rolling down (negative delta on many platforms) increases offset.
        let next = (node.style.scroll_offset_y - delta_y as f32).clamp(0.0, max_offset);
        if (next - node.style.scroll_offset_y).abs() < f32::EPSILON {
            return false;
        }
        node.style.scroll_offset_y = next;
        true
    }
}

fn color_from_u32(rgba: u32) -> ColorRgba {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_counter_tree_and_hit() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        host.set_number(root, PropertyId::Padding, 24.0);
        host.set_number(root, PropertyId::Gap, 16.0);

        let label = host.create_text("Count: 0");
        host.set_number(label, PropertyId::FontSize, 28.0);
        host.insert(label, root);

        let button = host.create_node(NodeType::View);
        host.set_number(button, PropertyId::Padding, 12.0);
        host.set_number(button, PropertyId::BorderRadius, 12.0);
        host.set_number(
            button,
            PropertyId::BackgroundColor,
            f64::from(pack_rgba(0x1f, 0x6f, 0xeb, 0xff)),
        );
        host.add_click_listener(button, 42);
        host.insert(button, root);

        let btn_label = host.create_text("Increment");
        host.set_number(btn_label, PropertyId::FontSize, 18.0);
        host.set_number(
            btn_label,
            PropertyId::TextColor,
            f64::from(pack_rgba(0xff, 0xff, 0xff, 0xff)),
        );
        host.insert(btn_label, button);

        host.layout(320.0, 240.0);
        let layout = {
            let inner = host.inner.lock().expect("host inner");
            inner.arena.get(button).unwrap().layout
        };
        let hit = host
            .hit_clickable(layout.x + 1.0, layout.y + 1.0)
            .expect("button hit");
        assert_eq!(hit, button);
        assert_eq!(host.click_token(button), Some(42));
    }

    #[test]
    fn remove_clears_subtree_and_tokens() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let child = host.create_node(NodeType::View);
        host.add_click_listener(child, 7);
        host.insert(child, root);
        host.remove(child);
        assert!(host.click_token(child).is_none());
        let inner = host.inner.lock().expect("host inner");
        assert!(inner.arena.get(child).is_none());
        assert!(inner.arena.get(root).unwrap().children.is_empty());
    }
}

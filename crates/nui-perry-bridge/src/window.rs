//! Native window app wiring layout / paint / pointer / wheel to the Host arena.

use std::sync::{Arc, Mutex};

use nui_core::{hit_scroll, hit_test, NodeId};
use nui_layout_taffy::layout_tree;
use nui_platform_winit::WindowApp;
use nui_render_skia::paint_tree;

use crate::host::HostInner;

pub(crate) struct HostWindowApp {
    pub(crate) shared: Arc<Mutex<HostInner>>,
    pub(crate) root: NodeId,
    pub(crate) on_click: Box<dyn FnMut(NodeId) -> bool>,
    pub(crate) viewport: (f32, f32),
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

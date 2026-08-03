//! Native window app wiring layout / paint / pointer / keyboard to the Host arena.

use std::sync::{Arc, Mutex};

use nui_core::{hit_scroll, hit_test, NodeId};
use nui_layout_taffy::layout_tree;
use nui_platform_winit::WindowApp;
use nui_render_skia::paint_tree;

use crate::host::{
    backspace_at_caret, insert_text_at_caret, paint_hints_from_inner, read_input_value, HostInner,
    HostUiEvent,
};

pub(crate) struct HostWindowApp {
    pub(crate) shared: Arc<Mutex<HostInner>>,
    pub(crate) root: NodeId,
    pub(crate) on_event: Box<dyn FnMut(HostUiEvent) -> bool>,
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
        let hints = paint_hints_from_inner(&inner);
        if let Err(err) = paint_tree(
            &inner.arena,
            self.root,
            pixels,
            width,
            height,
            scale,
            hints.as_ref(),
        ) {
            eprintln!("nui paint failed: {err}");
        }
    }

    fn pointer_pressed(&mut self, x: f64, y: f64, scale: f64) -> bool {
        let scale = scale.max(0.5);
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        let mut click_target: Option<NodeId> = None;
        let mut redraw = false;
        {
            let mut inner = self.shared.lock().expect("host inner");
            layout_tree(
                &mut inner.arena,
                self.root,
                self.viewport.0,
                self.viewport.1,
            );
            match hit_test(&inner.arena, self.root, lx, ly) {
                Some(hit) if inner.inputs.contains_key(&hit.raw()) => {
                    inner.focused = Some(hit);
                    let text_node = inner.inputs.get(&hit.raw()).map(|f| f.text_node);
                    if let Some(text_node) = text_node {
                        let len = inner
                            .arena
                            .get(text_node)
                            .and_then(|n| n.text.as_ref())
                            .map(|t| t.chars().count())
                            .unwrap_or(0);
                        if let Some(field) = inner.inputs.get_mut(&hit.raw()) {
                            field.caret = len;
                        }
                    }
                    redraw = true;
                }
                Some(hit) if inner.click_tokens.contains_key(&hit.raw()) => {
                    if !inner.inputs.contains_key(&hit.raw()) {
                        inner.focused = None;
                        redraw = true;
                    }
                    click_target = Some(hit);
                }
                _ => {
                    if inner.focused.take().is_some() {
                        redraw = true;
                    }
                }
            }
        }
        if let Some(hit) = click_target {
            redraw |= (self.on_event)(HostUiEvent::Click(hit));
        }
        redraw
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
        let next = (node.style.scroll_offset_y - delta_y as f32).clamp(0.0, max_offset);
        if (next - node.style.scroll_offset_y).abs() < f32::EPSILON {
            return false;
        }
        node.style.scroll_offset_y = next;
        true
    }

    fn text_input(&mut self, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        let event = {
            let mut inner = self.shared.lock().expect("host inner");
            insert_text_at_caret(&mut inner, text).map(|(node, value)| HostUiEvent::Change {
                node,
                value,
            })
        };
        match event {
            Some(ev) => {
                let _ = (self.on_event)(ev);
                true
            }
            None => false,
        }
    }

    fn key_backspace(&mut self) -> bool {
        let event = {
            let mut inner = self.shared.lock().expect("host inner");
            backspace_at_caret(&mut inner).map(|(node, value)| HostUiEvent::Change { node, value })
        };
        match event {
            Some(ev) => {
                let _ = (self.on_event)(ev);
                true
            }
            None => false,
        }
    }

    fn key_enter(&mut self) -> bool {
        let event = {
            let inner = self.shared.lock().expect("host inner");
            let Some(focused) = inner.focused else {
                return false;
            };
            if !inner.inputs.contains_key(&focused.raw()) {
                return false;
            }
            let value = read_input_value(&inner, focused);
            HostUiEvent::Submit {
                node: focused,
                value,
            }
        };
        let _ = (self.on_event)(event);
        true
    }
}

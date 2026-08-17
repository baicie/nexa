//! Native window app wiring layout / paint / pointer / keyboard to the Host arena.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nui_app_runtime::{
    DispatchQueue, Dispatcher, ErrorSupervisor, FrameDropStage, FramePhase, Scheduler, TickPhase,
};
use nui_core::protocol::ui::{WindowLifecycleEvent, WindowLifecycleKind};
use nui_core::{hit_scroll, hit_test, NodeId, SurfaceGeneration};
use nui_layout_taffy::{layout_tree_with_cache, layout_tree_with_cache_stats};
use nui_platform_winit::{
    ime_preedit_selection_utf16, text_editing_command, DesktopPlatform, ImeCursorArea, ImeState,
    PlatformFailure, PlatformFailureStage, RuntimeWaker, TextEditingCommand, TextNavigation,
    WindowApp,
};
use nui_render_skia::{paint_display_list_with_cache, BackendResourceCache};
use nui_system_core::{ClipboardBackend, DesktopClipboard};
use nui_text::{
    CommandOutcome, HorizontalDirection, KeyCommand, KeyModifiers as TextKeyModifiers,
    NavigationKey, Utf16Range, VerticalDirection,
};

use crate::frame_metrics::FrameMetricsState;
use crate::host::{
    apply_horizontal_input_command, apply_input_command, apply_line_edge_input_command,
    apply_vertical_input_command, backspace_at_caret, cancel_composition_at_focused,
    commit_composition_at_focused, display_list_from_inner, effective_layout_origin,
    ensure_input_caret_visible, focused_composition_bounds_from_inner, insert_text_at_caret,
    paint_hints_from_inner, read_input_value, replace_input_value_at_node,
    start_composition_at_focused, take_pending_ui_events, transition_focus,
    update_composition_at_focused, HostInner, HostUiEvent, NuiHost,
};
use nui_core::SemanticAction;
use nui_platform_winit::{
    AccessibilityActionRequest, KeyInput, KeyModifiers as PlatformKeyModifiers,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum WindowLifecycleState {
    #[default]
    Initial,
    Ready,
    Suspended,
    CloseRequested,
}

impl WindowLifecycleState {
    fn ready(&mut self) -> Option<WindowLifecycleKind> {
        match self {
            Self::Initial => {
                *self = Self::Ready;
                Some(WindowLifecycleKind::Ready)
            }
            Self::Suspended => {
                *self = Self::Ready;
                Some(WindowLifecycleKind::Resumed)
            }
            Self::Ready | Self::CloseRequested => None,
        }
    }

    fn suspended(&mut self) -> Option<WindowLifecycleKind> {
        if *self != Self::Ready {
            return None;
        }
        *self = Self::Suspended;
        Some(WindowLifecycleKind::Suspended)
    }

    fn close_requested(&mut self) -> Option<WindowLifecycleKind> {
        if *self == Self::CloseRequested {
            return None;
        }
        *self = Self::CloseRequested;
        Some(WindowLifecycleKind::CloseRequested)
    }
}

pub(crate) struct HostWindowApp {
    pub(crate) shared: Arc<Mutex<HostInner>>,
    pub(crate) root: NodeId,
    pub(crate) errors: ErrorSupervisor,
    pub(crate) dispatcher: Dispatcher<HostUiEvent>,
    pub(crate) accessibility_dispatcher: Dispatcher<AccessibilityActionRequest>,
    pub(crate) scheduler: Scheduler,
    pub(crate) install_runtime_waker: Box<dyn FnMut(RuntimeWaker)>,
    pub(crate) system_completion: Box<dyn FnMut(&Scheduler) -> bool>,
    pub(crate) framework_microtasks: Box<dyn FnMut() -> bool>,
    pub(crate) on_event: Box<dyn FnMut(HostUiEvent) -> bool>,
    pub(crate) after_events: Box<dyn FnMut() -> bool>,
    pub(crate) on_close: Box<dyn FnMut()>,
    pub(crate) viewport: (f32, f32),
    pub(crate) redraw_pending: bool,
    pub(crate) render_cache: BackendResourceCache,
    pub(crate) window_lifecycle: WindowLifecycleState,
    pub(crate) frame_metrics: FrameMetricsState,
}

impl HostWindowApp {
    fn window_lifecycle_event(
        &self,
        kind: WindowLifecycleKind,
        generation: Option<SurfaceGeneration>,
    ) -> HostUiEvent {
        let callback = self
            .shared
            .lock()
            .expect("host inner")
            .v1_listeners
            .get(&crate::ListenerKey::new(
                self.root.raw(),
                nui_core::EventId::WindowLifecycle as u32,
            ))
            .copied();
        HostUiEvent::WindowLifecycle {
            node: self.root,
            event: WindowLifecycleEvent {
                kind,
                surface_generation: generation.map(|value| value.get() as f64),
            },
            callback,
        }
    }

    fn apply_accessibility_action(&mut self, request: AccessibilityActionRequest) -> bool {
        let allowed = |inner: &HostInner, action: SemanticAction| {
            inner
                .semantic_snapshot
                .node(request.target)
                .is_some_and(|node| !node.state.disabled && node.actions.contains(&action))
        };

        match request.action {
            SemanticAction::Invoke => {
                let click = {
                    let mut inner = self.shared.lock().expect("host inner");
                    if !allowed(&inner, SemanticAction::Invoke)
                        || inner.arena.get(request.target).is_none()
                    {
                        return false;
                    }
                    let callback = inner
                        .v1_listeners
                        .get(&crate::ListenerKey::new(
                            request.target.raw(),
                            nui_core::EventId::Click as u32,
                        ))
                        .copied();
                    if callback.is_none() && !inner.click_tokens.contains_key(&request.target.raw())
                    {
                        return false;
                    }
                    NuiHost::mark_active_changed(&mut inner);
                    (request.target, callback)
                };
                self.dispatcher.enqueue(
                    DispatchQueue::Platform,
                    HostUiEvent::Click {
                        node: click.0,
                        callback: click.1,
                    },
                );
                self.redraw_pending = true;
                false
            }
            SemanticAction::Focus => {
                let changed = {
                    let mut inner = self.shared.lock().expect("host inner");
                    let arena = inner.arena.clone();
                    if !allowed(&inner, SemanticAction::Focus)
                        || inner.arena.get(request.target).is_none()
                        || !inner
                            .focus
                            .request_focus(request.target, &arena, Some(self.root))
                    {
                        return false;
                    }
                    let changed = transition_focus(&mut inner, Some(request.target));
                    if changed {
                        NuiHost::mark_active_changed(&mut inner);
                    }
                    changed
                };
                self.flush_pending_ui_events();
                self.redraw_pending |= changed;
                changed
            }
            SemanticAction::SetValue => {
                let change = {
                    let mut inner = self.shared.lock().expect("host inner");
                    if !allowed(&inner, SemanticAction::SetValue)
                        || request.value.is_none()
                        || inner.arena.get(request.target).is_none()
                    {
                        return false;
                    }
                    let Some(value) = replace_input_value_at_node(
                        &mut inner,
                        request.target,
                        request.value.as_deref().expect("checked above"),
                    ) else {
                        return false;
                    };
                    let callback = inner
                        .v1_listeners
                        .get(&crate::ListenerKey::new(
                            request.target.raw(),
                            nui_core::EventId::Change as u32,
                        ))
                        .copied();
                    Some((request.target, value, callback))
                };
                let Some((node, value, callback)) = change else {
                    return false;
                };
                let _ = self.relayout_and_reveal_input(node);
                self.dispatcher.enqueue(
                    DispatchQueue::Platform,
                    HostUiEvent::Change {
                        node,
                        value,
                        callback,
                    },
                );
                self.redraw_pending = true;
                false
            }
        }
    }

    fn flush_pending_ui_events(&mut self) {
        let events = {
            let mut inner = self.shared.lock().expect("host inner");
            take_pending_ui_events(&mut inner)
        };
        for event in events {
            self.dispatcher.enqueue(DispatchQueue::Platform, event);
        }
    }

    fn invalidate_surface_resources(&mut self) {
        self.render_cache.release_surface_resources();
    }

    fn relayout_and_reveal_input(&mut self, container: NodeId) -> bool {
        let result = {
            let mut inner = self.shared.lock().expect("host inner");
            let layout = {
                let inner = &mut *inner;
                let (arena, text_cache) = (&mut inner.arena, &mut inner.text_cache);
                layout_tree_with_cache(
                    arena,
                    self.root,
                    self.viewport.0,
                    self.viewport.1,
                    text_cache,
                )
            };
            layout.map(|()| ensure_input_caret_visible(&mut inner, container).unwrap_or(false))
        };
        match result {
            Ok(changed) => changed,
            Err(error) => {
                self.errors
                    .report(crate::frame_nexa_error("layout", error.to_string()));
                false
            }
        }
    }

    fn handle_clipboard_command(
        &mut self,
        command: TextEditingCommand,
        clipboard: &mut dyn ClipboardBackend,
    ) -> bool {
        let change = match command {
            TextEditingCommand::Copy | TextEditingCommand::Cut => {
                let selected = {
                    let inner = self.shared.lock().expect("host inner");
                    let Some(focused) = inner.focused else {
                        return false;
                    };
                    let Some(field) = inner.inputs.get(&focused.raw()) else {
                        return false;
                    };
                    if field.editor.composition().is_some() {
                        return false;
                    }
                    field.editor.selected_text().to_owned()
                };
                if selected.is_empty() {
                    return false;
                }
                if let Err(error) = clipboard.write_text(&selected) {
                    self.errors.report(crate::operation_state_nexa_error(
                        "clipboardWrite",
                        error.to_string(),
                    ));
                    return false;
                }
                if command == TextEditingCommand::Copy {
                    return false;
                }
                let mut inner = self.shared.lock().expect("host inner");
                insert_text_at_caret(&mut inner, "")
            }
            TextEditingCommand::Paste => {
                let pasted = match clipboard.read_text() {
                    Ok(text) => text,
                    Err(error) => {
                        self.errors.report(crate::operation_state_nexa_error(
                            "clipboardRead",
                            error.to_string(),
                        ));
                        return false;
                    }
                };
                let mut inner = self.shared.lock().expect("host inner");
                let Some(focused) = inner.focused else {
                    return false;
                };
                let Some(field) = inner.inputs.get(&focused.raw()) else {
                    return false;
                };
                if field.editor.composition().is_some()
                    || (pasted.is_empty() && field.editor.selection().is_collapsed())
                {
                    return false;
                }
                insert_text_at_caret(&mut inner, &pasted)
            }
            _ => return false,
        };
        let Some((node, value)) = change else {
            return false;
        };
        let callback = self
            .shared
            .lock()
            .expect("host inner")
            .v1_listeners
            .get(&crate::ListenerKey::new(
                node.raw(),
                nui_core::EventId::Change as u32,
            ))
            .copied();
        self.dispatcher.enqueue(
            DispatchQueue::Platform,
            HostUiEvent::Change {
                node,
                value,
                callback,
            },
        );
        let _ = self.relayout_and_reveal_input(node);
        self.redraw_pending = true;
        false
    }
}

impl WindowApp for HostWindowApp {
    fn install_runtime_waker(&mut self, waker: RuntimeWaker) {
        (self.install_runtime_waker)(waker);
    }

    fn accessibility_action(&mut self, request: AccessibilityActionRequest) -> bool {
        self.accessibility_dispatcher
            .enqueue(DispatchQueue::Platform, request);
        false
    }

    fn paint(&mut self, pixels: &mut [u32], width: u32, height: u32, scale: f64) {
        let _ = self.paint_frame(pixels, width, height, scale);
    }

    fn paint_frame(&mut self, pixels: &mut [u32], width: u32, height: u32, scale: f64) -> bool {
        let mut metrics = self.frame_metrics.begin_frame();
        let scale = scale.max(0.5);
        let logical_w = (width as f64 / scale) as f32;
        let logical_h = (height as f64 / scale) as f32;
        self.viewport = (logical_w, logical_h);
        let frame_result = {
            let mut inner = self.shared.lock().expect("host inner");
            NuiHost::size_root_for_viewport(&mut inner, self.root, logical_w, logical_h);
            metrics
                .begin_phase(FramePhase::Layout)
                .expect("layout metrics phase starts once");
            let result = {
                let inner = &mut *inner;
                let (arena, text_cache) = (&mut inner.arena, &mut inner.text_cache);
                layout_tree_with_cache_stats(arena, self.root, logical_w, logical_h, text_cache)
            };
            metrics
                .end_phase(FramePhase::Layout)
                .expect("layout metrics phase matches");
            NuiHost::mark_active_changed(&mut inner);
            match result {
                Ok(stats) => {
                    metrics.record_layout_nodes(u64::from(stats.node_count()));
                    metrics
                        .begin_phase(FramePhase::Semantics)
                        .expect("semantics metrics phase starts once");
                    let semantic_diff_count = {
                        let diff = crate::host::NuiHost::update_semantic_snapshot(
                            &mut inner,
                            Some(self.root),
                        );
                        u64::try_from(diff.len()).unwrap_or(u64::MAX)
                    };
                    metrics.record_semantic_diffs(semantic_diff_count);
                    metrics
                        .end_phase(FramePhase::Semantics)
                        .expect("semantics metrics phase matches");
                    metrics
                        .begin_phase(FramePhase::DisplayList)
                        .expect("display-list metrics phase starts once");
                    let display_list = { display_list_from_inner(&mut inner, self.root) };
                    metrics
                        .end_phase(FramePhase::DisplayList)
                        .expect("display-list metrics phase matches");
                    display_list
                        .map(|display_list| {
                            metrics.record_display_commands(
                                u64::try_from(display_list.commands().len()).unwrap_or(u64::MAX),
                            );
                            (display_list, paint_hints_from_inner(&mut inner))
                        })
                        .map_err(|error| (FrameDropStage::DisplayList, "displayList", error))
                }
                Err(error) => Err((FrameDropStage::Layout, "layout", error)),
            }
        };
        let (display_list, hints) = match frame_result {
            Ok(frame) => frame,
            Err((stage, operation, error)) => {
                self.errors
                    .report(crate::frame_nexa_error(operation, error.to_string()));
                self.frame_metrics.publish_dropped(metrics, stage);
                return false;
            }
        };
        metrics
            .begin_phase(FramePhase::Paint)
            .expect("paint metrics phase starts once");
        let paint_result = paint_display_list_with_cache(
            &display_list,
            pixels,
            width,
            height,
            scale,
            Some(&hints),
            &mut self.render_cache,
        );
        metrics
            .end_phase(FramePhase::Paint)
            .expect("paint metrics phase matches");
        if let Err(err) = paint_result {
            self.errors
                .report(crate::frame_nexa_error("paint", err.to_string()));
            self.frame_metrics
                .publish_dropped(metrics, FrameDropStage::Paint);
            return false;
        }
        self.frame_metrics.retain_for_present(metrics);
        true
    }

    fn ime_state(&mut self) -> ImeState {
        let mut inner = self.shared.lock().expect("host inner");
        let has_focused_editor = inner
            .focused
            .is_some_and(|focused| inner.inputs.contains_key(&focused.raw()));
        if !has_focused_editor {
            return ImeState::Disabled;
        }
        let cursor_area = focused_composition_bounds_from_inner(&mut inner)
            .and_then(|bounds| ImeCursorArea::new(bounds.x, bounds.y, bounds.width, bounds.height));
        ImeState::Enabled { cursor_area }
    }

    fn pointer_moved(&mut self, x: f64, y: f64, scale: f64) -> bool {
        let scale = scale.max(0.5);
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        let mut changed = false;
        let layout_error = {
            let mut inner = self.shared.lock().expect("host inner");
            let result = {
                let inner = &mut *inner;
                let (arena, text_cache) = (&mut inner.arena, &mut inner.text_cache);
                layout_tree_with_cache(
                    arena,
                    self.root,
                    self.viewport.0,
                    self.viewport.1,
                    text_cache,
                )
            };
            match result {
                Err(error) => Some(error),
                Ok(()) => {
                    let hit = hit_test(&inner.arena, self.root, lx, ly);
                    let pressed = inner.pointer_pressed_target;
                    for (raw, state) in &mut inner.interactions {
                        let previous = *state;
                        if hit.is_some_and(|target| target.raw() == *raw) {
                            state.pointer_enter();
                            if pressed.is_some_and(|target| target.raw() == *raw) {
                                let _ = state.pointer_press();
                            }
                        } else {
                            state.pointer_leave();
                        }
                        changed |= *state != previous;
                    }
                    if changed {
                        NuiHost::mark_active_changed(&mut inner);
                    }
                    None
                }
            }
        };
        if let Some(error) = layout_error {
            self.errors
                .report(crate::frame_nexa_error("layout", error.to_string()));
            return false;
        }
        self.redraw_pending |= changed;
        false
    }

    fn pointer_exited(&mut self) -> bool {
        let changed = {
            let mut inner = self.shared.lock().expect("host inner");
            let mut changed = false;
            for state in inner.interactions.values_mut() {
                let previous = *state;
                state.pointer_leave();
                changed |= *state != previous;
            }
            if changed {
                NuiHost::mark_active_changed(&mut inner);
            }
            changed
        };
        self.redraw_pending |= changed;
        false
    }

    fn pointer_pressed(&mut self, x: f64, y: f64, scale: f64) -> bool {
        let scale = scale.max(0.5);
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        let mut redraw = false;
        let layout_error = {
            let mut inner = self.shared.lock().expect("host inner");
            let result = {
                let inner = &mut *inner;
                let (arena, text_cache) = (&mut inner.arena, &mut inner.text_cache);
                layout_tree_with_cache(
                    arena,
                    self.root,
                    self.viewport.0,
                    self.viewport.1,
                    text_cache,
                )
            };
            match result {
                Err(error) => Some(error),
                Ok(()) => {
                    match hit_test(&inner.arena, self.root, lx, ly) {
                        Some(hit) if inner.inputs.contains_key(&hit.raw()) => {
                            for (raw, state) in &mut inner.interactions {
                                if *raw != hit.raw() {
                                    state.pointer_leave();
                                }
                            }
                            let pressed = {
                                let state = inner.interactions.entry(hit.raw()).or_default();
                                state.pointer_enter();
                                state.pointer_press()
                            };
                            if pressed {
                                let arena = inner.arena.clone();
                                let _ = inner.focus.request_focus(hit, &arena, Some(self.root));
                                if inner.event_dispatcher.set_pointer_capture(1, hit, &arena) {
                                    inner.pointer_pressed_target = Some(hit);
                                }
                                let focused = inner.focus.focused();
                                transition_focus(&mut inner, focused);
                                let text_node = inner.inputs.get(&hit.raw()).map(|f| f.text_node);
                                if let Some(text_node) = text_node {
                                    let text_origin =
                                        effective_layout_origin(&inner.arena, text_node);
                                    let snapshot = inner.text_cache.snapshot_for_node(text_node);
                                    let hit_caret = text_origin.zip(snapshot.as_deref()).and_then(
                                        |((origin_x, origin_y), snapshot)| {
                                            snapshot
                                                .hit_test(lx - origin_x, ly - origin_y)
                                                .and_then(|hit| {
                                                    snapshot
                                                        .index_map()
                                                        .utf8_to_grapheme(hit.offset().get())
                                                        .map(|grapheme| (grapheme, hit.affinity()))
                                                })
                                        },
                                    );
                                    let fallback_grapheme = hit_caret.map_or_else(
                                        || {
                                            inner
                                                .arena
                                                .get(text_node)
                                                .and_then(|n| n.text.as_ref())
                                                .map(|t| {
                                                    nui_text::TextIndexMap::new(t).grapheme_count()
                                                })
                                                .unwrap_or(0)
                                        },
                                        |(grapheme, _)| grapheme,
                                    );
                                    if let Some(field) = inner.inputs.get_mut(&hit.raw()) {
                                        let (grapheme, affinity) = hit_caret.unwrap_or_else(|| {
                                            let grapheme = fallback_grapheme;
                                            let affinity = if grapheme == 0 {
                                                nui_text::CaretAffinity::Downstream
                                            } else {
                                                nui_text::CaretAffinity::Upstream
                                            };
                                            (grapheme, affinity)
                                        });
                                        let _ =
                                            field.editor.editor_mut().set_caret(grapheme, false);
                                        field.caret_affinity = affinity;
                                    }
                                }
                                redraw = true;
                            }
                        }
                        Some(hit)
                            if inner.click_tokens.contains_key(&hit.raw())
                                || inner.v1_listeners.contains_key(&crate::ListenerKey::new(
                                    hit.raw(),
                                    nui_core::EventId::Click as u32,
                                )) =>
                        {
                            for (raw, state) in &mut inner.interactions {
                                if *raw != hit.raw() {
                                    state.pointer_leave();
                                }
                            }
                            let pressed = {
                                let state = inner.interactions.entry(hit.raw()).or_default();
                                state.pointer_enter();
                                state.pointer_press()
                            };
                            if pressed {
                                let arena = inner.arena.clone();
                                if inner.event_dispatcher.set_pointer_capture(1, hit, &arena) {
                                    inner.pointer_pressed_target = Some(hit);
                                }
                                let next_focus =
                                    if inner.focus.request_focus(hit, &arena, Some(self.root)) {
                                        inner.focus.focused()
                                    } else {
                                        inner.focus.clear_focus();
                                        None
                                    };
                                let _ = transition_focus(&mut inner, next_focus);
                                redraw = true;
                            }
                        }
                        _ => {
                            for state in inner.interactions.values_mut() {
                                state.pointer_leave();
                            }
                            let manager_changed = inner.focus.clear_focus().is_some();
                            redraw |= transition_focus(&mut inner, None) || manager_changed;
                        }
                    }
                    if redraw {
                        NuiHost::mark_active_changed(&mut inner);
                    }
                    None
                }
            }
        };
        if let Some(error) = layout_error {
            self.errors
                .report(crate::frame_nexa_error("layout", error.to_string()));
            return false;
        }
        self.flush_pending_ui_events();
        self.redraw_pending |= redraw;
        false
    }

    fn pointer_released(&mut self, x: f64, y: f64, scale: f64) -> bool {
        let scale = scale.max(0.5);
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        let mut click_target = None;
        let mut click_callback = None;
        let mut interaction_changed = false;
        let layout_error = {
            let mut inner = self.shared.lock().expect("host inner");
            let result = {
                let inner = &mut *inner;
                let (arena, text_cache) = (&mut inner.arena, &mut inner.text_cache);
                layout_tree_with_cache(
                    arena,
                    self.root,
                    self.viewport.0,
                    self.viewport.1,
                    text_cache,
                )
            };
            match result {
                Err(error) => Some(error),
                Ok(()) => {
                    let hit = hit_test(&inner.arena, self.root, lx, ly);
                    let pressed = inner.pointer_pressed_target.take();
                    let arena = inner.arena.clone();
                    let click_tokens = inner.click_tokens.clone();
                    let listeners = inner.v1_listeners.clone();
                    let same_target = pressed.is_some() && pressed == hit;
                    let invoke = pressed
                        .and_then(|pressed| inner.interactions.get_mut(&pressed.raw()))
                        .map_or(same_target, |state| {
                            let previous = *state;
                            let invoke = state.pointer_release(same_target);
                            interaction_changed |= *state != previous;
                            invoke
                        });
                    for (raw, state) in &mut inner.interactions {
                        let previous = *state;
                        if hit.is_some_and(|target| target.raw() == *raw) {
                            state.pointer_enter();
                        } else {
                            state.pointer_leave();
                        }
                        interaction_changed |= *state != previous;
                    }
                    let mut event_dispatcher = std::mem::take(&mut inner.event_dispatcher);
                    let result =
                        event_dispatcher.dispatch(&arena, hit, Some(1), |node, phase, _state| {
                            if phase == nui_core::PropagationPhase::DefaultAction
                                && invoke
                                && (click_tokens.contains_key(&node.raw())
                                    || listeners.contains_key(&crate::ListenerKey::new(
                                        node.raw(),
                                        nui_core::EventId::Click as u32,
                                    )))
                            {
                                click_target = Some(node);
                                click_callback = listeners
                                    .get(&crate::ListenerKey::new(
                                        node.raw(),
                                        nui_core::EventId::Click as u32,
                                    ))
                                    .copied();
                            }
                        });
                    event_dispatcher.release_pointer_capture(1);
                    inner.event_dispatcher = event_dispatcher;
                    if result.propagation.default_prevented {
                        click_target = None;
                        click_callback = None;
                    }
                    if interaction_changed || click_target.is_some() {
                        NuiHost::mark_active_changed(&mut inner);
                    }
                    None
                }
            }
        };
        if let Some(error) = layout_error {
            self.errors
                .report(crate::frame_nexa_error("layout", error.to_string()));
            return false;
        }
        if let Some(node) = click_target {
            self.dispatcher.enqueue(
                DispatchQueue::Platform,
                HostUiEvent::Click {
                    node,
                    callback: click_callback,
                },
            );
        }
        self.redraw_pending |= interaction_changed;
        false
    }

    fn wheel_scrolled(&mut self, x: f64, y: f64, delta_y: f64, scale: f64) -> bool {
        let scale = scale.max(0.5);
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        let (layout_error, changed) = {
            let mut inner = self.shared.lock().expect("host inner");
            let result = {
                let inner = &mut *inner;
                let (arena, text_cache) = (&mut inner.arena, &mut inner.text_cache);
                layout_tree_with_cache(
                    arena,
                    self.root,
                    self.viewport.0,
                    self.viewport.1,
                    text_cache,
                )
            };
            match result {
                Err(error) => (Some(error), false),
                Ok(()) => {
                    let changed = 'scroll: {
                        let Some(scroll) = hit_scroll(&inner.arena, self.root, lx, ly) else {
                            break 'scroll false;
                        };
                        let Some(node) = inner.arena.get(scroll) else {
                            break 'scroll false;
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
                            break 'scroll false;
                        };
                        let next =
                            (node.style.scroll_offset_y - delta_y as f32).clamp(0.0, max_offset);
                        if (next - node.style.scroll_offset_y).abs() < f32::EPSILON {
                            break 'scroll false;
                        }
                        node.style.scroll_offset_y = next;
                        true
                    };
                    if changed {
                        NuiHost::mark_active_changed(&mut inner);
                    }
                    (None, changed)
                }
            }
        };
        if let Some(error) = layout_error {
            self.errors
                .report(crate::frame_nexa_error("layout", error.to_string()));
            return false;
        }
        if changed {
            self.redraw_pending = true;
        }
        false
    }

    fn text_input(&mut self, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        let event = {
            let mut inner = self.shared.lock().expect("host inner");
            insert_text_at_caret(&mut inner, text).map(|(node, value)| HostUiEvent::Change {
                callback: inner
                    .v1_listeners
                    .get(&crate::ListenerKey::new(
                        node.raw(),
                        nui_core::EventId::Change as u32,
                    ))
                    .copied(),
                node,
                value,
            })
        };
        match event {
            Some(ev) => {
                let node = match &ev {
                    HostUiEvent::Change { node, .. } => *node,
                    _ => unreachable!("text input only emits Change"),
                };
                let _ = self.relayout_and_reveal_input(node);
                self.dispatcher.enqueue(DispatchQueue::Platform, ev);
                self.redraw_pending = true;
                false
            }
            None => false,
        }
    }

    fn ime_start(&mut self) -> bool {
        let started = {
            let mut inner = self.shared.lock().expect("host inner");
            start_composition_at_focused(&mut inner).is_some_and(|(_, started)| started)
        };
        self.flush_pending_ui_events();
        self.redraw_pending |= started;
        started
    }

    fn ime_preedit(&mut self, text: &str, cursor: Option<(usize, usize)>) -> bool {
        let selection = ime_preedit_selection_utf16(text, cursor).map(|selection| Utf16Range {
            start: selection.start,
            end: selection.end,
        });
        let update = {
            let mut inner = self.shared.lock().expect("host inner");
            update_composition_at_focused(&mut inner, text, selection)
        };
        self.flush_pending_ui_events();
        let changed = update.is_some();
        let scroll_changed = update
            .as_ref()
            .is_some_and(|(node, _)| self.relayout_and_reveal_input(*node));
        self.redraw_pending |= changed || scroll_changed;
        changed
    }

    fn ime_commit(&mut self, text: &str) -> bool {
        let event = {
            let mut inner = self.shared.lock().expect("host inner");
            commit_composition_at_focused(&mut inner, text).map(|(node, value)| {
                HostUiEvent::Change {
                    callback: inner
                        .v1_listeners
                        .get(&crate::ListenerKey::new(
                            node.raw(),
                            nui_core::EventId::Change as u32,
                        ))
                        .copied(),
                    node,
                    value,
                }
            })
        };
        self.flush_pending_ui_events();
        if let Some(event) = event {
            let node = match &event {
                HostUiEvent::Change { node, .. } => *node,
                _ => unreachable!("IME commit only emits Change"),
            };
            let _ = self.relayout_and_reveal_input(node);
            self.dispatcher.enqueue(DispatchQueue::Platform, event);
            self.redraw_pending = true;
            true
        } else {
            false
        }
    }

    fn ime_cancel(&mut self) -> bool {
        let (focused, changed) = {
            let mut inner = self.shared.lock().expect("host inner");
            let focused = inner.focused;
            (
                focused,
                cancel_composition_at_focused(&mut inner).unwrap_or(false),
            )
        };
        self.flush_pending_ui_events();
        let scroll_changed = focused
            .filter(|_| changed)
            .is_some_and(|node| self.relayout_and_reveal_input(node));
        self.redraw_pending |= changed || scroll_changed;
        changed
    }

    fn key_backspace(&mut self) -> bool {
        let event = {
            let mut inner = self.shared.lock().expect("host inner");
            backspace_at_caret(&mut inner).map(|(node, value)| HostUiEvent::Change {
                callback: inner
                    .v1_listeners
                    .get(&crate::ListenerKey::new(
                        node.raw(),
                        nui_core::EventId::Change as u32,
                    ))
                    .copied(),
                node,
                value,
            })
        };
        match event {
            Some(ev) => {
                let node = match &ev {
                    HostUiEvent::Change { node, .. } => *node,
                    _ => unreachable!("backspace only emits Change"),
                };
                let _ = self.relayout_and_reveal_input(node);
                self.dispatcher.enqueue(DispatchQueue::Platform, ev);
                self.redraw_pending = true;
                false
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
                callback: inner
                    .v1_listeners
                    .get(&crate::ListenerKey::new(
                        focused.raw(),
                        nui_core::EventId::Submit as u32,
                    ))
                    .copied()
                    .or_else(|| {
                        inner
                            .v1_listeners
                            .get(&crate::ListenerKey::new(
                                focused.raw(),
                                nui_core::EventId::Change as u32,
                            ))
                            .copied()
                    }),
            }
        };
        self.dispatcher.enqueue(DispatchQueue::Platform, event);
        false
    }

    fn key_tab(&mut self, backwards: bool) -> bool {
        let changed = {
            let mut inner = self.shared.lock().expect("host inner");
            let arena = inner.arena.clone();
            let next = if backwards {
                inner.focus.focus_previous(&arena, Some(self.root))
            } else {
                inner.focus.focus_next(&arena, Some(self.root))
            };
            let changed = transition_focus(&mut inner, next);
            if changed {
                NuiHost::mark_active_changed(&mut inner);
            }
            changed
        };
        self.flush_pending_ui_events();
        self.redraw_pending |= changed;
        false
    }

    fn key_command(&mut self, key: KeyInput, modifiers: PlatformKeyModifiers) -> bool {
        if matches!(key, KeyInput::Tab) {
            return self.key_tab(modifiers.shift);
        }
        if matches!(key, KeyInput::Enter | KeyInput::Space) {
            let button = {
                let mut inner = self.shared.lock().expect("host inner");
                let button = inner.focused.and_then(|node| {
                    if inner.inputs.contains_key(&node.raw()) {
                        return None;
                    }
                    let callback = inner
                        .v1_listeners
                        .get(&crate::ListenerKey::new(
                            node.raw(),
                            nui_core::EventId::Click as u32,
                        ))
                        .copied();
                    let has_listener =
                        callback.is_some() || inner.click_tokens.contains_key(&node.raw());
                    let can_invoke = has_listener
                        && inner
                            .interactions
                            .get_mut(&node.raw())
                            .is_some_and(nui_core::InteractionModel::keyboard_press);
                    can_invoke.then_some((node, callback))
                });
                if button.is_some() {
                    NuiHost::mark_active_changed(&mut inner);
                }
                button
            };
            if let Some((node, callback)) = button {
                self.dispatcher.enqueue(
                    DispatchQueue::Platform,
                    HostUiEvent::Click { node, callback },
                );
                self.redraw_pending = true;
                return false;
            }
        }
        let Some(editing_command) =
            text_editing_command(key, modifiers, DesktopPlatform::current())
        else {
            return false;
        };
        if matches!(
            editing_command,
            TextEditingCommand::Copy | TextEditingCommand::Cut | TextEditingCommand::Paste
        ) {
            return self.handle_clipboard_command(editing_command, &mut DesktopClipboard);
        }
        let (command, word) = match editing_command {
            TextEditingCommand::Navigate {
                target: TextNavigation::VisualLeft | TextNavigation::VisualRight,
                extend,
            } => {
                let direction = if matches!(
                    editing_command,
                    TextEditingCommand::Navigate {
                        target: TextNavigation::VisualLeft,
                        ..
                    }
                ) {
                    HorizontalDirection::Left
                } else {
                    HorizontalDirection::Right
                };
                let moved = {
                    let mut inner = self.shared.lock().expect("host inner");
                    apply_horizontal_input_command(&mut inner, direction, extend)
                };
                if let Some((_node, changed)) = moved {
                    self.redraw_pending |= changed;
                    return false;
                }
                (
                    KeyCommand::Navigate(if direction == HorizontalDirection::Left {
                        NavigationKey::Left
                    } else {
                        NavigationKey::Right
                    }),
                    false,
                )
            }
            TextEditingCommand::Navigate {
                target: TextNavigation::WordLeft,
                ..
            } => (KeyCommand::Navigate(NavigationKey::Left), true),
            TextEditingCommand::Navigate {
                target: TextNavigation::WordRight,
                ..
            } => (KeyCommand::Navigate(NavigationKey::Right), true),
            TextEditingCommand::Navigate {
                target: TextNavigation::VisualUp | TextNavigation::VisualDown,
                extend,
            } => {
                let direction = if matches!(
                    editing_command,
                    TextEditingCommand::Navigate {
                        target: TextNavigation::VisualUp,
                        ..
                    }
                ) {
                    VerticalDirection::Up
                } else {
                    VerticalDirection::Down
                };
                let moved = {
                    let mut inner = self.shared.lock().expect("host inner");
                    apply_vertical_input_command(&mut inner, direction, extend)
                };
                if let Some((_node, changed)) = moved {
                    self.redraw_pending |= changed;
                }
                return false;
            }
            TextEditingCommand::Navigate {
                target: TextNavigation::VisualLineStart | TextNavigation::VisualLineEnd,
                extend,
            } => {
                let to_end = matches!(
                    editing_command,
                    TextEditingCommand::Navigate {
                        target: TextNavigation::VisualLineEnd,
                        ..
                    }
                );
                let moved = {
                    let mut inner = self.shared.lock().expect("host inner");
                    apply_line_edge_input_command(&mut inner, to_end, extend)
                };
                if let Some((_node, changed)) = moved {
                    self.redraw_pending |= changed;
                    return false;
                }
                (
                    KeyCommand::Navigate(if to_end {
                        NavigationKey::End
                    } else {
                        NavigationKey::Home
                    }),
                    false,
                )
            }
            TextEditingCommand::Navigate {
                target: TextNavigation::DocumentStart,
                ..
            } => (KeyCommand::Navigate(NavigationKey::Home), false),
            TextEditingCommand::Navigate {
                target: TextNavigation::DocumentEnd,
                ..
            } => (KeyCommand::Navigate(NavigationKey::End), false),
            TextEditingCommand::DeleteBackward { word } => (KeyCommand::Backspace, word),
            TextEditingCommand::DeleteForward { word } => (KeyCommand::Delete, word),
            TextEditingCommand::Enter => (KeyCommand::Enter, false),
            TextEditingCommand::Copy | TextEditingCommand::Cut | TextEditingCommand::Paste => {
                unreachable!("clipboard commands return before text editing")
            }
        };
        let extend = matches!(
            editing_command,
            TextEditingCommand::Navigate { extend: true, .. }
        );
        let result = {
            let mut inner = self.shared.lock().expect("host inner");
            apply_input_command(
                &mut inner,
                command,
                TextKeyModifiers {
                    shift: extend,
                    word,
                },
            )
        };
        let Some((node, outcome, visual_changed, value)) = result else {
            return false;
        };
        match outcome {
            CommandOutcome::Changed => {
                if let Some(value) = value {
                    let callback = self
                        .shared
                        .lock()
                        .expect("host inner")
                        .v1_listeners
                        .get(&crate::ListenerKey::new(
                            node.raw(),
                            nui_core::EventId::Change as u32,
                        ))
                        .copied();
                    self.dispatcher.enqueue(
                        DispatchQueue::Platform,
                        HostUiEvent::Change {
                            node,
                            value,
                            callback,
                        },
                    );
                }
                let _ = self.relayout_and_reveal_input(node);
                self.redraw_pending = true;
                false
            }
            CommandOutcome::Submit => self.key_enter(),
            CommandOutcome::Handled => {
                let scroll_changed = visual_changed && self.relayout_and_reveal_input(node);
                self.redraw_pending |= visual_changed || scroll_changed;
                false
            }
            CommandOutcome::Unhandled => false,
        }
    }

    fn key_command_with_repeat(
        &mut self,
        key: KeyInput,
        modifiers: PlatformKeyModifiers,
        repeat: bool,
    ) -> bool {
        if repeat && matches!(key, KeyInput::Space | KeyInput::Enter) {
            let focused_pressable = {
                let inner = self.shared.lock().expect("host inner");
                inner.focused.is_some_and(|focused| {
                    !inner.inputs.contains_key(&focused.raw())
                        && (inner.click_tokens.contains_key(&focused.raw())
                            || inner.v1_listeners.contains_key(&crate::ListenerKey::new(
                                focused.raw(),
                                nui_core::EventId::Click as u32,
                            )))
                })
            };
            if focused_pressable {
                return false;
            }
        }
        self.key_command(key, modifiers)
    }

    fn key_command_released(&mut self, key: KeyInput, _modifiers: PlatformKeyModifiers) -> bool {
        if !matches!(key, KeyInput::Space | KeyInput::Enter) {
            return false;
        }
        let changed = {
            let mut inner = self.shared.lock().expect("host inner");
            let changed = inner.focused.is_some_and(|focused| {
                if inner.inputs.contains_key(&focused.raw())
                    || !(inner.click_tokens.contains_key(&focused.raw())
                        || inner.v1_listeners.contains_key(&crate::ListenerKey::new(
                            focused.raw(),
                            nui_core::EventId::Click as u32,
                        )))
                {
                    return false;
                }
                inner
                    .interactions
                    .get_mut(&focused.raw())
                    .is_some_and(nui_core::InteractionModel::keyboard_release)
            });
            if changed {
                NuiHost::mark_active_changed(&mut inner);
            }
            changed
        };
        self.redraw_pending |= changed;
        false
    }

    fn tick(&mut self) -> bool {
        self.flush_pending_ui_events();
        let mut metrics = self.frame_metrics.begin_tick();
        let mut redraw = std::mem::take(&mut self.redraw_pending);
        let mut events = VecDeque::new();
        self.scheduler
            .begin_tick()
            .expect("window tick is not nested");
        for expected in Scheduler::phases() {
            let phase = self.scheduler.enter_next().expect("valid tick phase");
            debug_assert_eq!(&phase, expected);
            match phase {
                TickPhase::PlatformEvents => {
                    metrics
                        .begin_phase(FramePhase::PlatformEvents)
                        .expect("metrics phase starts once");
                    let accessibility = self.accessibility_dispatcher.drain_tick();
                    let accessibility_count = accessibility.len();
                    for item in accessibility {
                        redraw |= self.apply_accessibility_action(item.payload);
                    }
                    let drained = self.dispatcher.drain_tick();
                    metrics.record_dispatched_events(
                        u64::try_from(drained.len())
                            .unwrap_or(u64::MAX)
                            .saturating_add(u64::try_from(accessibility_count).unwrap_or(u64::MAX)),
                    );
                    events.extend(drained.into_iter().map(|item| item.payload));
                    metrics
                        .end_phase(FramePhase::PlatformEvents)
                        .expect("metrics phase matches");
                }
                TickPhase::SystemCompletion => {
                    metrics
                        .begin_phase(FramePhase::SystemCompletion)
                        .expect("metrics phase starts once");
                    redraw |= (self.system_completion)(&self.scheduler);
                    metrics
                        .end_phase(FramePhase::SystemCompletion)
                        .expect("metrics phase matches");
                }
                TickPhase::FrameworkMicrotasks => {
                    // Native handlers only enqueue. Perry callbacks run here.
                    // Start the phase before entering Perry so callback work is included.
                    metrics
                        .begin_phase(FramePhase::FrameworkMicrotasks)
                        .expect("metrics phase starts once");
                    let _ran_microtasks = (self.framework_microtasks)();
                    if !events.is_empty() {
                        while let Some(event) = events.pop_front() {
                            redraw |= (self.on_event)(event);
                        }
                    }
                    metrics
                        .end_phase(FramePhase::FrameworkMicrotasks)
                        .expect("metrics phase matches");
                }
                TickPhase::HostMutationCommit => {
                    // Commit once after the complete event queue is delivered.
                    metrics
                        .begin_phase(FramePhase::HostMutationCommit)
                        .expect("metrics phase starts once");
                    redraw |= (self.after_events)();
                    let commit_activity = {
                        let mut inner = self.shared.lock().expect("host inner");
                        std::mem::take(&mut inner.commit_activity)
                    };
                    metrics.record_commit_activity(
                        commit_activity.attempts,
                        commit_activity.commits,
                        commit_activity.mutation_commands,
                    );
                    metrics
                        .end_phase(FramePhase::HostMutationCommit)
                        .expect("metrics phase matches");
                }
                _ => {}
            }
            self.scheduler.exit_phase().expect("valid phase exit");
        }
        self.scheduler.end_tick().expect("complete window tick");
        self.frame_metrics.finish_tick(metrics, redraw);
        redraw
    }

    fn surface_ready(&mut self, generation: SurfaceGeneration) {
        self.render_cache.set_surface_generation(generation);
        self.frame_metrics.set_surface_generation(generation);
        if let Some(kind) = self.window_lifecycle.ready() {
            let event = self.window_lifecycle_event(kind, Some(generation));
            self.dispatcher.enqueue(DispatchQueue::Platform, event);
        }
    }

    fn surface_suspended(&mut self) {
        self.invalidate_surface_resources();
        if let Some(kind) = self.window_lifecycle.suspended() {
            let event = self.window_lifecycle_event(kind, None);
            self.dispatcher.enqueue(DispatchQueue::Platform, event);
        }
    }

    fn surface_lost(&mut self, failure: &PlatformFailure) {
        self.invalidate_surface_resources();
        if let Some(kind) = self.window_lifecycle.suspended() {
            let event = self.window_lifecycle_event(kind, None);
            self.dispatcher.enqueue(DispatchQueue::Platform, event);
        }
        match failure.stage() {
            PlatformFailureStage::AcquireFrame => self.frame_metrics.publish_acquire_drop(),
            PlatformFailureStage::PresentFrame => self.frame_metrics.finish_present_drop(),
            PlatformFailureStage::CreateWindow
            | PlatformFailureStage::CreateContext
            | PlatformFailureStage::CreateSurface
            | PlatformFailureStage::ConfigureSurface
            | PlatformFailureStage::ResizeSurface => {}
        }
        self.report_platform_failure(failure);
    }

    fn frame_presenting(&mut self, generation: SurfaceGeneration) {
        self.frame_metrics.begin_present(generation);
    }

    fn frame_presented(&mut self, generation: SurfaceGeneration) {
        self.frame_metrics.finish_presented(generation);
    }

    fn close_requested(&mut self) {
        let Some(kind) = self.window_lifecycle.close_requested() else {
            return;
        };
        self.frame_metrics.finish_session();
        let event = self.window_lifecycle_event(kind, None);
        let _ = (self.on_event)(event);
        (self.on_close)();
    }

    fn report_platform_failure(&mut self, failure: &PlatformFailure) {
        self.errors
            .report(crate::platform_failure_nexa_error(failure));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use nui_app_runtime::{
        DispatchQueue, ErrorSupervisor, FrameClock, FrameDropStage, FrameMetricsObserver,
        FrameOutcome, ManualFrameClock, TickPhase,
    };
    use nui_core::protocol::common::ErrorSeverity;
    use nui_core::{
        Arena, ColorRgba, CompositionKind, FocusManager, NodeId, NodeType, PropagationPhase,
        PropertyId, ResourceId, SemanticAction, SemanticRole, Semantics, SurfaceGeneration,
    };
    use nui_platform_winit::{
        text_editing_command, AccessibilityActionRequest, DesktopPlatform, ImeState, KeyInput,
        KeyModifiers as PlatformKeyModifiers, PlatformFailure, PlatformFailureStage,
        TextEditingCommand, WindowApp,
    };
    use nui_render_skia::BackendResourceCache;
    use nui_system_core::{ClipboardBackend, ClipboardError};
    use nui_text::{
        FontDatabase, FontFaceDescriptor, FontRequest, FontSource, FontStyle, GlyphCoverage,
        Script, TextSelection,
    };
    use serde::Deserialize;

    use super::{
        HostInner, HostUiEvent, HostWindowApp, NuiHost, WindowLifecycleEvent, WindowLifecycleKind,
        WindowLifecycleState,
    };
    use crate::frame_metrics::FrameMetricsState;
    use crate::host::{CommitActivity, ImageAsset};

    const G3A11_SCENARIO_JSON: &str = include_str!("../../../examples/input-e2e/scenario.json");
    const G3B05_SCENARIO_JSON: &str = include_str!("../../../examples/semantic-e2e/scenario.json");

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct G3a11Scenario {
        schema_version: u32,
        platforms: Vec<G3a11Platform>,
        single_line: G3a11SingleLine,
        multiline: G3a11Multiline,
        clipboard: G3a11Clipboard,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct G3a11Platform {
        id: String,
        primary_modifier: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct G3a11SingleLine {
        initial: String,
        preedit: String,
        commit: String,
        expected: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct G3a11Multiline {
        initial: String,
        preedit: String,
        replacement_preedit: String,
        commit: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct G3a11Clipboard {
        initial: String,
        selection: G3a11Selection,
        selected_text: String,
        after_cut: String,
        shortcuts: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct G3a11Selection {
        anchor: usize,
        focus: usize,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct G3b05Scenario {
        schema_version: u32,
        platforms: Vec<G3b05Platform>,
        queries: Vec<G3b05Query>,
        assertions: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct G3b05Platform {
        id: String,
        primary_modifier: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct G3b05Query {
        role: String,
        name: String,
        actions: Vec<String>,
        set_value: Option<String>,
    }

    fn g3a11_scenario() -> G3a11Scenario {
        let scenario: G3a11Scenario =
            serde_json::from_str(G3A11_SCENARIO_JSON).expect("G3A-11 scenario fixture must parse");
        assert_eq!(scenario.schema_version, 1);
        scenario
    }

    fn g3b05_scenario() -> G3b05Scenario {
        let scenario: G3b05Scenario =
            serde_json::from_str(G3B05_SCENARIO_JSON).expect("G3B-05 scenario fixture must parse");
        assert_eq!(scenario.schema_version, 1);
        scenario
    }

    fn g3b05_role(value: &str) -> SemanticRole {
        match value {
            "Button" => SemanticRole::Button,
            "TextInput" => SemanticRole::TextInput,
            value => panic!("unsupported G3B-05 role fixture: {value}"),
        }
    }

    fn g3b05_action(value: &str) -> SemanticAction {
        match value {
            "Invoke" => SemanticAction::Invoke,
            "Focus" => SemanticAction::Focus,
            "SetValue" => SemanticAction::SetValue,
            value => panic!("unsupported G3B-05 action fixture: {value}"),
        }
    }

    fn g3a11_platform_case(fixture: &G3a11Platform) -> (DesktopPlatform, PlatformKeyModifiers) {
        match (fixture.id.as_str(), fixture.primary_modifier.as_str()) {
            ("macos", "Meta") => (
                DesktopPlatform::MacOs,
                PlatformKeyModifiers {
                    meta: true,
                    ..PlatformKeyModifiers::default()
                },
            ),
            ("windows", "Control") => (
                DesktopPlatform::Windows,
                PlatformKeyModifiers {
                    control: true,
                    ..PlatformKeyModifiers::default()
                },
            ),
            pair => panic!("unsupported G3A-11 platform fixture: {pair:?}"),
        }
    }

    fn g3a11_shortcut(name: &str) -> (KeyInput, TextEditingCommand) {
        match name {
            "Copy" => (KeyInput::Copy, TextEditingCommand::Copy),
            "Cut" => (KeyInput::Cut, TextEditingCommand::Cut),
            "Paste" => (KeyInput::Paste, TextEditingCommand::Paste),
            value => panic!("unsupported G3A-11 shortcut fixture: {value}"),
        }
    }

    fn metrics_test_app(
        shared: Arc<Mutex<HostInner>>,
        root: NodeId,
        errors: ErrorSupervisor,
        observer: FrameMetricsObserver,
    ) -> HostWindowApp {
        metrics_test_app_with_clock(
            shared,
            root,
            errors,
            observer,
            Arc::new(nui_app_runtime::SystemFrameClock::new()),
        )
    }

    fn metrics_test_app_with_clock(
        shared: Arc<Mutex<HostInner>>,
        root: NodeId,
        errors: ErrorSupervisor,
        observer: FrameMetricsObserver,
        clock: Arc<dyn FrameClock>,
    ) -> HostWindowApp {
        HostWindowApp {
            shared,
            root,
            errors,
            dispatcher: nui_app_runtime::Dispatcher::new(),
            accessibility_dispatcher: nui_app_runtime::Dispatcher::new(),
            scheduler: nui_app_runtime::Scheduler::new(),
            install_runtime_waker: Box::new(|_| {}),
            system_completion: Box::new(|_| false),
            framework_microtasks: Box::new(|| false),
            on_event: Box::new(|_| false),
            after_events: Box::new(|| false),
            on_close: Box::new(|| {}),
            viewport: (16.0, 16.0),
            redraw_pending: false,
            render_cache: BackendResourceCache::new(),
            window_lifecycle: WindowLifecycleState::default(),
            frame_metrics: FrameMetricsState::with_clock(observer, clock),
        }
    }

    fn accessibility_test_fixture() -> (NuiHost, HostWindowApp, NodeId, NodeId) {
        let host = accessibility_test_host();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        let button_text = host.create_text("Save");
        let input = host.create_node(NodeType::View);
        let input_text = host.create_text("A");
        for (node, width, height) in [
            (root, 320.0, 160.0),
            (button, 120.0, 36.0),
            (input, 200.0, 36.0),
        ] {
            host.set_number(node, PropertyId::Width, width);
            host.set_number(node, PropertyId::Height, height);
        }
        host.insert(button, root);
        host.insert(button_text, button);
        host.insert(input, root);
        host.insert(input_text, input);
        host.add_click_listener(button, 7);
        host.queue_register_button(button).expect("register button");
        host.commit_pending()
            .expect("button commit")
            .expect("button receipt");
        host.register_input(input, input_text, "Title");
        host.layout(320.0, 160.0);
        let app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        (host, app, button, input)
    }

    fn semantic_e2e_test_fixture() -> (NuiHost, HostWindowApp) {
        let host = accessibility_test_host();
        let root = host.create_node(NodeType::View);
        let save = host.create_node(NodeType::View);
        let save_text = host.create_text("Save");
        let title = host.create_node(NodeType::View);
        let title_text = host.create_text("Draft");
        let body = host.create_node(NodeType::Scroll);
        let body_text = host.create_text("First note");
        for (node, width, height) in [
            (root, 560.0, 420.0),
            (save, 120.0, 36.0),
            (title, 512.0, 36.0),
            (body, 512.0, 220.0),
        ] {
            host.set_number(node, PropertyId::Width, width);
            host.set_number(node, PropertyId::Height, height);
        }
        host.insert(title, root);
        host.insert(title_text, title);
        host.insert(body, root);
        host.insert(body_text, body);
        host.insert(save, root);
        host.insert(save_text, save);
        host.add_click_listener(save, 7);
        host.queue_register_button(save)
            .expect("register Save button");
        host.commit_pending()
            .expect("Save commit")
            .expect("Save receipt");
        host.register_input(title, title_text, "Title");
        host.register_input(body, body_text, "Body");
        host.layout(560.0, 420.0);
        let app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        (host, app)
    }

    fn accessibility_test_host() -> NuiHost {
        let mut database = FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Ahem Accessibility Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars((0x20_u8..=0x7e).map(char::from)),
            )
            .expect("fixture descriptor")
            .with_scripts([Script::Latin])
            .with_source(
                FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0)
                    .expect("fixture face parses"),
            ),
        );
        NuiHost::with_fonts(database, FontRequest::new(["Ahem Accessibility Fixture"]))
            .expect("fixture host")
    }

    #[test]
    fn host_window_app_resizes_adapter_root_and_window_content_on_each_frame() {
        let host = accessibility_test_host();
        let root = host.create_node(NodeType::Root);
        let window = host.create_node(NodeType::View);
        let content = host.create_node(NodeType::View);
        host.set_number(root, PropertyId::AlignItems, 3.0);
        host.set_number(window, PropertyId::AlignItems, 3.0);
        host.set_number(window, PropertyId::FlexGrow, 1.0);
        host.set_number(content, PropertyId::FlexGrow, 1.0);
        host.insert(window, root);
        host.insert(content, window);
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        let mut first = vec![0_u32; 320 * 180];
        assert!(app.paint_frame(&mut first, 320, 180, 1.0));
        let mut second = vec![0_u32; 640 * 420];
        assert!(app.paint_frame(&mut second, 640, 420, 1.0));

        let inner = host.inner.lock().expect("host inner");
        for node in [root, window, content] {
            let layout = inner.arena.get(node).expect("adapter tree node").layout;
            assert_eq!((layout.width, layout.height), (640.0, 420.0));
        }
    }

    #[test]
    fn g3b04_accessibility_actions_wait_for_tick_and_route_once() {
        let (host, mut app, button, input) = accessibility_test_fixture();
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        app.on_event = Box::new(move |event| {
            observed.lock().expect("events").push(event);
            false
        });
        let mut pixels = vec![0_u32; 320 * 160];
        assert!(app.paint_frame(&mut pixels, 320, 160, 1.0));

        assert!(!app.accessibility_action(AccessibilityActionRequest {
            target: button,
            action: SemanticAction::Invoke,
            value: None,
        }));
        assert!(events.lock().expect("events").is_empty());
        app.tick();
        assert_eq!(
            events
                .lock()
                .expect("events")
                .iter()
                .filter(|event| matches!(event, HostUiEvent::Click { node, .. } if *node == button))
                .count(),
            1
        );

        assert_eq!(
            crate::host::read_input_value(&host.inner.lock().expect("host inner"), input),
            "A"
        );
        assert!(!app.accessibility_action(AccessibilityActionRequest {
            target: input,
            action: SemanticAction::SetValue,
            value: Some("B".to_owned()),
        }));
        assert_eq!(
            crate::host::read_input_value(&host.inner.lock().expect("host inner"), input),
            "A"
        );
        app.tick();
        assert_eq!(
            crate::host::read_input_value(&host.inner.lock().expect("host inner"), input),
            "B"
        );
        assert_eq!(
            events
                .lock()
                .expect("events")
                .iter()
                .filter(|event| matches!(event, HostUiEvent::Change { node, value, .. } if *node == input && value == "B"))
                .count(),
            1
        );

        assert!(!app.accessibility_action(AccessibilityActionRequest {
            target: input,
            action: SemanticAction::Focus,
            value: None,
        }));
        assert_eq!(host.inner.lock().expect("host inner").focused, None);
        app.tick();
        assert_eq!(host.inner.lock().expect("host inner").focused, Some(input));
    }

    #[test]
    fn g3b04_accessibility_actions_ignore_stale_and_disabled_targets() {
        let (host, mut app, button, _) = accessibility_test_fixture();
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        app.on_event = Box::new(move |event| {
            observed.lock().expect("events").push(event);
            false
        });
        let mut pixels = vec![0_u32; 320 * 160];
        assert!(app.paint_frame(&mut pixels, 320, 160, 1.0));
        let stale = NodeId::new(button.slot().saturating_add(100), button.generation());
        app.accessibility_action(AccessibilityActionRequest {
            target: stale,
            action: SemanticAction::Invoke,
            value: None,
        });
        app.tick();
        assert!(events.lock().expect("events").is_empty());

        host.set_number(button, PropertyId::Disabled, 1.0);
        host.layout(320.0, 160.0);
        assert!(app.paint_frame(&mut pixels, 320, 160, 1.0));
        app.accessibility_action(AccessibilityActionRequest {
            target: button,
            action: SemanticAction::Invoke,
            value: None,
        });
        app.tick();
        assert!(events.lock().expect("events").is_empty());
    }

    #[test]
    fn g3b05_semantic_role_name_queries_drive_accessibility_actions() {
        let scenario = g3b05_scenario();
        assert_eq!(
            scenario
                .platforms
                .iter()
                .map(|platform| (platform.id.as_str(), platform.primary_modifier.as_str()))
                .collect::<Vec<_>>(),
            [("macos", "Meta"), ("windows", "Control")]
        );
        assert!(scenario
            .assertions
            .iter()
            .any(|assertion| assertion == "no query uses screen coordinates"));

        let (host, mut app) = semantic_e2e_test_fixture();
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        app.on_event = Box::new(move |event| {
            observed.lock().expect("events").push(event);
            false
        });
        let mut pixels = vec![0_u32; 560 * 420];
        assert!(app.paint_frame(&mut pixels, 560, 420, 1.0));
        let snapshot = host.semantic_snapshot();
        let mut resolved = Vec::new();
        for query in &scenario.queries {
            let node = snapshot
                .nodes
                .iter()
                .find(|node| {
                    node.role == g3b05_role(&query.role)
                        && node.name.as_deref() == Some(query.name.as_str())
                })
                .expect("semantic role/name query must resolve");
            assert_eq!(
                node.actions,
                query
                    .actions
                    .iter()
                    .map(|action| g3b05_action(action))
                    .collect::<Vec<_>>()
            );
            resolved.push((query, node.id));
        }

        for (query, target) in resolved {
            for action in &query.actions {
                let action = g3b05_action(action);
                let value = (action == SemanticAction::SetValue)
                    .then(|| query.set_value.clone().expect("SetValue fixture value"));
                assert!(!app.accessibility_action(AccessibilityActionRequest {
                    target,
                    action,
                    value,
                }));
                app.tick();
            }
            if let Some(expected) = &query.set_value {
                assert_eq!(
                    crate::host::read_input_value(&host.inner.lock().expect("host inner"), target),
                    expected.as_str()
                );
            }
        }

        let events = events.lock().expect("events");
        assert!(events
            .iter()
            .any(|event| matches!(event, HostUiEvent::Click { .. })));
        for expected in ["Meeting notes", "Agenda"] {
            assert!(events.iter().any(
                |event| matches!(event, HostUiEvent::Change { value, .. } if value == expected)
            ));
        }
    }

    fn text_area_test_host() -> NuiHost {
        let mut database = FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Ahem Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("ABC ".chars()),
            )
            .expect("fixture descriptor")
            .with_scripts([Script::Latin])
            .with_source(
                FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0)
                    .expect("fixture face parses"),
            ),
        );
        NuiHost::with_fonts(database, FontRequest::new(["Ahem Fixture"])).expect("fixture host")
    }

    fn mixed_bidi_text_host() -> NuiHost {
        let mut database = FontDatabase::new();
        database.register_face(
            FontFaceDescriptor::new(
                "Ahem Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("A ".chars()),
            )
            .expect("fixture descriptor")
            .with_scripts([Script::Latin])
            .with_source(
                FontSource::new(Arc::<[u8]>::from(font_test_data::AHEM), 0)
                    .expect("fixture face parses"),
            ),
        );
        database.register_face(
            FontFaceDescriptor::new(
                "Noto Sans Arabic Fixture",
                FontStyle::default(),
                GlyphCoverage::from_chars("مرحبا ".chars()),
            )
            .expect("Arabic fixture descriptor")
            .with_scripts([Script::Arabic])
            .with_source(
                FontSource::new(
                    Arc::<[u8]>::from(
                        &include_bytes!("../../nui-text/tests/fixtures/NotoSansArabic.ttf")[..],
                    ),
                    0,
                )
                .expect("Arabic fixture face parses"),
            ),
        );
        NuiHost::with_fonts(
            database,
            FontRequest::new(["Ahem Fixture", "Noto Sans Arabic Fixture"]),
        )
        .expect("mixed-BiDi fixture host")
    }

    fn cjk_emoji_text_host() -> NuiHost {
        let mut database = FontDatabase::new();
        for (family, script, coverage, source) in [
            (
                "Noto Serif TC Fixture",
                Script::Han,
                "你們",
                font_test_data::NOTOSERIFTC_AUTOHINT_METRICS,
            ),
            (
                "Noto Handwriting Fixture",
                Script::Common,
                "✍🏽‍️",
                font_test_data::NOTO_HANDWRITING_SBIX,
            ),
            (
                "Noto Serif Fixture",
                Script::Latin,
                "e\u{301}",
                font_test_data::NOTOSERIF_AUTOHINT_SHAPING,
            ),
        ] {
            database.register_face(
                FontFaceDescriptor::new(
                    family,
                    FontStyle::default(),
                    GlyphCoverage::from_chars(coverage.chars()),
                )
                .expect("multilingual fixture descriptor")
                .with_scripts([script])
                .with_source(
                    FontSource::new(Arc::<[u8]>::from(source), 0)
                        .expect("multilingual fixture face parses"),
                ),
            );
        }
        NuiHost::with_fonts(
            database,
            FontRequest::new([
                "Noto Serif TC Fixture",
                "Noto Handwriting Fixture",
                "Noto Serif Fixture",
            ]),
        )
        .expect("CJK/Emoji fixture host")
    }

    #[derive(Default)]
    struct MemoryClipboard {
        text: String,
        fail_read: bool,
        fail_write: bool,
    }

    impl ClipboardBackend for MemoryClipboard {
        fn read_text(&mut self) -> Result<String, ClipboardError> {
            if self.fail_read {
                return Err(ClipboardError::Operation(
                    "injected read failure".to_owned(),
                ));
            }
            Ok(self.text.clone())
        }

        fn write_text(&mut self, text: &str) -> Result<(), ClipboardError> {
            if self.fail_write {
                return Err(ClipboardError::Operation(
                    "injected write failure".to_owned(),
                ));
            }
            self.text = text.to_owned();
            Ok(())
        }
    }

    #[test]
    fn ime_cursor_area_tracks_input_and_text_area_focus() {
        let host = text_area_test_host();
        let root = host.create_node(NodeType::View);
        let input = host.create_node(NodeType::View);
        let input_text = host.create_text("AB");
        let text_area = host.create_node(NodeType::Scroll);
        let text_area_text = host.create_text("ABC ABC");
        host.set_number(root, PropertyId::Width, 200.0);
        host.set_number(root, PropertyId::Height, 120.0);
        host.set_number(input, PropertyId::Width, 200.0);
        host.set_number(input, PropertyId::Height, 40.0);
        host.set_number(input, PropertyId::Padding, 7.0);
        host.set_number(input_text, PropertyId::FontSize, 20.0);
        host.set_number(text_area, PropertyId::Width, 200.0);
        host.set_number(text_area, PropertyId::Height, 60.0);
        host.set_number(text_area, PropertyId::Padding, 7.0);
        host.set_number(text_area_text, PropertyId::FontSize, 20.0);
        host.insert(input, root);
        host.insert(input_text, input);
        host.insert(text_area, root);
        host.insert(text_area_text, text_area);
        host.register_input(input, input_text, "Title");
        host.register_input(text_area, text_area_text, "Body");
        host.layout(200.0, 120.0);

        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        assert_eq!(app.ime_state(), ImeState::Disabled);

        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(input, &arena, Some(root)));
            let focused = inner.focus.focused();
            crate::host::transition_focus(&mut inner, focused);
        }
        let input_bounds = host
            .composition_bounds(input)
            .expect("input paragraph caret bounds");
        let ImeState::Enabled {
            cursor_area: Some(input_area),
        } = app.ime_state()
        else {
            panic!("focused input must enable IME with paragraph geometry");
        };
        assert!((input_area.x() - input_bounds.x).abs() < 0.01);
        assert!((input_area.y() - input_bounds.y).abs() < 0.01);
        assert!((input_area.width() - input_bounds.width).abs() < 0.01);
        assert!((input_area.height() - input_bounds.height).abs() < 0.01);

        host.set_text(input_text, "ABC");
        assert_eq!(
            app.ime_state(),
            ImeState::Enabled { cursor_area: None },
            "a focused editor stays IME-enabled while its layout snapshot is stale"
        );
        host.layout(200.0, 120.0);

        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(text_area, &arena, Some(root)));
            let focused = inner.focus.focused();
            crate::host::transition_focus(&mut inner, focused);
        }
        let text_area_bounds = host
            .composition_bounds(text_area)
            .expect("text area paragraph caret bounds");
        let ImeState::Enabled {
            cursor_area: Some(text_area_ime),
        } = app.ime_state()
        else {
            panic!("focused text area must enable IME with paragraph geometry");
        };
        assert!((text_area_ime.x() - text_area_bounds.x).abs() < 0.01);
        assert!((text_area_ime.y() - text_area_bounds.y).abs() < 0.01);
        assert!((text_area_ime.width() - text_area_bounds.width).abs() < 0.01);
        assert!((text_area_ime.height() - text_area_bounds.height).abs() < 0.01);

        {
            let mut inner = host.inner.lock().expect("host inner");
            inner.focus.clear_focus();
            crate::host::transition_focus(&mut inner, None);
        }
        assert_eq!(app.ime_state(), ImeState::Disabled);
    }

    #[test]
    fn g3a11_cjk_emoji_preedit_tracks_input_text_area_bounds_scroll_and_fifo() {
        let scenario = g3a11_scenario();
        let single_line = &scenario.single_line;
        let multiline = &scenario.multiline;
        let host = cjk_emoji_text_host();
        let root = host.create_node(NodeType::View);
        let input = host.create_node(NodeType::View);
        let input_text = host.create_text(&single_line.initial);
        let text_area = host.create_node(NodeType::Scroll);
        let initial_body = multiline.initial.as_str();
        let text_area_text = host.create_text(initial_body);
        host.set_number(root, PropertyId::Width, 320.0);
        host.set_number(root, PropertyId::Height, 160.0);
        host.set_number(input, PropertyId::Width, 280.0);
        host.set_number(input, PropertyId::Height, 40.0);
        host.set_number(input_text, PropertyId::FontSize, 20.0);
        host.set_number(text_area, PropertyId::Width, 280.0);
        host.set_number(text_area, PropertyId::Height, 36.0);
        host.set_number(text_area_text, PropertyId::FontSize, 20.0);
        host.insert(input, root);
        host.insert(input_text, input);
        host.insert(text_area, root);
        host.insert(text_area_text, text_area);
        host.register_input(input, input_text, "Title");
        host.register_input(text_area, text_area_text, "Body");
        host.layout(320.0, 160.0);

        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (320.0, 160.0);
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(input, &arena, Some(root)));
            let focused = inner.focus.focused();
            crate::host::transition_focus(&mut inner, focused);
        }

        assert!(app.ime_start());
        assert!(app.ime_preedit(&single_line.preedit, Some((0, single_line.preedit.len()))));
        let state = host
            .text_input_state(input)
            .expect("single-line preedit state");
        assert_eq!(state.text, single_line.expected);
        let composition = state.composition.expect("single-line composition range");
        assert_eq!((composition.start, composition.end), (1, 2));
        assert_eq!((state.selection.anchor, state.selection.focus), (1, 2));
        let ImeState::Enabled {
            cursor_area: Some(input_area),
        } = app.ime_state()
        else {
            panic!("single-line preedit must retain candidate bounds");
        };
        assert!(input_area.width().is_finite() && input_area.width() > 0.0);
        assert!(input_area.height().is_finite() && input_area.height() > 0.0);
        assert!(app.ime_preedit("", None));
        assert!(app.ime_commit(&single_line.commit));
        let input_events = app.dispatcher.drain_tick();
        let input_kinds = input_events
            .iter()
            .filter_map(|item| match &item.payload {
                HostUiEvent::Composition { event, .. } => Some(event.kind),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            input_kinds,
            vec![
                CompositionKind::Start,
                CompositionKind::Update,
                CompositionKind::Update,
                CompositionKind::Commit,
            ]
        );
        assert!(matches!(
            input_events.last().map(|item| &item.payload),
            Some(HostUiEvent::Change { node, value, .. })
                if *node == input && value == &single_line.expected
        ));

        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(text_area, &arena, Some(root)));
            let focused = inner.focus.focused();
            crate::host::transition_focus(&mut inner, focused);
        }
        let emoji = multiline.preedit.as_str();
        assert!(app.ime_start());
        assert!(app.ime_preedit(emoji, Some((0, emoji.len()))));
        let emoji_state = host
            .text_input_state(text_area)
            .expect("multiline Emoji preedit state");
        assert_eq!(emoji_state.text, format!("{initial_body}{emoji}"));
        let composition = emoji_state
            .composition
            .expect("multiline composition range");
        let start = u32::try_from(initial_body.encode_utf16().count()).unwrap();
        let end = start + u32::try_from(emoji.encode_utf16().count()).unwrap();
        assert_eq!((composition.start, composition.end), (start, end));
        let ImeState::Enabled {
            cursor_area: Some(emoji_area),
        } = app.ime_state()
        else {
            panic!("multiline preedit must retain candidate bounds");
        };
        assert!(emoji_area.width().is_finite() && emoji_area.width() > 0.0);
        assert!(emoji_area.height().is_finite() && emoji_area.height() > 0.0);
        assert!(
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get(text_area)
                .expect("text area")
                .style
                .scroll_offset_y
                > 0.0,
            "preedit caret must scroll into the TextArea viewport"
        );
        assert!(app.ime_preedit(
            &multiline.replacement_preedit,
            Some((0, multiline.replacement_preedit.len()))
        ));
        assert!(app.ime_commit(&multiline.commit));
        let expected_body = format!("{initial_body}{}", multiline.commit);
        let text_area_events = app.dispatcher.drain_tick();
        assert_eq!(
            text_area_events
                .iter()
                .filter(|item| matches!(item.payload, HostUiEvent::Change { .. }))
                .count(),
            1
        );
        assert!(matches!(
            text_area_events.last().map(|item| &item.payload),
            Some(HostUiEvent::Change { node, value, .. })
                if *node == text_area && value == &expected_body
        ));
        assert!(text_area_events.iter().all(|item| !matches!(
            item.payload,
            HostUiEvent::Composition {
                event: nui_core::CompositionEvent {
                    kind: CompositionKind::Cancel,
                    ..
                },
                ..
            }
        )));

        assert!(app.ime_start());
        assert!(app.ime_preedit(
            &multiline.replacement_preedit,
            Some((0, multiline.replacement_preedit.len()))
        ));
        assert!(app.ime_cancel());
        let cancel_events = app.dispatcher.drain_tick();
        assert_eq!(
            cancel_events
                .iter()
                .filter_map(|item| match &item.payload {
                    HostUiEvent::Composition { event, .. } => Some(event.kind),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            vec![
                CompositionKind::Start,
                CompositionKind::Update,
                CompositionKind::Cancel,
            ]
        );
        assert!(cancel_events
            .iter()
            .all(|item| !matches!(item.payload, HostUiEvent::Change { .. })));
    }

    #[test]
    fn g3a11_macos_and_windows_clipboard_commands_preserve_multilingual_cross_line_selection() {
        let scenario = g3a11_scenario();
        let fixture = &scenario.clipboard;
        let mut mac = None;
        let mut windows = None;
        for platform_fixture in &scenario.platforms {
            let (platform, modifiers) = g3a11_platform_case(platform_fixture);
            for shortcut in &fixture.shortcuts {
                let (key, expected) = g3a11_shortcut(shortcut);
                assert_eq!(
                    text_editing_command(key, modifiers, platform),
                    Some(expected)
                );
            }
            match platform {
                DesktopPlatform::MacOs => mac = Some(modifiers),
                DesktopPlatform::Windows => windows = Some(modifiers),
                DesktopPlatform::Other => panic!("G3A-11 fixture only supports desktop targets"),
            }
        }
        let mac = mac.expect("macOS G3A-11 fixture");
        let windows = windows.expect("Windows G3A-11 fixture");

        let host = cjk_emoji_text_host();
        let root = host.create_node(NodeType::View);
        let text_area = host.create_node(NodeType::Scroll);
        let text = host.create_text(&fixture.initial);
        host.set_number(root, PropertyId::Width, 320.0);
        host.set_number(root, PropertyId::Height, 180.0);
        host.set_number(text_area, PropertyId::Width, 280.0);
        host.set_number(text_area, PropertyId::Height, 120.0);
        host.set_number(text, PropertyId::FontSize, 20.0);
        host.insert(text_area, root);
        host.insert(text, text_area);
        host.register_input(text_area, text, "Body");
        host.layout(320.0, 180.0);
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(text_area, &arena, Some(root)));
            let focused = inner.focus.focused();
            crate::host::transition_focus(&mut inner, focused);
            inner
                .inputs
                .get_mut(&text_area.raw())
                .expect("text area")
                .editor
                .set_selection(TextSelection::new(
                    fixture.selection.anchor,
                    fixture.selection.focus,
                ))
                .expect("reversed cross-line selection");
        }
        let errors = ErrorSupervisor::default();
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            errors,
            FrameMetricsObserver::default(),
        );
        app.viewport = (320.0, 180.0);
        let mut clipboard = MemoryClipboard::default();

        let copy = text_editing_command(KeyInput::Copy, mac, DesktopPlatform::MacOs)
            .expect("macOS copy command");
        assert_eq!(copy, TextEditingCommand::Copy);
        assert!(!app.handle_clipboard_command(copy, &mut clipboard));
        assert_eq!(clipboard.text, fixture.selected_text);
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .inputs
                .get(&text_area.raw())
                .expect("text area")
                .editor
                .value(),
            fixture.initial
        );
        assert_eq!(app.dispatcher.pending_count(), 0);

        let cut = text_editing_command(KeyInput::Cut, windows, DesktopPlatform::Windows)
            .expect("Windows cut command");
        assert!(!app.handle_clipboard_command(cut, &mut clipboard));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .inputs
                .get(&text_area.raw())
                .expect("text area")
                .editor
                .value(),
            fixture.after_cut
        );
        let cut_events = app.dispatcher.drain_tick();
        assert!(matches!(
            cut_events.as_slice(),
            [nui_app_runtime::DispatchItem { payload: HostUiEvent::Change { node, value, .. }, .. }]
                if *node == text_area && value == &fixture.after_cut
        ));

        let paste = text_editing_command(KeyInput::Paste, mac, DesktopPlatform::MacOs)
            .expect("macOS paste command");
        assert!(!app.handle_clipboard_command(paste, &mut clipboard));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .inputs
                .get(&text_area.raw())
                .expect("text area")
                .editor
                .value(),
            fixture.initial
        );
        let paste_events = app.dispatcher.drain_tick();
        assert!(matches!(
            paste_events.as_slice(),
            [nui_app_runtime::DispatchItem { payload: HostUiEvent::Change { node, value, .. }, .. }]
                if *node == text_area && value == &fixture.initial
        ));
    }

    #[test]
    fn g3a11_clipboard_failures_leave_value_selection_and_events_unchanged() {
        let host = cjk_emoji_text_host();
        let root = host.create_node(NodeType::View);
        let input = host.create_node(NodeType::View);
        let text = host.create_text("你們");
        host.insert(input, root);
        host.insert(text, input);
        host.register_input(input, text, "Title");
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(input, &arena, Some(root)));
            let focused = inner.focus.focused();
            crate::host::transition_focus(&mut inner, focused);
            inner
                .inputs
                .get_mut(&input.raw())
                .expect("input")
                .editor
                .set_selection(TextSelection::new(0, 1))
                .expect("selection");
        }
        let errors = ErrorSupervisor::default();
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            errors.clone(),
            FrameMetricsObserver::default(),
        );
        let mut clipboard = MemoryClipboard {
            fail_write: true,
            ..MemoryClipboard::default()
        };

        assert!(!app.handle_clipboard_command(TextEditingCommand::Cut, &mut clipboard));
        clipboard.fail_write = false;
        clipboard.fail_read = true;
        assert!(!app.handle_clipboard_command(TextEditingCommand::Paste, &mut clipboard));

        let inner = host.inner.lock().expect("host inner");
        let field = inner.inputs.get(&input.raw()).expect("input");
        assert_eq!(field.editor.value(), "你們");
        assert_eq!(field.editor.selection(), TextSelection::new(0, 1));
        assert_eq!(app.dispatcher.pending_count(), 0);
        drop(inner);
        let history = errors.history();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].operation, "clipboardWrite");
        assert_eq!(history[1].operation, "clipboardRead");
    }

    #[test]
    fn g3a11_input_strips_crlf_at_every_insertion_boundary_while_text_area_preserves_it() {
        let host = text_area_test_host();
        let root = host.create_node(NodeType::View);
        let input = host.create_node(NodeType::View);
        let input_text = host.create_text("A");
        let text_area = host.create_node(NodeType::Scroll);
        let text_area_text = host.create_text("A");
        host.set_number(root, PropertyId::Width, 320.0);
        host.set_number(root, PropertyId::Height, 180.0);
        for node in [input, text_area] {
            host.set_number(node, PropertyId::Width, 280.0);
            host.set_number(node, PropertyId::Height, 60.0);
        }
        for node in [input_text, text_area_text] {
            host.set_number(node, PropertyId::FontSize, 20.0);
        }
        host.insert(input, root);
        host.insert(input_text, input);
        host.insert(text_area, root);
        host.insert(text_area_text, text_area);
        host.register_input(input, input_text, "Title");
        host.register_input(text_area, text_area_text, "Body");
        host.layout(320.0, 180.0);

        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (320.0, 180.0);
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(input, &arena, Some(root)));
            let focused = inner.focus.focused();
            crate::host::transition_focus(&mut inner, focused);
        }

        assert!(!app.text_input("B\r\n"));
        let mut clipboard = MemoryClipboard {
            text: "\rC\n".to_owned(),
            ..MemoryClipboard::default()
        };
        assert!(!app.handle_clipboard_command(TextEditingCommand::Paste, &mut clipboard));
        assert!(app.ime_start());
        assert!(app.ime_preedit("\rB\n", Some((1, 2))));
        let preedit = host.text_input_state(input).expect("Input preedit state");
        assert_eq!(preedit.text, "ABCB");
        assert_eq!(
            preedit.composition,
            Some(nui_core::protocol::ui::TextRange { start: 3, end: 4 })
        );
        assert_eq!((preedit.selection.anchor, preedit.selection.focus), (3, 4));
        assert!(app.ime_commit("\nC\r"));
        host.replace_text_input(
            input,
            nui_core::protocol::ui::TextRange { start: 4, end: 4 },
            "\rB\n",
        )
        .expect("single-line protocol replacement");
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .inputs
                .get(&input.raw())
                .expect("Input")
                .editor
                .value(),
            "ABCCB"
        );

        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            assert!(inner.focus.request_focus(text_area, &arena, Some(root)));
            let focused = inner.focus.focused();
            crate::host::transition_focus(&mut inner, focused);
        }
        assert!(!app.text_input("B\r\n"));
        clipboard.text = "\rC\n".to_owned();
        assert!(!app.handle_clipboard_command(TextEditingCommand::Paste, &mut clipboard));
        assert!(app.ime_start());
        assert!(app.ime_preedit("\rB\n", Some((1, 2))));
        assert!(app.ime_commit("\nC\r"));
        let text_area_length = "AB\r\n\rC\n\nC\r".encode_utf16().count() as u32;
        host.replace_text_input(
            text_area,
            nui_core::protocol::ui::TextRange {
                start: text_area_length,
                end: text_area_length,
            },
            "\rB\n",
        )
        .expect("multiline protocol replacement");
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .inputs
                .get(&text_area.raw())
                .expect("TextArea")
                .editor
                .value(),
            "AB\r\n\rC\n\nC\r\rB\n"
        );
    }

    #[test]
    fn tick_metrics_count_real_events_and_commits_without_empty_render_phases() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            commit_activity: CommitActivity {
                attempts: 1,
                commits: 1,
                mutation_commands: 3,
            },
            ..HostInner::default()
        }));
        let observer = FrameMetricsObserver::with_history_limit(4);
        let mut app = HostWindowApp {
            shared,
            root,
            errors: ErrorSupervisor::default(),
            dispatcher: nui_app_runtime::Dispatcher::new(),
            accessibility_dispatcher: nui_app_runtime::Dispatcher::new(),
            scheduler: nui_app_runtime::Scheduler::new(),
            install_runtime_waker: Box::new(|_| {}),
            system_completion: Box::new(|_| false),
            framework_microtasks: Box::new(|| false),
            on_event: Box::new(|_| false),
            after_events: Box::new(|| false),
            on_close: Box::new(|| {}),
            viewport: (16.0, 16.0),
            redraw_pending: false,
            render_cache: BackendResourceCache::new(),
            window_lifecycle: WindowLifecycleState::default(),
            frame_metrics: FrameMetricsState::new(observer.clone()),
        };
        app.dispatcher.enqueue(
            DispatchQueue::Platform,
            HostUiEvent::Click {
                node: root,
                callback: None,
            },
        );

        assert!(!app.tick());

        let metrics = observer.history().pop().expect("tick metrics");
        assert_eq!(metrics.counts.dispatched_events, 1);
        assert_eq!(metrics.counts.commit_attempts, 1);
        assert_eq!(metrics.counts.commits, 1);
        assert_eq!(metrics.counts.mutation_commands, 3);
        assert_eq!(metrics.counts.layout_attempts, 0);
        assert_eq!(metrics.counts.semantic_attempts, 0);
        assert_eq!(metrics.counts.paint_attempts, 0);
        assert_eq!(metrics.counts.present_attempts, 0);
    }

    #[test]
    fn tick_metrics_include_time_spent_inside_framework_microtasks_callback() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            ..HostInner::default()
        }));
        let observer = FrameMetricsObserver::with_history_limit(4);
        let clock = Arc::new(ManualFrameClock::new());
        let callback_clock = Arc::clone(&clock);
        let mut app = metrics_test_app_with_clock(
            shared,
            root,
            ErrorSupervisor::default(),
            observer.clone(),
            clock,
        );
        app.framework_microtasks = Box::new(move || {
            callback_clock.advance(Duration::from_millis(7));
            false
        });

        assert!(!app.tick());

        let metrics = observer.history().pop().expect("tick metrics");
        assert_eq!(
            metrics.durations.framework_microtasks,
            Duration::from_millis(7)
        );
    }

    #[test]
    fn paint_frame_publishes_initial_and_incremental_semantic_diffs() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.get_mut(root).expect("root").style = nui_core::Style {
            width: Some(16.0),
            height: Some(16.0),
            background: Some(ColorRgba::rgb(0x20, 0x40, 0x60)),
            ..nui_core::Style::default()
        };
        arena.get_mut(root).expect("root").semantics = Some(Semantics {
            role: SemanticRole::Header,
            label: Some("Notes".to_owned()),
            ..Semantics::default()
        });
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            ..HostInner::default()
        }));
        let observer = FrameMetricsObserver::with_history_limit(4);
        let mut app = metrics_test_app(
            shared.clone(),
            root,
            ErrorSupervisor::default(),
            observer.clone(),
        );
        let generation = SurfaceGeneration::new(9);
        app.surface_ready(generation);
        let mut pixels = vec![0_u32; 16 * 16];

        assert!(app.paint_frame(&mut pixels, 16, 16, 1.0));
        app.frame_presenting(generation);
        app.frame_presented(generation);
        {
            let history = observer.history();
            assert_eq!(history.len(), 1);
            assert_eq!(history[0].counts.semantic_attempts, 1);
            assert_eq!(history[0].counts.semantic_diffs, 1);
        }

        shared
            .lock()
            .expect("host inner")
            .arena
            .get_mut(root)
            .expect("root")
            .semantics
            .as_mut()
            .expect("semantics")
            .label = Some("Notebook".to_owned());
        assert!(app.paint_frame(&mut pixels, 16, 16, 1.0));
        app.frame_presenting(generation);
        app.frame_presented(generation);
        let history = observer.history();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].counts.semantic_attempts, 1);
        assert_eq!(history[1].counts.semantic_diffs, 1);
    }

    #[test]
    fn surface_ready_updates_backend_cache_generation() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let mut app = HostWindowApp {
            shared: Arc::new(Mutex::new(HostInner {
                arena,
                root: Some(root),
                ..HostInner::default()
            })),
            root,
            errors: ErrorSupervisor::default(),
            dispatcher: nui_app_runtime::Dispatcher::new(),
            accessibility_dispatcher: nui_app_runtime::Dispatcher::new(),
            scheduler: nui_app_runtime::Scheduler::new(),
            install_runtime_waker: Box::new(|_| {}),
            system_completion: Box::new(|_| false),
            framework_microtasks: Box::new(|| false),
            on_event: Box::new(|_| false),
            after_events: Box::new(|| false),
            on_close: Box::new(|| {}),
            viewport: (16.0, 16.0),
            redraw_pending: false,
            render_cache: BackendResourceCache::new(),
            window_lifecycle: WindowLifecycleState::default(),
            frame_metrics: FrameMetricsState::new(FrameMetricsObserver::default()),
        };
        let first = SurfaceGeneration::new(1);
        let second = SurfaceGeneration::new(2);

        assert_eq!(
            app.render_cache.surface_generation(),
            SurfaceGeneration::default()
        );
        app.surface_ready(first);
        assert_eq!(app.render_cache.surface_generation(), first);
        app.surface_ready(first);
        assert_eq!(app.render_cache.surface_generation(), first);
        app.surface_ready(second);
        assert_eq!(app.render_cache.surface_generation(), second);
    }

    #[test]
    fn surface_lifecycle_events_are_ordered_and_idempotent() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let mut app = metrics_test_app(
            Arc::new(Mutex::new(HostInner {
                arena,
                root: Some(root),
                ..HostInner::default()
            })),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        let first = SurfaceGeneration::new(1);
        let second = SurfaceGeneration::new(2);
        let third = SurfaceGeneration::new(3);

        app.surface_ready(first);
        app.surface_ready(first);
        app.surface_suspended();
        app.surface_suspended();
        app.surface_ready(second);
        app.surface_ready(second);
        app.surface_lost(&PlatformFailure::new(
            PlatformFailureStage::AcquireFrame,
            "acquire failed",
        ));
        app.surface_lost(&PlatformFailure::new(
            PlatformFailureStage::AcquireFrame,
            "duplicate acquire failure",
        ));
        app.surface_ready(third);
        app.surface_ready(third);

        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 5);
        assert!(matches!(
            events[0].payload,
            HostUiEvent::WindowLifecycle {
                node,
                event: WindowLifecycleEvent {
                    kind: WindowLifecycleKind::Ready,
                    surface_generation: Some(1.0),
                },
                callback: None,
            } if node == root
        ));
        assert!(matches!(
            events[1].payload,
            HostUiEvent::WindowLifecycle {
                node,
                event: WindowLifecycleEvent {
                    kind: WindowLifecycleKind::Suspended,
                    surface_generation: None,
                },
                callback: None,
            } if node == root
        ));
        assert!(matches!(
            events[2].payload,
            HostUiEvent::WindowLifecycle {
                node,
                event: WindowLifecycleEvent {
                    kind: WindowLifecycleKind::Resumed,
                    surface_generation: Some(2.0),
                },
                callback: None,
            } if node == root
        ));
        assert!(matches!(
            events[3].payload,
            HostUiEvent::WindowLifecycle {
                node,
                event: WindowLifecycleEvent {
                    kind: WindowLifecycleKind::Suspended,
                    surface_generation: None,
                },
                callback: None,
            } if node == root
        ));
        assert!(matches!(
            events[4].payload,
            HostUiEvent::WindowLifecycle {
                node,
                event: WindowLifecycleEvent {
                    kind: WindowLifecycleKind::Resumed,
                    surface_generation: Some(3.0),
                },
                callback: None,
            } if node == root
        ));
    }

    #[test]
    fn close_lifecycle_event_is_synchronous_ordered_and_idempotent() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let order = Arc::new(Mutex::new(Vec::new()));
        let observed_event_order = Arc::clone(&order);
        let observed_close_order = Arc::clone(&order);
        let mut app = metrics_test_app(
            Arc::new(Mutex::new(HostInner {
                arena,
                root: Some(root),
                ..HostInner::default()
            })),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.on_event = Box::new(move |event| {
            assert!(matches!(
                event,
                HostUiEvent::WindowLifecycle {
                    node,
                    event: WindowLifecycleEvent {
                        kind: WindowLifecycleKind::CloseRequested,
                        surface_generation: None,
                    },
                    callback: None,
                } if node == root
            ));
            observed_event_order
                .lock()
                .expect("close order")
                .push("callback");
            false
        });
        app.on_close = Box::new(move || {
            observed_close_order
                .lock()
                .expect("close order")
                .push("close");
        });

        app.close_requested();
        app.close_requested();

        assert_eq!(
            order.lock().expect("close order").as_slice(),
            ["callback", "close"]
        );
        assert_eq!(app.dispatcher.pending_count(), 0);
    }

    #[test]
    fn surface_suspend_releases_bridge_backend_resources_immediately() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::Image);
        let resource_id = ResourceId::new(0, 1);
        arena.set_image_resource(root, Some(resource_id));
        let mut inner = HostInner {
            arena,
            root: Some(root),
            ..HostInner::default()
        };
        inner.images.insert(
            root.raw(),
            ImageAsset {
                path: String::from("memory://suspend-image"),
                resource_id,
                width: 1,
                height: 1,
                pixels: Arc::from(vec![0xffff0000]),
                inferred_width: false,
                inferred_height: false,
            },
        );
        let mut app = metrics_test_app(
            Arc::new(Mutex::new(inner)),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        let generation = SurfaceGeneration::new(1);
        let mut pixels = vec![0_u32; 16 * 16];
        app.surface_ready(generation);

        assert!(app.paint_frame(&mut pixels, 16, 16, 1.0));
        app.frame_presenting(generation);
        app.frame_presented(generation);
        assert_eq!(app.render_cache.image_upload_count(), 1);
        assert_eq!(app.render_cache.cached_image_count(), 1);

        app.surface_suspended();
        assert_eq!(app.render_cache.cached_image_count(), 0);
        assert!(app.paint_frame(&mut pixels, 16, 16, 1.0));
        assert_eq!(app.render_cache.image_upload_count(), 2);
        assert_eq!(app.render_cache.cached_image_count(), 1);
    }

    #[test]
    fn events_wait_for_framework_tick_and_are_fifo() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        let commits = Arc::new(AtomicUsize::new(0));
        let observed_commits = Arc::clone(&commits);
        let closes = Arc::new(AtomicUsize::new(0));
        let observed_closes = Arc::clone(&closes);
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            ..HostInner::default()
        }));
        let frame_metrics = FrameMetricsObserver::default();
        let mut app = HostWindowApp {
            shared,
            root,
            errors: ErrorSupervisor::default(),
            dispatcher: nui_app_runtime::Dispatcher::new(),
            accessibility_dispatcher: nui_app_runtime::Dispatcher::new(),
            scheduler: nui_app_runtime::Scheduler::new(),
            install_runtime_waker: Box::new(|_| {}),
            system_completion: Box::new(|_| false),
            framework_microtasks: Box::new(|| false),
            on_event: Box::new(move |event| {
                observed.lock().expect("events").push(event);
                true
            }),
            after_events: Box::new(move || {
                observed_commits.fetch_add(1, Ordering::SeqCst);
                true
            }),
            on_close: Box::new(move || {
                observed_closes.fetch_add(1, Ordering::SeqCst);
            }),
            viewport: (640.0, 420.0),
            redraw_pending: false,
            render_cache: BackendResourceCache::new(),
            window_lifecycle: WindowLifecycleState::default(),
            frame_metrics: FrameMetricsState::new(frame_metrics.clone()),
        };

        app.dispatcher.enqueue(
            DispatchQueue::Platform,
            HostUiEvent::Click {
                node: NodeId::from_raw(1),
                callback: None,
            },
        );
        app.dispatcher.enqueue(
            DispatchQueue::Platform,
            HostUiEvent::Change {
                node: NodeId::from_raw(2),
                value: "next".to_owned(),
                callback: None,
            },
        );
        assert!(events.lock().expect("events").is_empty());

        // Multiple callbacks and the commit collapse to one redraw decision.
        assert!(app.tick());
        let delivered = events.lock().expect("events");
        assert_eq!(delivered.len(), 2);
        assert!(matches!(delivered[0], HostUiEvent::Click { .. }));
        assert!(matches!(delivered[1], HostUiEvent::Change { .. }));
        assert_eq!(commits.load(Ordering::SeqCst), 1);
        assert_eq!(app.scheduler.completed_ticks(), 1);
        drop(delivered);
        app.close_requested();
        let delivered = events.lock().expect("events");
        assert_eq!(delivered.len(), 3);
        assert!(matches!(
            delivered[2],
            HostUiEvent::WindowLifecycle {
                event: WindowLifecycleEvent {
                    kind: WindowLifecycleKind::CloseRequested,
                    surface_generation: None,
                },
                ..
            }
        ));
        drop(delivered);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        let metrics = frame_metrics
            .history()
            .pop()
            .expect("closed redraw metrics");
        assert_eq!(
            metrics.outcome,
            FrameOutcome::Dropped(FrameDropStage::Surface)
        );
        assert_eq!(metrics.tick_id, Some(1));
    }

    #[test]
    fn system_completion_hook_runs_in_its_scheduler_phase_before_framework_work() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        let system_order = Arc::clone(&order);
        app.system_completion = Box::new(move |scheduler| {
            assert_eq!(scheduler.phase(), Some(TickPhase::SystemCompletion));
            system_order.lock().expect("phase order").push("system");
            false
        });
        let framework_order = Arc::clone(&order);
        app.on_event = Box::new(move |_| {
            framework_order
                .lock()
                .expect("phase order")
                .push("framework");
            false
        });
        let commit_order = Arc::clone(&order);
        app.after_events = Box::new(move || {
            commit_order.lock().expect("phase order").push("commit");
            false
        });
        app.dispatcher.enqueue(
            DispatchQueue::Platform,
            HostUiEvent::Click {
                node: root,
                callback: None,
            },
        );

        assert!(!app.tick());
        assert_eq!(
            *order.lock().expect("phase order"),
            ["system", "framework", "commit"]
        );
    }

    #[test]
    fn renderer_and_platform_failures_enter_the_shared_supervisor() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let errors = ErrorSupervisor::default();
        let mut app = HostWindowApp {
            shared: Arc::new(Mutex::new(HostInner {
                arena,
                root: Some(root),
                ..HostInner::default()
            })),
            root,
            errors: errors.clone(),
            dispatcher: nui_app_runtime::Dispatcher::new(),
            accessibility_dispatcher: nui_app_runtime::Dispatcher::new(),
            scheduler: nui_app_runtime::Scheduler::new(),
            install_runtime_waker: Box::new(|_| {}),
            system_completion: Box::new(|_| false),
            framework_microtasks: Box::new(|| false),
            on_event: Box::new(|_| false),
            after_events: Box::new(|| false),
            on_close: Box::new(|| {}),
            viewport: (16.0, 16.0),
            redraw_pending: false,
            render_cache: BackendResourceCache::new(),
            window_lifecycle: WindowLifecycleState::default(),
            frame_metrics: FrameMetricsState::new(FrameMetricsObserver::default()),
        };

        assert!(!app.paint_frame(&mut [], 16, 16, 1.0));
        app.report_platform_failure(&PlatformFailure::new(
            PlatformFailureStage::PresentFrame,
            "present failed",
        ));

        let history = errors.history();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].severity, ErrorSeverity::FrameFailure);
        assert_eq!(history[0].operation, "paint");
        assert_eq!(history[1].severity, ErrorSeverity::FrameFailure);
        assert_eq!(history[1].operation, "presentFrame");
    }

    #[test]
    fn text_layout_failure_drops_the_paint_frame_and_is_reported() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::Text);
        arena.set_text(root, "missing font");
        let errors = ErrorSupervisor::default();
        let frame_metrics = FrameMetricsObserver::with_history_limit(4);
        let mut app = HostWindowApp {
            shared: Arc::new(Mutex::new(HostInner {
                arena,
                root: Some(root),
                ..HostInner::default()
            })),
            root,
            errors: errors.clone(),
            dispatcher: nui_app_runtime::Dispatcher::new(),
            accessibility_dispatcher: nui_app_runtime::Dispatcher::new(),
            scheduler: nui_app_runtime::Scheduler::new(),
            install_runtime_waker: Box::new(|_| {}),
            system_completion: Box::new(|_| false),
            framework_microtasks: Box::new(|| false),
            on_event: Box::new(|_| false),
            after_events: Box::new(|| false),
            on_close: Box::new(|| {}),
            viewport: (16.0, 16.0),
            redraw_pending: false,
            render_cache: BackendResourceCache::new(),
            window_lifecycle: WindowLifecycleState::default(),
            frame_metrics: FrameMetricsState::new(frame_metrics.clone()),
        };
        let mut pixels = vec![0_u32; 16 * 16];

        assert!(!app.paint_frame(&mut pixels, 16, 16, 1.0));

        let history = errors.history();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].severity, ErrorSeverity::FrameFailure);
        assert_eq!(history[0].operation, "layout");
        assert!(history[0].message.contains("primary font"));
        let metrics = frame_metrics
            .history()
            .pop()
            .expect("dropped frame metrics");
        assert_eq!(
            metrics.outcome,
            FrameOutcome::Dropped(FrameDropStage::Layout)
        );
        assert_eq!(metrics.counts.layout_attempts, 1);
        assert_eq!(metrics.counts.display_list_attempts, 0);
        assert_eq!(metrics.counts.paint_attempts, 0);
        assert_eq!(metrics.counts.present_attempts, 0);
    }

    #[test]
    fn multiple_updates_in_one_tick_count_real_work_and_present_once() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        host.inner
            .lock()
            .expect("host inner")
            .arena
            .get_mut(root)
            .expect("root")
            .style
            .background = Some(ColorRgba::rgb(0x10, 0x20, 0x30));
        let observer = FrameMetricsObserver::with_history_limit(4);
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            observer.clone(),
        );
        let generation = SurfaceGeneration::new(4);
        let mut pixels = vec![0_u32; 16 * 16];
        let update_index = Arc::new(AtomicUsize::new(0));
        let observed_index = Arc::clone(&update_index);
        let mutation_host = host.clone();
        app.on_event = Box::new(move |event| {
            if !matches!(event, HostUiEvent::Click { .. }) {
                return false;
            }
            match observed_index.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    mutation_host
                        .queue_set_number(root, PropertyId::Width, 16.0)
                        .expect("queued width");
                    mutation_host
                        .queue_set_number(root, PropertyId::Height, 16.0)
                        .expect("queued height");
                }
                1 => mutation_host
                    .queue_set_number(root, PropertyId::BorderRadius, 2.0)
                    .expect("queued radius"),
                _ => unreachable!("two events are queued"),
            }
            true
        });
        let commit_host = host.clone();
        app.after_events =
            Box::new(move || commit_host.commit_pending().expect("tick commit").is_some());

        app.surface_ready(generation);
        for _ in 0..2 {
            app.dispatcher.enqueue(
                DispatchQueue::Platform,
                HostUiEvent::Click {
                    node: root,
                    callback: None,
                },
            );
        }
        assert!(app.tick());
        assert!(app.paint_frame(&mut pixels, 16, 16, 1.0));
        app.frame_presenting(generation);
        app.frame_presented(generation);
        app.frame_presented(generation);

        let inner = host.inner.lock().expect("host inner");
        let root_node = inner.arena.get(root).expect("committed root");
        assert_eq!(root_node.style.width, Some(16.0));
        assert_eq!(root_node.style.height, Some(16.0));
        assert_eq!(root_node.style.border_radius, 2.0);
        drop(inner);

        let history = observer.history();
        assert_eq!(history.len(), 1);
        let metrics = &history[0];
        assert_eq!(metrics.tick_id, Some(1));
        assert_eq!(metrics.frame_id, Some(1));
        assert_eq!(metrics.surface_generation, Some(generation));
        assert_eq!(metrics.outcome, FrameOutcome::Presented);
        assert_eq!(metrics.counts.dispatched_events, 3);
        assert_eq!(metrics.counts.commit_attempts, 1);
        assert_eq!(metrics.counts.commits, 1);
        assert_eq!(metrics.counts.mutation_commands, 3);
        assert_eq!(metrics.counts.layout_attempts, 1);
        assert_eq!(metrics.counts.layout_nodes, 1);
        assert_eq!(metrics.counts.semantic_attempts, 1);
        assert_eq!(metrics.counts.semantic_diffs, 0);
        assert_eq!(metrics.counts.display_list_attempts, 1);
        assert_eq!(metrics.counts.display_commands, 1);
        assert_eq!(metrics.counts.paint_attempts, 1);
        assert_eq!(metrics.counts.present_attempts, 1);
        assert_eq!(metrics.counts.successful_presents, 1);
        assert_eq!(metrics.counts.dropped_frames, 0);
    }

    #[test]
    fn paint_frame_resolves_additive_interaction_tokens() {
        let mut arena = Arena::new();
        let button = arena.create(NodeType::View);
        arena.get_mut(button).expect("button").style.background =
            Some(ColorRgba::rgb(0x1f, 0x6f, 0xeb));
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(button),
            interactions: std::collections::HashMap::from([(
                button.raw(),
                nui_core::InteractionModel::new(),
            )]),
            ..HostInner::default()
        }));
        let mut idle_app = metrics_test_app(
            Arc::clone(&shared),
            button,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        let mut idle_pixels = vec![0_u32; 24 * 24];
        assert!(idle_app.paint_frame(&mut idle_pixels, 24, 24, 1.0));

        {
            let mut inner = shared.lock().expect("host inner");
            let state = inner
                .interactions
                .get_mut(&button.raw())
                .expect("button interaction");
            state.pointer_enter();
            state.set_focused(true);
        }
        let mut focused_app = metrics_test_app(
            shared,
            button,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        let mut focused_pixels = vec![0_u32; 24 * 24];
        assert!(focused_app.paint_frame(&mut focused_pixels, 24, 24, 1.0));

        assert_ne!(focused_pixels, idle_pixels);
    }

    #[test]
    fn invalid_pixel_buffer_drops_at_paint_without_present_attempt() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        arena.get_mut(root).expect("root").style.background =
            Some(ColorRgba::rgb(0x10, 0x20, 0x30));
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            ..HostInner::default()
        }));
        let observer = FrameMetricsObserver::with_history_limit(4);
        let mut app = metrics_test_app(shared, root, ErrorSupervisor::default(), observer.clone());

        assert!(!app.paint_frame(&mut [], 16, 16, 1.0));

        let metrics = observer.history().pop().expect("paint drop");
        assert_eq!(
            metrics.outcome,
            FrameOutcome::Dropped(FrameDropStage::Paint)
        );
        assert_eq!(metrics.counts.layout_attempts, 1);
        assert_eq!(metrics.counts.layout_nodes, 1);
        assert_eq!(metrics.counts.display_list_attempts, 1);
        assert_eq!(metrics.counts.display_commands, 1);
        assert_eq!(metrics.counts.paint_attempts, 1);
        assert_eq!(metrics.counts.present_attempts, 0);
    }

    #[test]
    fn acquire_failure_drops_pending_frame_before_present() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            ..HostInner::default()
        }));
        let errors = ErrorSupervisor::default();
        let observer = FrameMetricsObserver::with_history_limit(4);
        let mut app = metrics_test_app(shared, root, errors.clone(), observer.clone());
        let generation = SurfaceGeneration::new(5);

        app.surface_ready(generation);
        app.redraw_pending = true;
        assert!(app.tick());
        app.surface_lost(&PlatformFailure::new(
            PlatformFailureStage::AcquireFrame,
            "acquire failed",
        ));

        let metrics = observer.history().pop().expect("acquire drop");
        assert_eq!(
            metrics.outcome,
            FrameOutcome::Dropped(FrameDropStage::Acquire)
        );
        assert_eq!(metrics.surface_generation, Some(generation));
        assert_eq!(metrics.counts.layout_attempts, 0);
        assert_eq!(metrics.counts.present_attempts, 0);
        assert_eq!(errors.history().len(), 1);
    }

    #[test]
    fn present_failure_finishes_active_present_as_dropped() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::Image);
        let resource_id = ResourceId::new(0, 1);
        arena.set_image_resource(root, Some(resource_id));
        let root_node = arena.get_mut(root).expect("image root");
        root_node.style.width = Some(1.0);
        root_node.style.height = Some(1.0);
        let image_asset = ImageAsset {
            path: String::from("memory://present-failure-image"),
            resource_id,
            width: 1,
            height: 1,
            pixels: Arc::from(vec![0xffff0000]),
            inferred_width: false,
            inferred_height: false,
        };
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            images: std::collections::HashMap::from([(root.raw(), image_asset)]),
            ..HostInner::default()
        }));
        let errors = ErrorSupervisor::default();
        let observer = FrameMetricsObserver::with_history_limit(4);
        let mut app = metrics_test_app(shared, root, errors.clone(), observer.clone());
        let generation = SurfaceGeneration::new(6);
        let mut pixels = vec![0_u32; 16 * 16];

        app.surface_ready(generation);
        assert!(app.paint_frame(&mut pixels, 16, 16, 1.0));
        assert_eq!(app.render_cache.cached_image_count(), 1);
        app.frame_presenting(generation);
        app.surface_lost(&PlatformFailure::new(
            PlatformFailureStage::PresentFrame,
            "present failed",
        ));
        assert_eq!(app.render_cache.cached_image_count(), 0);

        let metrics = observer.history().pop().expect("present drop");
        assert_eq!(
            metrics.outcome,
            FrameOutcome::Dropped(FrameDropStage::Present)
        );
        assert_eq!(metrics.surface_generation, Some(generation));
        assert_eq!(metrics.counts.present_attempts, 1);
        assert_eq!(metrics.counts.successful_presents, 0);
        assert_eq!(metrics.counts.dropped_frames, 1);
        assert_eq!(errors.history().len(), 1);
    }

    #[test]
    fn metrics_sink_runs_after_host_and_observer_locks_are_released() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            ..HostInner::default()
        }));
        let observer = FrameMetricsObserver::with_history_limit(4);
        let unlocked_calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&unlocked_calls);
        let observed_shared = Arc::clone(&shared);
        let observed_metrics = observer.clone();
        observer.set_sink(Some(Arc::new(move |_| {
            if observed_shared.try_lock().is_ok() && observed_metrics.history().len() == 1 {
                observed_calls.fetch_add(1, Ordering::SeqCst);
            }
        })));
        let mut app = metrics_test_app(shared, root, ErrorSupervisor::default(), observer.clone());

        assert!(!app.paint_frame(&mut [], 16, 16, 1.0));

        assert_eq!(unlocked_calls.load(Ordering::SeqCst), 1);
        assert_eq!(observer.history().len(), 1);
    }

    #[test]
    fn invalid_layout_skips_pointer_and_wheel_hit_testing_and_reports_unlocked() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            ..HostInner::default()
        }));
        let errors = ErrorSupervisor::default();
        let unlocked_reports = Arc::new(AtomicUsize::new(0));
        let observed_reports = Arc::clone(&unlocked_reports);
        let observed_shared = Arc::clone(&shared);
        errors.set_sink(Some(Arc::new(move |_| {
            if observed_shared.try_lock().is_ok() {
                observed_reports.fetch_add(1, Ordering::SeqCst);
            }
        })));
        let mut app = HostWindowApp {
            shared,
            root,
            errors: errors.clone(),
            dispatcher: nui_app_runtime::Dispatcher::new(),
            accessibility_dispatcher: nui_app_runtime::Dispatcher::new(),
            scheduler: nui_app_runtime::Scheduler::new(),
            install_runtime_waker: Box::new(|_| {}),
            system_completion: Box::new(|_| false),
            framework_microtasks: Box::new(|| false),
            on_event: Box::new(|_| false),
            after_events: Box::new(|| false),
            on_close: Box::new(|| {}),
            viewport: (-1.0, 16.0),
            redraw_pending: false,
            render_cache: BackendResourceCache::new(),
            window_lifecycle: WindowLifecycleState::default(),
            frame_metrics: FrameMetricsState::new(FrameMetricsObserver::default()),
        };

        assert!(!app.pointer_pressed(1.0, 1.0, 1.0));
        assert!(!app.wheel_scrolled(1.0, 1.0, 10.0, 1.0));

        assert_eq!(app.dispatcher.pending_count(), 0);
        assert_eq!(unlocked_reports.load(Ordering::SeqCst), 2);
        let history = errors.history();
        assert_eq!(history.len(), 2);
        assert!(history.iter().all(|error| {
            error.severity == ErrorSeverity::FrameFailure && error.operation == "layout"
        }));
    }

    #[test]
    fn tab_and_shift_tab_update_host_focus_mirror() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let first = arena.create(NodeType::View);
        let second = arena.create(NodeType::View);
        arena.insert_child(root, first);
        arena.insert_child(root, second);
        let mut focus = FocusManager::default();
        focus.register(first, 0, true);
        focus.register(second, 0, true);
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            focus,
            ..HostInner::default()
        }));
        let mut app = metrics_test_app(
            Arc::clone(&shared),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        assert!(!app.key_tab(false));
        assert_eq!(shared.lock().expect("host inner").focused, Some(first));
        assert!(!app.key_tab(false));
        assert_eq!(shared.lock().expect("host inner").focused, Some(second));
        assert!(!app.key_tab(true));
        assert_eq!(shared.lock().expect("host inner").focused, Some(first));
    }

    #[test]
    fn tab_cancels_old_input_preedit_and_syncs_interaction_focus() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let first = host.create_node(NodeType::View);
        let first_text = host.create_text("A");
        let second = host.create_node(NodeType::View);
        let second_text = host.create_text("B");
        host.insert(first, root);
        host.insert(first_text, first);
        host.insert(second, root);
        host.insert(second_text, second);
        host.register_input(first, first_text, "first");
        host.register_input(second, second_text, "second");
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        assert!(!app.key_tab(false));
        assert!(app.ime_preedit("ni", None));
        assert!(!app.key_tab(false));

        let inner = host.inner.lock().expect("host inner");
        assert_eq!(inner.focused, Some(second));
        let first_field = inner.inputs.get(&first.raw()).expect("first input");
        assert_eq!(first_field.editor.value(), "A");
        assert_eq!(first_field.editor.composition(), None);
        assert_eq!(
            inner
                .arena
                .get(first_text)
                .and_then(|node| node.text.as_deref()),
            Some("A")
        );
        assert_eq!(
            inner
                .interactions
                .get(&first.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Idle)
        );
        assert_eq!(
            inner
                .interactions
                .get(&second.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Focused)
        );
        drop(inner);

        let events = app.dispatcher.drain_tick();
        let kinds = events
            .iter()
            .filter_map(|item| match &item.payload {
                HostUiEvent::Composition { event, .. } => Some(event.kind),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                CompositionKind::Start,
                CompositionKind::Update,
                CompositionKind::Cancel,
            ]
        );
    }

    #[test]
    fn standard_ime_commit_preserves_utf16_selection_and_fifo_event_order() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let input = host.create_node(NodeType::View);
        let text = host.create_text("e");
        host.insert(input, root);
        host.insert(text, input);
        host.register_input(input, text, "input");
        let composition_callback = crate::CallbackHandle::new(17, 1);
        host.add_event_listener(input, nui_core::EventId::Composition, composition_callback)
            .expect("composition listener");
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (200.0, 80.0);
        host.layout(200.0, 80.0);
        assert!(!app.key_tab(false));

        assert!(app.ime_start());
        assert!(app.ime_preedit("A😀B", Some((1, 5))));
        assert!(app.ime_preedit("", None));
        assert!(app.ime_commit("你"));

        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 5);
        let compositions = events
            .iter()
            .filter_map(|item| match &item.payload {
                HostUiEvent::Composition {
                    node,
                    event,
                    callback,
                } => Some((*node, event, *callback)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(compositions.len(), 4);
        assert_eq!(
            compositions
                .iter()
                .map(|(_, event, _)| event.kind)
                .collect::<Vec<_>>(),
            vec![
                CompositionKind::Start,
                CompositionKind::Update,
                CompositionKind::Update,
                CompositionKind::Commit,
            ]
        );
        assert_eq!(compositions[1].1.text, "A😀B");
        assert_eq!(compositions[1].1.selection_start, 1);
        assert_eq!(compositions[1].1.selection_end, 3);
        assert_eq!(compositions[3].1.text, "你");
        assert_eq!(compositions[3].1.selection_start, 1);
        assert_eq!(compositions[3].1.selection_end, 1);
        for (index, (node, event, callback)) in compositions.iter().enumerate() {
            assert_eq!(*node, input);
            assert_eq!(*callback, Some(composition_callback));
            assert_eq!(event.context.timestamp, (index + 1).to_string());
            assert_eq!(event.context.propagation.phase, PropagationPhase::Target);
            assert_eq!(
                event
                    .context
                    .target
                    .as_ref()
                    .map(|target| (target.slot, target.generation)),
                Some((input.slot(), input.generation()))
            );
        }
        assert!(matches!(
            events[4].payload,
            HostUiEvent::Change { node, ref value, .. } if node == input && value == "e你"
        ));
        assert!(compositions
            .iter()
            .all(|(_, event, _)| event.kind != CompositionKind::Cancel));
    }

    #[test]
    fn empty_ime_commit_still_terminates_preedit_without_a_false_cancel() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let input = host.create_node(NodeType::View);
        let text = host.create_text("e");
        host.insert(input, root);
        host.insert(text, input);
        host.register_input(input, text, "input");
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (200.0, 80.0);
        host.layout(200.0, 80.0);
        assert!(!app.key_tab(false));

        assert!(app.ime_start());
        assert!(app.ime_preedit("x", None));
        assert!(app.ime_preedit("", None));
        assert!(app.ime_commit(""));

        let events = app.dispatcher.drain_tick();
        let kinds = events
            .iter()
            .filter_map(|item| match &item.payload {
                HostUiEvent::Composition { event, .. } => Some(event.kind),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                CompositionKind::Start,
                CompositionKind::Update,
                CompositionKind::Update,
                CompositionKind::Commit,
            ]
        );
        assert!(kinds.iter().all(|kind| *kind != CompositionKind::Cancel));
        let inner = host.inner.lock().expect("host inner");
        let field = inner.inputs.get(&input.raw()).expect("input");
        assert_eq!(field.editor.value(), "e");
        assert_eq!(field.editor.composition(), None);
    }

    #[test]
    fn pointer_focus_clear_cancels_the_old_input_preedit() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let input = host.create_node(NodeType::View);
        let text = host.create_text("A");
        host.insert(input, root);
        host.set_number(root, PropertyId::Width, 100.0);
        host.set_number(root, PropertyId::Height, 100.0);
        host.set_number(input, PropertyId::Width, 40.0);
        host.set_number(input, PropertyId::Height, 40.0);
        host.register_input(input, text, "input");
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (100.0, 100.0);

        assert!(!app.key_tab(false));
        assert!(app.ime_preedit("ni", None));
        assert!(!app.pointer_pressed(90.0, 90.0, 1.0));

        let inner = host.inner.lock().expect("host inner");
        assert_eq!(inner.focused, None);
        let field = inner.inputs.get(&input.raw()).expect("input");
        assert_eq!(field.editor.value(), "A");
        assert_eq!(field.editor.composition(), None);
        assert_eq!(
            inner.arena.get(text).and_then(|node| node.text.as_deref()),
            Some("A")
        );
        assert_eq!(
            inner
                .interactions
                .get(&input.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Idle)
        );
    }

    #[test]
    fn pointer_text_hit_testing_uses_the_scrolled_visual_origin() {
        let host = NuiHost::new();
        let scroll = host.create_node(NodeType::Scroll);
        let input = host.create_node(NodeType::View);
        let text = host.create_text("A\nB");
        host.set_number(scroll, PropertyId::Width, 120.0);
        host.set_number(scroll, PropertyId::Height, 60.0);
        host.set_number(scroll, PropertyId::ScrollOffsetY, 30.0);
        host.set_number(input, PropertyId::Width, 120.0);
        host.set_number(input, PropertyId::Height, 60.0);
        host.set_number(text, PropertyId::FontSize, 20.0);
        host.insert(input, scroll);
        host.insert(text, input);
        host.register_input(input, text, "input");
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            scroll,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (120.0, 60.0);

        host.layout(120.0, 60.0);
        {
            let inner = host.inner.lock().expect("host inner");
            assert_eq!(
                nui_core::hit_test(&inner.arena, scroll, 90.0, 10.0),
                Some(input),
                "scroll={:?}, input={:?}, text={:?}",
                inner.arena.get(scroll).map(|node| node.layout),
                inner.arena.get(input).map(|node| node.layout),
                inner.arena.get(text).map(|node| node.layout),
            );
        }

        assert!(!app.pointer_pressed(90.0, 10.0, 1.0));

        let inner = host.inner.lock().expect("host inner");
        let selection = inner
            .inputs
            .get(&input.raw())
            .expect("input")
            .editor
            .selection();
        assert_eq!(selection.focus.0, 3);
    }

    #[test]
    fn queued_remove_commit_syncs_recovered_focus_to_the_next_input() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let first = host.create_node(NodeType::View);
        let first_text = host.create_text("A");
        let second = host.create_node(NodeType::View);
        let second_text = host.create_text("B");
        host.insert(first, root);
        host.insert(first_text, first);
        host.insert(second, root);
        host.insert(second_text, second);
        host.register_input(first, first_text, "first");
        host.register_input(second, second_text, "second");
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        assert!(!app.key_tab(false));

        host.queue_remove(first).expect("queue first input removal");
        host.commit_pending().expect("commit removal");

        let inner = host.inner.lock().expect("host inner");
        assert_eq!(inner.focused, Some(second));
        assert_eq!(
            inner
                .interactions
                .get(&second.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Focused)
        );
    }

    #[test]
    fn pointer_capture_clicks_only_when_release_returns_to_pressed_target() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let button = arena.create(NodeType::View);
        arena.set_style(
            root,
            nui_core::Style {
                width: Some(100.0),
                height: Some(100.0),
                ..nui_core::Style::default()
            },
        );
        arena.set_style(
            button,
            nui_core::Style {
                width: Some(40.0),
                height: Some(40.0),
                ..nui_core::Style::default()
            },
        );
        arena.set_clickable(button, true);
        arena.insert_child(root, button);
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            ..HostInner::default()
        }));
        shared.lock().expect("host inner").v1_listeners.insert(
            crate::ListenerKey::new(button.raw(), nui_core::EventId::Click as u32),
            crate::CallbackHandle::new(3, 1),
        );
        let mut app = metrics_test_app(
            Arc::clone(&shared),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (100.0, 100.0);

        assert!(!app.pointer_pressed(10.0, 10.0, 1.0));
        assert_eq!(app.dispatcher.pending_count(), 0);
        assert_eq!(
            shared
                .lock()
                .expect("host inner")
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Pressed)
        );
        assert!(!app.pointer_released(10.0, 10.0, 1.0));
        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].payload, HostUiEvent::Click { node, .. } if node == button));

        assert!(!app.pointer_pressed(10.0, 10.0, 1.0));
        assert!(!app.pointer_moved(90.0, 90.0, 1.0));
        assert!(!app.pointer_moved(10.0, 10.0, 1.0));
        assert_eq!(
            shared
                .lock()
                .expect("host inner")
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Pressed)
        );
        assert!(!app.pointer_released(10.0, 10.0, 1.0));
        assert_eq!(app.dispatcher.drain_tick().len(), 1);

        assert!(!app.pointer_pressed(10.0, 10.0, 1.0));
        app.redraw_pending = false;
        assert!(!app.pointer_released(90.0, 90.0, 1.0));
        assert!(app.redraw_pending);
        assert_eq!(app.dispatcher.pending_count(), 0);
        assert_eq!(
            shared
                .lock()
                .expect("host inner")
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Idle)
        );
    }

    #[test]
    fn pointer_motion_updates_hover_and_pointer_press_focuses_the_button() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.set_number(root, PropertyId::Width, 100.0);
        host.set_number(root, PropertyId::Height, 100.0);
        host.set_number(button, PropertyId::Width, 40.0);
        host.set_number(button, PropertyId::Height, 40.0);
        host.insert(button, root);
        host.add_click_listener(button, 7);
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (100.0, 100.0);

        assert!(!app.pointer_moved(10.0, 10.0, 1.0));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Hovered)
        );

        assert!(!app.pointer_moved(90.0, 90.0, 1.0));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Idle)
        );
        assert!(!app.pointer_moved(10.0, 10.0, 1.0));

        assert!(!app.pointer_pressed(10.0, 10.0, 1.0));
        assert_eq!(host.inner.lock().expect("host inner").focused, Some(button));
        assert!(!app.pointer_released(10.0, 10.0, 1.0));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Focused)
        );

        assert!(!app.pointer_moved(90.0, 90.0, 1.0));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .interactions
                .get(&button.raw())
                .map(|state| state.state()),
            Some(nui_core::InteractionState::Focused)
        );
        assert!(!app.pointer_exited());
    }

    #[test]
    fn disabled_button_does_not_press_capture_or_click_and_clear_restores_pointer_invoke() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.set_number(root, PropertyId::Width, 100.0);
        host.set_number(root, PropertyId::Height, 100.0);
        host.set_number(button, PropertyId::Width, 40.0);
        host.set_number(button, PropertyId::Height, 40.0);
        host.set_number(button, PropertyId::Disabled, 1.0);
        host.insert(button, root);
        host.add_click_listener(button, 7);
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (100.0, 100.0);

        assert!(!app.pointer_pressed(10.0, 10.0, 1.0));
        {
            let inner = host.inner.lock().expect("host inner");
            assert_eq!(inner.pointer_pressed_target, None);
            assert_eq!(inner.event_dispatcher.captured_pointer(1), None);
            assert_eq!(
                inner
                    .interactions
                    .get(&button.raw())
                    .map(|state| state.state()),
                Some(nui_core::InteractionState::Disabled)
            );
        }
        assert!(!app.pointer_released(10.0, 10.0, 1.0));
        assert_eq!(app.dispatcher.pending_count(), 0);

        host.clear_property(button, PropertyId::Disabled)
            .expect("clear disabled");
        assert!(!app.pointer_pressed(10.0, 10.0, 1.0));
        {
            let inner = host.inner.lock().expect("host inner");
            assert_eq!(inner.pointer_pressed_target, Some(button));
            assert_eq!(inner.event_dispatcher.captured_pointer(1), Some(button));
            assert_eq!(
                inner
                    .interactions
                    .get(&button.raw())
                    .map(|state| state.state()),
                Some(nui_core::InteractionState::Pressed)
            );
        }
        host.set_number(button, PropertyId::Disabled, 1.0);
        {
            let inner = host.inner.lock().expect("host inner");
            assert_eq!(inner.pointer_pressed_target, None);
            assert_eq!(inner.event_dispatcher.captured_pointer(1), None);
            assert_eq!(
                inner
                    .interactions
                    .get(&button.raw())
                    .map(|state| state.state()),
                Some(nui_core::InteractionState::Disabled)
            );
        }
        assert!(!app.pointer_released(10.0, 10.0, 1.0));
        assert_eq!(app.dispatcher.pending_count(), 0);

        host.clear_property(button, PropertyId::Disabled)
            .expect("clear disabled again");
        assert!(!app.pointer_pressed(10.0, 10.0, 1.0));
        assert!(!app.pointer_released(10.0, 10.0, 1.0));
        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0].payload,
            HostUiEvent::Click { node, .. } if node == button
        ));
    }

    #[test]
    fn enter_invokes_the_focused_button_through_the_platform_queue() {
        let mut arena = Arena::new();
        let root = arena.create(NodeType::View);
        let button = arena.create(NodeType::View);
        arena.insert_child(root, button);
        arena.set_clickable(button, true);
        let mut focus = FocusManager::default();
        focus.register(button, 0, true);
        assert!(focus.request_focus(button, &arena, Some(root)));
        let callback = crate::CallbackHandle::new(8, 1);
        let mut interaction = nui_core::InteractionModel::new();
        interaction.set_focused(true);
        let shared = Arc::new(Mutex::new(HostInner {
            arena,
            root: Some(root),
            focus,
            focused: Some(button),
            v1_listeners: std::collections::HashMap::from([(
                crate::ListenerKey::new(button.raw(), nui_core::EventId::Click as u32),
                callback,
            )]),
            interactions: std::collections::HashMap::from([(button.raw(), interaction)]),
            ..HostInner::default()
        }));
        let mut app = metrics_test_app(
            Arc::clone(&shared),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        assert!(!app.key_command_with_repeat(
            KeyInput::Enter,
            PlatformKeyModifiers::default(),
            false,
        ));
        {
            let inner = shared.lock().expect("host inner");
            let token = inner
                .interactions
                .get(&button.raw())
                .expect("button interaction")
                .token();
            assert!(token.contains(nui_core::InteractionStateToken::PRESSED));
            assert!(token.contains(nui_core::InteractionStateToken::FOCUSED));
        }
        assert!(app.redraw_pending);
        app.redraw_pending = false;
        assert!(!app.key_command_with_repeat(
            KeyInput::Enter,
            PlatformKeyModifiers::default(),
            true,
        ));
        assert!(!app.key_command_released(KeyInput::Enter, PlatformKeyModifiers::default(),));
        {
            let inner = shared.lock().expect("host inner");
            let token = inner
                .interactions
                .get(&button.raw())
                .expect("button interaction")
                .token();
            assert!(!token.contains(nui_core::InteractionStateToken::PRESSED));
            assert!(token.contains(nui_core::InteractionStateToken::FOCUSED));
        }
        assert!(app.redraw_pending);
        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0].payload,
            HostUiEvent::Click { node, callback: Some(value) }
                if node == button && value == callback
        ));
    }

    #[test]
    fn disabling_the_focused_button_blocks_keyboard_invoke_until_cleared() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);
        host.add_click_listener(button, 7);
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        assert!(!app.key_tab(false));
        assert_eq!(host.inner.lock().expect("host inner").focused, Some(button));

        host.set_number(button, PropertyId::Disabled, 1.0);
        assert_eq!(host.inner.lock().expect("host inner").focused, None);
        assert!(!app.key_command(KeyInput::Enter, PlatformKeyModifiers::default()));
        assert!(!app.key_command(KeyInput::Space, PlatformKeyModifiers::default()));
        assert_eq!(app.dispatcher.pending_count(), 0);

        host.clear_property(button, PropertyId::Disabled)
            .expect("clear disabled");
        assert!(!app.key_tab(false));
        assert_eq!(host.inner.lock().expect("host inner").focused, Some(button));
        assert!(!app.key_command(KeyInput::Enter, PlatformKeyModifiers::default()));
        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0].payload,
            HostUiEvent::Click { node, .. } if node == button
        ));
    }

    #[test]
    fn disabling_the_focused_button_recovers_to_the_next_enabled_button() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let first = host.create_node(NodeType::View);
        let second = host.create_node(NodeType::View);
        host.insert(first, root);
        host.insert(second, root);
        host.add_click_listener(first, 7);
        host.add_click_listener(second, 8);
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        assert!(!app.key_tab(false));
        assert_eq!(host.inner.lock().expect("host inner").focused, Some(first));

        host.set_number(first, PropertyId::Disabled, 1.0);
        assert_eq!(host.inner.lock().expect("host inner").focused, Some(second));
        assert!(!app.key_command(KeyInput::Enter, PlatformKeyModifiers::default()));

        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0].payload,
            HostUiEvent::Click { node, .. } if node == second
        ));
    }

    #[test]
    fn space_command_and_text_paths_insert_once_into_the_focused_input() {
        let host = NuiHost::new();
        let input = host.create_node(NodeType::View);
        let text = host.create_text("A");
        host.insert(text, input);
        host.register_input(input, text, "placeholder");
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            let root = inner.root;
            assert!(inner.focus.request_focus(input, &arena, root));
            inner.focused = inner.focus.focused();
        }
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            input,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        assert!(!app.key_command(KeyInput::Space, PlatformKeyModifiers::default()));
        assert_eq!(app.dispatcher.pending_count(), 0);
        assert!(!app.text_input(" "));

        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0].payload,
            HostUiEvent::Change { node, value, .. } if *node == input && value == "A "
        ));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get(text)
                .and_then(|node| node.text.as_deref()),
            Some("A ")
        );
    }

    #[test]
    fn enter_inserts_a_line_break_into_a_scroll_backed_text_area() {
        let host = text_area_test_host();
        let text_area = host.create_node(NodeType::Scroll);
        let text = host.create_text("A");
        host.set_number(text_area, PropertyId::Width, 80.0);
        host.set_number(text_area, PropertyId::Height, 20.0);
        host.set_number(text, PropertyId::FontSize, 20.0);
        host.insert(text, text_area);
        host.register_input(text_area, text, "Body");
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            let root = inner.root;
            assert!(inner.focus.request_focus(text_area, &arena, root));
            inner.focused = inner.focus.focused();
        }
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            text_area,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (80.0, 20.0);

        assert!(!app.key_command(KeyInput::Enter, PlatformKeyModifiers::default()));

        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0].payload,
            HostUiEvent::Change { node, value, .. } if *node == text_area && value == "A\n"
        ));
        let inner = host.inner.lock().expect("host inner");
        assert_eq!(
            inner.arena.get(text).and_then(|node| node.text.as_deref()),
            Some("A\n")
        );
        assert!(
            inner
                .arena
                .get(text_area)
                .expect("text area")
                .style
                .scroll_offset_y
                > 0.0
        );
    }

    #[test]
    fn textarea_down_navigation_uses_visual_lines_shift_selection_and_caret_scrolling() {
        let host = text_area_test_host();
        let text_area = host.create_node(NodeType::Scroll);
        let text = host.create_text("ABC ABC ABC");
        host.set_number(text_area, PropertyId::Width, 80.0);
        host.set_number(text_area, PropertyId::Height, 40.0);
        host.set_number(text, PropertyId::FontSize, 20.0);
        host.insert(text, text_area);
        host.register_input(text_area, text, "Body");
        host.layout(80.0, 40.0);

        let (snapshot, start, second, second_home, second_end, third) = {
            let mut inner = host.inner.lock().expect("host inner");
            let snapshot = inner
                .text_cache
                .snapshot_for_node(text)
                .expect("text snapshot");
            assert_eq!(snapshot.lines().len(), 3);
            let x = 40.0;
            let hit = |line: usize| {
                let metrics = snapshot.lines()[line].metrics();
                snapshot
                    .hit_test(x, metrics.top() + metrics.height() * 0.5)
                    .expect("visual line hit")
            };
            let start = hit(0);
            let second = hit(1);
            let second_home = snapshot
                .hit_test(0.0, snapshot.lines()[1].metrics().top() + 10.0)
                .expect("second-line home");
            let second_end = snapshot
                .hit_test(
                    snapshot.lines()[1].metrics().advance(),
                    snapshot.lines()[1].metrics().top() + 10.0,
                )
                .expect("second-line end");
            let third = hit(2);
            (snapshot, start, second, second_home, second_end, third)
        };
        let start_y = {
            let metrics = snapshot.lines()[start.line()].metrics();
            metrics.top() + metrics.height() * 0.5
        };
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            text_area,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );
        app.viewport = (80.0, 40.0);

        assert!(!app.pointer_pressed(40.0, f64::from(start_y), 1.0));
        assert!(!app.pointer_released(40.0, f64::from(start_y), 1.0));
        assert!(!app.key_command(KeyInput::ArrowDown, PlatformKeyModifiers::default()));
        {
            let inner = host.inner.lock().expect("host inner");
            let selection = inner
                .inputs
                .get(&text_area.raw())
                .expect("text area")
                .editor
                .selection();
            let expected = snapshot
                .index_map()
                .utf8_to_grapheme(second.offset().get())
                .expect("second-line caret");
            assert_eq!(selection, TextSelection::collapsed(expected));
        }

        assert!(!app.key_command(KeyInput::Home, PlatformKeyModifiers::default()));
        assert!(!app.key_command(
            KeyInput::End,
            PlatformKeyModifiers {
                shift: true,
                ..PlatformKeyModifiers::default()
            },
        ));
        {
            let inner = host.inner.lock().expect("host inner");
            let selection = inner
                .inputs
                .get(&text_area.raw())
                .expect("text area")
                .editor
                .selection();
            let home = snapshot
                .index_map()
                .utf8_to_grapheme(second_home.offset().get())
                .expect("second-line home");
            let end = snapshot
                .index_map()
                .utf8_to_grapheme(second_end.offset().get())
                .expect("second-line end");
            assert_eq!(selection, TextSelection::new(home, end));
        }

        assert!(!app.pointer_pressed(40.0, f64::from(start_y), 1.0));
        assert!(!app.pointer_released(40.0, f64::from(start_y), 1.0));
        assert!(!app.key_command(KeyInput::ArrowDown, PlatformKeyModifiers::default()));

        assert!(!app.key_command(
            KeyInput::ArrowDown,
            PlatformKeyModifiers {
                shift: true,
                ..PlatformKeyModifiers::default()
            },
        ));
        let inner = host.inner.lock().expect("host inner");
        let selection = inner
            .inputs
            .get(&text_area.raw())
            .expect("text area")
            .editor
            .selection();
        let second_grapheme = snapshot
            .index_map()
            .utf8_to_grapheme(second.offset().get())
            .expect("second-line caret");
        let third_grapheme = snapshot
            .index_map()
            .utf8_to_grapheme(third.offset().get())
            .expect("third-line caret");
        assert_eq!(
            selection,
            TextSelection::new(second_grapheme, third_grapheme)
        );
        assert!(
            inner
                .arena
                .get(text_area)
                .expect("text area node")
                .style
                .scroll_offset_y
                > 0.0
        );
        assert_eq!(app.dispatcher.pending_count(), 0);
    }

    #[test]
    fn arrow_right_uses_mixed_bidi_visual_caret_order_through_the_bridge() {
        let host = mixed_bidi_text_host();
        let input = host.create_node(NodeType::View);
        let text = host.create_text("A مرحبا A");
        host.set_number(input, PropertyId::Width, 240.0);
        host.set_number(input, PropertyId::Height, 40.0);
        host.set_number(text, PropertyId::FontSize, 20.0);
        host.insert(text, input);
        host.register_input(input, text, "Mixed text");
        host.layout(240.0, 40.0);

        let expected = {
            let mut inner = host.inner.lock().expect("host inner");
            let snapshot = inner
                .text_cache
                .snapshot_for_node(text)
                .expect("mixed paragraph snapshot");
            let pair = snapshot.lines()[0]
                .caret_stops()
                .windows(2)
                .find(|pair| {
                    let left = snapshot
                        .index_map()
                        .utf8_to_grapheme(pair[0].offset().get())
                        .expect("left grapheme");
                    let right = snapshot
                        .index_map()
                        .utf8_to_grapheme(pair[1].offset().get())
                        .expect("right grapheme");
                    left.abs_diff(right) > 1
                })
                .expect("fixture exposes visual/logical order difference");
            let start = pair[0];
            let expected = pair[1];
            let start_grapheme = snapshot
                .index_map()
                .utf8_to_grapheme(start.offset().get())
                .expect("start grapheme");
            let expected_grapheme = snapshot
                .index_map()
                .utf8_to_grapheme(expected.offset().get())
                .expect("expected grapheme");
            let arena = inner.arena.clone();
            let root = inner.root;
            assert!(inner.focus.request_focus(input, &arena, root));
            inner.focused = inner.focus.focused();
            let field = inner.inputs.get_mut(&input.raw()).expect("input field");
            field
                .editor
                .set_caret(start_grapheme, false)
                .expect("start caret");
            field.caret_affinity = start.affinity();
            (expected_grapheme, expected.affinity())
        };
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            input,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        assert!(!app.key_command(KeyInput::ArrowRight, PlatformKeyModifiers::default()));

        let inner = host.inner.lock().expect("host inner");
        let field = inner.inputs.get(&input.raw()).expect("input field");
        assert_eq!(
            field.editor.selection(),
            TextSelection::collapsed(expected.0)
        );
        assert_eq!(field.caret_affinity, expected.1);
    }

    #[test]
    fn space_command_and_text_paths_invoke_the_focused_button_once() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let button = host.create_node(NodeType::View);
        host.insert(button, root);
        host.add_click_listener(button, 7);
        {
            let mut inner = host.inner.lock().expect("host inner");
            let arena = inner.arena.clone();
            let root = inner.root;
            assert!(inner.focus.request_focus(button, &arena, root));
            inner.focused = inner.focus.focused();
        }
        let mut app = metrics_test_app(
            Arc::clone(&host.inner),
            root,
            ErrorSupervisor::default(),
            FrameMetricsObserver::default(),
        );

        assert!(!app.key_command(KeyInput::Space, PlatformKeyModifiers::default()));
        assert!(!app.text_input(" "));

        let events = app.dispatcher.drain_tick();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0].payload,
            HostUiEvent::Click { node, .. } if node == button
        ));
    }
}

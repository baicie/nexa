//! Perry FFI exports for the Nexa UI Host Protocol.
//!
//! Isolates `perry-ffi` from `nui-core` / `nui-perry-bridge` (ADR-004 §8).

mod performance;
mod perry_full_stdlib_compat;

use std::any::Any;
#[cfg(not(test))]
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, OnceLock};

use nui_app_runtime::{ErrorSupervisor, OwnerId, OwnerScope, OwnerState, Scheduler};
use nui_core::protocol::common::NexaError;
use nui_core::protocol::ui::{
    SemanticAction as ProtocolSemanticAction, SemanticRole as ProtocolSemanticRole,
    Semantics as ProtocolSemantics, WindowLifecycleEvent, WindowLifecycleKind,
};
use nui_core::{EventId, NodeId, NodeType, PropertyId, SemanticAction, SemanticRole, Semantics};
use nui_perry_bridge::{
    composition_bounds_result_json, error_result_json, fatal_runtime_nexa_error,
    handle_parts_to_node_id, handshake_json_with_error, invalid_handle_result_json,
    invalid_listener_argument_result_json, invalid_property_result_json,
    listener_handle_result_json, listener_remove_result_json_with_handle, mutation_nexa_error,
    mutation_receipt_result_json, mutation_result_json, node_handle_result_json,
    node_invalid_argument_result_json, operation_state_nexa_error, property_result_json,
    text_input_replace_result_json, text_input_state_result_json, unit_result_json, CallbackHandle,
    CallbackRegistry, HostUiEvent, ListenerKey, MutationError, NuiHost, RemoveResult,
};
use performance::PerformanceCapture;
use perry_ffi::{
    alloc_string, gc_register_mutable_root_scanner_named, read_string, JsClosure, JsString,
    JsValue, RawClosureHeader, StringHeader,
};

fn runtime_waker() -> &'static Mutex<Option<nui_platform_winit::RuntimeWaker>> {
    static WAKER: OnceLock<Mutex<Option<nui_platform_winit::RuntimeWaker>>> = OnceLock::new();
    WAKER.get_or_init(|| Mutex::new(None))
}

#[cfg(not(test))]
extern "C" fn wake_runtime_event_loop() {
    let waker = runtime_waker()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if let Some(waker) = waker {
        waker.wake();
    }
}

#[cfg(not(test))]
unsafe extern "C" fn wake_perry_runtime(_context: *mut c_void) {
    wake_runtime_event_loop();
}

#[cfg(not(test))]
extern "C" {
    fn nexa_system_set_runtime_wakeup_v1(callback: Option<extern "C" fn()>);
    fn nexa_system_begin_owner_v1(owner: u64) -> i32;
    fn nexa_system_end_owner_v1(owner: u64) -> i32;
    fn nexa_system_drain_completions_v1(scheduler: *const c_void) -> i32;
    fn perry_set_wake_callback(
        callback: Option<unsafe extern "C" fn(*mut c_void)>,
        context: *mut c_void,
    );
    fn perry_poll() -> i32;
}

fn system_begin_owner(owner: u64) -> i32 {
    #[cfg(not(test))]
    unsafe {
        nexa_system_begin_owner_v1(owner)
    }
    #[cfg(test)]
    {
        let _ = owner;
        0
    }
}

fn system_end_owner(owner: u64) -> i32 {
    #[cfg(not(test))]
    unsafe {
        nexa_system_end_owner_v1(owner)
    }
    #[cfg(test)]
    {
        let _ = owner;
        0
    }
}

fn install_runtime_wakeup(waker: nui_platform_winit::RuntimeWaker) {
    *runtime_waker()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(waker);
    #[cfg(not(test))]
    unsafe {
        nexa_system_set_runtime_wakeup_v1(Some(wake_runtime_event_loop));
        perry_set_wake_callback(Some(wake_perry_runtime), std::ptr::null_mut());
    }
}

fn clear_runtime_wakeup() {
    #[cfg(not(test))]
    unsafe {
        perry_set_wake_callback(None, std::ptr::null_mut());
        nexa_system_set_runtime_wakeup_v1(None);
    }
    *runtime_waker()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

fn drain_system_completions(scheduler: &Scheduler) -> bool {
    #[cfg(not(test))]
    unsafe {
        nexa_system_drain_completions_v1((scheduler as *const Scheduler).cast()) > 0
    }
    #[cfg(test)]
    {
        let _ = scheduler;
        false
    }
}

fn poll_perry_microtasks() -> bool {
    #[cfg(not(test))]
    unsafe {
        perry_poll() > 0
    }
    #[cfg(test)]
    {
        false
    }
}

struct HostSession {
    host: NuiHost,
    callbacks: CallbackRegistry,
    pending_callbacks: Option<PendingCallbackState>,
    owner_scope: OwnerScope,
}

#[derive(Clone)]
struct PendingCallbackState {
    callbacks: CallbackRegistry,
}

impl Default for HostSession {
    fn default() -> Self {
        let host = NuiHost::with_system_fonts().unwrap_or_else(|error| {
            let host = NuiHost::new();
            host.error_supervisor().report(operation_state_nexa_error(
                "fontDiscovery",
                error.to_string(),
            ));
            host
        });
        let mut owner_scope = OwnerScope::new(OwnerId::from_raw(host.owner()));
        owner_scope.activate();
        Self {
            host,
            callbacks: CallbackRegistry::default(),
            pending_callbacks: None,
            owner_scope,
        }
    }
}

impl HostSession {
    fn handshake(&self, input: &str) -> String {
        let (json, error) = handshake_json_with_error(input);
        if let Some(error) = error {
            self.host.error_supervisor().report(error);
        }
        json
    }

    fn commit_pending(&self) -> Result<Option<nui_core::MutationReceipt>, MutationError> {
        let result = self.host.commit_pending();
        if let Err(error) = result {
            self.host
                .error_supervisor()
                .report(mutation_nexa_error(error, "commit"));
        }
        result
    }

    fn ensure_pending_callbacks(&mut self) -> &mut PendingCallbackState {
        self.pending_callbacks
            .get_or_insert_with(|| PendingCallbackState {
                callbacks: self.callbacks.clone(),
            })
    }

    fn commit_pending_callbacks(&mut self) {
        let Some(pending) = self.pending_callbacks.take() else {
            return;
        };
        self.callbacks = pending.callbacks;
    }

    fn abort_pending(&mut self) {
        self.host.abort_pending();
        if let Some(pending) = self.pending_callbacks.take() {
            self.callbacks.absorb_aborted(pending.callbacks);
        }
    }

    fn begin_close(&mut self) {
        self.owner_scope.begin_close();
        if self.owner_scope.state() != OwnerState::Closing {
            return;
        }
        if let Some(pending) = self.pending_callbacks.take() {
            self.callbacks.absorb_aborted(pending.callbacks);
        }
        self.host.abort_pending();
        let owner = self.owner_scope.id().raw();
        let _ = self.callbacks.invalidate_owner(owner);
    }

    fn finish_reset(&mut self) {
        if self.owner_scope.state() != OwnerState::Closing {
            self.begin_close();
        }
        self.host.reset();
        self.owner_scope.drain_deferred();
        self.owner_scope.finish_close();

        let mut next_scope = OwnerScope::new(OwnerId::from_raw(self.host.owner()));
        next_scope.activate();
        self.owner_scope = next_scope;
    }

    fn reset(&mut self) {
        self.begin_close();
        self.finish_reset();
    }
}

fn session() -> &'static Mutex<HostSession> {
    static SESSION: OnceLock<Mutex<HostSession>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(HostSession::default()))
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "native panic without a string payload".to_owned()
    }
}

fn guard_ffi<T>(
    errors: &ErrorSupervisor,
    operation: &str,
    body: impl FnOnce() -> T,
    on_panic: impl FnOnce(&NexaError) -> T,
) -> T {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(value) => value,
        Err(payload) => {
            let error = fatal_runtime_nexa_error(
                operation,
                format!("native FFI panic: {}", panic_message(payload.as_ref())),
            );
            errors.report(error.clone());
            on_panic(&error)
        }
    }
}

fn ffi_error_supervisor() -> ErrorSupervisor {
    session()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .host
        .error_supervisor()
}

macro_rules! guard_ffi_result {
    ($operation:literal, $body:block) => {{
        let errors = ffi_error_supervisor();
        guard_ffi(
            &errors,
            $operation,
            || $body,
            |error| alloc_string(&error_result_json(error)).as_raw(),
        )
    }};
}

macro_rules! guard_ffi_value {
    ($operation:literal, $fallback:expr, $body:block) => {{
        let errors = ffi_error_supervisor();
        guard_ffi(&errors, $operation, || $body, |_| $fallback)
    }};
}

fn cleanup_after_commit(session: &mut HostSession) {
    session.commit_pending_callbacks();
    for callback in session.host.take_last_removed_listener_handles() {
        let _ = session
            .callbacks
            .remove_owned(session.host.owner(), callback);
    }
    let _ = session.host.take_last_removed_nodes();
}

fn ensure_closure_scanner() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        gc_register_mutable_root_scanner_named("nexa-nui-host", |visitor| {
            if let Ok(mut session) = session().lock() {
                session.callbacks.visit_active_tokens(|cb| {
                    visitor.visit_i64_slot(cb);
                });
                if let Some(pending) = session.pending_callbacks.as_mut() {
                    pending.callbacks.visit_active_tokens(|cb| {
                        visitor.visit_i64_slot(cb);
                    });
                }
            }
        });
    });
}

fn node_from_raw(raw: u64) -> NodeId {
    NodeId::from_raw(raw)
}

fn exact_u32(value: f64) -> Option<u32> {
    (value.is_finite() && value.fract() == 0.0 && value >= 0.0 && value <= f64::from(u32::MAX))
        .then_some(value as u32)
}

fn property_from_u32(property: u32) -> Option<PropertyId> {
    Some(match property {
        1 => PropertyId::Width,
        2 => PropertyId::Height,
        3 => PropertyId::MinWidth,
        4 => PropertyId::MinHeight,
        5 => PropertyId::Padding,
        6 => PropertyId::Gap,
        7 => PropertyId::FlexDirection,
        8 => PropertyId::AlignItems,
        9 => PropertyId::JustifyContent,
        10 => PropertyId::BackgroundColor,
        11 => PropertyId::BorderRadius,
        12 => PropertyId::Opacity,
        13 => PropertyId::FontSize,
        14 => PropertyId::FontWeight,
        15 => PropertyId::TextColor,
        16 => PropertyId::ScrollOffsetY,
        17 => PropertyId::FlexGrow,
        18 => PropertyId::Disabled,
        _ => return None,
    })
}

fn event_from_u32(event: u32) -> Option<EventId> {
    Some(match event {
        1 => EventId::Click,
        2 => EventId::Change,
        3 => EventId::Submit,
        8 => EventId::Composition,
        10 => EventId::WindowLifecycle,
        _ => return None,
    })
}

fn semantics_from_json(input: &str) -> Result<Semantics, MutationError> {
    const FIELDS: &[&str] = &[
        "role",
        "label",
        "value",
        "description",
        "disabled",
        "checked",
        "actions",
    ];
    let value: serde_json::Value =
        serde_json::from_str(input).map_err(|_| MutationError::InvalidSemantics)?;
    let object = value.as_object().ok_or(MutationError::InvalidSemantics)?;
    if object.keys().any(|name| !FIELDS.contains(&name.as_str())) {
        return Err(MutationError::InvalidSemantics);
    }
    let semantics: ProtocolSemantics =
        serde_json::from_value(value).map_err(|_| MutationError::InvalidSemantics)?;
    Ok(Semantics {
        role: match semantics.role.unwrap_or(ProtocolSemanticRole::None) {
            ProtocolSemanticRole::None => SemanticRole::None,
            ProtocolSemanticRole::Button => SemanticRole::Button,
            ProtocolSemanticRole::Text => SemanticRole::Text,
            ProtocolSemanticRole::Image => SemanticRole::Image,
            ProtocolSemanticRole::TextInput => SemanticRole::TextInput,
            ProtocolSemanticRole::Scroll => SemanticRole::Scroll,
            ProtocolSemanticRole::Header => SemanticRole::Header,
        },
        label: semantics.label,
        value: semantics.value,
        description: semantics.description,
        disabled: semantics.disabled.unwrap_or(false),
        checked: semantics.checked,
        actions: semantics
            .actions
            .unwrap_or_default()
            .into_iter()
            .map(|action| match action {
                ProtocolSemanticAction::Invoke => SemanticAction::Invoke,
                ProtocolSemanticAction::Focus => SemanticAction::Focus,
                ProtocolSemanticAction::SetValue => SemanticAction::SetValue,
            })
            .collect(),
    })
}

fn queue_callback(session: &mut HostSession, node: NodeId, event: EventId, callback: i64) -> bool {
    let key = ListenerKey::new(node.raw(), event as u32);
    let owner = session.host.owner();
    let before = session.ensure_pending_callbacks().clone();
    let (registration, _) = session
        .pending_callbacks
        .as_mut()
        .expect("pending callback state")
        .callbacks
        .add_owned(owner, key, callback);
    if session
        .host
        .queue_add_event_listener(node, event, registration.handle)
        .is_ok()
    {
        true
    } else {
        session.pending_callbacks = Some(before);
        false
    }
}

fn call_string_callback(cb: i64, value: &str) {
    if cb == 0 {
        return;
    }
    let closure = unsafe { JsClosure::from_raw(cb as *const RawClosureHeader) };
    if closure.is_null() {
        return;
    }
    let handle = alloc_string(value);
    let arg = f64::from_bits(JsValue::from_string_ptr(handle.as_raw()).0);
    let _ = unsafe { closure.call1(arg) };
}

fn callback_token(
    session: &HostSession,
    node: NodeId,
    event: EventId,
    callback: Option<CallbackHandle>,
) -> Option<i64> {
    let handle = callback?;
    let key = ListenerKey::new(node.raw(), event as u32);
    session
        .callbacks
        .active_for_key_owned(session.host.owner(), key)
        .filter(|registration| registration.handle == handle)
        .map(|registration| registration.token)
}

fn window_lifecycle_payload(event: &WindowLifecycleEvent) -> String {
    match event.surface_generation {
        Some(surface_generation) => serde_json::json!({
            "kind": event.kind,
            "surfaceGeneration": surface_generation,
        }),
        None => serde_json::json!({ "kind": event.kind }),
    }
    .to_string()
}

fn close_window_session<I, E>(
    system_owner: u64,
    root: Option<NodeId>,
    mut invoke_callback: I,
    mut end_owner: E,
) where
    I: FnMut(i64, &str),
    E: FnMut(u64) -> i32,
{
    let callback = {
        let session = session().lock().expect("host session");
        root.and_then(|node| {
            let callback = session.host.event_listener(node, EventId::WindowLifecycle);
            callback_token(&session, node, EventId::WindowLifecycle, callback)
        })
    };
    if let Some(callback) = callback {
        let payload = window_lifecycle_payload(&WindowLifecycleEvent {
            kind: WindowLifecycleKind::CloseRequested,
            surface_generation: None,
        });
        invoke_callback(callback, &payload);
    }

    let _ = end_owner(system_owner);
    let mut session = session().lock().expect("host session");
    if session.host.owner() == system_owner {
        session.begin_close();
    }
}

/// # Safety
/// `hello_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_handshake_v1(
    hello_ptr: *const StringHeader,
) -> *const StringHeader {
    guard_ffi_result!("handshake", {
        let handle = JsString::from_raw(hello_ptr as *mut StringHeader);
        let hello = read_string(handle).unwrap_or("");
        let result = session().lock().expect("host session").handshake(hello);
        alloc_string(&result).as_raw()
    })
}

/// Create a node through the stable v1 HandleRef string-result ABI.
#[no_mangle]
pub extern "C" fn js_nui_create_node_v1(node_type: u32) -> *const StringHeader {
    guard_ffi_result!("createNode", {
        let ty = match node_type {
            0 => NodeType::Root,
            1 => NodeType::View,
            2 => NodeType::Text,
            3 => NodeType::Image,
            4 => NodeType::Scroll,
            _ => {
                session()
                    .lock()
                    .expect("host session")
                    .host
                    .poison_pending(MutationError::InvalidNodeType(node_type));
                let result = node_invalid_argument_result_json("unknown node type");
                return alloc_string(&result).as_raw();
            }
        };
        let session = session().lock().expect("host session");
        let result = match session.host.queue_create_node(ty) {
            Ok(node) => node_handle_result_json(node),
            Err(error) => mutation_result_json(Err(error), "createNode"),
        };
        alloc_string(&result).as_raw()
    })
}

#[no_mangle]
pub extern "C" fn js_nui_create_node(node_type: f64) -> u64 {
    guard_ffi_value!("createNode", 0, {
        let Some(node_type) = exact_u32(node_type) else {
            session()
                .lock()
                .expect("host session")
                .host
                .poison_pending(MutationError::InvalidNodeType(u32::MAX));
            return 0;
        };
        let ty = match node_type {
            0 => NodeType::Root,
            1 => NodeType::View,
            2 => NodeType::Text,
            3 => NodeType::Image,
            4 => NodeType::Scroll,
            _ => {
                session()
                    .lock()
                    .expect("host session")
                    .host
                    .poison_pending(MutationError::InvalidNodeType(node_type));
                return 0;
            }
        };
        let session = session().lock().expect("host session");
        session
            .host
            .queue_create_node(ty)
            .map_or(0, |node| node.raw())
    })
}

/// # Safety
/// `text_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_create_text(text_ptr: *const StringHeader) -> u64 {
    guard_ffi_value!("createText", 0, {
        let handle = JsString::from_raw(text_ptr as *mut StringHeader);
        let text = read_string(handle).unwrap_or("");
        let session = session().lock().expect("host session");
        session
            .host
            .queue_create_text(text)
            .map_or(0, |node| node.raw())
    })
}

#[no_mangle]
pub extern "C" fn js_nui_insert(child: u64, parent: u64, before: u64) {
    guard_ffi_value!("insert", (), {
        let session = session().lock().expect("host session");
        let before = if before == 0 {
            None
        } else {
            Some(node_from_raw(before))
        };
        let _ =
            session
                .host
                .queue_insert_before(node_from_raw(child), node_from_raw(parent), before);
    });
}

#[no_mangle]
pub extern "C" fn js_nui_remove(node: u64) {
    guard_ffi_value!("remove", (), {
        let session = session().lock().expect("host session");
        let id = node_from_raw(node);
        let _ = session.host.queue_remove(id);
    });
}

/// # Safety
/// `text_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_set_text(node: u64, text_ptr: *const StringHeader) {
    guard_ffi_value!("setText", (), {
        let handle = JsString::from_raw(text_ptr as *mut StringHeader);
        let text = read_string(handle).unwrap_or("");
        let session = session().lock().expect("host session");
        let _ = session.host.queue_set_text(node_from_raw(node), text);
    });
}

#[no_mangle]
pub extern "C" fn js_nui_set_number(node: u64, property: f64, value: f64) {
    guard_ffi_value!("setNumber", (), {
        let Some(property) = exact_u32(property) else {
            session()
                .lock()
                .expect("host session")
                .host
                .poison_pending(MutationError::InvalidPropertyId(u32::MAX));
            return;
        };
        let Some(prop) = property_from_u32(property) else {
            session()
                .lock()
                .expect("host session")
                .host
                .poison_pending(MutationError::InvalidPropertyId(property));
            return;
        };
        let session = session().lock().expect("host session");
        let _ = session
            .host
            .queue_set_number(node_from_raw(node), prop, value);
    });
}

/// Clear a property through the stable v1 string-result ABI.
#[no_mangle]
pub extern "C" fn js_nui_clear_property_v1(
    node_slot: u32,
    node_generation: u32,
    property: u32,
) -> *const StringHeader {
    guard_ffi_result!("clearProperty", {
        let Some(property) = property_from_u32(property) else {
            session()
                .lock()
                .expect("host session")
                .host
                .poison_pending(MutationError::InvalidPropertyId(property));
            let result = invalid_property_result_json(property);
            return alloc_string(&result).as_raw();
        };
        let node = match handle_parts_to_node_id(node_slot, node_generation) {
            Ok(node) => node,
            Err(_) => {
                let result =
                    invalid_handle_result_json("clearProperty", "node.generation", node_generation);
                return alloc_string(&result).as_raw();
            }
        };
        let session = session().lock().expect("host session");
        let result = match session.host.queue_clear_property(node, property) {
            Ok(()) => property_result_json(Ok(())),
            Err(error) => mutation_result_json(Err(error), "clearProperty"),
        };
        alloc_string(&result).as_raw()
    })
}

/// Queue explicit visual-tree semantics through the stable v1 JSON ABI.
///
/// # Safety
/// `semantics_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_set_semantics_v1(
    node_slot: u32,
    node_generation: u32,
    semantics_ptr: *const StringHeader,
) -> *const StringHeader {
    guard_ffi_result!("setSemantics", {
        let node = match handle_parts_to_node_id(node_slot, node_generation) {
            Ok(node) => node,
            Err(_) => {
                session().lock().expect("host session").host.poison_pending(
                    MutationError::StaleNode(NodeId::new(node_slot, node_generation)),
                );
                let result =
                    invalid_handle_result_json("setSemantics", "node.generation", node_generation);
                return alloc_string(&result).as_raw();
            }
        };
        let handle = JsString::from_raw(semantics_ptr as *mut StringHeader);
        let semantics = read_string(handle)
            .ok_or(MutationError::InvalidSemantics)
            .and_then(semantics_from_json);
        let session = session().lock().expect("host session");
        let result = match semantics {
            Ok(semantics) => session.host.queue_set_semantics(node, semantics),
            Err(error) => {
                session.host.poison_pending(error);
                Err(error)
            }
        };
        alloc_string(&mutation_result_json(result, "setSemantics")).as_raw()
    })
}

/// Clear explicit semantics so component defaults can be derived again.
#[no_mangle]
pub extern "C" fn js_nui_clear_semantics_v1(
    node_slot: u32,
    node_generation: u32,
) -> *const StringHeader {
    guard_ffi_result!("clearSemantics", {
        let node = match handle_parts_to_node_id(node_slot, node_generation) {
            Ok(node) => node,
            Err(_) => {
                session().lock().expect("host session").host.poison_pending(
                    MutationError::StaleNode(NodeId::new(node_slot, node_generation)),
                );
                let result = invalid_handle_result_json(
                    "clearSemantics",
                    "node.generation",
                    node_generation,
                );
                return alloc_string(&result).as_raw();
            }
        };
        let session = session().lock().expect("host session");
        let result = session.host.queue_clear_semantics(node);
        alloc_string(&mutation_result_json(result, "clearSemantics")).as_raw()
    })
}

/// Register a composite View as a first-party Button for default semantics.
#[no_mangle]
pub extern "C" fn js_nui_register_button_v1(
    node_slot: u32,
    node_generation: u32,
) -> *const StringHeader {
    guard_ffi_result!("registerButton", {
        let node = match handle_parts_to_node_id(node_slot, node_generation) {
            Ok(node) => node,
            Err(_) => {
                session().lock().expect("host session").host.poison_pending(
                    MutationError::StaleNode(NodeId::new(node_slot, node_generation)),
                );
                let result = invalid_handle_result_json(
                    "registerButton",
                    "node.generation",
                    node_generation,
                );
                return alloc_string(&result).as_raw();
            }
        };
        let session = session().lock().expect("host session");
        let result = session.host.queue_register_button(node);
        alloc_string(&mutation_result_json(result, "registerButton")).as_raw()
    })
}

/// Add or replace one callback through the stable v1 listener ABI.
#[no_mangle]
pub extern "C" fn js_nui_add_event_listener_v1(
    node_slot: u32,
    node_generation: u32,
    event: u32,
    callback: i64,
) -> *const StringHeader {
    guard_ffi_result!("addEventListener", {
        ensure_closure_scanner();
        let node = match handle_parts_to_node_id(node_slot, node_generation) {
            Ok(node) => node,
            Err(_) => {
                let result = invalid_handle_result_json(
                    "addEventListener",
                    "node.generation",
                    node_generation,
                );
                return alloc_string(&result).as_raw();
            }
        };
        let Some(event) = event_from_u32(event) else {
            let result = invalid_listener_argument_result_json(
                "addEventListener",
                "event",
                "known ui.EventId",
                &event.to_string(),
            );
            return alloc_string(&result).as_raw();
        };
        if callback == 0 {
            let result = invalid_listener_argument_result_json(
                "addEventListener",
                "callback",
                "non-null function",
                "null",
            );
            return alloc_string(&result).as_raw();
        }

        let mut session = session().lock().expect("host session");
        if !session.host.has_node(node) && !session.host.has_pending_batch() {
            let result =
                listener_handle_result_json(Err(nui_perry_bridge::HostListenerError::StaleNode {
                    node,
                    current_generation: session.host.current_generation(node.slot()),
                }));
            return alloc_string(&result).as_raw();
        }

        let key = ListenerKey::new(node.raw(), event as u32);
        let owner = session.host.owner();
        let before = session.ensure_pending_callbacks().clone();
        let (registration, _replaced) = session
            .pending_callbacks
            .as_mut()
            .expect("pending callback state")
            .callbacks
            .add_owned(owner, key, callback);
        let result = match session
            .host
            .queue_add_event_listener(node, event, registration.handle)
        {
            Ok(_) => listener_handle_result_json(Ok(registration.handle)),
            Err(error) => {
                session.pending_callbacks = Some(before);
                listener_handle_result_json(Err(error))
            }
        };
        alloc_string(&result).as_raw()
    })
}

/// Remove a callback through the stable v1 listener ABI. Closed and stale
/// callback handles intentionally resolve as idempotent success.
#[no_mangle]
pub extern "C" fn js_nui_remove_event_listener_v1(
    listener_slot: u32,
    listener_generation: u32,
) -> *const StringHeader {
    guard_ffi_result!("removeEventListener", {
        if listener_generation == 0 {
            let result = invalid_handle_result_json(
                "removeEventListener",
                "listener.generation",
                listener_generation,
            );
            return alloc_string(&result).as_raw();
        }
        let handle = CallbackHandle::new(listener_slot, listener_generation);
        let mut session = session().lock().expect("host session");
        let owner = session.host.owner();
        let had_pending = session.pending_callbacks.is_some();
        let before = session.ensure_pending_callbacks().clone();
        let current_generation = session
            .pending_callbacks
            .as_ref()
            .and_then(|pending| pending.callbacks.current_generation(handle.slot()));
        let remove_result = session
            .pending_callbacks
            .as_mut()
            .expect("pending callback state")
            .callbacks
            .remove_owned(owner, handle);
        if let RemoveResult::Closed(registration) = remove_result {
            if let Some(event) = event_from_u32(registration.key.event) {
                let node = node_from_raw(registration.key.node_raw);
                if !session
                    .host
                    .queue_remove_event_listener(node, event, handle)
                {
                    session.pending_callbacks = Some(before);
                }
            }
        } else if !had_pending {
            session.pending_callbacks = None;
        }
        let result = listener_remove_result_json_with_handle(
            remove_result,
            Some(handle),
            current_generation,
        );
        alloc_string(&result).as_raw()
    })
}

#[no_mangle]
pub extern "C" fn js_nui_add_click_listener(node: u64, callback: i64) {
    guard_ffi_value!("addClickListener", (), {
        ensure_closure_scanner();
        let mut session = session().lock().expect("host session");
        let id = node_from_raw(node);
        let _ = queue_callback(&mut session, id, EventId::Click, callback);
    });
}

/// # Safety
/// `placeholder_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_register_input(
    container: u64,
    text_node: u64,
    placeholder_ptr: *const StringHeader,
) {
    guard_ffi_value!("registerInput", (), {
        let handle = JsString::from_raw(placeholder_ptr as *mut StringHeader);
        let placeholder = read_string(handle).unwrap_or("");
        let session = session().lock().expect("host session");
        let _ = session.host.queue_register_input(
            node_from_raw(container),
            node_from_raw(text_node),
            placeholder,
        );
    });
}

#[no_mangle]
pub extern "C" fn js_nui_add_change_listener(node: u64, callback: i64) {
    guard_ffi_value!("addChangeListener", (), {
        ensure_closure_scanner();
        let mut session = session().lock().expect("host session");
        let id = node_from_raw(node);
        let _ = queue_callback(&mut session, id, EventId::Change, callback);
    });
}

#[no_mangle]
pub extern "C" fn js_nui_add_submit_listener(node: u64, callback: i64) {
    guard_ffi_value!("addSubmitListener", (), {
        ensure_closure_scanner();
        let mut session = session().lock().expect("host session");
        let id = node_from_raw(node);
        let _ = queue_callback(&mut session, id, EventId::Submit, callback);
    });
}

/// # Safety
/// `path_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_set_image(node: u64, path_ptr: *const StringHeader) {
    guard_ffi_value!("setImage", (), {
        let handle = JsString::from_raw(path_ptr as *mut StringHeader);
        let path = read_string(handle).unwrap_or("");
        let session = session().lock().expect("host session");
        let _ = session.host.queue_set_image(node_from_raw(node), path);
    });
}

#[no_mangle]
pub extern "C" fn js_nui_commit() {
    guard_ffi_value!("commit", (), {
        let mut session = session().lock().expect("host session");
        match session.commit_pending() {
            Ok(_) => cleanup_after_commit(&mut session),
            Err(error) => {
                session.abort_pending();
                eprintln!("nui commit rejected: {error:?}");
            }
        }
    });
}

/// Commit through the stable result-envelope ABI.
#[no_mangle]
pub extern "C" fn js_nui_commit_v1() -> *const StringHeader {
    guard_ffi_result!("commit", {
        let mut session = session().lock().expect("host session");
        let commit = session.commit_pending();
        let succeeded = commit.is_ok();
        let result = mutation_receipt_result_json(commit);
        if succeeded {
            cleanup_after_commit(&mut session);
        } else {
            session.abort_pending();
        }
        alloc_string(&result).as_raw()
    })
}

/// Close the current owner scope and prepare an empty session for remount.
#[no_mangle]
pub extern "C" fn js_nui_reset_session_v1() -> *const StringHeader {
    guard_ffi_result!("resetSession", {
        session().lock().expect("host session").reset();
        alloc_string(&unit_result_json()).as_raw()
    })
}

/// Query a registered input through the stable UTF-16 TextInputClient ABI.
#[no_mangle]
pub extern "C" fn js_nui_get_text_input_state_v1(
    node_slot: u32,
    node_generation: u32,
) -> *const StringHeader {
    guard_ffi_result!("getTextInputState", {
        let node = match handle_parts_to_node_id(node_slot, node_generation) {
            Ok(node) => node,
            Err(_) => {
                let result = invalid_handle_result_json(
                    "getTextInputState",
                    "node.generation",
                    node_generation,
                );
                return alloc_string(&result).as_raw();
            }
        };
        let session = session().lock().expect("host session");
        let result = text_input_state_result_json(session.host.text_input_state(node));
        alloc_string(&result).as_raw()
    })
}

/// Replace a UTF-16 range through the stable TextInputClient ABI.
///
/// # Safety
/// `text_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_replace_text_input_v1(
    node_slot: u32,
    node_generation: u32,
    range_start: u32,
    range_end: u32,
    text_ptr: *const StringHeader,
) -> *const StringHeader {
    guard_ffi_result!("replaceTextInput", {
        let node = match handle_parts_to_node_id(node_slot, node_generation) {
            Ok(node) => node,
            Err(_) => {
                let result = invalid_handle_result_json(
                    "replaceTextInput",
                    "node.generation",
                    node_generation,
                );
                return alloc_string(&result).as_raw();
            }
        };
        let handle = JsString::from_raw(text_ptr as *mut StringHeader);
        let text = read_string(handle).unwrap_or("");
        let session = session().lock().expect("host session");
        let result = text_input_replace_result_json(session.host.replace_text_input(
            node,
            nui_core::protocol::ui::TextRange {
                start: range_start,
                end: range_end,
            },
            text,
        ));
        alloc_string(&result).as_raw()
    })
}

/// Query the current paragraph-derived caret rectangle for platform IME UI.
#[no_mangle]
pub extern "C" fn js_nui_get_composition_bounds_v1(
    node_slot: u32,
    node_generation: u32,
) -> *const StringHeader {
    guard_ffi_result!("getCompositionBounds", {
        let node = match handle_parts_to_node_id(node_slot, node_generation) {
            Ok(node) => node,
            Err(_) => {
                let result = invalid_handle_result_json(
                    "getCompositionBounds",
                    "node.generation",
                    node_generation,
                );
                return alloc_string(&result).as_raw();
            }
        };
        let session = session().lock().expect("host session");
        let result = composition_bounds_result_json(session.host.composition_bounds(node));
        alloc_string(&result).as_raw()
    })
}

/// # Safety
/// `title_ptr` must be null or a Perry-runtime `StringHeader`.
#[allow(clippy::result_large_err)]
fn run_host(title: &str) -> Result<(), NexaError> {
    let host = {
        let session = session().lock().expect("host session");
        session.host.clone()
    };
    let performance_capture = PerformanceCapture::from_environment()
        .map_err(|message| operation_state_nexa_error("performanceCapture", message))?;
    let system_owner = host.owner();
    if system_begin_owner(system_owner) != 0 {
        return Err(fatal_runtime_nexa_error(
            "initializeSystemRuntime",
            "System Host could not activate the current window owner",
        ));
    }
    if let Some(capture) = &performance_capture {
        capture.install(&host.frame_metrics_observer());
    }
    let close_host = host.clone();
    let performance_redraw = performance_capture.clone();

    let result = host.run_with_runtime_hooks_v1(
        title,
        move |ev| match ev {
            HostUiEvent::Click { node, callback } => {
                let cb = {
                    let session = session().lock().expect("host session");
                    callback_token(&session, node, EventId::Click, callback)
                };
                let Some(cb) = cb else {
                    return false;
                };
                if cb == 0 {
                    return false;
                }
                let closure = unsafe { JsClosure::from_raw(cb as *const RawClosureHeader) };
                if closure.is_null() {
                    return false;
                }
                let _ = unsafe { closure.call0() };
                true
            }
            HostUiEvent::Change {
                node,
                value,
                callback,
            } => {
                let cb = {
                    let session = session().lock().expect("host session");
                    callback_token(&session, node, EventId::Change, callback)
                };
                if let Some(cb) = cb {
                    call_string_callback(cb, &value);
                }
                true
            }
            HostUiEvent::Submit {
                node,
                value,
                callback,
            } => {
                let submit_cb = {
                    let session = session().lock().expect("host session");
                    callback_token(&session, node, EventId::Submit, callback)
                        .or_else(|| callback_token(&session, node, EventId::Change, callback))
                };
                if let Some(cb) = submit_cb {
                    call_string_callback(cb, &value);
                }
                true
            }
            HostUiEvent::Composition {
                node,
                event,
                callback,
            } => {
                let cb = {
                    let session = session().lock().expect("host session");
                    callback_token(&session, node, EventId::Composition, callback)
                };
                if let (Some(cb), Ok(payload)) = (cb, serde_json::to_string(&event)) {
                    call_string_callback(cb, &payload);
                }
                true
            }
            HostUiEvent::WindowLifecycle {
                node,
                event,
                callback,
            } => {
                if event.kind == WindowLifecycleKind::CloseRequested {
                    return false;
                }
                let cb = {
                    let session = session().lock().expect("host session");
                    callback_token(&session, node, EventId::WindowLifecycle, callback)
                };
                if let Some(cb) = cb {
                    call_string_callback(cb, &window_lifecycle_payload(&event));
                }
                true
            }
        },
        move || {
            let mut session = session().lock().expect("host session");
            let mut redraw = match session.commit_pending() {
                Ok(Some(receipt)) => {
                    cleanup_after_commit(&mut session);
                    receipt.dirty.bits() != 0
                }
                Ok(None) => {
                    cleanup_after_commit(&mut session);
                    false
                }
                Err(error) => {
                    session.abort_pending();
                    eprintln!("nui commit rejected: {error:?}");
                    false
                }
            };
            redraw |= performance_redraw
                .as_ref()
                .is_some_and(PerformanceCapture::needs_redraw);
            redraw
        },
        install_runtime_wakeup,
        drain_system_completions,
        poll_perry_microtasks,
        move || {
            close_window_session(
                system_owner,
                close_host.root(),
                call_string_callback,
                system_end_owner,
            );
        },
    );
    if performance_capture.is_some() {
        host.frame_metrics_observer().set_sink(None);
    }
    let _ = system_end_owner(system_owner);
    clear_runtime_wakeup();
    let mut session = session().lock().expect("host session");
    session.begin_close();
    session.finish_reset();
    result
}

/// # Safety
/// `title_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_run(title_ptr: *const StringHeader) {
    guard_ffi_value!("run", (), {
        let handle = JsString::from_raw(title_ptr as *mut StringHeader);
        let title = read_string(handle).unwrap_or("Nexa UI").to_owned();
        if let Err(error) = run_host(&title) {
            eprintln!("nui run failed: {error:?}");
        }
    });
}

/// Run the current Host session through the stable v1 result envelope.
///
/// # Safety
/// `title_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_run_v1(title_ptr: *const StringHeader) -> *const StringHeader {
    guard_ffi_result!("run", {
        let handle = JsString::from_raw(title_ptr as *mut StringHeader);
        let title = read_string(handle).unwrap_or("Nexa UI").to_owned();
        let result = run_host(&title)
            .map(|_| unit_result_json())
            .unwrap_or_else(|error| error_result_json(&error));
        alloc_string(&result).as_raw()
    })
}

#[cfg(test)]
#[no_mangle]
unsafe extern "C" fn js_string_from_bytes(data: *const u8, len: u32) -> *mut StringHeader {
    use std::alloc::{alloc, Layout};
    use std::ptr::{copy_nonoverlapping, null_mut, write};

    if data.is_null() && len != 0 {
        return null_mut();
    }
    let byte_len = len as usize;
    let bytes = if byte_len == 0 {
        &[][..]
    } else {
        // SAFETY: the Perry FFI allocator contract supplies `len` readable bytes.
        unsafe { std::slice::from_raw_parts(data, byte_len) }
    };
    let utf16_len = std::str::from_utf8(bytes)
        .ok()
        .and_then(|text| u32::try_from(text.encode_utf16().count()).ok())
        .unwrap_or(len);
    let header_size = std::mem::size_of::<StringHeader>();
    let layout = Layout::from_size_align(
        header_size.checked_add(byte_len).expect("test string size"),
        std::mem::align_of::<StringHeader>(),
    )
    .expect("test string layout");
    // SAFETY: `layout` is non-zero and valid for one header plus its payload.
    let allocation = unsafe { alloc(layout) };
    if allocation.is_null() {
        return null_mut();
    }
    // SAFETY: the allocation has room for the header and exactly `byte_len` bytes.
    unsafe {
        write(
            allocation.cast::<StringHeader>(),
            StringHeader {
                utf16_len,
                byte_len: len,
                capacity: len,
                refcount: 0,
                flags: 0,
            },
        );
        if byte_len != 0 {
            copy_nonoverlapping(data, allocation.add(header_size), byte_len);
        }
    }
    allocation.cast::<StringHeader>()
}

#[cfg(test)]
mod tests {
    use nui_app_runtime::ErrorSupervisor;
    use nui_core::protocol::common::ErrorSeverity;
    use nui_perry_bridge::CallbackRegistration;

    use super::*;

    static TEXT_INPUT_FFI_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct ResetGlobalSession;

    impl Drop for ResetGlobalSession {
        fn drop(&mut self) {
            session()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .reset();
        }
    }

    fn ffi_json(pointer: *const StringHeader) -> serde_json::Value {
        // SAFETY: every tested extern returns a Perry-owned string or null.
        let handle = unsafe { JsString::from_raw(pointer.cast_mut()) };
        let json = read_string(handle).expect("FFI result string");
        serde_json::from_str(json).expect("valid FFI result JSON")
    }

    fn assert_bounds(bounds: &serde_json::Value) {
        for field in ["x", "y", "width", "height"] {
            assert!(
                bounds[field].as_f64().is_some_and(f64::is_finite),
                "{field} must be finite: {bounds}"
            );
        }
        assert!(bounds["width"].as_f64().expect("width") > 0.0);
        assert!(bounds["height"].as_f64().expect("height") > 0.0);
    }

    fn assert_text_input_state(
        result: &serde_json::Value,
        expected_text: &str,
        expected_utf16_length: u64,
        expected_selection: u64,
        expected_revision: &str,
    ) {
        assert_eq!(result["ok"], true, "text input state error: {result}");
        let state = &result["value"];
        assert_eq!(state["text"], expected_text);
        assert_eq!(state["surroundingText"]["start"], 0);
        assert_eq!(state["surroundingText"]["end"], expected_utf16_length);
        assert_eq!(state["selection"]["anchor"], expected_selection);
        assert_eq!(state["selection"]["focus"], expected_selection);
        assert_eq!(state["composition"], serde_json::Value::Null);
        assert_eq!(state["revision"], expected_revision);
        assert_bounds(&state["compositionBounds"]);
    }

    #[test]
    fn text_input_v1_exports_match_generated_abi_signatures() {
        let _: extern "C" fn(u32, u32) -> *const StringHeader = js_nui_get_text_input_state_v1;
        let _: unsafe extern "C" fn(
            u32,
            u32,
            u32,
            u32,
            *const StringHeader,
        ) -> *const StringHeader = js_nui_replace_text_input_v1;
        let _: extern "C" fn(u32, u32) -> *const StringHeader = js_nui_get_composition_bounds_v1;
    }

    #[test]
    fn semantics_v1_exports_match_generated_abi_signatures() {
        let _: unsafe extern "C" fn(u32, u32, *const StringHeader) -> *const StringHeader =
            js_nui_set_semantics_v1;
        let _: extern "C" fn(u32, u32) -> *const StringHeader = js_nui_clear_semantics_v1;
        let _: extern "C" fn(u32, u32) -> *const StringHeader = js_nui_register_button_v1;
    }

    #[test]
    fn register_button_v1_drives_default_semantics_and_rejects_non_view_nodes() {
        let _serial = TEXT_INPUT_FFI_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reset();
        let _reset = ResetGlobalSession;
        let (button, label) = {
            let session = session().lock().expect("host session");
            let root = session.host.create_node(NodeType::View);
            let button = session.host.create_node(NodeType::View);
            let label = session.host.create_text("Save");
            session.host.insert(button, root);
            session.host.insert(label, button);
            session.host.set_number(root, PropertyId::Width, 320.0);
            session.host.set_number(root, PropertyId::Height, 200.0);
            session.host.set_number(button, PropertyId::Width, 100.0);
            session.host.set_number(button, PropertyId::Height, 32.0);
            session.host.layout(320.0, 200.0);
            (button, label)
        };

        assert!(session()
            .lock()
            .expect("host session")
            .host
            .semantic_snapshot()
            .node(button)
            .is_none());
        assert_eq!(
            ffi_json(js_nui_register_button_v1(
                button.slot(),
                button.generation()
            )),
            serde_json::json!({ "ok": true, "value": null })
        );
        assert!(
            session()
                .lock()
                .expect("host session")
                .host
                .semantic_snapshot()
                .node(button)
                .is_none(),
            "registration must remain pending"
        );
        let commit = ffi_json(js_nui_commit_v1());
        assert_eq!(commit["value"]["dirtyFlags"], 8);
        let snapshot = session()
            .lock()
            .expect("host session")
            .host
            .semantic_snapshot();
        assert_eq!(
            snapshot.node(button).expect("button semantics").role,
            SemanticRole::Button
        );
        assert_eq!(
            snapshot
                .node(button)
                .expect("button semantics")
                .name
                .as_deref(),
            Some("Save")
        );
        assert!(snapshot.node(label).is_none());

        let invalid = ffi_json(js_nui_register_button_v1(label.slot(), label.generation()));
        assert_eq!(invalid["ok"], false);
        assert_eq!(invalid["error"]["name"], "INVALID_KIND");
        assert_eq!(invalid["error"]["context"]["expectedKind"], "View");
        assert_eq!(ffi_json(js_nui_commit_v1())["ok"], false);
    }

    #[test]
    fn semantics_v1_set_clear_and_invalid_batches_are_atomic() {
        let _serial = TEXT_INPUT_FFI_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reset();
        let _reset = ResetGlobalSession;
        let node = session()
            .lock()
            .expect("host session")
            .host
            .create_node(NodeType::View);

        let semantics_json = alloc_string(
            r#"{"role":"Button","label":"Save","value":"draft","description":"Save note","disabled":false,"checked":true,"actions":["Invoke","Focus"]}"#,
        );
        // SAFETY: `semantics_json` is a live Perry-compatible test string.
        let set_result = ffi_json(unsafe {
            js_nui_set_semantics_v1(node.slot(), node.generation(), semantics_json.as_raw())
        });
        assert_eq!(set_result, serde_json::json!({ "ok": true, "value": null }));
        assert_eq!(
            session().lock().expect("host session").host.semantics(node),
            None
        );
        let set_commit = ffi_json(js_nui_commit_v1());
        assert_eq!(set_commit["ok"], true);
        assert_eq!(set_commit["value"]["dirtyFlags"], 8);
        let semantics = session()
            .lock()
            .expect("host session")
            .host
            .semantics(node)
            .expect("committed semantics");
        assert_eq!(semantics.role, nui_core::SemanticRole::Button);
        assert_eq!(semantics.label.as_deref(), Some("Save"));
        assert_eq!(semantics.value.as_deref(), Some("draft"));
        assert_eq!(semantics.description.as_deref(), Some("Save note"));
        assert!(!semantics.disabled);
        assert_eq!(semantics.checked, Some(true));
        assert_eq!(
            semantics.actions,
            vec![
                nui_core::SemanticAction::Invoke,
                nui_core::SemanticAction::Focus
            ]
        );

        let clear_result = ffi_json(js_nui_clear_semantics_v1(node.slot(), node.generation()));
        assert_eq!(
            clear_result,
            serde_json::json!({ "ok": true, "value": null })
        );
        assert!(
            session()
                .lock()
                .expect("host session")
                .host
                .semantics(node)
                .is_some(),
            "clear must remain pending"
        );
        let clear_commit = ffi_json(js_nui_commit_v1());
        assert_eq!(clear_commit["value"]["dirtyFlags"], 8);
        assert_eq!(
            session().lock().expect("host session").host.semantics(node),
            None
        );

        for invalid in [
            "not-json",
            r#"{"role":"Unknown"}"#,
            r#"{"actions":["Unknown"]}"#,
            r#"{"label":"Save","unexpected":true}"#,
        ] {
            let valid = alloc_string(r#"{"label":"must not leak"}"#);
            // SAFETY: `valid` is a live Perry-compatible test string.
            assert_eq!(
                ffi_json(unsafe {
                    js_nui_set_semantics_v1(node.slot(), node.generation(), valid.as_raw())
                })["ok"],
                true
            );
            let invalid = alloc_string(invalid);
            // SAFETY: `invalid` is a live Perry-compatible test string.
            let invalid_result = ffi_json(unsafe {
                js_nui_set_semantics_v1(node.slot(), node.generation(), invalid.as_raw())
            });
            assert_eq!(invalid_result["ok"], false);
            assert_eq!(invalid_result["error"]["name"], "INVALID_ARGUMENT");
            let commit = ffi_json(js_nui_commit_v1());
            assert_eq!(commit["ok"], false);
            assert_eq!(
                session().lock().expect("host session").host.semantics(node),
                None
            );
            session().lock().expect("host session").abort_pending();
        }

        let stale = session()
            .lock()
            .expect("host session")
            .host
            .create_node(NodeType::View);
        session().lock().expect("host session").host.remove(stale);
        let valid = alloc_string(r#"{"role":"Text"}"#);
        // SAFETY: `valid` is a live Perry-compatible test string.
        let stale_result = ffi_json(unsafe {
            js_nui_set_semantics_v1(stale.slot(), stale.generation(), valid.as_raw())
        });
        assert_eq!(stale_result["ok"], false);
        assert_eq!(stale_result["error"]["name"], "STALE_HANDLE");
    }

    #[test]
    fn supported_event_ids_are_accepted_by_the_stable_listener_abi() {
        assert_eq!(event_from_u32(8), Some(EventId::Composition));
        assert_eq!(event_from_u32(10), Some(EventId::WindowLifecycle));
        assert_eq!(event_from_u32(u32::MAX), None);
    }

    #[test]
    fn window_lifecycle_payload_omits_an_absent_surface_generation() {
        use nui_core::protocol::ui::{WindowLifecycleEvent, WindowLifecycleKind};

        assert_eq!(
            window_lifecycle_payload(&WindowLifecycleEvent {
                kind: WindowLifecycleKind::Ready,
                surface_generation: Some(7.0),
            }),
            r#"{"kind":"Ready","surfaceGeneration":7.0}"#
        );
        assert_eq!(
            window_lifecycle_payload(&WindowLifecycleEvent {
                kind: WindowLifecycleKind::Suspended,
                surface_generation: None,
            }),
            r#"{"kind":"Suspended"}"#
        );
    }

    #[test]
    fn close_requested_callback_precedes_owner_end_and_session_close_without_holding_mutex() {
        let _serial = TEXT_INPUT_FFI_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reset();
        let _reset = ResetGlobalSession;
        let (root, owner, callback) = {
            let mut session = session().lock().expect("host session");
            let root = session.host.create_node(NodeType::View);
            let owner = session.host.owner();
            let key = ListenerKey::new(root.raw(), EventId::WindowLifecycle as u32);
            let (callback, _) = session.callbacks.add_owned(owner, key, 41);
            session
                .host
                .add_event_listener(root, EventId::WindowLifecycle, callback.handle)
                .expect("window lifecycle listener");
            (root, owner, callback)
        };
        let order = std::sync::Arc::new(Mutex::new(Vec::new()));
        let callback_order = std::sync::Arc::clone(&order);
        let owner_end_order = std::sync::Arc::clone(&order);

        close_window_session(
            owner,
            Some(root),
            move |token, payload| {
                assert_eq!(token, 41);
                assert_eq!(payload, r#"{"kind":"CloseRequested"}"#);
                let reentered = session()
                    .try_lock()
                    .expect("lifecycle callback must run without the session mutex");
                assert_eq!(reentered.owner_scope.state(), OwnerState::Active);
                assert_eq!(reentered.host.root(), Some(root));
                drop(reentered);
                callback_order.lock().expect("close order").push("callback");
            },
            move |ended_owner| {
                assert_eq!(ended_owner, owner);
                let reentered = session()
                    .try_lock()
                    .expect("owner teardown must run without the session mutex");
                assert_eq!(reentered.owner_scope.state(), OwnerState::Active);
                drop(reentered);
                owner_end_order
                    .lock()
                    .expect("close order")
                    .push("system_end_owner");
                0
            },
        );

        let session = session().lock().expect("host session");
        assert_eq!(session.owner_scope.state(), OwnerState::Closing);
        assert_eq!(
            callback_token(
                &session,
                root,
                EventId::WindowLifecycle,
                Some(callback.handle),
            ),
            None
        );
        assert_eq!(
            order.lock().expect("close order").as_slice(),
            ["callback", "system_end_owner"]
        );
    }

    #[test]
    fn registered_input_and_text_area_succeed_through_text_input_v1_exports() {
        let _serial = TEXT_INPUT_FFI_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reset();
        let _reset = ResetGlobalSession;

        let (input, text_area) = {
            let session = session().lock().expect("host session");
            let root = session.host.create_node(NodeType::View);
            let input = session.host.create_node(NodeType::View);
            let input_text = session.host.create_text("A😀B");
            let text_area = session.host.create_node(NodeType::Scroll);
            let text_area_text = session.host.create_text("第一行\nA😀B");
            session.host.set_number(root, PropertyId::Width, 640.0);
            session.host.set_number(root, PropertyId::Height, 480.0);
            session.host.set_number(input, PropertyId::Width, 220.0);
            session.host.set_number(input, PropertyId::Height, 36.0);
            session.host.set_number(input, PropertyId::Padding, 10.0);
            session
                .host
                .set_number(input_text, PropertyId::FontSize, 16.0);
            session.host.set_number(text_area, PropertyId::Width, 320.0);
            session
                .host
                .set_number(text_area, PropertyId::Height, 160.0);
            session
                .host
                .set_number(text_area, PropertyId::Padding, 10.0);
            session
                .host
                .set_number(text_area_text, PropertyId::FontSize, 16.0);
            session.host.insert(input, root);
            session.host.insert(input_text, input);
            session.host.insert(text_area, root);
            session.host.insert(text_area_text, text_area);
            session.host.register_input(input, input_text, "Title");
            session
                .host
                .register_input(text_area, text_area_text, "Body");
            session.host.layout(640.0, 480.0);
            (input, text_area)
        };

        let input_state = ffi_json(js_nui_get_text_input_state_v1(
            input.slot(),
            input.generation(),
        ));
        assert_text_input_state(&input_state, "A😀B", 4, 4, "0");
        let input_bounds = ffi_json(js_nui_get_composition_bounds_v1(
            input.slot(),
            input.generation(),
        ));
        assert_eq!(input_bounds["ok"], true);
        assert_bounds(&input_bounds["value"]);
        assert_eq!(
            input_bounds["value"],
            input_state["value"]["compositionBounds"]
        );

        let input_replacement = alloc_string("中");
        // SAFETY: `input_replacement` is a live Perry-compatible test string.
        let input_replace = ffi_json(unsafe {
            js_nui_replace_text_input_v1(
                input.slot(),
                input.generation(),
                1,
                3,
                input_replacement.as_raw(),
            )
        });
        assert_eq!(
            input_replace,
            serde_json::json!({ "ok": true, "value": null })
        );
        session()
            .lock()
            .expect("host session")
            .host
            .layout(640.0, 480.0);
        let input_state = ffi_json(js_nui_get_text_input_state_v1(
            input.slot(),
            input.generation(),
        ));
        assert_text_input_state(&input_state, "A中B", 3, 2, "1");

        let text_area_state = ffi_json(js_nui_get_text_input_state_v1(
            text_area.slot(),
            text_area.generation(),
        ));
        assert_text_input_state(&text_area_state, "第一行\nA😀B", 8, 8, "0");
        let text_area_bounds = ffi_json(js_nui_get_composition_bounds_v1(
            text_area.slot(),
            text_area.generation(),
        ));
        assert_eq!(text_area_bounds["ok"], true);
        assert_bounds(&text_area_bounds["value"]);
        assert_eq!(
            text_area_bounds["value"],
            text_area_state["value"]["compositionBounds"]
        );

        let text_area_replacement = alloc_string("中");
        // SAFETY: `text_area_replacement` is a live Perry-compatible test string.
        let text_area_replace = ffi_json(unsafe {
            js_nui_replace_text_input_v1(
                text_area.slot(),
                text_area.generation(),
                5,
                7,
                text_area_replacement.as_raw(),
            )
        });
        assert_eq!(
            text_area_replace,
            serde_json::json!({ "ok": true, "value": null })
        );
        session()
            .lock()
            .expect("host session")
            .host
            .layout(640.0, 480.0);
        let text_area_state = ffi_json(js_nui_get_text_input_state_v1(
            text_area.slot(),
            text_area.generation(),
        ));
        assert_text_input_state(&text_area_state, "第一行\nA中B", 7, 6, "1");
    }

    fn active_listener_session() -> (HostSession, NodeId, ListenerKey, CallbackRegistration) {
        let mut session = HostSession::default();
        let node = session.host.create_node(NodeType::View);
        let key = ListenerKey::new(node.raw(), EventId::Click as u32);
        let (registration, _) = session.callbacks.add(key, 11);
        session
            .host
            .add_event_listener(node, EventId::Click, registration.handle)
            .expect("active listener");
        (session, node, key, registration)
    }

    #[test]
    fn session_routes_protocol_and_commit_failures_to_the_supervisor() {
        let session = HostSession::default();

        let handshake = session.handshake("not-json");
        assert!(handshake.contains("ProtocolViolation"));
        session
            .host
            .poison_pending(MutationError::InvalidPropertyId(999));
        assert_eq!(
            session.commit_pending(),
            Err(MutationError::InvalidPropertyId(999))
        );

        let history = session.host.error_supervisor().history();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].severity, ErrorSeverity::ProtocolViolation);
        assert_eq!(history[0].operation, "handshake");
        assert_eq!(history[1].severity, ErrorSeverity::RecoverableOperation);
        assert_eq!(history[1].operation, "commit");
    }

    #[test]
    fn ffi_guard_converts_a_rust_panic_to_a_latched_fatal_error() {
        let errors = ErrorSupervisor::default();

        let value = guard_ffi(
            &errors,
            "testFfi",
            || panic!("ffi invariant failed"),
            error_result_json,
        );

        assert!(value.contains("\"severity\":\"FatalRuntime\""));
        assert!(value.contains("\"operation\":\"testFfi\""));
        assert!(errors.should_stop());
        assert_eq!(errors.history().len(), 1);
    }

    #[test]
    fn pending_listener_replacement_is_invisible_and_rolls_back_on_failure() {
        let (mut session, node, key, active) = active_listener_session();
        let (replacement, _) = session.ensure_pending_callbacks().callbacks.add(key, 22);
        session
            .host
            .queue_add_event_listener(node, EventId::Click, replacement.handle)
            .expect("queued replacement");

        assert_eq!(session.callbacks.active_for_key(key), Some(active));
        assert_eq!(
            session.host.event_listener(node, EventId::Click),
            Some(active.handle)
        );

        session
            .host
            .poison_pending(MutationError::InvalidPropertyId(999));
        assert_eq!(
            session.host.commit_pending(),
            Err(MutationError::InvalidPropertyId(999))
        );
        session.abort_pending();

        assert_eq!(session.callbacks.active_for_key(key), Some(active));
        assert_eq!(
            session.host.event_listener(node, EventId::Click),
            Some(active.handle)
        );
    }

    #[test]
    fn abort_does_not_reuse_a_provisional_callback_generation() {
        let mut session = HostSession::default();
        let node = session.host.create_node(NodeType::View);
        let owner = session.host.owner();
        let key = ListenerKey::new(node.raw(), EventId::Click as u32);
        let (provisional, _) = session
            .ensure_pending_callbacks()
            .callbacks
            .add_owned(owner, key, 11);

        session.abort_pending();

        let (replacement, _) = session
            .ensure_pending_callbacks()
            .callbacks
            .add_owned(owner, key, 22);
        assert_eq!(replacement.handle.slot(), provisional.handle.slot());
        assert_ne!(
            replacement.handle.generation(),
            provisional.handle.generation()
        );
    }

    #[test]
    fn pending_listener_remove_switches_only_after_successful_commit() {
        let (mut session, node, key, active) = active_listener_session();
        assert!(matches!(
            session
                .ensure_pending_callbacks()
                .callbacks
                .remove(active.handle),
            RemoveResult::Closed(_)
        ));
        assert!(session
            .host
            .queue_remove_event_listener(node, EventId::Click, active.handle));

        assert_eq!(session.callbacks.active_for_key(key), Some(active));
        assert_eq!(
            session.host.event_listener(node, EventId::Click),
            Some(active.handle)
        );

        session.host.commit_pending().expect("commit");
        cleanup_after_commit(&mut session);
        assert_eq!(session.callbacks.active_for_key(key), None);
        assert_eq!(session.host.event_listener(node, EventId::Click), None);
    }

    #[test]
    fn late_event_generation_cannot_invoke_replacement_callback() {
        let mut session = HostSession::default();
        let node = session.host.create_node(NodeType::View);
        let owner = session.host.owner();
        let key = ListenerKey::new(node.raw(), EventId::Click as u32);
        let (first, _) = session.callbacks.add_owned(owner, key, 11);
        let (second, _) = session.callbacks.add_owned(owner, key, 22);

        assert_eq!(
            callback_token(&session, node, EventId::Click, Some(first.handle)),
            None
        );
        assert_eq!(
            callback_token(&session, node, EventId::Click, Some(second.handle)),
            Some(22)
        );
    }

    #[test]
    fn legacy_listener_registration_uses_the_same_registry() {
        let mut session = HostSession::default();
        let node = session.host.create_node(NodeType::View);
        assert!(queue_callback(&mut session, node, EventId::Click, 31));
        let owner = session.host.owner();
        let key = ListenerKey::new(node.raw(), EventId::Click as u32);
        let registration = session
            .pending_callbacks
            .as_ref()
            .and_then(|pending| pending.callbacks.active_for_key_owned(owner, key))
            .expect("legacy registration");
        assert_eq!(registration.token, 31);
    }

    #[test]
    fn reset_closes_the_owner_and_prevents_callback_handle_reuse() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let mut session = HostSession::default();
        let node = session.host.create_node(NodeType::View);
        let first_owner = session.host.owner();
        let key = ListenerKey::new(node.raw(), EventId::Click as u32);
        let (active, _) = session.callbacks.add_owned(first_owner, key, 11);
        session
            .host
            .add_event_listener(node, EventId::Click, active.handle)
            .expect("active listener");
        let (pending, _) =
            session
                .ensure_pending_callbacks()
                .callbacks
                .add_owned(first_owner, key, 12);
        session
            .host
            .queue_add_event_listener(node, EventId::Click, pending.handle)
            .expect("pending listener");
        let cleaned = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&cleaned);
        session.owner_scope.defer(move || {
            observed.fetch_add(1, Ordering::SeqCst);
        });

        session.begin_close();

        assert_eq!(
            session.owner_scope.state(),
            nui_app_runtime::OwnerState::Closing
        );
        assert_eq!(cleaned.load(Ordering::SeqCst), 0);
        assert!(!session.host.has_pending_batch());
        assert_eq!(session.callbacks.active_count(), 0);
        assert_eq!(
            session.callbacks.state(pending.handle),
            Some(nui_perry_bridge::CallbackState::Invalidated)
        );
        assert_eq!(
            callback_token(&session, node, EventId::Click, Some(pending.handle)),
            None
        );
        assert_eq!(session.host.root(), Some(node));

        session.finish_reset();

        assert_ne!(session.host.owner(), first_owner);
        assert_eq!(
            session.owner_scope.state(),
            nui_app_runtime::OwnerState::Active
        );
        assert_eq!(session.owner_scope.id().raw(), session.host.owner());
        assert_eq!(cleaned.load(Ordering::SeqCst), 1);
        assert_eq!(session.host.root(), None);
        assert_eq!(session.callbacks.active_count(), 0);
        assert!(matches!(
            session.callbacks.state(active.handle),
            Some(
                nui_perry_bridge::CallbackState::Closed
                    | nui_perry_bridge::CallbackState::Invalidated
            )
        ));
        assert_eq!(
            callback_token(&session, node, EventId::Click, Some(active.handle)),
            None
        );
        assert!(session.pending_callbacks.is_none());

        let next_node = session.host.create_node(NodeType::View);
        let next_owner = session.host.owner();
        let (next, _) = session.callbacks.add_owned(
            next_owner,
            ListenerKey::new(next_node.raw(), key.event),
            22,
        );
        assert_ne!(next.handle, active.handle);
        assert_ne!(next.handle, pending.handle);
        assert_eq!(
            callback_token(&session, node, EventId::Click, Some(pending.handle)),
            None
        );
        assert_eq!(
            callback_token(&session, next_node, EventId::Click, Some(next.handle)),
            Some(22)
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn default_session_uses_source_backed_system_fonts() {
        let session = HostSession::default();
        assert!(session.host.has_font_configuration());
        assert!(session.host.error_supervisor().history().is_empty());
    }
}

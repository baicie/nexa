//! Perry FFI exports for the Nexa UI Host Protocol.
//!
//! Isolates `perry-ffi` from `nui-core` / `nui-perry-bridge` (ADR-004 §8).

mod perry_stdlib_stubs;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use nui_core::{NodeId, NodeType, PropertyId};
use nui_perry_bridge::NuiHost;
use perry_ffi::{
    gc_register_mutable_root_scanner_named, read_string, JsClosure, JsString, RawClosureHeader,
    StringHeader,
};

struct HostSession {
    host: NuiHost,
    /// node.raw() → Perry closure pointer bits (i64 as u64).
    closures: HashMap<u64, i64>,
}

impl Default for HostSession {
    fn default() -> Self {
        Self {
            host: NuiHost::new(),
            closures: HashMap::new(),
        }
    }
}

fn session() -> &'static Mutex<HostSession> {
    static SESSION: OnceLock<Mutex<HostSession>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(HostSession::default()))
}

fn ensure_closure_scanner() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        gc_register_mutable_root_scanner_named("nexa-nui-host", |visitor| {
            if let Ok(mut session) = session().lock() {
                for cb in session.closures.values_mut() {
                    visitor.visit_i64_slot(cb);
                }
            }
        });
    });
}

fn node_from_raw(raw: u64) -> NodeId {
    NodeId::from_raw(raw)
}

#[no_mangle]
pub extern "C" fn js_nui_create_node(node_type: f64) -> u64 {
    let ty = match node_type as u8 {
        0 => NodeType::Root,
        1 => NodeType::View,
        2 => NodeType::Text,
        3 => NodeType::Image,
        4 => NodeType::Scroll,
        _ => NodeType::View,
    };
    let session = session().lock().expect("host session");
    session.host.create_node(ty).raw()
}

/// # Safety
/// `text_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_create_text(text_ptr: *const StringHeader) -> u64 {
    let handle = JsString::from_raw(text_ptr as *mut StringHeader);
    let text = read_string(handle).unwrap_or("");
    let session = session().lock().expect("host session");
    session.host.create_text(text).raw()
}

#[no_mangle]
pub extern "C" fn js_nui_insert(child: u64, parent: u64, before: u64) {
    let session = session().lock().expect("host session");
    let before = if before == 0 {
        None
    } else {
        Some(node_from_raw(before))
    };
    session
        .host
        .insert_before(node_from_raw(child), node_from_raw(parent), before);
}

#[no_mangle]
pub extern "C" fn js_nui_remove(node: u64) {
    let mut session = session().lock().expect("host session");
    let id = node_from_raw(node);
    // Drop closure roots for this node (subtree tokens cleared in host.remove).
    session.closures.remove(&node);
    session.host.remove(id);
}

/// # Safety
/// `text_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_set_text(node: u64, text_ptr: *const StringHeader) {
    let handle = JsString::from_raw(text_ptr as *mut StringHeader);
    let text = read_string(handle).unwrap_or("");
    let session = session().lock().expect("host session");
    session.host.set_text(node_from_raw(node), text);
}

#[no_mangle]
pub extern "C" fn js_nui_set_number(node: u64, property: f64, value: f64) {
    let prop = match property as u16 {
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
        _ => return,
    };
    let session = session().lock().expect("host session");
    session
        .host
        .set_number(node_from_raw(node), prop, value);
}

#[no_mangle]
pub extern "C" fn js_nui_add_click_listener(node: u64, callback: i64) {
    ensure_closure_scanner();
    let mut session = session().lock().expect("host session");
    let id = node_from_raw(node);
    session.host.add_click_listener(id, callback as u64);
    session.closures.insert(node, callback);
}

#[no_mangle]
pub extern "C" fn js_nui_commit() {
    // Slice 2: mutations apply immediately; commit is reserved for future
    // batching / request_redraw while the window is running.
}

/// # Safety
/// `title_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nui_run(title_ptr: *const StringHeader) {
    let handle = JsString::from_raw(title_ptr as *mut StringHeader);
    let title = read_string(handle).unwrap_or("Nexa UI").to_owned();

    // Clone the Arc-backed host so FFI mutations (set_text) share the window arena.
    let (host, closures) = {
        let session = session().lock().expect("host session");
        (session.host.clone(), session.closures.clone())
    };

    if let Err(err) = host.run(&title, move |node| {
        let Some(&cb) = closures.get(&node.raw()) else {
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
    }) {
        eprintln!("nui run failed: {err}");
    }
}

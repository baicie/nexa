//! Perry FFI for Nexa System Host (ADR-005 Slice 12).

use std::sync::{Mutex, OnceLock};

use nui_system_core::{
    clipboard_read_text, clipboard_write_text, CommandId, PermissionId, PermissionSet,
};
use perry_ffi::{alloc_string, read_string, JsString, StringHeader};

fn permissions() -> &'static Mutex<PermissionSet> {
    static PERMS: OnceLock<Mutex<PermissionSet>> = OnceLock::new();
    PERMS.get_or_init(|| Mutex::new(PermissionSet::default()))
}

/// Read clipboard text. Returns empty string on denial / empty / error.
///
/// # Safety
/// Return value is a Perry `StringHeader` pointer.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_clipboard_read_text() -> *mut StringHeader {
    let perms = permissions().lock().expect("permissions");
    if perms
        .require(PermissionId::ClipboardRead, CommandId::ClipboardReadText)
        .is_err()
    {
        return alloc_string("").as_raw();
    }
    drop(perms);

    match clipboard_read_text() {
        Ok(text) => alloc_string(&text).as_raw(),
        Err(_) => alloc_string("").as_raw(),
    }
}

/// Write clipboard text. Returns `0` on success, `-1` on failure / denial.
///
/// # Safety
/// `text_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_clipboard_write_text(text_ptr: *const StringHeader) -> i32 {
    let perms = permissions().lock().expect("permissions");
    if perms
        .require(PermissionId::ClipboardWrite, CommandId::ClipboardWriteText)
        .is_err()
    {
        return -1;
    }
    drop(perms);

    let handle = JsString::from_raw(text_ptr as *mut StringHeader);
    let text = read_string(handle).unwrap_or("");
    match clipboard_write_text(text) {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

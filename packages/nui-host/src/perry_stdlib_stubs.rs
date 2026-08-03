//! Temporary stubs for Perry prebuilt-stdlib optional HTTP extension symbols.
//!
//! When linking a nativeLibrary against Perry's prebuilt full stdlib, the linker
//! expects `perry-ext-http` symbols. Until we vendor that extension or rebuild
//! stdlib from `PERRY_WORKSPACE_ROOT`, provide no-op stubs so Slice 2 can link.

#![allow(clippy::missing_const_for_fn)]

#[no_mangle]
pub extern "C" fn js_ext_http_agent_is_handle(_handle: i64) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn js_ext_http_agent_dispatch_method(
    _handle: i64,
    _method: i64,
    _args: i64,
    _argc: i32,
) -> f64 {
    0.0
}

#[no_mangle]
pub extern "C" fn js_ext_http_agent_dispatch_property(_handle: i64, _prop: i64) -> f64 {
    0.0
}

#[no_mangle]
pub extern "C" fn js_ext_http_agent_dispatch_property_set(
    _handle: i64,
    _prop: i64,
    _value: f64,
) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn js_ext_http_client_incoming_message_is_handle(_handle: i64) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn js_ext_http_client_incoming_message_set_encoding(
    _handle: i64,
    _encoding: i64,
) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn js_ext_http_client_inflight() -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn js_ext_http_client_request_dispatch_method(
    _handle: i64,
    _method: i64,
    _args: i64,
    _argc: i32,
) -> f64 {
    0.0
}

#[no_mangle]
pub extern "C" fn js_ext_http_client_request_dispatch_property(_handle: i64, _prop: i64) -> f64 {
    0.0
}

#[no_mangle]
pub extern "C" fn js_ext_http_client_request_is_handle(_handle: i64) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn js_http_has_pending() -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn js_http_incoming_message_pipe(_handle: i64, _dest: i64) -> f64 {
    0.0
}

#[no_mangle]
pub extern "C" fn js_http_is_incoming_message(_handle: i64) -> i32 {
    0
}

#[no_mangle]
pub extern "C" fn js_http_response_trailers(_handle: i64) -> f64 {
    0.0
}

//! Link compatibility for Perry 0.5.1220's prebuilt full standard library.
//!
//! Perry's prebuilt archive references its optional HTTP extension even when an
//! application does not compile the HTTP package. Nexa UI does not expose that
//! extension in its package allowlist, so these symbols only satisfy the fixed
//! toolchain's unconditional linker references. They are not a Nexa HTTP API.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_http_extension_is_inactive() {
        assert_eq!(js_ext_http_agent_is_handle(1), 0);
        assert_eq!(js_ext_http_client_incoming_message_is_handle(1), 0);
        assert_eq!(js_ext_http_client_request_is_handle(1), 0);
        assert_eq!(js_ext_http_client_inflight(), 0);
        assert_eq!(js_http_has_pending(), 0);
        assert_eq!(js_http_is_incoming_message(1), 0);
    }
}

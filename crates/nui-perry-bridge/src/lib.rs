//! NUI Host engine used by the Perry native-library wrapper.
//!
//! This crate intentionally does **not** depend on `perry-ffi`, so the
//! workspace can test HostOps without linking Perry. The `packages/nui-host`
//! crate owns `#[no_mangle]` exports and Perry ABI types.
//!
//! Tree state is `Arc`-shared so Perry click callbacks can `set_text` while
//! the window event loop owns the same arena (Slice 2→3 fix).

mod callback;
mod errors;
mod frame_metrics;
mod handle;
mod handshake;
mod host;
mod window;

pub use callback::{
    CallbackHandle, CallbackOwner, CallbackRegistration, CallbackRegistry, CallbackState,
    ListenerKey, RemoveResult,
};
pub use errors::{
    error_result_json, fatal_runtime_nexa_error, frame_nexa_error, mutation_nexa_error,
    operation_state_nexa_error, platform_failure_nexa_error, platform_run_nexa_error,
    text_input_nexa_error,
};
pub use handle::{
    decode_handle_token, encode_handle_token, handle_parts_to_node_id, handle_to_node_id,
    node_id_to_handle,
};
pub use handshake::{handshake_json, handshake_json_with_error};
pub use host::{
    pack_rgba, HostFontConfigError, HostListenerError, HostPropertyError, HostTextInputError,
    HostUiEvent, NuiHost,
};
pub use nui_core::MutationError;

/// Encode a queued mutation result using the stable v1 error envelope.
pub fn mutation_result_json(result: Result<(), MutationError>, operation: &str) -> String {
    match result {
        Ok(()) => serde_json::json!({ "ok": true, "value": null }).to_string(),
        Err(error) => error_result_json(&mutation_nexa_error(error, operation)),
    }
}

/// Encode a TextInputClient state query using the stable v1 result envelope.
pub fn text_input_state_result_json(
    result: Result<nui_protocol::ui::TextInputState, HostTextInputError>,
) -> String {
    match result {
        Ok(state) => serde_json::json!({ "ok": true, "value": state }).to_string(),
        Err(error) => error_result_json(&text_input_nexa_error(error, "getTextInputState")),
    }
}

/// Encode a TextInputClient replacement using the stable v1 result envelope.
pub fn text_input_replace_result_json(result: Result<(), HostTextInputError>) -> String {
    match result {
        Ok(()) => unit_result_json(),
        Err(error) => error_result_json(&text_input_nexa_error(error, "replaceTextInput")),
    }
}

/// Encode a composition-bounds query using the stable v1 result envelope.
pub fn composition_bounds_result_json(
    result: Result<nui_protocol::ui::Rect, HostTextInputError>,
) -> String {
    match result {
        Ok(bounds) => serde_json::json!({ "ok": true, "value": bounds }).to_string(),
        Err(error) => error_result_json(&text_input_nexa_error(error, "getCompositionBounds")),
    }
}

/// Encode a successful commit receipt for the v1 result transport.
pub fn mutation_receipt_result_json(
    result: Result<Option<nui_core::MutationReceipt>, MutationError>,
) -> String {
    match result {
        Ok(Some(receipt)) => serde_json::json!({
            "ok": true,
            "value": {
                "sequence": receipt.sequence,
                "dirtyFlags": receipt.dirty.bits()
            }
        })
        .to_string(),
        Ok(None) => serde_json::json!({
            "ok": true,
            "value": { "sequence": 0, "dirtyFlags": 0 }
        })
        .to_string(),
        Err(error) => mutation_result_json(Err(error), "commit"),
    }
}

/// Encode a node creation result as the v1 JSON result envelope.
pub fn node_handle_result_json(id: nui_core::NodeId) -> String {
    match node_id_to_handle(id).and_then(|handle| encode_handle_token(&handle)) {
        Ok(token) => serde_json::json!({ "ok": true, "value": token }).to_string(),
        Err(error) => serde_json::json!({
            "ok": false,
            "error": {
                "domain": "ui",
                "code": nui_protocol::ui::ErrorCode::InternalFailure as u32,
                "name": "INTERNAL_FAILURE",
                "severity": "FatalRuntime",
                "operation": "createNode",
                "retryable": false,
                "message": format!("invalid native handle: {error:?}"),
                "runtimeVersion": env!("CARGO_PKG_VERSION")
            }
        })
        .to_string(),
    }
}

/// Encode a stable UI invalid-argument result for v1 callers.
pub fn node_invalid_argument_result_json(message: &str) -> String {
    serde_json::json!({
        "ok": false,
        "error": {
            "domain": "ui",
            "code": nui_protocol::ui::ErrorCode::InvalidArgument as u32,
            "name": "INVALID_ARGUMENT",
            "severity": "RecoverableOperation",
            "operation": "createNode",
            "retryable": false,
            "message": message,
            "runtimeVersion": env!("CARGO_PKG_VERSION")
        }
    })
    .to_string()
}

/// Encode a clear-property result for the v1 string-result ABI.
pub fn property_result_json(result: Result<(), HostPropertyError>) -> String {
    match result {
        Ok(()) => serde_json::json!({ "ok": true, "value": null }).to_string(),
        Err(HostPropertyError::StaleNode {
            node,
            current_generation,
        }) => serde_json::json!({
            "ok": false,
            "error": {
                "domain": "ui",
                "code": nui_protocol::ui::ErrorCode::StaleHandle as u32,
                "name": "STALE_HANDLE",
                "severity": "RecoverableOperation",
                "operation": "clearProperty",
                "retryable": false,
                "message": "node handle is stale or belongs to another owner",
                "runtimeVersion": env!("CARGO_PKG_VERSION"),
                "context": {
                    "slot": node.slot(),
                    "generation": node.generation(),
                    "currentGeneration": current_generation
                }
            }
        })
        .to_string(),
        Err(HostPropertyError::InvalidProperty(property)) => serde_json::json!({
            "ok": false,
            "error": {
                "domain": "ui",
                "code": nui_protocol::ui::ErrorCode::InvalidArgument as u32,
                "name": "INVALID_ARGUMENT",
                "severity": "RecoverableOperation",
                "operation": "clearProperty",
                "retryable": false,
                "message": "property cannot be cleared",
                "runtimeVersion": env!("CARGO_PKG_VERSION"),
                "context": {
                    "parameter": "property",
                    "expected": "clearable ui.PropertyId",
                    "actual": property as u32
                }
            }
        })
        .to_string(),
    }
}

/// Encode a v1 invalid-property result when the raw ABI value is unknown.
pub fn invalid_property_result_json(property: u32) -> String {
    serde_json::json!({
        "ok": false,
        "error": {
            "domain": "ui",
            "code": nui_protocol::ui::ErrorCode::InvalidArgument as u32,
            "name": "INVALID_ARGUMENT",
            "severity": "RecoverableOperation",
            "operation": "clearProperty",
            "retryable": false,
            "message": "property cannot be cleared",
            "runtimeVersion": env!("CARGO_PKG_VERSION"),
            "context": {
                "parameter": "property",
                "expected": "known ui.PropertyId",
                "actual": property
            }
        }
    })
    .to_string()
}

/// Encode invalid HandleRef parts using the protocol INVALID_ARGUMENT context contract.
pub fn invalid_handle_result_json(operation: &str, parameter: &str, actual: u32) -> String {
    serde_json::json!({
        "ok": false,
        "error": {
            "domain": "ui",
            "code": nui_protocol::ui::ErrorCode::InvalidArgument as u32,
            "name": "INVALID_ARGUMENT",
            "severity": "RecoverableOperation",
            "operation": operation,
            "retryable": false,
            "message": "handle generation must be a non-zero uint32",
            "runtimeVersion": env!("CARGO_PKG_VERSION"),
            "context": {
                "parameter": parameter,
                "expected": "1..=4294967295",
                "actual": actual
            }
        }
    })
    .to_string()
}

/// Encode a callback registration result for the stable v1 listener ABI.
pub fn listener_handle_result_json(result: Result<CallbackHandle, HostListenerError>) -> String {
    match result {
        Ok(handle) => {
            let wire = nui_protocol::common::HandleRef {
                slot: handle.slot(),
                generation: handle.generation(),
            };
            match encode_handle_token(&wire) {
                Ok(token) => serde_json::json!({ "ok": true, "value": token }).to_string(),
                Err(error) => serde_json::json!({
                    "ok": false,
                    "error": {
                        "domain": "ui",
                        "code": nui_protocol::ui::ErrorCode::InternalFailure as u32,
                        "name": "INTERNAL_FAILURE",
                        "severity": "FatalRuntime",
                        "operation": "addEventListener",
                        "retryable": false,
                        "message": format!("invalid callback handle: {error:?}"),
                        "runtimeVersion": env!("CARGO_PKG_VERSION")
                    }
                })
                .to_string(),
            }
        }
        Err(HostListenerError::StaleNode {
            node,
            current_generation,
        }) => serde_json::json!({
            "ok": false,
            "error": {
                "domain": "ui",
                "code": nui_protocol::ui::ErrorCode::StaleHandle as u32,
                "name": "STALE_HANDLE",
                "severity": "RecoverableOperation",
                "operation": "addEventListener",
                "retryable": false,
                "message": "node handle is stale or belongs to another owner",
                "runtimeVersion": env!("CARGO_PKG_VERSION"),
                "context": {
                    "slot": node.slot(),
                    "generation": node.generation(),
                    "currentGeneration": current_generation
                }
            }
        })
        .to_string(),
    }
}

/// Encode a successful command with the protocol unit value.
pub fn unit_result_json() -> String {
    serde_json::json!({ "ok": true, "value": null }).to_string()
}

/// Encode a successful listener removal result.
pub fn listener_unit_result_json() -> String {
    unit_result_json()
}

/// Encode owner validation for callback removal while keeping closed and
/// invalidated tombstones idempotent for the owning session.
pub fn listener_remove_result_json(result: RemoveResult) -> String {
    listener_remove_result_json_with_handle(result, None, None)
}

/// Encode callback removal with the rejected handle's generation metadata.
pub fn listener_remove_result_json_with_handle(
    result: RemoveResult,
    handle: Option<CallbackHandle>,
    current_generation: Option<u32>,
) -> String {
    match result {
        RemoveResult::WrongOwner { expected, actual } => serde_json::json!({
            "ok": false,
            "error": {
                "domain": "ui",
                "code": nui_protocol::ui::ErrorCode::WrongOwner as u32,
                "name": "WRONG_OWNER",
                "severity": "RecoverableOperation",
                "operation": "removeEventListener",
                "retryable": false,
                "message": "callback belongs to another owner scope",
                "runtimeVersion": env!("CARGO_PKG_VERSION"),
                "context": {
                    "expectedOwner": expected.to_string(),
                    "actualOwner": actual.to_string()
                }
            }
        })
        .to_string(),
        RemoveResult::Closed(_) | RemoveResult::AlreadyClosed | RemoveResult::Invalidated => {
            listener_unit_result_json()
        }
        RemoveResult::Stale => {
            let mut context = serde_json::Map::new();
            if let Some(handle) = handle {
                context.insert("slot".to_owned(), serde_json::json!(handle.slot()));
                context.insert(
                    "generation".to_owned(),
                    serde_json::json!(handle.generation()),
                );
            }
            if let Some(current_generation) = current_generation {
                context.insert(
                    "currentGeneration".to_owned(),
                    serde_json::json!(current_generation),
                );
            }
            serde_json::json!({
                "ok": false,
                "error": {
                    "domain": "ui",
                    "code": nui_protocol::ui::ErrorCode::StaleHandle as u32,
                    "name": "STALE_HANDLE",
                    "severity": "RecoverableOperation",
                    "operation": "removeEventListener",
                    "retryable": false,
                    "message": "listener handle is stale or was never registered",
                    "runtimeVersion": env!("CARGO_PKG_VERSION"),
                    "context": context
                }
            })
            .to_string()
        }
    }
}

/// Encode an invalid listener argument using the manifest context contract.
pub fn invalid_listener_argument_result_json(
    operation: &str,
    parameter: &str,
    expected: &str,
    actual: &str,
) -> String {
    serde_json::json!({
        "ok": false,
        "error": {
            "domain": "ui",
            "code": nui_protocol::ui::ErrorCode::InvalidArgument as u32,
            "name": "INVALID_ARGUMENT",
            "severity": "RecoverableOperation",
            "operation": operation,
            "retryable": false,
            "message": format!("invalid {parameter}"),
            "runtimeVersion": env!("CARGO_PKG_VERSION"),
            "context": { "parameter": parameter, "expected": expected, "actual": actual }
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use nui_core::{EventId, NodeId, NodeType, PropertyId};

    use super::*;
    use crate::host::{backspace_at_caret, insert_text_at_caret};

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
    fn host_paint_executes_display_list_snapshot() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        host.set_number(root, PropertyId::Width, 16.0);
        host.set_number(root, PropertyId::Height, 16.0);
        host.set_number(
            root,
            PropertyId::BackgroundColor,
            f64::from(pack_rgba(0xff, 0x00, 0x00, 0xff)),
        );
        host.layout(16.0, 16.0);
        let mut pixels = vec![0_u32; 16 * 16];

        host.paint(&mut pixels, 16, 16, 1.0).expect("host paint");

        assert_eq!(pixels[8 * 16 + 8], 0xffff0000);
    }

    #[test]
    fn host_accepts_generated_protocol_ids() {
        let host = NuiHost::new();
        let node = host.create_node(nui_core::protocol::ui::NodeType::View);
        host.set_number(node, nui_core::protocol::ui::PropertyId::Width, 120.0);

        let inner = host.inner.lock().expect("host inner");
        assert_eq!(inner.arena.get(node).unwrap().style.width, Some(120.0));
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

    #[test]
    fn remove_clears_descendant_input_and_image_state() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let input = host.create_node(NodeType::View);
        let text = host.create_text("draft");
        let image = host.create_node(NodeType::Image);
        host.insert(input, root);
        host.insert(text, input);
        host.insert(image, root);
        host.register_input(input, text, "Draft");
        host.set_image(image, "/tmp/nexa-ui-dispose-missing.png");

        host.remove(root);

        let inner = host.inner.lock().expect("host inner");
        assert!(inner.inputs.is_empty());
        assert!(inner.images.is_empty());
        assert!(inner.arena.get(root).is_none());
        assert!(inner.arena.get(input).is_none());
        assert!(inner.arena.get(text).is_none());
        assert!(inner.arena.get(image).is_none());
    }

    #[test]
    fn queued_empty_image_source_clears_image_state() {
        let host = NuiHost::new();
        let image = host.create_node(NodeType::Image);

        host.queue_set_image(image, "/tmp/nexa-ui-image.png")
            .expect("queue image");
        host.commit_pending().expect("commit image");
        assert_eq!(
            host.image_path(image).as_deref(),
            Some("/tmp/nexa-ui-image.png")
        );

        host.queue_set_image(image, "").expect("queue image clear");
        host.commit_pending().expect("commit image clear");
        assert_eq!(host.image_path(image), None);
    }

    #[test]
    fn host_try_insert_rejects_stale_parent_atomically() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let child = host.create_node(NodeType::View);
        let stale_parent = host.create_node(NodeType::View);
        host.insert(child, root);
        host.remove(stale_parent);

        let result = host.try_insert(child, stale_parent);
        assert_eq!(
            result,
            Err(nui_core::TreeMutationError::StaleParent(stale_parent))
        );
        let inner = host.inner.lock().expect("host inner");
        assert_eq!(inner.arena.get(root).unwrap().children, vec![child]);
        assert_eq!(inner.arena.get(child).unwrap().parent, Some(root));
    }

    #[test]
    fn clear_property_restores_declared_defaults() {
        let host = NuiHost::new();
        let node = host.create_node(NodeType::View);
        for (property, value) in [
            (PropertyId::Width, 320.0),
            (PropertyId::Height, 200.0),
            (PropertyId::MinWidth, 80.0),
            (PropertyId::MinHeight, 40.0),
            (PropertyId::Padding, 12.0),
            (PropertyId::Gap, 8.0),
            (PropertyId::FlexDirection, 1.0),
            (PropertyId::AlignItems, 1.0),
            (PropertyId::JustifyContent, 2.0),
            (PropertyId::BorderRadius, 6.0),
            (PropertyId::Opacity, 0.25),
            (PropertyId::FontSize, 28.0),
            (PropertyId::FontWeight, 700.0),
            (PropertyId::TextColor, pack_rgba(0, 255, 0, 255) as f64),
            (PropertyId::ScrollOffsetY, 14.0),
            (PropertyId::FlexGrow, 1.0),
        ] {
            host.set_number(node, property, value);
            host.clear_property(node, property).expect("clear property");
        }
        host.set_number(
            node,
            PropertyId::BackgroundColor,
            pack_rgba(255, 0, 0, 255) as f64,
        );
        host.clear_property(node, PropertyId::BackgroundColor)
            .expect("clear background");

        let inner = host.inner.lock().expect("host inner");
        let style = &inner.arena.get(node).unwrap().style;
        assert_eq!(style.width, None);
        assert_eq!(style.height, None);
        assert_eq!(style.min_width, None);
        assert_eq!(style.min_height, None);
        assert_eq!(style.padding, 0.0);
        assert_eq!(style.gap, 0.0);
        assert_eq!(style.flex_direction, nui_core::FlexDirection::Column);
        assert_eq!(style.align_items, nui_core::Align::Start);
        assert_eq!(style.justify_content, nui_core::Align::Start);
        assert_eq!(style.flex_grow, 0.0);
        assert_eq!(style.background, None);
        assert_eq!(style.border_radius, 0.0);
        assert_eq!(style.opacity, 1.0);
        assert_eq!(style.font_size, 16.0);
        assert_eq!(style.font_weight, 400);
        assert_eq!(style.color, nui_core::ColorRgba::rgb(0x11, 0x18, 0x27));
        assert_eq!(style.scroll_offset_y, 0.0);
    }

    #[test]
    fn clear_property_rejects_stale_nodes() {
        let host = NuiHost::new();
        let node = host.create_node(NodeType::View);
        host.remove(node);
        let error = host
            .clear_property(node, PropertyId::Padding)
            .expect_err("removed node must be stale");
        assert!(matches!(
            error,
            HostPropertyError::StaleNode {
                node: actual,
                current_generation: Some(_),
            } if actual == node
        ));
    }

    #[test]
    fn invalid_property_uses_manifest_context_keys() {
        let value: serde_json::Value =
            serde_json::from_str(&invalid_property_result_json(99)).unwrap();
        let context = value["error"]["context"].as_object().unwrap();
        let mut keys: Vec<_> = context.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["actual", "expected", "parameter"]);
    }

    #[test]
    fn invalid_handle_uses_manifest_context_keys() {
        let value: serde_json::Value = serde_json::from_str(&invalid_handle_result_json(
            "clearProperty",
            "node.generation",
            0,
        ))
        .unwrap();
        assert_eq!(value["error"]["name"], "INVALID_ARGUMENT");
        assert_eq!(value["error"]["context"]["parameter"], "node.generation");
        assert_eq!(value["error"]["context"]["actual"], 0);
    }

    #[test]
    fn text_input_state_result_uses_the_generated_camel_case_contract() {
        let state = nui_core::protocol::ui::TextInputState {
            text: "A😀B".to_owned(),
            surrounding_text: nui_core::protocol::ui::TextRange { start: 0, end: 4 },
            selection: nui_core::protocol::ui::TextSelection {
                anchor: 1,
                focus: 3,
            },
            composition: Some(nui_core::protocol::ui::TextRange { start: 1, end: 3 }),
            composition_bounds: nui_core::protocol::ui::Rect {
                x: 12.5,
                y: 20.0,
                width: 1.0,
                height: 18.0,
            },
            revision: "9007199254740993".to_owned(),
        };

        let value: serde_json::Value =
            serde_json::from_str(&text_input_state_result_json(Ok(state))).unwrap();

        assert_eq!(value["ok"], true);
        assert_eq!(value["value"]["surroundingText"]["end"], 4);
        assert_eq!(value["value"]["compositionBounds"]["x"], 12.5);
        assert_eq!(value["value"]["revision"], "9007199254740993");
    }

    #[test]
    fn invalid_text_input_range_uses_structured_invalid_argument_context() {
        let value: serde_json::Value = serde_json::from_str(&text_input_replace_result_json(Err(
            HostTextInputError::InvalidUtf16Range {
                start: 2,
                end: 2,
                utf16_length: 4,
            },
        )))
        .unwrap();

        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["name"], "INVALID_ARGUMENT");
        assert_eq!(value["error"]["operation"], "replaceTextInput");
        assert_eq!(value["error"]["context"]["parameter"], "range");
        assert_eq!(value["error"]["context"]["actual"], "2..2");
    }

    #[test]
    fn unknown_listener_generation_is_a_stale_handle_error() {
        let value: serde_json::Value =
            serde_json::from_str(&listener_remove_result_json(RemoveResult::Stale)).unwrap();

        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["name"], "STALE_HANDLE");
        assert_eq!(value["error"]["operation"], "removeEventListener");
    }

    #[test]
    fn stale_property_uses_manifest_context_keys() {
        let value: serde_json::Value =
            serde_json::from_str(&property_result_json(Err(HostPropertyError::StaleNode {
                node: NodeId::new(3, 7),
                current_generation: Some(8),
            })))
            .unwrap();
        let context = value["error"]["context"].as_object().unwrap();
        let mut keys: Vec<_> = context.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["currentGeneration", "generation", "slot"]);
        assert_eq!(context["currentGeneration"], 8);
    }

    #[test]
    fn host_listener_replacement_cannot_be_removed_by_old_handle() {
        let host = NuiHost::new();
        let node = host.create_node(NodeType::View);
        let first = CallbackHandle::new(1, 1);
        let second = CallbackHandle::new(2, 1);
        assert_eq!(
            host.add_event_listener(node, nui_core::EventId::Click, first)
                .unwrap(),
            None
        );
        assert_eq!(
            host.add_event_listener(node, nui_core::EventId::Click, second)
                .unwrap(),
            Some(first)
        );
        assert_eq!(
            host.event_listener(node, nui_core::EventId::Click),
            Some(second)
        );
        assert!(!host.remove_event_listener(node, nui_core::EventId::Click, first));
        assert_eq!(
            host.event_listener(node, nui_core::EventId::Click),
            Some(second)
        );
        assert!(host.remove_event_listener(node, nui_core::EventId::Click, second));
        assert!(!host.remove_event_listener(node, nui_core::EventId::Click, second));
    }

    #[test]
    fn removing_node_returns_all_v1_listener_handles_for_root_cleanup() {
        let host = NuiHost::new();
        let node = host.create_node(NodeType::View);
        let click = CallbackHandle::new(4, 1);
        let change = CallbackHandle::new(5, 1);
        host.add_event_listener(node, nui_core::EventId::Click, click)
            .unwrap();
        host.add_event_listener(node, nui_core::EventId::Change, change)
            .unwrap();
        let mut removed = host.remove(node);
        removed.sort_by_key(|handle| handle.slot());
        assert_eq!(removed, vec![click, change]);
    }

    #[test]
    fn input_insert_and_backspace() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let field = host.create_node(NodeType::View);
        let text = host.create_text("");
        host.insert(text, field);
        host.insert(field, root);
        host.register_input(field, text, "Type…");
        {
            let mut inner = host.inner.lock().expect("host inner");
            inner.focused = Some(field);
            let (_, v) = insert_text_at_caret(&mut inner, "Hi").expect("insert");
            assert_eq!(v, "Hi");
            let (_, v) = insert_text_at_caret(&mut inner, "!").expect("insert");
            assert_eq!(v, "Hi!");
            let (_, v) = backspace_at_caret(&mut inner).expect("backspace");
            assert_eq!(v, "Hi");
        }
        let inner = host.inner.lock().expect("host inner");
        assert_eq!(
            inner
                .arena
                .get(text)
                .and_then(|n| n.text.clone())
                .as_deref(),
            Some("Hi")
        );
    }

    #[test]
    fn set_image_missing_file_stores_placeholder() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let image = host.create_node(NodeType::Image);
        host.insert(image, root);
        host.set_image(image, "/tmp/nexa-ui-missing-image-fixture.png");
        assert_eq!(
            host.image_path(image).as_deref(),
            Some("/tmp/nexa-ui-missing-image-fixture.png")
        );
        let inner = host.inner.lock().expect("host inner");
        let asset = inner.images.get(&image.raw()).expect("asset");
        assert!(asset.pixels.is_empty());
        assert_eq!((asset.width, asset.height), (64, 64));
        let style = &inner.arena.get(image).unwrap().style;
        assert_eq!(style.width, Some(64.0));
        assert_eq!(style.height, Some(64.0));
    }

    #[test]
    fn queued_tree_is_invisible_until_commit() {
        let host = NuiHost::new();
        let root = host.queue_create_node(NodeType::View).expect("root");
        let label = host.queue_create_text("queued").expect("label");
        host.queue_insert_before(label, root, None).expect("insert");

        assert!(!host.has_node(root));
        assert!(!host.has_node(label));
        assert!(host.root().is_none());

        let receipt = host
            .commit_pending()
            .expect("commit result")
            .expect("receipt");
        assert_eq!(receipt.command_count, 4);
        assert!(host.has_node(root));
        assert_eq!(host.root(), Some(root));
        let inner = host.inner.lock().expect("host inner");
        assert_eq!(inner.arena.get(root).unwrap().children, vec![label]);
    }

    #[test]
    fn queued_property_is_invisible_until_commit_and_reports_dirty_flags() {
        let host = NuiHost::new();
        let node = host.create_node(NodeType::View);
        host.queue_set_number(node, PropertyId::Padding, 24.0)
            .expect("queue property");
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get(node)
                .unwrap()
                .style
                .padding,
            0.0
        );
        let receipt = host.commit_pending().expect("commit").expect("receipt");
        assert!(receipt.dirty.contains(nui_core::DirtyFlags::LAYOUT));
        assert!(receipt.dirty.contains(nui_core::DirtyFlags::PAINT));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get(node)
                .unwrap()
                .style
                .padding,
            24.0
        );
    }

    #[test]
    fn failed_queued_command_poisons_and_rolls_back_the_whole_batch() {
        let host = NuiHost::new();
        let provisional = host.queue_create_node(NodeType::View).expect("queued node");
        let error = host
            .queue_set_number(provisional, PropertyId::Width, f64::NAN)
            .expect_err("non-finite property must fail");
        assert_eq!(
            error,
            nui_core::MutationError::InvalidPropertyValue(PropertyId::Width)
        );

        assert_eq!(host.commit_pending(), Err(error));
        assert!(!host.has_node(provisional));
        assert!(host.has_pending_batch());

        host.abort_pending();
        let next = host.queue_create_node(NodeType::View).expect("new batch");
        let receipt = host.commit_pending().expect("commit").expect("receipt");
        assert_eq!(receipt.sequence, 2);
        assert!(host.has_node(next));
    }

    #[test]
    fn queued_commit_rejects_plan_when_active_arena_changes() {
        let host = NuiHost::new();
        let provisional = host.queue_create_node(NodeType::View).expect("queued node");
        host.queue_set_number(provisional, PropertyId::Padding, 24.0)
            .expect("queued property");
        let active = host.create_node(NodeType::View);
        assert_eq!(provisional.raw(), active.raw());

        let error = host
            .commit_pending()
            .expect_err("active mutation invalidates queued plan");
        assert_eq!(error, nui_core::MutationError::PlanInvalidated);
        assert!(host.has_node(active));
        assert!(host.has_pending_batch());
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get(active)
                .expect("active node")
                .style
                .padding,
            0.0
        );
        assert!(host.take_last_removed_nodes().is_empty());
        assert!(host.take_last_removed_listener_handles().is_empty());
    }

    #[test]
    fn queued_commit_rejects_active_metadata_changes_without_losing_them() {
        let host = NuiHost::new();
        let node = host.create_node(NodeType::View);
        host.queue_set_number(node, PropertyId::Padding, 24.0)
            .expect("queued property");
        host.add_click_listener(node, 77);

        assert_eq!(
            host.commit_pending(),
            Err(nui_core::MutationError::PlanInvalidated)
        );
        assert_eq!(host.click_token(node), Some(77));
        assert_eq!(
            host.inner
                .lock()
                .expect("host inner")
                .arena
                .get(node)
                .expect("node")
                .style
                .padding,
            0.0
        );
    }

    #[test]
    fn metadata_only_image_commit_is_paint_dirty() {
        let host = NuiHost::new();
        let image = host.create_node(NodeType::Image);
        host.set_number(image, PropertyId::Width, 32.0);
        host.set_number(image, PropertyId::Height, 32.0);
        host.queue_set_image(image, "/tmp/nexa-ui-missing-image-dirty.png")
            .expect("queue image");

        let receipt = host.commit_pending().expect("commit").expect("receipt");
        assert!(receipt.dirty.contains(nui_core::DirtyFlags::PAINT));
    }

    #[test]
    fn sequence_overflow_rejects_before_applying() {
        let host = NuiHost::new();
        host.inner.lock().expect("host inner").next_sequence = u64::from(u32::MAX);
        let provisional = host.queue_create_node(NodeType::View).expect("queued node");

        assert_eq!(
            host.commit_pending(),
            Err(nui_core::MutationError::SequenceExhausted {
                sequence: u64::from(u32::MAX) + 1
            })
        );
        assert!(!host.has_node(provisional));
    }

    #[test]
    fn queued_remove_defers_listener_and_input_cleanup() {
        let host = NuiHost::new();
        let root = host.create_node(NodeType::View);
        let child = host.create_node(NodeType::View);
        let text = host.create_text("draft");
        host.insert(text, child);
        host.insert(child, root);
        let callback = CallbackHandle::new(30, 1);
        host.add_event_listener(child, EventId::Change, callback)
            .expect("listener");
        host.register_input(child, text, "Draft");

        host.queue_remove(child).expect("queue remove");
        assert!(host.has_node(child));
        host.commit_pending().expect("commit");
        assert!(!host.has_node(child));
        assert_eq!(host.take_last_removed_listener_handles(), vec![callback]);
        let inner = host.inner.lock().expect("host inner");
        assert!(inner.inputs.is_empty());
        assert!(inner.arena.get(root).unwrap().children.is_empty());
    }
}

#[cfg(test)]
mod structured_error_tests {
    use nui_app_runtime::ErrorDisposition;
    use nui_core::protocol::common::ErrorSeverity;
    use nui_platform_winit::{PlatformError, PlatformFailure, PlatformFailureStage};

    use super::*;

    #[test]
    fn maps_host_and_platform_failures_to_stable_nexa_errors() {
        let mutation = mutation_nexa_error(MutationError::InvalidPropertyId(999), "commit");
        assert_eq!(mutation.severity, ErrorSeverity::RecoverableOperation);
        assert_eq!(mutation.operation, "commit");
        assert_eq!(mutation.name, "INVALID_ARGUMENT");
        let semantics = mutation_nexa_error(MutationError::InvalidSemantics, "setSemantics");
        assert_eq!(semantics.name, "INVALID_ARGUMENT");
        assert_eq!(semantics.operation, "setSemantics");

        let frame = platform_failure_nexa_error(&PlatformFailure::new(
            PlatformFailureStage::PresentFrame,
            "present failed",
        ));
        assert_eq!(frame.severity, ErrorSeverity::FrameFailure);
        assert_eq!(frame.operation, "presentFrame");
        assert!(frame.retryable);

        let fatal =
            platform_run_nexa_error(&PlatformError::EventLoop("event loop failed".to_owned()));
        assert_eq!(fatal.severity, ErrorSeverity::FatalRuntime);
        assert_eq!(fatal.operation, "eventLoop");
        assert_eq!(
            ErrorDisposition::from(fatal.severity),
            ErrorDisposition::StopRuntime
        );
    }

    #[test]
    fn serializes_a_structured_error_without_losing_its_contract_fields() {
        let error = frame_nexa_error("paint", "display list failed");
        let json: serde_json::Value =
            serde_json::from_str(&error_result_json(&error)).expect("structured error JSON");

        assert_eq!(json["ok"], false);
        assert_eq!(json["error"]["severity"], "FrameFailure");
        assert_eq!(json["error"]["operation"], "paint");
        assert_eq!(json["error"]["runtimeVersion"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn structured_mappers_use_only_manifest_context_keys() {
        let invalid = mutation_nexa_error(MutationError::InvalidPropertyId(999), "commit");
        let invalid_json: serde_json::Value =
            serde_json::from_str(&error_result_json(&invalid)).unwrap();
        let invalid_context = invalid_json["error"]["context"].as_object().unwrap();
        assert_eq!(invalid_context.len(), 3);
        assert!(invalid_context.contains_key("parameter"));
        assert!(invalid_context.contains_key("expected"));
        assert!(invalid_context.contains_key("actual"));

        let platform = platform_failure_nexa_error(&PlatformFailure::new(
            PlatformFailureStage::PresentFrame,
            "present failed",
        ));
        let platform_json: serde_json::Value =
            serde_json::from_str(&error_result_json(&platform)).unwrap();
        let platform_context = platform_json["error"]["context"].as_object().unwrap();
        assert_eq!(platform_context.len(), 2);
        assert_eq!(platform_context["platform"], "winit");
        assert_eq!(platform_context["operation"], "presentFrame");
    }
}

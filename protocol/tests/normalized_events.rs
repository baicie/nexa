use nui_protocol::common::HandleRef;
use nui_protocol::ui::{
    CompositionEvent, CompositionKind, EventContext, EventModifiers, FocusEvent, FocusKind,
    KeyboardEvent, KeyboardKind, PointerEvent, PointerKind, PropagationPhase, PropagationState,
    TextInputEvent, WheelEvent,
};
use serde::de::DeserializeOwned;
use serde::Serialize;

fn round_trip<T>(value: &T, expected_json: &str)
where
    T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let encoded = serde_json::to_string(value).expect("normalized event serializes");
    assert_eq!(encoded, expected_json);
    let decoded: T = serde_json::from_str(&encoded).expect("normalized event deserializes");
    assert_eq!(&decoded, value);
}

fn context() -> EventContext {
    EventContext {
        window_id: 7,
        target: Some(HandleRef {
            slot: 12,
            generation: 3,
        }),
        timestamp: "9007199254740993".to_owned(),
        modifiers: EventModifiers {
            shift: true,
            control: false,
            alt: true,
            meta: false,
            caps_lock: false,
            num_lock: true,
        },
        propagation: PropagationState {
            phase: PropagationPhase::Target,
            default_prevented: false,
            propagation_stopped: false,
            immediate_propagation_stopped: false,
        },
    }
}

#[test]
fn pointer_round_trips_without_timestamp_precision_loss() {
    round_trip(
        &PointerEvent {
            kind: PointerKind::Down,
            pointer_id: 42,
            x: 12.5,
            y: 8.25,
            buttons: 1,
            pressure: 0.5,
            context: context(),
        },
        r#"{"kind":"Down","pointerId":42,"x":12.5,"y":8.25,"buttons":1,"pressure":0.5,"context":{"windowId":7,"target":{"slot":12,"generation":3},"timestamp":"9007199254740993","modifiers":{"shift":true,"control":false,"alt":true,"meta":false,"capsLock":false,"numLock":true},"propagation":{"phase":"Target","defaultPrevented":false,"propagationStopped":false,"immediatePropagationStopped":false}}}"#,
    );
}

#[test]
fn remaining_normalized_event_families_round_trip() {
    round_trip(
        &WheelEvent {
            delta_x: 1.25,
            delta_y: -4.0,
            x: 2.0,
            y: 3.0,
            context: context(),
        },
        r#"{"deltaX":1.25,"deltaY":-4.0,"x":2.0,"y":3.0,"context":{"windowId":7,"target":{"slot":12,"generation":3},"timestamp":"9007199254740993","modifiers":{"shift":true,"control":false,"alt":true,"meta":false,"capsLock":false,"numLock":true},"propagation":{"phase":"Target","defaultPrevented":false,"propagationStopped":false,"immediatePropagationStopped":false}}}"#,
    );
    round_trip(
        &KeyboardEvent {
            kind: KeyboardKind::Down,
            key: "あ".to_owned(),
            code: "KeyA".to_owned(),
            repeat: false,
            context: context(),
        },
        r#"{"kind":"Down","key":"あ","code":"KeyA","repeat":false,"context":{"windowId":7,"target":{"slot":12,"generation":3},"timestamp":"9007199254740993","modifiers":{"shift":true,"control":false,"alt":true,"meta":false,"capsLock":false,"numLock":true},"propagation":{"phase":"Target","defaultPrevented":false,"propagationStopped":false,"immediatePropagationStopped":false}}}"#,
    );
    round_trip(
        &TextInputEvent {
            text: "🙂".to_owned(),
            context: context(),
        },
        r#"{"text":"🙂","context":{"windowId":7,"target":{"slot":12,"generation":3},"timestamp":"9007199254740993","modifiers":{"shift":true,"control":false,"alt":true,"meta":false,"capsLock":false,"numLock":true},"propagation":{"phase":"Target","defaultPrevented":false,"propagationStopped":false,"immediatePropagationStopped":false}}}"#,
    );
    round_trip(
        &CompositionEvent {
            kind: CompositionKind::Update,
            text: "かな".to_owned(),
            selection_start: 2,
            selection_end: 4,
            context: context(),
        },
        r#"{"kind":"Update","text":"かな","selectionStart":2,"selectionEnd":4,"context":{"windowId":7,"target":{"slot":12,"generation":3},"timestamp":"9007199254740993","modifiers":{"shift":true,"control":false,"alt":true,"meta":false,"capsLock":false,"numLock":true},"propagation":{"phase":"Target","defaultPrevented":false,"propagationStopped":false,"immediatePropagationStopped":false}}}"#,
    );
    round_trip(
        &FocusEvent {
            kind: FocusKind::Lost,
            related_target: None,
            context: context(),
        },
        r#"{"kind":"Lost","relatedTarget":null,"context":{"windowId":7,"target":{"slot":12,"generation":3},"timestamp":"9007199254740993","modifiers":{"shift":true,"control":false,"alt":true,"meta":false,"capsLock":false,"numLock":true},"propagation":{"phase":"Target","defaultPrevented":false,"propagationStopped":false,"immediatePropagationStopped":false}}}"#,
    );
}

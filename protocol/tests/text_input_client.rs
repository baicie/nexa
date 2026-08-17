use nui_protocol::ui::{Rect, TextInputState, TextRange, TextSelection};

#[test]
fn text_input_state_round_trips_utf16_ranges_without_numeric_revision_loss() {
    let state = TextInputState {
        text: "A😀中".to_owned(),
        surrounding_text: TextRange { start: 0, end: 4 },
        selection: TextSelection {
            anchor: 1,
            focus: 3,
        },
        composition: Some(TextRange { start: 1, end: 3 }),
        composition_bounds: Rect {
            x: 12.5,
            y: 20.0,
            width: 1.0,
            height: 18.0,
        },
        revision: "9007199254740993".to_owned(),
    };

    let json = serde_json::to_string(&state).expect("serialize text input state");
    assert_eq!(
        json,
        r#"{"text":"A😀中","surroundingText":{"start":0,"end":4},"selection":{"anchor":1,"focus":3},"composition":{"start":1,"end":3},"compositionBounds":{"x":12.5,"y":20.0,"width":1.0,"height":18.0},"revision":"9007199254740993"}"#
    );
    assert_eq!(
        serde_json::from_str::<TextInputState>(&json).expect("deserialize text input state"),
        state
    );
}

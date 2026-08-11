use nui_protocol::ui::{SemanticRole, Semantics};

#[test]
fn semantics_round_trip_preserves_string_role_and_explicit_empty_actions() {
    let semantics = Semantics {
        role: Some(SemanticRole::Button),
        label: Some("Save".to_owned()),
        value: Some("ready".to_owned()),
        description: Some("Save the current note".to_owned()),
        disabled: Some(false),
        checked: Some(true),
        actions: Some(Vec::new()),
    };

    let json = serde_json::to_string(&semantics).expect("serialize semantics");
    assert_eq!(
        json,
        r#"{"role":"Button","label":"Save","value":"ready","description":"Save the current note","disabled":false,"checked":true,"actions":[]}"#
    );
    assert_eq!(
        serde_json::from_str::<Semantics>(&json).expect("deserialize semantics"),
        semantics
    );
}

#[test]
fn semantics_reject_unknown_role_and_action_names() {
    let unknown_role = serde_json::from_str::<Semantics>(r#"{"role":"button"}"#)
        .expect_err("unknown role must fail");
    assert!(unknown_role
        .to_string()
        .contains("unknown variant `button`"));

    let unknown_action = serde_json::from_str::<Semantics>(r#"{"actions":["Activate"]}"#)
        .expect_err("unknown action must fail");
    assert!(unknown_action
        .to_string()
        .contains("unknown variant `Activate`"));
}

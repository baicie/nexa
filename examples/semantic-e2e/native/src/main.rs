use std::sync::{Arc, Mutex};

use nui_app_runtime::{DispatchQueue, Dispatcher};
use nui_core::{
    LayoutRect, NodeId, SemanticAction, SemanticNode, SemanticRole, SemanticState,
    SemanticTreeSnapshot,
};
use nui_platform_winit::{run_app, AccessibilityActionRequest, WindowApp};
use serde::Deserialize;

mod platform_client;

pub(crate) const WINDOW_TITLE: &str = "Nexa UI - Semantic Accessibility Smoke";
pub(crate) const TITLE_ID: NodeId = NodeId::new(1, 1);
pub(crate) const BODY_ID: NodeId = NodeId::new(2, 1);
pub(crate) const SAVE_ID: NodeId = NodeId::new(3, 1);
const STATUS_ID: NodeId = NodeId::new(4, 1);

pub(crate) type SharedState = Arc<Mutex<SmokeState>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SmokeState {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) status: String,
    pub(crate) focused: Option<NodeId>,
    verified: bool,
    failure: Option<String>,
}

impl Default for SmokeState {
    fn default() -> Self {
        Self {
            title: "Draft".to_owned(),
            body: "First note".to_owned(),
            status: "Not saved".to_owned(),
            focused: None,
            verified: false,
            failure: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientOutcome {
    Pending,
    Passed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClientProgress {
    Pending,
    Passed,
    Failed(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    schema_version: u32,
    queries: Vec<ScenarioQuery>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioQuery {
    role: String,
    name: String,
    actions: Vec<String>,
    #[serde(default)]
    set_value: Option<String>,
}

fn main() {
    let scenario: Scenario = serde_json::from_str(include_str!("../../scenario.json"))
        .expect("semantic scenario is valid JSON");
    validate_scenario(&scenario).unwrap_or_else(|error| {
        eprintln!("semantic accessibility smoke scenario invalid: {error}");
        std::process::exit(2);
    });

    let shared = Arc::new(Mutex::new(SmokeState::default()));
    let app = SmokeApp::new(Arc::clone(&shared));
    let run_result = run_app(WINDOW_TITLE, app);
    if let Err(error) = run_result {
        eprintln!("semantic accessibility smoke platform error: {error}");
        std::process::exit(1);
    }
    let outcome = shared.lock().expect("smoke state").clone();
    if let Some(error) = outcome.failure {
        eprintln!("semantic accessibility smoke failed: {error}");
        std::process::exit(1);
    }
    if !outcome.verified || outcome.status != "Saved: Meeting notes" {
        eprintln!(
            "semantic accessibility smoke ended without platform verification: {}",
            outcome.status
        );
        std::process::exit(1);
    }
    println!(
        "semantic accessibility smoke passed: role/name -> Dispatcher -> {}",
        outcome.status
    );
}

fn validate_scenario(scenario: &Scenario) -> Result<(), String> {
    if scenario.schema_version != 1 {
        return Err(format!(
            "unsupported schemaVersion {}",
            scenario.schema_version
        ));
    }
    let expected = [
        ("TextInput", "Title", ["Focus", "SetValue"].as_slice()),
        ("TextInput", "Body", ["Focus", "SetValue"].as_slice()),
        ("Button", "Save", ["Invoke"].as_slice()),
    ];
    if scenario.queries.len() != expected.len() {
        return Err("scenario query count changed".to_owned());
    }
    for (query, (role, name, actions)) in scenario.queries.iter().zip(expected) {
        if (query.role.as_str(), query.name.as_str()) != (role, name)
            || query.actions.iter().map(String::as_str).collect::<Vec<_>>() != actions
        {
            return Err(format!("unexpected query {}/{}", query.role, query.name));
        }
        if name == "Title" && query.set_value.as_deref() != Some("Meeting notes")
            || name == "Body" && query.set_value.as_deref() != Some("Agenda")
        {
            return Err(format!("unexpected setValue for {name}"));
        }
    }
    Ok(())
}

struct SmokeApp {
    shared: SharedState,
    dispatcher: Dispatcher<AccessibilityActionRequest>,
    client: platform_client::Client,
    outcome: ClientOutcome,
}

impl SmokeApp {
    fn new(shared: SharedState) -> Self {
        let client = platform_client::Client::new(Arc::clone(&shared));
        Self {
            shared,
            dispatcher: Dispatcher::new(),
            client,
            outcome: ClientOutcome::Pending,
        }
    }

    fn apply_action(&mut self, request: AccessibilityActionRequest) -> bool {
        let mut state = self.shared.lock().expect("smoke state");
        match request.action {
            SemanticAction::Focus if request.target == TITLE_ID || request.target == BODY_ID => {
                state.focused = Some(request.target);
                true
            }
            SemanticAction::SetValue
                if (request.target == TITLE_ID || request.target == BODY_ID)
                    && request.value.is_some() =>
            {
                let value = request.value.expect("checked value");
                if request.target == TITLE_ID {
                    state.title = value;
                } else {
                    state.body = value;
                }
                true
            }
            SemanticAction::Invoke if request.target == SAVE_ID => {
                state.status = format!("Saved: {}", state.title);
                true
            }
            _ => false,
        }
    }

    fn snapshot_for_state(state: &SmokeState) -> SemanticTreeSnapshot {
        SemanticTreeSnapshot {
            nodes: vec![
                SemanticNode {
                    id: TITLE_ID,
                    parent: None,
                    role: SemanticRole::TextInput,
                    name: Some("Title".to_owned()),
                    value: Some(state.title.clone()),
                    description: None,
                    state: SemanticState {
                        focused: state.focused == Some(TITLE_ID),
                        ..SemanticState::default()
                    },
                    bounds: LayoutRect {
                        x: 24.0,
                        y: 24.0,
                        width: 512.0,
                        height: 36.0,
                    },
                    actions: vec![SemanticAction::Focus, SemanticAction::SetValue],
                },
                SemanticNode {
                    id: BODY_ID,
                    parent: None,
                    role: SemanticRole::TextInput,
                    name: Some("Body".to_owned()),
                    value: Some(state.body.clone()),
                    description: None,
                    state: SemanticState {
                        focused: state.focused == Some(BODY_ID),
                        ..SemanticState::default()
                    },
                    bounds: LayoutRect {
                        x: 24.0,
                        y: 72.0,
                        width: 512.0,
                        height: 220.0,
                    },
                    actions: vec![SemanticAction::Focus, SemanticAction::SetValue],
                },
                SemanticNode {
                    id: SAVE_ID,
                    parent: None,
                    role: SemanticRole::Button,
                    name: Some("Save".to_owned()),
                    value: None,
                    description: None,
                    state: SemanticState::default(),
                    bounds: LayoutRect {
                        x: 24.0,
                        y: 304.0,
                        width: 120.0,
                        height: 36.0,
                    },
                    actions: vec![SemanticAction::Invoke],
                },
                SemanticNode {
                    id: STATUS_ID,
                    parent: None,
                    role: SemanticRole::Text,
                    name: Some(state.status.clone()),
                    value: Some(state.status.clone()),
                    description: None,
                    state: SemanticState::default(),
                    bounds: LayoutRect {
                        x: 24.0,
                        y: 352.0,
                        width: 512.0,
                        height: 24.0,
                    },
                    actions: Vec::new(),
                },
            ],
        }
    }
}

impl WindowApp for SmokeApp {
    fn paint(&mut self, pixels: &mut [u32], _width: u32, _height: u32, _scale: f64) {
        pixels.fill(0xff202830);
    }

    fn tick(&mut self) -> bool {
        let mut changed = false;
        for item in self.dispatcher.drain_tick() {
            changed |= self.apply_action(item.payload);
        }

        let state = self.shared.lock().expect("smoke state").clone();
        match self.client.drive(&state) {
            ClientProgress::Pending => {}
            ClientProgress::Passed => {
                self.shared.lock().expect("smoke state").verified = true;
                self.outcome = ClientOutcome::Passed;
            }
            ClientProgress::Failed(error) => {
                self.shared.lock().expect("smoke state").failure = Some(error);
                self.outcome = ClientOutcome::Failed;
            }
        }
        if self.outcome == ClientOutcome::Pending {
            // Keep polling the platform tree while the OS client waits for
            // the next committed semantic update.
            true
        } else {
            changed
        }
    }

    fn accessibility_snapshot(&mut self) -> Option<SemanticTreeSnapshot> {
        let state = self.shared.lock().expect("smoke state").clone();
        Some(Self::snapshot_for_state(&state))
    }

    fn accessibility_action(&mut self, request: AccessibilityActionRequest) -> bool {
        self.dispatcher.enqueue(DispatchQueue::Platform, request);
        false
    }

    fn exit_requested(&mut self) -> bool {
        self.outcome != ClientOutcome::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenario_contract_is_shared_with_the_native_fixture() {
        let scenario: Scenario =
            serde_json::from_str(include_str!("../../scenario.json")).expect("scenario JSON");
        assert_eq!(scenario.schema_version, 1);
        assert_eq!(scenario.queries.len(), 3);
        validate_scenario(&scenario).expect("native fixture follows scenario");
    }

    #[test]
    fn dispatcher_actions_update_the_saved_status() {
        let shared = Arc::new(Mutex::new(SmokeState::default()));
        let mut app = SmokeApp::new(Arc::clone(&shared));
        assert!(app.apply_action(AccessibilityActionRequest {
            target: TITLE_ID,
            action: SemanticAction::SetValue,
            value: Some("Meeting notes".to_owned()),
        }));
        assert!(app.apply_action(AccessibilityActionRequest {
            target: SAVE_ID,
            action: SemanticAction::Invoke,
            value: None,
        }));
        assert_eq!(shared.lock().expect("state").status, "Saved: Meeting notes");
    }
}

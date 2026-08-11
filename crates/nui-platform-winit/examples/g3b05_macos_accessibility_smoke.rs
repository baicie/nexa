#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("g3b05_macos_accessibility_smoke only runs on macOS");
}

#[cfg(target_os = "macos")]
mod macos {
    use std::process::ExitCode;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use accessibility::{
        AXAttribute, AXUIElement, AXUIElementActions, AXUIElementAttributes, ElementFinder,
    };
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::CFString;
    use nui_core::{
        LayoutRect, NodeId, SemanticAction, SemanticNode, SemanticRole, SemanticState,
        SemanticTreeSnapshot,
    };
    use nui_platform_winit::{run_app, AccessibilityActionRequest, WindowApp};
    use serde::Deserialize;

    const SCENARIO_JSON: &str = include_str!("../../../examples/semantic-e2e/scenario.json");
    const WINDOW_TITLE: &str = "Nexa UI - Semantic E2E";
    const ACTION_TIMEOUT: Duration = Duration::from_secs(5);
    const QUERY_TIMEOUT: Duration = Duration::from_secs(10);

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Scenario {
        schema_version: u32,
        platforms: Vec<Platform>,
        queries: Vec<Query>,
        assertions: Vec<String>,
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Platform {
        id: String,
        primary_modifier: String,
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Query {
        role: String,
        name: String,
        actions: Vec<String>,
        set_value: Option<String>,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct ObservedAction {
        name: String,
        action: SemanticAction,
        value: Option<String>,
    }

    #[derive(Default)]
    struct Observation {
        actions: Vec<ObservedAction>,
    }

    struct SmokeApp {
        snapshot: SemanticTreeSnapshot,
        observation: Arc<Mutex<Observation>>,
    }

    impl SmokeApp {
        fn new(scenario: &Scenario, observation: Arc<Mutex<Observation>>) -> Result<Self, String> {
            let mut nodes = Vec::with_capacity(scenario.queries.len());
            for (index, query) in scenario.queries.iter().enumerate() {
                let role = semantic_role(&query.role)?;
                let actions = query
                    .actions
                    .iter()
                    .map(|action| semantic_action(action))
                    .collect::<Result<Vec<_>, _>>()?;
                nodes.push(SemanticNode {
                    id: NodeId::new(
                        u32::try_from(index + 1).map_err(|error| error.to_string())?,
                        1,
                    ),
                    parent: None,
                    role,
                    name: Some(query.name.clone()),
                    value: (role == SemanticRole::TextInput).then(String::new),
                    description: None,
                    state: SemanticState::default(),
                    bounds: LayoutRect {
                        x: 24.0,
                        y: 24.0 + index as f32 * 52.0,
                        width: 320.0,
                        height: 36.0,
                    },
                    actions,
                });
            }
            Ok(Self {
                snapshot: SemanticTreeSnapshot { nodes },
                observation,
            })
        }
    }

    impl WindowApp for SmokeApp {
        fn paint(&mut self, pixels: &mut [u32], _width: u32, _height: u32, _scale: f64) {
            pixels.fill(0x00ff_ffff);
        }

        fn accessibility_snapshot(&mut self) -> Option<SemanticTreeSnapshot> {
            Some(self.snapshot.clone())
        }

        fn accessibility_action(&mut self, request: AccessibilityActionRequest) -> bool {
            let Some(index) = self.snapshot.nodes.iter().position(|node| {
                node.id == request.target && node.actions.contains(&request.action)
            }) else {
                return false;
            };
            let name = self.snapshot.nodes[index].name.clone().unwrap_or_default();
            match request.action {
                SemanticAction::Focus => {
                    for node in &mut self.snapshot.nodes {
                        node.state.focused = false;
                    }
                    self.snapshot.nodes[index].state.focused = true;
                }
                SemanticAction::SetValue => {
                    let Some(value) = request.value.clone() else {
                        return false;
                    };
                    self.snapshot.nodes[index].value = Some(value);
                }
                SemanticAction::Invoke => {}
            }
            self.observation
                .lock()
                .expect("smoke observation")
                .actions
                .push(ObservedAction {
                    name,
                    action: request.action,
                    value: request.value,
                });
            true
        }
    }

    pub fn main() -> ExitCode {
        let scenario = match parse_scenario() {
            Ok(scenario) => scenario,
            Err(error) => return fail(error),
        };
        let observation = Arc::new(Mutex::new(Observation::default()));
        let app = match SmokeApp::new(&scenario, Arc::clone(&observation)) {
            Ok(app) => app,
            Err(error) => return fail(error),
        };
        thread::spawn(move || finish(run_ax_scenario(&scenario, &observation)));

        match run_app(WINDOW_TITLE, app) {
            Ok(()) => fail("window closed before the AX scenario completed".to_owned()),
            Err(error) => fail(format!("window failed: {error}")),
        }
    }

    fn parse_scenario() -> Result<Scenario, String> {
        let scenario: Scenario =
            serde_json::from_str(SCENARIO_JSON).map_err(|error| error.to_string())?;
        if scenario.schema_version != 1 {
            return Err(format!(
                "unsupported semantic scenario schema {}",
                scenario.schema_version
            ));
        }
        let macos = scenario
            .platforms
            .iter()
            .find(|platform| platform.id == "macos")
            .ok_or_else(|| "semantic scenario has no macOS platform".to_owned())?;
        if macos.primary_modifier != "Meta" {
            return Err(format!(
                "unexpected macOS primary modifier {}",
                macos.primary_modifier
            ));
        }
        if scenario.assertions.is_empty() || scenario.queries.is_empty() {
            return Err("semantic scenario must include queries and assertions".to_owned());
        }
        Ok(scenario)
    }

    fn semantic_role(role: &str) -> Result<SemanticRole, String> {
        match role {
            "TextInput" => Ok(SemanticRole::TextInput),
            "Button" => Ok(SemanticRole::Button),
            value => Err(format!("unsupported semantic role {value}")),
        }
    }

    fn semantic_action(action: &str) -> Result<SemanticAction, String> {
        match action {
            "Focus" => Ok(SemanticAction::Focus),
            "SetValue" => Ok(SemanticAction::SetValue),
            "Invoke" => Ok(SemanticAction::Invoke),
            value => Err(format!("unsupported semantic action {value}")),
        }
    }

    fn run_ax_scenario(
        scenario: &Scenario,
        observation: &Arc<Mutex<Observation>>,
    ) -> Result<(), String> {
        let application = AXUIElement::application(
            i32::try_from(std::process::id()).map_err(|error| error.to_string())?,
        );
        application
            .set_messaging_timeout(2.0)
            .map_err(|error| format!("set AX messaging timeout: {error}"))?;

        for query in &scenario.queries {
            let role = macos_role(&query.role)?;
            let name = query.name.clone();
            let finder = ElementFinder::new(
                &application,
                move |element| {
                    element.role().is_ok_and(|actual| actual == role)
                        && element.title().is_ok_and(|actual| actual == name)
                },
                Some(QUERY_TIMEOUT),
            );
            let element = finder.find().map_err(|error| {
                format!(
                    "find {}/{} through AXUIElement: {error}",
                    query.role, query.name
                )
            })?;

            for action in &query.actions {
                let expected = match action.as_str() {
                    "Focus" => {
                        element
                            .set_attribute(&AXAttribute::focused(), CFBoolean::true_value())
                            .map_err(|error| {
                                format!("focus {} through AXUIElement: {error}", query.name)
                            })?;
                        ObservedAction {
                            name: query.name.clone(),
                            action: SemanticAction::Focus,
                            value: None,
                        }
                    }
                    "SetValue" => {
                        let value = query.set_value.as_ref().ok_or_else(|| {
                            format!("{} has SetValue without setValue", query.name)
                        })?;
                        element
                            .set_value(CFString::new(value).as_CFType())
                            .map_err(|error| {
                                format!("set {} value through AXUIElement: {error}", query.name)
                            })?;
                        ObservedAction {
                            name: query.name.clone(),
                            action: SemanticAction::SetValue,
                            value: Some(value.clone()),
                        }
                    }
                    "Invoke" => {
                        element.press().map_err(|error| {
                            format!("press {} through AXUIElement: {error}", query.name)
                        })?;
                        ObservedAction {
                            name: query.name.clone(),
                            action: SemanticAction::Invoke,
                            value: None,
                        }
                    }
                    value => return Err(format!("unsupported AX action {value}")),
                };
                wait_for_action(observation, &expected)?;
            }
        }
        Ok(())
    }

    fn macos_role(role: &str) -> Result<String, String> {
        match role {
            "TextInput" => Ok("AXTextField".to_owned()),
            "Button" => Ok("AXButton".to_owned()),
            value => Err(format!("unsupported macOS AX role for {value}")),
        }
    }

    fn wait_for_action(
        observation: &Arc<Mutex<Observation>>,
        expected: &ObservedAction,
    ) -> Result<(), String> {
        let deadline = Instant::now() + ACTION_TIMEOUT;
        loop {
            if observation
                .lock()
                .map_err(|error| error.to_string())?
                .actions
                .contains(expected)
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "WindowApp did not receive AX action {expected:?}; observed {:?}",
                    observation
                        .lock()
                        .map_err(|error| error.to_string())?
                        .actions
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn finish(result: Result<(), String>) -> ! {
        match result {
            Ok(()) => {
                eprintln!("G3B-05 macOS AX accessibility smoke passed");
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("G3B-05 macOS AX accessibility smoke failed: {error}");
                std::process::exit(1);
            }
        }
    }

    fn fail(error: String) -> ExitCode {
        eprintln!("G3B-05 macOS AX accessibility smoke failed: {error}");
        ExitCode::FAILURE
    }
}

#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    macos::main()
}

//! System Host file-dialog request parsing and native backend.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use nui_system_core::{DialogBackend, DialogError, DialogFilter, DialogRequest};
use serde_json::Value;

mod embedded_test_fixture {
    include!(concat!(env!("OUT_DIR"), "/embedded_dialog_test_fixture.rs"));
}

/// Parse the compact JSON filter transport used by the Perry ABI.
pub(crate) fn parse_request(
    title: String,
    default_path: String,
    filters_json: String,
) -> Result<DialogRequest, DialogError> {
    let filters_value: Value = serde_json::from_str(&filters_json)
        .map_err(|error| DialogError::InvalidRequest(format!("filters JSON: {error}")))?;
    let filters = filters_value
        .as_array()
        .ok_or_else(|| DialogError::InvalidRequest("filters must be an array".to_owned()))?
        .iter()
        .map(parse_filter)
        .collect::<Result<Vec<_>, _>>()?;

    let request = DialogRequest {
        title: non_empty(title),
        default_path: non_empty(default_path).map(PathBuf::from),
        filters,
    };
    request.validate()?;
    Ok(request)
}

fn parse_filter(value: &Value) -> Result<DialogFilter, DialogError> {
    let object = value
        .as_object()
        .ok_or_else(|| DialogError::InvalidRequest("each filter must be an object".to_owned()))?;
    let allowed = ["name", "extensions"];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(DialogError::InvalidRequest(
            "filter contains an unknown field".to_owned(),
        ));
    }
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| DialogError::InvalidRequest("filter.name must be a string".to_owned()))?
        .to_owned();
    let extensions = object
        .get("extensions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            DialogError::InvalidRequest("filter.extensions must be an array".to_owned())
        })?
        .iter()
        .map(|extension| {
            extension.as_str().map(str::to_owned).ok_or_else(|| {
                DialogError::InvalidRequest("filter extension must be a string".to_owned())
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DialogFilter { name, extensions })
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct NativeDialogBackend;

impl DialogBackend for NativeDialogBackend {
    fn open_file(&self, request: &DialogRequest) -> Result<Option<PathBuf>, DialogError> {
        let dialog = build_dialog(request);
        Ok(dialog.pick_file())
    }

    fn save_file(&self, request: &DialogRequest) -> Result<Option<PathBuf>, DialogError> {
        let dialog = build_dialog(request);
        Ok(dialog.save_file())
    }
}

pub(crate) struct FixtureDialogBackend {
    open: Mutex<VecDeque<Option<PathBuf>>>,
    save: Mutex<VecDeque<Option<PathBuf>>>,
}

impl FixtureDialogBackend {
    fn parse(bytes: &[u8]) -> Result<Self, DialogError> {
        let value: Value = serde_json::from_slice(bytes).map_err(|error| {
            DialogError::InvalidRequest(format!("dialog test fixture JSON: {error}"))
        })?;
        let object = value.as_object().ok_or_else(|| {
            DialogError::InvalidRequest("dialog test fixture must be an object".to_owned())
        })?;
        let allowed = ["version", "open", "save"];
        if object.keys().any(|key| !allowed.contains(&key.as_str())) || object.len() != 3 {
            return Err(DialogError::InvalidRequest(
                "dialog test fixture must contain only version, open, and save".to_owned(),
            ));
        }
        if object.get("version").and_then(Value::as_u64) != Some(1) {
            return Err(DialogError::InvalidRequest(
                "dialog test fixture version must be 1".to_owned(),
            ));
        }
        Ok(Self {
            open: Mutex::new(parse_fixture_responses(object.get("open"), "open")?),
            save: Mutex::new(parse_fixture_responses(object.get("save"), "save")?),
        })
    }

    fn next(
        queue: &Mutex<VecDeque<Option<PathBuf>>>,
        operation: &str,
    ) -> Result<Option<PathBuf>, DialogError> {
        queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop_front()
            .ok_or_else(|| {
                DialogError::PlatformFailure(format!(
                    "embedded dialog test fixture {operation} responses are exhausted"
                ))
            })
    }
}

impl DialogBackend for FixtureDialogBackend {
    fn open_file(&self, _request: &DialogRequest) -> Result<Option<PathBuf>, DialogError> {
        Self::next(&self.open, "open")
    }

    fn save_file(&self, _request: &DialogRequest) -> Result<Option<PathBuf>, DialogError> {
        Self::next(&self.save, "save")
    }
}

fn parse_fixture_responses(
    value: Option<&Value>,
    operation: &str,
) -> Result<VecDeque<Option<PathBuf>>, DialogError> {
    let responses = value.and_then(Value::as_array).ok_or_else(|| {
        DialogError::InvalidRequest(format!("dialog test fixture {operation} must be an array"))
    })?;
    responses
        .iter()
        .map(|response| {
            if response.is_null() {
                return Ok(None);
            }
            let path = response.as_str().ok_or_else(|| {
                DialogError::InvalidRequest(format!(
                    "dialog test fixture {operation} responses must be paths or null"
                ))
            })?;
            if path.is_empty() || path.contains('\0') {
                return Err(DialogError::InvalidRequest(format!(
                    "dialog test fixture {operation} selected paths must be non-empty and contain no NUL"
                )));
            }
            Ok(Some(PathBuf::from(path)))
        })
        .collect()
}

pub(crate) enum SystemDialogBackend {
    Native(NativeDialogBackend),
    Fixture(FixtureDialogBackend),
    InvalidFixture(DialogError),
}

impl DialogBackend for SystemDialogBackend {
    fn open_file(&self, request: &DialogRequest) -> Result<Option<PathBuf>, DialogError> {
        match self {
            Self::Native(backend) => backend.open_file(request),
            Self::Fixture(backend) => backend.open_file(request),
            Self::InvalidFixture(error) => Err(error.clone()),
        }
    }

    fn save_file(&self, request: &DialogRequest) -> Result<Option<PathBuf>, DialogError> {
        match self {
            Self::Native(backend) => backend.save_file(request),
            Self::Fixture(backend) => backend.save_file(request),
            Self::InvalidFixture(error) => Err(error.clone()),
        }
    }
}

pub(crate) fn system_dialog_backend() -> Arc<SystemDialogBackend> {
    static BACKEND: OnceLock<Arc<SystemDialogBackend>> = OnceLock::new();
    Arc::clone(BACKEND.get_or_init(|| {
        Arc::new(match embedded_test_fixture::EMBEDDED_DIALOG_TEST_FIXTURE {
            Some(bytes) => match FixtureDialogBackend::parse(bytes) {
                Ok(backend) => SystemDialogBackend::Fixture(backend),
                Err(error) => SystemDialogBackend::InvalidFixture(error),
            },
            None => SystemDialogBackend::Native(NativeDialogBackend),
        })
    }))
}

fn build_dialog(request: &DialogRequest) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = &request.title {
        dialog = dialog.set_title(title);
    }
    if let Some(path) = &request.default_path {
        if path.file_name().is_some() {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                dialog = dialog.set_directory(parent);
            }
            if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
                dialog = dialog.set_file_name(file_name);
            }
        } else {
            dialog = dialog.set_directory(path);
        }
    }
    for filter in &request.filters {
        dialog = dialog.add_filter(&filter.name, &filter.extensions);
    }
    dialog
}

#[allow(dead_code)]
fn _path_is_absolute(path: &Path) -> bool {
    path.is_absolute()
}

#[cfg(test)]
mod tests {
    use super::{parse_request, FixtureDialogBackend};
    use nui_system_core::{DialogBackend, DialogRequest};

    fn empty_request() -> DialogRequest {
        DialogRequest {
            title: None,
            default_path: None,
            filters: Vec::new(),
        }
    }

    #[test]
    fn parses_and_validates_filters() {
        let request = parse_request(
            "Open".to_owned(),
            "/tmp/notes.md".to_owned(),
            r#"[{"name":"Text","extensions":["txt","md"]}]"#.to_owned(),
        )
        .expect("dialog request");
        assert_eq!(request.title.as_deref(), Some("Open"));
        assert_eq!(request.filters[0].extensions, ["txt", "md"]);
    }

    #[test]
    fn rejects_unknown_filter_fields() {
        let error = parse_request(
            String::new(),
            String::new(),
            r#"[{"name":"Text","extensions":[],"extra":true}]"#.to_owned(),
        )
        .expect_err("unknown field must fail closed");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn fixture_backend_consumes_selected_paths_and_cancellation_in_order() {
        let backend = FixtureDialogBackend::parse(
            br#"{"version":1,"open":["open.txt",null],"save":["save.txt"]}"#,
        )
        .expect("dialog fixture");
        let request = empty_request();

        assert_eq!(
            backend.open_file(&request).expect("first open"),
            Some("open.txt".into())
        );
        assert_eq!(backend.open_file(&request).expect("cancelled open"), None);
        assert_eq!(
            backend.save_file(&request).expect("first save"),
            Some("save.txt".into())
        );
        assert!(backend
            .save_file(&request)
            .expect_err("fixture must fail when exhausted")
            .to_string()
            .contains("exhausted"));
    }

    #[test]
    fn fixture_backend_rejects_unknown_fields_and_empty_selected_paths() {
        for fixture in [
            br#"{"version":1,"open":[],"save":[],"extra":true}"#.as_slice(),
            br#"{"version":1,"open":[""],"save":[]}"#.as_slice(),
        ] {
            assert!(FixtureDialogBackend::parse(fixture).is_err());
        }
    }
}

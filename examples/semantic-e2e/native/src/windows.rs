use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use super::super::{ClientProgress, SharedState, SmokeState};
use windows::Win32::UI::Accessibility::{
    IUIAutomationCondition, IUIAutomationElement, UIA_ButtonControlTypeId, UIA_EditControlTypeId,
};

pub(crate) struct Client {
    result: Receiver<Result<(), String>>,
    deadline: Instant,
}

impl Client {
    pub(crate) fn new(shared: SharedState) -> Self {
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("nexa-uia-client".to_owned())
            .spawn(move || {
                eprintln!("UI Automation client worker started");
                let result = match catch_unwind(AssertUnwindSafe(|| run_client(&shared))) {
                    Ok(result) => result,
                    Err(panic) => {
                        let detail = panic
                            .downcast_ref::<&str>()
                            .copied()
                            .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
                            .unwrap_or("unknown panic payload");
                        Err(format!("UI Automation client panicked: {detail}"))
                    }
                };
                eprintln!("UI Automation client worker completed: {result:?}");
                let send_result = sender.send(result);
                eprintln!(
                    "UI Automation client worker result delivery: {}",
                    if send_result.is_ok() {
                        "sent"
                    } else {
                        "receiver dropped"
                    }
                );
                wake_fixture();
            })
            .expect("spawn UI Automation client worker");
        Self {
            result: receiver,
            deadline: Instant::now() + Duration::from_secs(35),
        }
    }

    pub(crate) fn drive(&mut self, _state: &SmokeState) -> ClientProgress {
        let progress = match self.result.try_recv() {
            Ok(Ok(())) => ClientProgress::Passed,
            Ok(Err(error)) => ClientProgress::Failed(error),
            Err(TryRecvError::Empty) if Instant::now() < self.deadline => ClientProgress::Pending,
            Err(TryRecvError::Empty) => {
                ClientProgress::Failed("UI Automation client did not finish within 35s".to_owned())
            }
            Err(TryRecvError::Disconnected) => {
                ClientProgress::Failed("UI Automation client exited without a result".to_owned())
            }
        };
        if !matches!(progress, ClientProgress::Pending) {
            eprintln!("UI Automation client progress: {progress:?}");
        }
        progress
    }
}

fn run_client(shared: &SharedState) -> Result<(), String> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationInvokePattern, UIA_InvokePatternId,
    };
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;

    eprintln!("UI Automation client initializing COM");
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| format!("CoInitializeEx failed: {error}"))?;
    }
    eprintln!("UI Automation client COM initialized");
    let result = (|| -> Result<(), String> {
        eprintln!("UI Automation client creating automation object");
        let automation: IUIAutomation = unsafe {
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| format!("CoCreateInstance(CUIAutomation) failed: {error}"))?
        };
        eprintln!("UI Automation client automation object created");
        let deadline = Instant::now() + Duration::from_secs(30);
        let hwnd = loop {
            let found = unsafe {
                FindWindowW(
                    None,
                    windows::core::w!("Nexa UI - Semantic Accessibility Smoke"),
                )
            };
            if let Ok(hwnd) = found {
                break hwnd;
            }
            if Instant::now() >= deadline {
                return Err("UI Automation window was not found within 30s".to_owned());
            }
            thread::sleep(Duration::from_millis(25));
        };
        let root = unsafe {
            automation
                .ElementFromHandle(hwnd)
                .map_err(|error| format!("ElementFromHandle failed: {error}"))?
        };
        let condition = unsafe {
            automation
                .CreateTrueCondition()
                .map_err(|error| format!("CreateTrueCondition failed: {error}"))?
        };
        let (title, body, save, status) = wait_for_elements(&root, &condition, deadline)?;

        unsafe {
            title
                .SetFocus()
                .map_err(|error| format!("Title SetFocus failed: {error}"))?;
        }
        wait_until(shared, deadline, |state| {
            state.focused == Some(super::super::TITLE_ID)
        })?;
        wait_for_platform_focus(&title, deadline, "Title")?;
        set_value(&title, "Meeting notes")?;
        wait_until(shared, deadline, |state| state.title == "Meeting notes")?;

        unsafe {
            body.SetFocus()
                .map_err(|error| format!("Body SetFocus failed: {error}"))?;
        }
        wait_until(shared, deadline, |state| {
            state.focused == Some(super::super::BODY_ID)
        })?;
        wait_for_platform_focus(&body, deadline, "Body")?;
        set_value(&body, "Agenda")?;
        wait_until(shared, deadline, |state| state.body == "Agenda")?;

        let invoke: IUIAutomationInvokePattern = unsafe {
            save.GetCurrentPatternAs(UIA_InvokePatternId)
                .map_err(|error| format!("Save InvokePattern unavailable: {error}"))?
        };
        unsafe {
            invoke
                .Invoke()
                .map_err(|error| format!("Save Invoke failed: {error}"))?;
        }
        wait_until(shared, deadline, |state| {
            state.status == "Saved: Meeting notes"
        })?;

        let title_value = current_value(&title)?;
        let body_value = current_value(&body)?;
        let status_name = unsafe {
            status
                .CurrentName()
                .map_err(|error| format!("Status CurrentName failed: {error}"))?
        };
        if title_value != "Meeting notes" || body_value != "Agenda" {
            return Err(format!(
                "UI Automation values did not settle: title={title_value:?}, body={body_value:?}"
            ));
        }
        let status_name = status_name.to_string();
        if status_name != "Saved: Meeting notes" {
            return Err(format!("status name mismatch: {status_name:?}"));
        }

        Ok(())
    })();
    unsafe { CoUninitialize() };
    result
}

fn wake_fixture() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, PostMessageW, WM_NULL};

    let hwnd = unsafe {
        FindWindowW(
            None,
            windows::core::w!("Nexa UI - Semantic Accessibility Smoke"),
        )
    };
    if let Ok(hwnd) = hwnd {
        let _ = unsafe { PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0)) };
    }
}

fn wait_for_elements(
    root: &IUIAutomationElement,
    condition: &IUIAutomationCondition,
    deadline: Instant,
) -> Result<
    (
        IUIAutomationElement,
        IUIAutomationElement,
        IUIAutomationElement,
        IUIAutomationElement,
    ),
    String,
> {
    use windows::Win32::UI::Accessibility::TreeScope_Descendants;

    loop {
        let mut title = None;
        let mut body = None;
        let mut save = None;
        let mut status = None;
        let elements = unsafe {
            root.FindAll(TreeScope_Descendants, condition)
                .map_err(|error| format!("FindAll failed: {error}"))?
        };
        let length = unsafe {
            elements
                .Length()
                .map_err(|error| format!("Length failed: {error}"))?
        };
        for index in 0..length {
            let element = unsafe {
                elements
                    .GetElement(index)
                    .map_err(|error| format!("GetElement failed: {error}"))?
            };
            let name = unsafe {
                element
                    .CurrentName()
                    .map_err(|error| format!("CurrentName failed: {error}"))?
            };
            let control_type = unsafe {
                element
                    .CurrentControlType()
                    .map_err(|error| format!("CurrentControlType failed: {error}"))?
            };
            let name = name.to_string();
            if control_type == UIA_EditControlTypeId && name == "Title" {
                title = Some(element);
            } else if control_type == UIA_EditControlTypeId && name == "Body" {
                body = Some(element);
            } else if control_type == UIA_ButtonControlTypeId && name == "Save" {
                save = Some(element);
            } else if name == "Not saved" || name == "Saved: Meeting notes" {
                status = Some(element);
            }
        }
        if let (Some(title), Some(body), Some(save), Some(status)) = (title, body, save, status) {
            return Ok((title, body, save, status));
        }
        if Instant::now() >= deadline {
            return Err("UI Automation role/name queries did not resolve".to_owned());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn set_value(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    value: &str,
) -> Result<(), String> {
    use windows::Win32::UI::Accessibility::{IUIAutomationValuePattern, UIA_ValuePatternId};
    let pattern: IUIAutomationValuePattern = unsafe {
        element
            .GetCurrentPatternAs(UIA_ValuePatternId)
            .map_err(|error| format!("ValuePattern unavailable: {error}"))?
    };
    let value = windows::core::BSTR::from(value);
    unsafe {
        pattern
            .SetValue(&value)
            .map_err(|error| format!("ValuePattern.SetValue failed: {error}"))
    }
}

fn current_value(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Result<String, String> {
    use windows::Win32::UI::Accessibility::{IUIAutomationValuePattern, UIA_ValuePatternId};
    let pattern: IUIAutomationValuePattern = unsafe {
        element
            .GetCurrentPatternAs(UIA_ValuePatternId)
            .map_err(|error| format!("ValuePattern unavailable: {error}"))?
    };
    unsafe {
        pattern
            .CurrentValue()
            .map(|value| value.to_string())
            .map_err(|error| format!("ValuePattern.CurrentValue failed: {error}"))
    }
}

fn wait_until(
    shared: &SharedState,
    deadline: Instant,
    predicate: impl Fn(&SmokeState) -> bool,
) -> Result<(), String> {
    loop {
        let state = shared.lock().expect("smoke state").clone();
        if predicate(&state) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("application state did not reflect UI Automation action".to_owned());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_platform_focus(
    element: &IUIAutomationElement,
    deadline: Instant,
    name: &str,
) -> Result<(), String> {
    loop {
        let focused = unsafe {
            element
                .CurrentHasKeyboardFocus()
                .map_err(|error| format!("{name} CurrentHasKeyboardFocus failed: {error}"))?
        };
        if focused.as_bool() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "{name} did not expose UI Automation keyboard focus"
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

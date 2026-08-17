#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2::{msg_send, rc::Retained, runtime::AnyObject};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSApplication;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSString};
use std::time::{Duration, Instant};

use super::super::{ClientProgress, SharedState, SmokeState, WINDOW_TITLE};

const TEXT_FIELD_ROLE: &str = "AXTextField";
const BUTTON_ROLE: &str = "AXButton";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Discover,
    FocusTitle,
    SetTitle,
    FocusBody,
    SetBody,
    InvokeSave,
    VerifySaved,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActionProgress {
    Request,
    AwaitPlatformReadback,
    Complete,
}

fn action_progress(internal_committed: bool, platform_committed: bool) -> ActionProgress {
    if !internal_committed {
        ActionProgress::Request
    } else if platform_committed {
        ActionProgress::Complete
    } else {
        ActionProgress::AwaitPlatformReadback
    }
}

pub(crate) struct Client {
    stage: Stage,
    deadline: Instant,
}

struct Elements {
    title: Retained<AnyObject>,
    body: Retained<AnyObject>,
    save: Retained<AnyObject>,
    status: Retained<AnyObject>,
}

impl Client {
    pub(crate) fn new(_shared: SharedState) -> Self {
        Self {
            stage: Stage::Discover,
            deadline: Instant::now() + Duration::from_secs(30),
        }
    }

    pub(crate) fn drive(&mut self, state: &SmokeState) -> ClientProgress {
        if Instant::now() >= self.deadline {
            return ClientProgress::Failed(format!(
                "NSAccessibility scenario timed out after 30s at {:?}: focused={:?}, title={:?}, body={:?}, status={:?}",
                self.stage, state.focused, state.title, state.body, state.status
            ));
        }
        let Some(Elements {
            title,
            body,
            save,
            status,
        }) = discover()
        else {
            return ClientProgress::Pending;
        };

        let result = match self.stage {
            Stage::Discover => {
                self.stage = Stage::FocusTitle;
                Ok(())
            }
            Stage::FocusTitle => {
                match action_progress(
                    state.focused == Some(super::super::TITLE_ID),
                    is_focused(&title),
                ) {
                    ActionProgress::Request => {
                        let _: () = unsafe { msg_send![&*title, setAccessibilityFocused: true] };
                    }
                    ActionProgress::AwaitPlatformReadback => {}
                    ActionProgress::Complete => self.stage = Stage::SetTitle,
                }
                Ok(())
            }
            Stage::SetTitle => {
                match action_progress(
                    state.title == "Meeting notes",
                    value_of(&title).as_deref() == Some("Meeting notes"),
                ) {
                    ActionProgress::Request => set_value(&title, "Meeting notes"),
                    ActionProgress::AwaitPlatformReadback => {}
                    ActionProgress::Complete => self.stage = Stage::FocusBody,
                }
                Ok(())
            }
            Stage::FocusBody => {
                match action_progress(
                    state.focused == Some(super::super::BODY_ID),
                    is_focused(&body),
                ) {
                    ActionProgress::Request => {
                        let _: () = unsafe { msg_send![&*body, setAccessibilityFocused: true] };
                    }
                    ActionProgress::AwaitPlatformReadback => {}
                    ActionProgress::Complete => self.stage = Stage::SetBody,
                }
                Ok(())
            }
            Stage::SetBody => {
                match action_progress(
                    state.body == "Agenda",
                    value_of(&body).as_deref() == Some("Agenda"),
                ) {
                    ActionProgress::Request => set_value(&body, "Agenda"),
                    ActionProgress::AwaitPlatformReadback => {}
                    ActionProgress::Complete => self.stage = Stage::InvokeSave,
                }
                Ok(())
            }
            Stage::InvokeSave => {
                let pressed: bool = unsafe { msg_send![&*save, accessibilityPerformPress] };
                if !pressed {
                    return ClientProgress::Failed(
                        "NSAccessibility accessibilityPerformPress returned false".to_owned(),
                    );
                }
                self.stage = Stage::VerifySaved;
                Ok(())
            }
            Stage::VerifySaved => {
                let expected = "Saved: Meeting notes";
                if state.status == expected
                    && (title_value_matches(&title, "Meeting notes"))
                    && (value_of(&body) == Some("Agenda".to_owned()))
                    && (title_of(&status) == Some(expected.to_owned())
                        || value_of(&status) == Some(expected.to_owned()))
                {
                    self.stage = Stage::Done;
                }
                Ok(())
            }
            Stage::Done => return ClientProgress::Passed,
        };

        if let Err(error) = result {
            ClientProgress::Failed(error)
        } else {
            ClientProgress::Pending
        }
    }
}

fn discover() -> Option<Elements> {
    let marker = MainThreadMarker::new()?;
    let application = NSApplication::sharedApplication(marker);
    #[allow(deprecated)]
    application.activateIgnoringOtherApps(true);
    let windows = application.windows();
    for index in 0..windows.count() {
        let window = windows.objectAtIndex(index);
        if window.title().to_string() != WINDOW_TITLE {
            continue;
        }
        window.makeKeyAndOrderFront(None);
        let Some(content_view) = window.contentView() else {
            continue;
        };
        let Some(children) = accessibility_children(&*content_view) else {
            continue;
        };
        let Some(title) = find_named(&children, TEXT_FIELD_ROLE, "Title") else {
            continue;
        };
        let Some(body) = find_named(&children, TEXT_FIELD_ROLE, "Body") else {
            continue;
        };
        let Some(save) = find_named(&children, BUTTON_ROLE, "Save") else {
            continue;
        };
        let Some(status) = find_named(&children, "AXStaticText", "Not saved")
            .or_else(|| find_named(&children, "AXStaticText", "Saved: Meeting notes"))
        else {
            continue;
        };
        return Some(Elements {
            title,
            body,
            save,
            status,
        });
    }
    None
}

fn find_named(
    children: &NSArray<AnyObject>,
    role: &str,
    name: &str,
) -> Option<Retained<AnyObject>> {
    for index in 0..children.count() {
        let child = children.objectAtIndex(index);
        if role_of(&child).as_deref() == Some(role)
            && (title_of(&child).as_deref() == Some(name)
                || value_of(&child).as_deref() == Some(name))
        {
            return Some(child);
        }
        if let Some(grandchildren) = accessibility_children(&*child) {
            if let Some(found) = find_named(&grandchildren, role, name) {
                return Some(found);
            }
        }
    }
    None
}

fn accessibility_children<T>(element: &T) -> Option<Retained<NSArray<AnyObject>>>
where
    T: objc2::Message + ?Sized,
{
    unsafe { msg_send![element, accessibilityChildren] }
}

fn role_of(element: &AnyObject) -> Option<String> {
    let role: Option<Retained<NSString>> = unsafe { msg_send![element, accessibilityRole] };
    role.map(|value| value.to_string())
}

fn title_of(element: &AnyObject) -> Option<String> {
    let title: Option<Retained<NSString>> = unsafe { msg_send![element, accessibilityTitle] };
    title.map(|value| value.to_string())
}

fn value_of(element: &AnyObject) -> Option<String> {
    let value: Option<Retained<AnyObject>> = unsafe { msg_send![element, accessibilityValue] };
    value.and_then(|object| {
        let string: Option<Retained<NSString>> = unsafe { msg_send![&*object, description] };
        string.map(|value| value.to_string())
    })
}

fn title_value_matches(element: &AnyObject, expected: &str) -> bool {
    title_of(element).as_deref() == Some(expected) || value_of(element).as_deref() == Some(expected)
}

fn is_focused(element: &AnyObject) -> bool {
    unsafe { msg_send![element, isAccessibilityFocused] }
}

fn set_value(element: &AnyObject, value: &str) {
    let value = NSString::from_str(value);
    let _: () = unsafe { msg_send![element, setAccessibilityValue: &*value] };
}

#[cfg(test)]
mod tests {
    use super::{action_progress, ActionProgress};

    #[test]
    fn committed_internal_action_waits_for_platform_readback_without_reissuing() {
        assert_eq!(action_progress(false, false), ActionProgress::Request);
        assert_eq!(
            action_progress(true, false),
            ActionProgress::AwaitPlatformReadback
        );
        assert_eq!(action_progress(true, true), ActionProgress::Complete);
    }
}

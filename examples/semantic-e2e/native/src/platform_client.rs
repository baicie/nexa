#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod macos;
#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod windows;

#[cfg(target_os = "macos")]
pub(crate) use macos::Client;
#[cfg(target_os = "windows")]
pub(crate) use windows::Client;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported {
    use super::super::{ClientProgress, SharedState, SmokeState};

    pub(crate) struct Client;

    impl Client {
        pub(crate) fn new(_shared: SharedState) -> Self {
            Self
        }

        pub(crate) fn drive(&mut self, _state: &SmokeState) -> ClientProgress {
            ClientProgress::Failed(
                "real accessibility smoke is supported only on macOS and Windows".to_owned(),
            )
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) use unsupported::Client;

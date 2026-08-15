//! Perry FFI for Nexa System Host (ADR-005 Slice 12).

mod dialog;
mod errors;
mod permissions;
mod result;
mod task_runtime;

pub use errors::{task_registry_nexa_error, worker_failure_nexa_error};
pub use permissions::{
    ManifestPermissionInstallError, PermissionInstallError, SystemHostPermissions,
};
pub use result::{catch_command_result_json, command_result_json};

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use nui_app_runtime::{
    OwnerId, Scheduler, TaskHandle, DEFAULT_WORKER_COUNT, DEFAULT_WORK_QUEUE_CAPACITY,
};
use nui_system_core::{
    clipboard_read_text, clipboard_write_text, internal_failure, invalid_argument,
    permission_denied, platform_failure, AppManifest, CommandId, DialogError, PermissionSource,
};
use perry_ffi::{alloc_string, read_string, JsPromise, JsString, Promise, StringHeader};
use serde_json::{json, Value};

#[cfg(test)]
use dialog::parse_request_with_current_dir;
use dialog::system_dialog_backend;
use task_runtime::SystemTaskRuntime;

fn permissions() -> &'static SystemHostPermissions {
    static PERMISSIONS: OnceLock<SystemHostPermissions> = OnceLock::new();
    PERMISSIONS.get_or_init(SystemHostPermissions::default)
}

mod embedded_manifest {
    include!(concat!(env!("OUT_DIR"), "/embedded_app_manifest.rs"));
}

fn install_embedded_app_manifest() -> Result<(), String> {
    static RESULT: OnceLock<Result<(), String>> = OnceLock::new();
    RESULT
        .get_or_init(|| {
            let Some(bytes) = embedded_manifest::EMBEDDED_APP_MANIFEST else {
                return Ok(());
            };
            permissions()
                .install_release_bytes(bytes)
                .map_err(|error| error.to_string())
        })
        .clone()
}

type RuntimeWakeCallback = extern "C" fn();

fn runtime_wakeup() -> &'static Mutex<Option<RuntimeWakeCallback>> {
    static CALLBACK: OnceLock<Mutex<Option<RuntimeWakeCallback>>> = OnceLock::new();
    CALLBACK.get_or_init(|| Mutex::new(None))
}

fn request_runtime_wakeup() {
    let callback = *runtime_wakeup()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(callback) = callback {
        callback();
    }
}

struct SystemRuntimeHost {
    owner: Option<OwnerId>,
    tasks: SystemTaskRuntime<JsPromise>,
}

// `NexaError` is the stable value type returned by System protocol commands.
#[allow(clippy::result_large_err)]
impl SystemRuntimeHost {
    fn new() -> Result<Self, nui_system_core::protocol::common::NexaError> {
        let tasks = SystemTaskRuntime::with_config(
            DEFAULT_WORKER_COUNT,
            DEFAULT_WORK_QUEUE_CAPACITY,
            request_runtime_wakeup,
        )
        .map_err(|error| {
            internal_failure(
                "initializeSystemRuntime",
                "System worker pool can be created",
                "composition",
                format!("worker runtime initialization failed: {error:?}"),
                None,
            )
        })?;
        Ok(Self { owner: None, tasks })
    }

    fn active_owner(
        &self,
        operation: &str,
    ) -> Result<OwnerId, nui_system_core::protocol::common::NexaError> {
        self.owner.ok_or_else(|| {
            invalid_argument(
                operation,
                "owner",
                "an active NuiHost window owner",
                "no active owner",
            )
        })
    }
}

fn system_runtime() -> &'static Mutex<Option<SystemRuntimeHost>> {
    static RUNTIME: OnceLock<Mutex<Option<SystemRuntimeHost>>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(None))
}

#[allow(clippy::result_large_err)]
fn with_system_runtime<T>(
    operation: &str,
    body: impl FnOnce(
        &mut SystemRuntimeHost,
        OwnerId,
    ) -> Result<T, nui_system_core::protocol::common::NexaError>,
) -> Result<T, nui_system_core::protocol::common::NexaError> {
    let mut runtime = system_runtime()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let runtime = runtime.as_mut().ok_or_else(|| {
        invalid_argument(
            operation,
            "runtime",
            "an initialized NuiHost system runtime",
            "not initialized",
        )
    })?;
    let owner = runtime.active_owner(operation)?;
    body(runtime, owner)
}

#[allow(clippy::result_large_err)]
fn require_command(
    operation: &str,
    command: CommandId,
) -> Result<(), nui_system_core::protocol::common::NexaError> {
    permissions()
        .require_command(command)
        .map_err(|denied| permission_denied(operation, &denied, PermissionSource::Manifest))
}

fn handle_json(handle: nui_system_core::protocol::common::HandleRef) -> Value {
    json!({ "slot": handle.slot, "generation": handle.generation })
}

#[allow(clippy::result_large_err)]
fn dialog_request(
    operation: &str,
    title: String,
    default_path: String,
    filters_json: String,
) -> Result<nui_system_core::DialogRequest, nui_system_core::protocol::common::NexaError> {
    dialog_request_result(
        operation,
        dialog::parse_request(title, default_path, filters_json),
    )
}

#[cfg(test)]
#[allow(clippy::result_large_err)]
fn dialog_request_with_current_dir(
    operation: &str,
    title: String,
    default_path: String,
    filters_json: String,
    current_dir: impl FnOnce() -> std::io::Result<PathBuf>,
) -> Result<nui_system_core::DialogRequest, nui_system_core::protocol::common::NexaError> {
    dialog_request_result(
        operation,
        parse_request_with_current_dir(title, default_path, filters_json, current_dir),
    )
}

#[allow(clippy::result_large_err)]
fn dialog_request_result(
    operation: &str,
    result: Result<nui_system_core::DialogRequest, DialogError>,
) -> Result<nui_system_core::DialogRequest, nui_system_core::protocol::common::NexaError> {
    result.map_err(|error| dialog_error_nexa_error(operation, error))
}

fn dialog_error_nexa_error(
    operation: &str,
    error: DialogError,
) -> nui_system_core::protocol::common::NexaError {
    match error {
        DialogError::InvalidRequest(message) => {
            nui_system_core::invalid_data(operation, "dialog-request", &message)
        }
        DialogError::PlatformFailure(message) => {
            platform_failure(operation, std::env::consts::OS, None, message, None)
        }
    }
}

/// Install or replace the process-level event-loop wake callback. The
/// callback must be thread-safe because worker completions invoke it.
#[no_mangle]
pub extern "C" fn nexa_system_set_runtime_wakeup_v1(callback: Option<RuntimeWakeCallback>) {
    *runtime_wakeup()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = callback;
}

/// Activate the System owner used by typed commands for the current window.
#[no_mangle]
pub extern "C" fn nexa_system_begin_owner_v1(owner: u64) -> i32 {
    std::panic::catch_unwind(|| {
        if owner == 0 {
            return -1;
        }
        if install_embedded_app_manifest().is_err() {
            return -1;
        }
        let owner = OwnerId::from_raw(owner);
        let mut runtime = system_runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if runtime.is_none() {
            *runtime = match SystemRuntimeHost::new() {
                Ok(runtime) => Some(runtime),
                Err(_) => return -1,
            };
        }
        let runtime = runtime.as_mut().expect("runtime initialized above");
        if let Some(previous) = runtime.owner {
            if previous != owner {
                let _ = runtime.tasks.invalidate_owner(previous);
            }
        }
        runtime.owner = Some(owner);
        0
    })
    .unwrap_or(-1)
}

/// Install the owner terminal fence and remove every pending awaiter.
#[no_mangle]
pub extern "C" fn nexa_system_end_owner_v1(owner: u64) -> i32 {
    std::panic::catch_unwind(|| {
        let owner = OwnerId::from_raw(owner);
        let mut runtime = system_runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(runtime) = runtime.as_mut() else {
            return 0;
        };
        if runtime.owner != Some(owner) {
            return -1;
        }
        if runtime.tasks.invalidate_owner(owner).is_err() {
            return -1;
        }
        runtime.owner = None;
        0
    })
    .unwrap_or(-1)
}

/// Drain worker results while the composition scheduler proves that the
/// current phase is `SystemCompletion`, then resolve Perry promises on this
/// UI thread.
///
/// # Safety
/// `scheduler` must point to the live Scheduler passed to the runtime hook.
#[no_mangle]
pub unsafe extern "C" fn nexa_system_drain_completions_v1(scheduler: *const Scheduler) -> i32 {
    if scheduler.is_null() {
        return -1;
    }
    let drained = std::panic::catch_unwind(|| {
        let scheduler = unsafe { &*scheduler };
        let mut runtime = system_runtime()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(runtime) = runtime.as_mut() else {
            return Ok(Vec::new());
        };
        runtime.tasks.drain_completions(scheduler)
    });
    let resolutions = match drained {
        Ok(Ok(resolutions)) => resolutions,
        Ok(Err(_)) | Err(_) => return -1,
    };
    let count = resolutions.len();
    for resolution in resolutions {
        resolution.awaiter.resolve_string(&resolution.encoded);
    }
    i32::try_from(count).unwrap_or(i32::MAX)
}

/// Install validated app permissions from the trusted Rust launcher exactly once.
pub fn install_app_manifest(manifest: &AppManifest) -> Result<(), PermissionInstallError> {
    permissions().install(manifest)
}

/// Read clipboard text. Returns empty string on denial / empty / error.
///
/// # Safety
/// Return value is a Perry `StringHeader` pointer.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_clipboard_read_text() -> *mut StringHeader {
    if permissions()
        .require_command(CommandId::ClipboardReadText)
        .is_err()
    {
        return alloc_string("").as_raw();
    }

    match clipboard_read_text() {
        Ok(text) => alloc_string(&text).as_raw(),
        Err(_) => alloc_string("").as_raw(),
    }
}

/// Write clipboard text. Returns `0` on success, `-1` on failure / denial.
///
/// # Safety
/// `text_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_clipboard_write_text(text_ptr: *const StringHeader) -> i32 {
    if permissions()
        .require_command(CommandId::ClipboardWriteText)
        .is_err()
    {
        return -1;
    }

    let handle = JsString::from_raw(text_ptr as *mut StringHeader);
    let text = read_string(handle).unwrap_or("");
    match clipboard_write_text(text) {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

/// Start an asynchronous clipboard text read and return a Task HandleRef
/// result envelope.
///
/// # Safety
/// This function has no pointer arguments and returns an owned Perry string.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_clipboard_read_text_v1() -> *mut StringHeader {
    let encoded = catch_command_result_json("clipboardReadText", || {
        require_command("clipboardReadText", CommandId::ClipboardReadText)?;
        with_system_runtime("clipboardReadText", |runtime, owner| {
            runtime.tasks.spawn_clipboard_read(owner).map(handle_json)
        })
    });
    alloc_string(&encoded).as_raw()
}

/// Start an asynchronous clipboard text write and return a Task HandleRef
/// result envelope.
///
/// # Safety
/// `text_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_clipboard_write_text_v1(
    text_ptr: *const StringHeader,
) -> *mut StringHeader {
    let text = read_ffi_string(text_ptr);
    let encoded = catch_command_result_json("clipboardWriteText", || {
        require_command("clipboardWriteText", CommandId::ClipboardWriteText)?;
        with_system_runtime("clipboardWriteText", |runtime, owner| {
            runtime
                .tasks
                .spawn_clipboard_write(owner, text)
                .map(handle_json)
        })
    });
    alloc_string(&encoded).as_raw()
}

/// Start a UTF-8 text read and return a Task HandleRef result envelope.
///
/// # Safety
/// `path_ptr` must be null or a Perry-runtime `StringHeader`.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_read_text_file_v1(
    path_ptr: *const StringHeader,
) -> *mut StringHeader {
    let path = {
        let handle = JsString::from_raw(path_ptr as *mut StringHeader);
        read_string(handle).unwrap_or("").to_owned()
    };
    let encoded = catch_command_result_json("readTextFile", || {
        require_command("readTextFile", CommandId::ReadTextFile)?;
        with_system_runtime("readTextFile", |runtime, owner| {
            runtime
                .tasks
                .spawn_read(owner, PathBuf::from(path))
                .map(handle_json)
        })
    });
    alloc_string(&encoded).as_raw()
}

/// Start an atomic UTF-8 text write and return a Task HandleRef result
/// envelope.
///
/// # Safety
/// Both pointers must be null or Perry-runtime `StringHeader` values.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_write_text_file_v1(
    path_ptr: *const StringHeader,
    text_ptr: *const StringHeader,
) -> *mut StringHeader {
    let path = {
        let handle = JsString::from_raw(path_ptr as *mut StringHeader);
        read_string(handle).unwrap_or("").to_owned()
    };
    let text = {
        let handle = JsString::from_raw(text_ptr as *mut StringHeader);
        read_string(handle).unwrap_or("").to_owned()
    };
    let encoded = catch_command_result_json("writeTextFile", || {
        require_command("writeTextFile", CommandId::WriteTextFile)?;
        with_system_runtime("writeTextFile", |runtime, owner| {
            runtime
                .tasks
                .spawn_write(owner, PathBuf::from(path), text)
                .map(handle_json)
        })
    });
    alloc_string(&encoded).as_raw()
}

/// Start an asynchronous native open-file dialog.
///
/// # Safety
/// All pointers must be null or Perry-runtime `StringHeader` values.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_open_file_dialog_v1(
    title_ptr: *const StringHeader,
    default_path_ptr: *const StringHeader,
    filters_ptr: *const StringHeader,
) -> *mut StringHeader {
    let title = read_ffi_string(title_ptr);
    let default_path = read_ffi_string(default_path_ptr);
    let filters_json = read_ffi_string(filters_ptr);
    let encoded = catch_command_result_json("openFileDialog", || {
        require_command("openFileDialog", CommandId::OpenFileDialog)?;
        let request = dialog_request("openFileDialog", title, default_path, filters_json)?;
        with_system_runtime("openFileDialog", |runtime, owner| {
            runtime
                .tasks
                .spawn_open(owner, request, system_dialog_backend())
                .map(handle_json)
        })
    });
    alloc_string(&encoded).as_raw()
}

/// Start an asynchronous native save-file dialog.
///
/// # Safety
/// All pointers must be null or Perry-runtime `StringHeader` values.
#[no_mangle]
pub unsafe extern "C" fn js_nexa_save_file_dialog_v1(
    title_ptr: *const StringHeader,
    default_path_ptr: *const StringHeader,
    filters_ptr: *const StringHeader,
) -> *mut StringHeader {
    let title = read_ffi_string(title_ptr);
    let default_path = read_ffi_string(default_path_ptr);
    let filters_json = read_ffi_string(filters_ptr);
    let encoded = catch_command_result_json("saveFileDialog", || {
        require_command("saveFileDialog", CommandId::SaveFileDialog)?;
        let request = dialog_request("saveFileDialog", title, default_path, filters_json)?;
        with_system_runtime("saveFileDialog", |runtime, owner| {
            runtime
                .tasks
                .spawn_save(owner, request, system_dialog_backend())
                .map(handle_json)
        })
    });
    alloc_string(&encoded).as_raw()
}

unsafe fn read_ffi_string(pointer: *const StringHeader) -> String {
    let handle = JsString::from_raw(pointer as *mut StringHeader);
    read_string(handle).unwrap_or("").to_owned()
}

/// Register the single Perry awaiter associated with a typed Task object.
#[no_mangle]
pub extern "C" fn js_nexa_await_task_v1(slot: u32, generation: u32) -> *mut Promise {
    let promise = JsPromise::new();
    let raw = promise.as_raw();
    let task = TaskHandle::new(slot, generation);
    let registration = with_system_runtime("awaitTask", move |runtime, owner| {
        runtime.tasks.register_awaiter(owner, task, promise);
        Ok(())
    });
    if registration.is_ok() {
        request_runtime_wakeup();
    }
    // A missing runtime/owner is a terminal fence: there is no valid
    // SystemCompletion boundary left at which this Promise may settle.
    raw
}

/// Cooperatively cancel a Task. A write that already won its commit boundary
/// remains active and this command succeeds as an idempotent no-op.
#[no_mangle]
pub extern "C" fn js_nexa_cancel_task_v1(slot: u32, generation: u32) -> *mut StringHeader {
    let task = TaskHandle::new(slot, generation);
    let encoded = catch_command_result_json("cancelTask", || {
        with_system_runtime("cancelTask", |runtime, owner| {
            runtime.tasks.cancel(owner, task).map(|_| Value::Null)
        })
    });
    alloc_string(&encoded).as_raw()
}

#[cfg(test)]
mod tests {
    use std::io;

    use nui_system_core::protocol::system::ErrorCode;

    use super::dialog_request_with_current_dir;

    #[test]
    fn dialog_platform_failure_survives_the_ffi_error_boundary() {
        let error = dialog_request_with_current_dir(
            "openFileDialog",
            String::new(),
            "notes.txt".to_owned(),
            "[]".to_owned(),
            || {
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "working directory removed",
                ))
            },
        )
        .expect_err("relative dialog paths must surface a platform failure");

        assert_eq!(error.code, ErrorCode::PlatformFailure as u32);
        assert_eq!(error.name, "PLATFORM_FAILURE");
        assert!(error.message.contains("working directory removed"));
    }

    #[test]
    fn dialog_invalid_request_remains_invalid_data_at_the_ffi_boundary() {
        let error = dialog_request_with_current_dir(
            "openFileDialog",
            String::new(),
            String::new(),
            "{\"unexpected\":true}".to_owned(),
            || panic!("invalid requests must not query the current directory"),
        )
        .expect_err("malformed filters must be rejected");

        assert_eq!(error.code, ErrorCode::InvalidData as u32);
        assert_eq!(error.name, "INVALID_DATA");
    }
}

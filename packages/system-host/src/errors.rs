//! Application Runtime failures mapped at the System Host boundary.

use nui_app_runtime::{OwnerId, TaskHandle, TaskRegistryError, WorkerOutcome};
use nui_system_core::protocol::common::{HandleRef, NexaError};
use nui_system_core::protocol::system::TaskKind;
use nui_system_core::{
    cancelled, internal_failure, invalid_argument, invalid_kind, invalid_state, stale_handle,
    wrong_owner,
};

fn handle_ref(handle: TaskHandle) -> HandleRef {
    HandleRef {
        slot: handle.slot(),
        generation: handle.generation(),
    }
}

#[must_use]
pub fn task_registry_nexa_error(
    failure: TaskRegistryError,
    operation: &str,
    handle: TaskHandle,
) -> NexaError {
    let wire_handle = handle_ref(handle);
    match failure {
        TaskRegistryError::InvalidHandle => invalid_argument(
            operation,
            "task",
            "HandleRef with generation >= 1",
            &format!("{}/{}", handle.slot(), handle.generation()),
        ),
        TaskRegistryError::InvalidKind { expected, actual } => {
            invalid_kind(operation, expected, actual, wire_handle)
        }
        TaskRegistryError::StaleHandle => stale_handle(operation, wire_handle, None),
        TaskRegistryError::WrongOwner { expected, actual } => {
            wrong_owner(operation, expected.raw(), actual.raw(), wire_handle)
        }
        TaskRegistryError::InvalidState { state } => {
            invalid_state(operation, &format!("{state:?}"), wire_handle)
        }
    }
}

#[must_use]
pub fn worker_failure_nexa_error<R>(
    outcome: &WorkerOutcome<R>,
    operation: &str,
    owner: OwnerId,
    task_kind: TaskKind,
) -> Option<NexaError> {
    match outcome {
        WorkerOutcome::Completed(_) => None,
        WorkerOutcome::Cancelled => Some(cancelled(
            operation,
            "cooperativeCancellation",
            owner.raw(),
            task_kind,
        )),
        WorkerOutcome::Panicked(message) => Some(internal_failure(
            operation,
            "worker operation does not panic",
            "worker",
            message.clone(),
            None,
        )),
    }
}

#[cfg(test)]
mod tests {
    use nui_app_runtime::{
        HandleKind, OwnerId, TaskHandle, TaskRegistryError, TaskState, WorkerOutcome,
    };
    use nui_system_core::protocol::system::{ErrorCode, TaskKind};

    use super::{task_registry_nexa_error, worker_failure_nexa_error};

    const HANDLE: TaskHandle = TaskHandle::new(7, 11);

    #[test]
    fn registry_failures_map_to_distinct_stable_system_errors() {
        let cases = [
            (TaskRegistryError::InvalidHandle, ErrorCode::InvalidArgument),
            (
                TaskRegistryError::InvalidKind {
                    expected: HandleKind::Task,
                    actual: HandleKind::NativeResource,
                },
                ErrorCode::InvalidKind,
            ),
            (TaskRegistryError::StaleHandle, ErrorCode::StaleHandle),
            (
                TaskRegistryError::WrongOwner {
                    expected: OwnerId::from_raw(41),
                    actual: OwnerId::from_raw(42),
                },
                ErrorCode::WrongOwner,
            ),
            (
                TaskRegistryError::InvalidState {
                    state: TaskState::Closed,
                },
                ErrorCode::InvalidState,
            ),
        ];

        for (failure, expected) in cases {
            let error = task_registry_nexa_error(failure, "cancelTask", HANDLE);
            assert_eq!(error.domain, "system");
            assert_eq!(error.code, expected as u32);
            let context = error.context.expect("registry error context");
            if failure != TaskRegistryError::InvalidHandle {
                assert_eq!(
                    context["slot"],
                    nui_system_core::protocol::common::ErrorContextValue::U32(7)
                );
                assert_eq!(
                    context["generation"],
                    nui_system_core::protocol::common::ErrorContextValue::U32(11)
                );
            }
        }
    }

    #[test]
    fn cancellation_and_worker_panic_remain_distinct_diagnostics() {
        let cancelled = worker_failure_nexa_error(
            &WorkerOutcome::<()>::Cancelled,
            "readTextFile",
            OwnerId::from_raw(41),
            TaskKind::ClipboardReadText,
        )
        .expect("cancelled outcome is an error");
        let panicked = worker_failure_nexa_error(
            &WorkerOutcome::<()>::Panicked("worker boom".to_owned()),
            "readTextFile",
            OwnerId::from_raw(41),
            TaskKind::ClipboardReadText,
        )
        .expect("panicked outcome is an error");

        assert_eq!(cancelled.code, ErrorCode::Cancelled as u32);
        assert_eq!(panicked.code, ErrorCode::InternalFailure as u32);
        assert!(worker_failure_nexa_error(
            &WorkerOutcome::Completed(()),
            "readTextFile",
            OwnerId::from_raw(41),
            TaskKind::ClipboardReadText,
        )
        .is_none());
    }
}

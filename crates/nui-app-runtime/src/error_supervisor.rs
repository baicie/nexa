//! Process-scoped structured error routing for the application runtime.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

use nui_core::protocol::common::{ErrorSeverity, NexaError};

pub const DEFAULT_ERROR_HISTORY_LIMIT: usize = 64;

/// Runtime action associated with one stable protocol severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorDisposition {
    RejectOperation,
    Continue,
    DropFrame,
    StopRuntime,
}

impl From<ErrorSeverity> for ErrorDisposition {
    fn from(severity: ErrorSeverity) -> Self {
        match severity {
            ErrorSeverity::ProtocolViolation => Self::RejectOperation,
            ErrorSeverity::RecoverableOperation => Self::Continue,
            ErrorSeverity::FrameFailure => Self::DropFrame,
            ErrorSeverity::FatalRuntime => Self::StopRuntime,
        }
    }
}

/// Monotonic process-runtime counters exposed to diagnostics and future tools.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ErrorCounts {
    pub protocol_violations: u64,
    pub recoverable_operations: u64,
    pub frame_failures: u64,
    pub fatal_runtime: u64,
}

impl ErrorCounts {
    fn increment(&mut self, severity: ErrorSeverity) {
        let counter = match severity {
            ErrorSeverity::ProtocolViolation => &mut self.protocol_violations,
            ErrorSeverity::RecoverableOperation => &mut self.recoverable_operations,
            ErrorSeverity::FrameFailure => &mut self.frame_failures,
            ErrorSeverity::FatalRuntime => &mut self.fatal_runtime,
        };
        *counter = counter.saturating_add(1);
    }
}

/// Native diagnostic or Dispatcher-enqueue handler.
///
/// This sink must not synchronously call a Perry/Framework callback. An
/// application handler is enqueued here and runs in `FrameworkMicrotasks`.
pub type ErrorSink = Arc<dyn Fn(&NexaError) + Send + Sync + 'static>;

struct ErrorSupervisorInner {
    history_limit: usize,
    history: VecDeque<NexaError>,
    counts: ErrorCounts,
    fatal_error: Option<NexaError>,
    sink: Option<ErrorSink>,
}

/// Cloneable process-runtime error observer and fatal-state latch.
#[derive(Clone)]
pub struct ErrorSupervisor {
    inner: Arc<Mutex<ErrorSupervisorInner>>,
}

impl std::fmt::Debug for ErrorSupervisor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ErrorSupervisor")
            .field("history_limit", &self.history_limit())
            .field("counts", &self.counts())
            .field("should_stop", &self.should_stop())
            .finish_non_exhaustive()
    }
}

impl Default for ErrorSupervisor {
    fn default() -> Self {
        Self::with_history_limit(DEFAULT_ERROR_HISTORY_LIMIT)
    }
}

impl ErrorSupervisor {
    #[must_use]
    pub fn with_history_limit(history_limit: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ErrorSupervisorInner {
                history_limit,
                history: VecDeque::with_capacity(history_limit),
                counts: ErrorCounts::default(),
                fatal_error: None,
                sink: None,
            })),
        }
    }

    /// Store and route one structured error. The sink is invoked after the
    /// internal lock is released so it may safely inspect this supervisor.
    pub fn report(&self, error: NexaError) -> ErrorDisposition {
        let disposition = ErrorDisposition::from(error.severity);
        let sink = {
            let mut inner = self.inner.lock().expect("error supervisor");
            inner.counts.increment(error.severity);
            if error.severity == ErrorSeverity::FatalRuntime && inner.fatal_error.is_none() {
                inner.fatal_error = Some(error.clone());
            }
            if inner.history_limit > 0 {
                if inner.history.len() == inner.history_limit {
                    inner.history.pop_front();
                }
                inner.history.push_back(error.clone());
            }
            inner.sink.clone()
        };

        if let Some(sink) = sink {
            let _ = catch_unwind(AssertUnwindSafe(|| sink(&error)));
        }
        disposition
    }

    pub fn set_sink(&self, sink: Option<ErrorSink>) {
        self.inner.lock().expect("error supervisor").sink = sink;
    }

    #[must_use]
    pub fn history(&self) -> Vec<NexaError> {
        self.inner
            .lock()
            .expect("error supervisor")
            .history
            .iter()
            .cloned()
            .collect()
    }

    #[must_use]
    pub fn history_limit(&self) -> usize {
        self.inner.lock().expect("error supervisor").history_limit
    }

    #[must_use]
    pub fn counts(&self) -> ErrorCounts {
        self.inner.lock().expect("error supervisor").counts
    }

    #[must_use]
    pub fn fatal_error(&self) -> Option<NexaError> {
        self.inner
            .lock()
            .expect("error supervisor")
            .fatal_error
            .clone()
    }

    #[must_use]
    pub fn should_stop(&self) -> bool {
        self.inner
            .lock()
            .expect("error supervisor")
            .fatal_error
            .is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use nui_core::protocol::common::{ErrorSeverity, NexaError};

    use super::{ErrorDisposition, ErrorSink, ErrorSupervisor};

    fn error(severity: ErrorSeverity, operation: &str) -> NexaError {
        NexaError {
            domain: "ui".to_owned(),
            code: 0x0100_0009,
            name: "INTERNAL_FAILURE".to_owned(),
            severity,
            operation: operation.to_owned(),
            retryable: false,
            message: format!("{operation} failed"),
            runtime_version: "0.1.0-test".to_owned(),
            context: None,
            platform_code: None,
            cause: None,
        }
    }

    #[test]
    fn routes_each_severity_and_counts_every_report() {
        let supervisor = ErrorSupervisor::with_history_limit(8);

        assert_eq!(
            supervisor.report(error(ErrorSeverity::ProtocolViolation, "decode")),
            ErrorDisposition::RejectOperation
        );
        assert_eq!(
            supervisor.report(error(ErrorSeverity::RecoverableOperation, "clipboard")),
            ErrorDisposition::Continue
        );
        assert_eq!(
            supervisor.report(error(ErrorSeverity::FrameFailure, "present")),
            ErrorDisposition::DropFrame
        );
        assert_eq!(
            supervisor.report(error(ErrorSeverity::FatalRuntime, "eventLoop")),
            ErrorDisposition::StopRuntime
        );

        let counts = supervisor.counts();
        assert_eq!(counts.protocol_violations, 1);
        assert_eq!(counts.recoverable_operations, 1);
        assert_eq!(counts.frame_failures, 1);
        assert_eq!(counts.fatal_runtime, 1);
    }

    #[test]
    fn retains_only_the_newest_errors_in_report_order() {
        let supervisor = ErrorSupervisor::with_history_limit(2);

        supervisor.report(error(ErrorSeverity::RecoverableOperation, "first"));
        supervisor.report(error(ErrorSeverity::RecoverableOperation, "second"));
        supervisor.report(error(ErrorSeverity::RecoverableOperation, "third"));

        let operations: Vec<_> = supervisor
            .history()
            .into_iter()
            .map(|error| error.operation)
            .collect();
        assert_eq!(operations, ["second", "third"]);
    }

    #[test]
    fn notifies_the_sink_in_fifo_order_outside_the_internal_lock() {
        let supervisor = ErrorSupervisor::with_history_limit(4);
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_by_sink = Arc::clone(&observed);
        let supervisor_by_sink = supervisor.clone();
        let sink: ErrorSink = Arc::new(move |error: &NexaError| {
            // This would deadlock if the supervisor invoked the sink while locked.
            let history_len = supervisor_by_sink.history().len();
            observed_by_sink
                .lock()
                .expect("observed errors")
                .push((error.operation.clone(), history_len));
        });
        supervisor.set_sink(Some(sink));

        supervisor.report(error(ErrorSeverity::ProtocolViolation, "decode"));
        supervisor.report(error(ErrorSeverity::FrameFailure, "paint"));

        assert_eq!(
            *observed.lock().expect("observed errors"),
            [("decode".to_owned(), 1), ("paint".to_owned(), 2)]
        );
    }

    #[test]
    fn latches_the_first_fatal_error_without_overwriting_it() {
        let supervisor = ErrorSupervisor::default();

        assert!(!supervisor.should_stop());
        supervisor.report(error(ErrorSeverity::FatalRuntime, "firstFatal"));
        supervisor.report(error(ErrorSeverity::FatalRuntime, "secondFatal"));

        assert!(supervisor.should_stop());
        assert_eq!(
            supervisor
                .fatal_error()
                .expect("fatal error is latched")
                .operation,
            "firstFatal"
        );
    }

    #[test]
    fn contains_a_panicking_top_level_sink() {
        let supervisor = ErrorSupervisor::default();
        let sink: ErrorSink = Arc::new(|_: &NexaError| panic!("handler panic"));
        supervisor.set_sink(Some(sink));

        let disposition = supervisor.report(error(
            ErrorSeverity::RecoverableOperation,
            "topLevelHandler",
        ));

        assert_eq!(disposition, ErrorDisposition::Continue);
        assert_eq!(supervisor.history().len(), 1);
    }
}

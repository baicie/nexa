use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use nui_app_runtime::{
    FrameCounts, FrameDropStage, FrameDurations, FrameMetrics, FrameMetricsObserver, FrameOutcome,
};

pub(crate) const PERFORMANCE_EVENT_PREFIX: &str = "NEXA_PERFORMANCE_EVENT ";
const CAPTURE_ENVIRONMENT: &str = "NEXA_PERFORMANCE_CAPTURE_V1";
const FRAME_TARGET_ENVIRONMENT: &str = "NEXA_PERFORMANCE_FRAME_TARGET";
const MAX_FRAME_TARGET: u64 = 1_000;

type PerformanceEmitter = Arc<dyn Fn(String) + Send + Sync + 'static>;

#[derive(Clone)]
pub(crate) struct PerformanceCapture {
    target: u64,
    presented: Arc<AtomicU64>,
    emitter: PerformanceEmitter,
}

impl PerformanceCapture {
    pub(crate) fn from_environment() -> Result<Option<Self>, String> {
        let capture = environment_value(CAPTURE_ENVIRONMENT)?;
        if capture.is_none() {
            return Ok(None);
        }
        let target = environment_value(FRAME_TARGET_ENVIRONMENT)?;
        Self::from_values(capture.as_deref(), target.as_deref())
    }

    fn from_values(capture: Option<&str>, target: Option<&str>) -> Result<Option<Self>, String> {
        let Some(capture) = capture else {
            return Ok(None);
        };
        if capture != "1" {
            return Err(format!(
                "{CAPTURE_ENVIRONMENT} must be exactly 1 when present"
            ));
        }
        let target = target
            .ok_or_else(|| {
                format!("{FRAME_TARGET_ENVIRONMENT} is required when capture is enabled")
            })?
            .parse::<u64>()
            .map_err(|_| format!("{FRAME_TARGET_ENVIRONMENT} must be an integer"))?;
        if !(1..=MAX_FRAME_TARGET).contains(&target) {
            return Err(format!(
                "{FRAME_TARGET_ENVIRONMENT} must be between 1 and {MAX_FRAME_TARGET}"
            ));
        }

        Ok(Some(Self::with_emitter(target, emit_stdout)))
    }

    fn with_emitter(target: u64, emitter: impl Fn(String) + Send + Sync + 'static) -> Self {
        Self {
            target,
            presented: Arc::new(AtomicU64::new(0)),
            emitter: Arc::new(emitter),
        }
    }

    pub(crate) fn install(&self, observer: &FrameMetricsObserver) {
        let capture = self.clone();
        observer.set_sink(Some(Arc::new(move |metrics| capture.observe(metrics))));
    }

    fn observe(&self, metrics: &FrameMetrics) {
        (self.emitter)(format!(
            "{PERFORMANCE_EVENT_PREFIX}{}",
            frame_event_json(metrics)
        ));
        if metrics.outcome == FrameOutcome::Presented {
            self.presented.fetch_add(1, Ordering::Release);
        }
    }

    pub(crate) fn needs_redraw(&self) -> bool {
        self.presented.load(Ordering::Acquire) < self.target
    }
}

fn environment_value(name: &str) -> Result<Option<String>, String> {
    std::env::var_os(name)
        .map(|value| {
            value
                .into_string()
                .map_err(|_| format!("{name} must contain valid Unicode"))
        })
        .transpose()
}

fn emit_stdout(line: String) {
    let mut stdout = std::io::stdout().lock();
    if writeln!(stdout, "{line}")
        .and_then(|()| stdout.flush())
        .is_err()
    {
        eprintln!("nui performance capture could not write a native event");
    }
}

fn decimal(value: u64) -> String {
    value.to_string()
}

fn optional_decimal(value: Option<u64>) -> Option<String> {
    value.map(decimal)
}

fn duration_decimal(value: std::time::Duration) -> String {
    value.as_nanos().to_string()
}

fn outcome_fields(outcome: FrameOutcome) -> (&'static str, Option<&'static str>) {
    match outcome {
        FrameOutcome::NoPresentRequested => ("noPresentRequested", None),
        FrameOutcome::Coalesced => ("coalesced", None),
        FrameOutcome::Presented => ("presented", None),
        FrameOutcome::Dropped(stage) => (
            "dropped",
            Some(match stage {
                FrameDropStage::Acquire => "acquire",
                FrameDropStage::Layout => "layout",
                FrameDropStage::Semantics => "semantics",
                FrameDropStage::DisplayList => "displayList",
                FrameDropStage::Paint => "paint",
                FrameDropStage::Present => "present",
                FrameDropStage::Surface => "surface",
            }),
        ),
    }
}

fn counts_json(counts: FrameCounts) -> serde_json::Value {
    serde_json::json!({
        "dispatchedEvents": decimal(counts.dispatched_events),
        "mutationCommands": decimal(counts.mutation_commands),
        "commitAttempts": decimal(counts.commit_attempts),
        "commits": decimal(counts.commits),
        "layoutAttempts": decimal(counts.layout_attempts),
        "layoutNodes": decimal(counts.layout_nodes),
        "semanticAttempts": decimal(counts.semantic_attempts),
        "semanticDiffs": decimal(counts.semantic_diffs),
        "displayListAttempts": decimal(counts.display_list_attempts),
        "displayCommands": decimal(counts.display_commands),
        "paintAttempts": decimal(counts.paint_attempts),
        "presentAttempts": decimal(counts.present_attempts),
        "successfulPresents": decimal(counts.successful_presents),
        "droppedFrames": decimal(counts.dropped_frames),
    })
}

fn durations_json(durations: FrameDurations) -> serde_json::Value {
    serde_json::json!({
        "platformEvents": duration_decimal(durations.platform_events),
        "systemCompletion": duration_decimal(durations.system_completion),
        "frameworkMicrotasks": duration_decimal(durations.framework_microtasks),
        "stateEffects": duration_decimal(durations.state_effects),
        "hostMutationCommit": duration_decimal(durations.host_mutation_commit),
        "layout": duration_decimal(durations.layout),
        "semantics": duration_decimal(durations.semantics),
        "displayList": duration_decimal(durations.display_list),
        "paint": duration_decimal(durations.paint),
        "present": duration_decimal(durations.present),
        "deferredCleanup": duration_decimal(durations.deferred_cleanup),
    })
}

fn frame_event_json(metrics: &FrameMetrics) -> String {
    let (outcome, drop_stage) = outcome_fields(metrics.outcome);
    serde_json::json!({
        "schemaVersion": 1,
        "kind": "frame",
        "outcome": outcome,
        "dropStage": drop_stage,
        "sessionId": optional_decimal(metrics.session_id),
        "tickId": optional_decimal(metrics.tick_id),
        "frameId": optional_decimal(metrics.frame_id),
        "surfaceGeneration": metrics.surface_generation.map(|generation| decimal(generation.get())),
        "counts": counts_json(metrics.counts),
        "durationsNs": durations_json(metrics.durations),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use nui_app_runtime::{
        FrameCounts, FrameDropStage, FrameDurations, FrameMetrics, FrameMetricsObserver,
        FrameOutcome,
    };

    use super::{frame_event_json, PerformanceCapture, PERFORMANCE_EVENT_PREFIX};

    fn metrics(outcome: FrameOutcome) -> FrameMetrics {
        FrameMetrics {
            session_id: Some(u64::MAX),
            tick_id: Some(7),
            frame_id: Some(11),
            surface_generation: Some(nui_core::SurfaceGeneration::new(3)),
            outcome,
            counts: FrameCounts {
                layout_nodes: 13,
                successful_presents: u64::from(matches!(outcome, FrameOutcome::Presented)),
                dropped_frames: u64::from(matches!(outcome, FrameOutcome::Dropped(_))),
                ..FrameCounts::default()
            },
            durations: FrameDurations {
                platform_events: Duration::from_nanos(2),
                layout: Duration::from_nanos(3),
                paint: Duration::from_nanos(5),
                present: Duration::from_nanos(7),
                ..FrameDurations::default()
            },
        }
    }

    #[test]
    fn performance_capture_configuration_is_opt_in_and_bounded() {
        assert!(PerformanceCapture::from_values(None, Some("invalid"))
            .expect("disabled capture ignores unrelated values")
            .is_none());
        assert!(PerformanceCapture::from_values(Some("0"), Some("10")).is_err());
        assert!(PerformanceCapture::from_values(Some("1"), None).is_err());
        assert!(PerformanceCapture::from_values(Some("1"), Some("0")).is_err());
        assert!(PerformanceCapture::from_values(Some("1"), Some("1001")).is_err());

        let capture = PerformanceCapture::from_values(Some("1"), Some("10"))
            .expect("valid capture")
            .expect("enabled capture");
        assert!(capture.needs_redraw());
    }

    #[test]
    fn native_frame_event_preserves_raw_identifiers_counts_and_durations() {
        let line = frame_event_json(&metrics(FrameOutcome::Dropped(FrameDropStage::Paint)));
        let event: serde_json::Value =
            serde_json::from_str(&line).expect("native frame event JSON");

        assert_eq!(event["schemaVersion"], 1);
        assert_eq!(event["kind"], "frame");
        assert_eq!(event["outcome"], "dropped");
        assert_eq!(event["dropStage"], "paint");
        assert_eq!(event["sessionId"], u64::MAX.to_string());
        assert_eq!(event["tickId"], "7");
        assert_eq!(event["frameId"], "11");
        assert_eq!(event["surfaceGeneration"], "3");
        assert_eq!(event["counts"]["layoutNodes"], "13");
        assert_eq!(event["counts"]["droppedFrames"], "1");
        assert_eq!(event["durationsNs"]["platformEvents"], "2");
        assert_eq!(event["durationsNs"]["layout"], "3");
        assert_eq!(event["durationsNs"]["paint"], "5");
        assert_eq!(event["durationsNs"]["present"], "7");
        assert!(PERFORMANCE_EVENT_PREFIX.ends_with(' '));
    }

    #[test]
    fn capture_emits_every_record_and_stops_driving_after_present_target() {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&lines);
        let capture = PerformanceCapture::with_emitter(2, move |line| {
            observed.lock().expect("captured event lines").push(line);
        });
        let observer = FrameMetricsObserver::default();
        capture.install(&observer);

        observer.publish(metrics(FrameOutcome::NoPresentRequested));
        observer.publish(metrics(FrameOutcome::Presented));
        assert!(capture.needs_redraw());
        observer.publish(metrics(FrameOutcome::Presented));

        assert!(!capture.needs_redraw());
        let lines = lines.lock().expect("captured event lines");
        assert_eq!(lines.len(), 3);
        assert!(lines
            .iter()
            .all(|line| line.starts_with(PERFORMANCE_EVENT_PREFIX)));
    }
}

//! Runtime frame counters, timings, and diagnostic observation.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nui_core::SurfaceGeneration;

use crate::frame_clock::{FrameClock, FrameInstant};

pub const DEFAULT_FRAME_METRICS_HISTORY_LIMIT: usize = 64;

/// Actual unit of frame work. A phase is counted only when its operation is
/// started; walking an otherwise empty Scheduler phase does not record work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FramePhase {
    PlatformEvents,
    SystemCompletion,
    FrameworkMicrotasks,
    StateEffects,
    HostMutationCommit,
    Layout,
    Semantics,
    DisplayList,
    Paint,
    Present,
    DeferredCleanup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FrameDropStage {
    Acquire,
    Layout,
    Semantics,
    DisplayList,
    Paint,
    Present,
    Surface,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FrameOutcome {
    NoPresentRequested,
    Coalesced,
    Presented,
    Dropped(FrameDropStage),
}

/// Counts for one logical tick/frame record.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameCounts {
    pub dispatched_events: u64,
    pub mutation_commands: u64,
    pub commit_attempts: u64,
    pub commits: u64,
    pub layout_attempts: u64,
    pub layout_nodes: u64,
    pub semantic_attempts: u64,
    pub semantic_diffs: u64,
    pub display_list_attempts: u64,
    pub display_commands: u64,
    pub paint_attempts: u64,
    pub present_attempts: u64,
    pub successful_presents: u64,
    pub dropped_frames: u64,
}

impl FrameCounts {
    fn add_assign(&mut self, other: Self) {
        self.dispatched_events = self
            .dispatched_events
            .saturating_add(other.dispatched_events);
        self.mutation_commands = self
            .mutation_commands
            .saturating_add(other.mutation_commands);
        self.commit_attempts = self.commit_attempts.saturating_add(other.commit_attempts);
        self.commits = self.commits.saturating_add(other.commits);
        self.layout_attempts = self.layout_attempts.saturating_add(other.layout_attempts);
        self.layout_nodes = self.layout_nodes.saturating_add(other.layout_nodes);
        self.semantic_attempts = self
            .semantic_attempts
            .saturating_add(other.semantic_attempts);
        self.semantic_diffs = self.semantic_diffs.saturating_add(other.semantic_diffs);
        self.display_list_attempts = self
            .display_list_attempts
            .saturating_add(other.display_list_attempts);
        self.display_commands = self.display_commands.saturating_add(other.display_commands);
        self.paint_attempts = self.paint_attempts.saturating_add(other.paint_attempts);
        self.present_attempts = self.present_attempts.saturating_add(other.present_attempts);
        self.successful_presents = self
            .successful_presents
            .saturating_add(other.successful_presents);
        self.dropped_frames = self.dropped_frames.saturating_add(other.dropped_frames);
    }
}

/// Accumulated time spent in actual operations for one record.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameDurations {
    pub platform_events: Duration,
    pub system_completion: Duration,
    pub framework_microtasks: Duration,
    pub state_effects: Duration,
    pub host_mutation_commit: Duration,
    pub layout: Duration,
    pub semantics: Duration,
    pub display_list: Duration,
    pub paint: Duration,
    pub present: Duration,
    pub deferred_cleanup: Duration,
}

impl FrameDurations {
    fn add(&mut self, phase: FramePhase, elapsed: Duration) {
        let duration = match phase {
            FramePhase::PlatformEvents => &mut self.platform_events,
            FramePhase::SystemCompletion => &mut self.system_completion,
            FramePhase::FrameworkMicrotasks => &mut self.framework_microtasks,
            FramePhase::StateEffects => &mut self.state_effects,
            FramePhase::HostMutationCommit => &mut self.host_mutation_commit,
            FramePhase::Layout => &mut self.layout,
            FramePhase::Semantics => &mut self.semantics,
            FramePhase::DisplayList => &mut self.display_list,
            FramePhase::Paint => &mut self.paint,
            FramePhase::Present => &mut self.present,
            FramePhase::DeferredCleanup => &mut self.deferred_cleanup,
        };
        *duration = duration.saturating_add(elapsed);
    }

    fn add_assign(&mut self, other: Self) {
        self.platform_events = self.platform_events.saturating_add(other.platform_events);
        self.system_completion = self
            .system_completion
            .saturating_add(other.system_completion);
        self.framework_microtasks = self
            .framework_microtasks
            .saturating_add(other.framework_microtasks);
        self.state_effects = self.state_effects.saturating_add(other.state_effects);
        self.host_mutation_commit = self
            .host_mutation_commit
            .saturating_add(other.host_mutation_commit);
        self.layout = self.layout.saturating_add(other.layout);
        self.semantics = self.semantics.saturating_add(other.semantics);
        self.display_list = self.display_list.saturating_add(other.display_list);
        self.paint = self.paint.saturating_add(other.paint);
        self.present = self.present.saturating_add(other.present);
        self.deferred_cleanup = self.deferred_cleanup.saturating_add(other.deferred_cleanup);
    }
}

/// Lifetime aggregates retained independently from the bounded record history.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameMetricsTotals {
    pub records: u64,
    pub counts: FrameCounts,
    pub durations: FrameDurations,
}

impl FrameMetricsTotals {
    fn add_assign(&mut self, metrics: &FrameMetrics) {
        self.records = self.records.saturating_add(1);
        self.counts.add_assign(metrics.counts);
        self.durations.add_assign(metrics.durations);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameMetrics {
    pub session_id: Option<u64>,
    pub tick_id: Option<u64>,
    pub frame_id: Option<u64>,
    pub surface_generation: Option<SurfaceGeneration>,
    pub outcome: FrameOutcome,
    pub counts: FrameCounts,
    pub durations: FrameDurations,
}

pub type FrameMetricsSink = Arc<dyn Fn(&FrameMetrics) + Send + Sync + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameMetricsRecorderError {
    PhaseAlreadyActive {
        active: FramePhase,
        requested: FramePhase,
    },
    NoActivePhase,
    PhaseMismatch {
        active: FramePhase,
        requested: FramePhase,
    },
    PresentedWhilePhaseActive(FramePhase),
    PresentedWithoutAttempt,
}

impl std::fmt::Display for FrameMetricsRecorderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "invalid frame metrics recorder transition: {self:?}"
        )
    }
}

impl std::error::Error for FrameMetricsRecorderError {}

/// Mutable metrics for one logical tick/frame. It may be retained between the
/// tick, paint, and platform-present callbacks.
pub struct FrameMetricsRecorder {
    clock: Arc<dyn FrameClock>,
    session_id: Option<u64>,
    tick_id: Option<u64>,
    frame_id: Option<u64>,
    surface_generation: Option<SurfaceGeneration>,
    counts: FrameCounts,
    durations: FrameDurations,
    active_phase: Option<(FramePhase, FrameInstant)>,
}

impl std::fmt::Debug for FrameMetricsRecorder {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FrameMetricsRecorder")
            .field("session_id", &self.session_id)
            .field("tick_id", &self.tick_id)
            .field("frame_id", &self.frame_id)
            .field("surface_generation", &self.surface_generation)
            .field("counts", &self.counts)
            .field("durations", &self.durations)
            .field("active_phase", &self.active_phase)
            .finish_non_exhaustive()
    }
}

impl FrameMetricsRecorder {
    #[must_use]
    pub fn new(clock: Arc<dyn FrameClock>) -> Self {
        Self {
            clock,
            session_id: None,
            tick_id: None,
            frame_id: None,
            surface_generation: None,
            counts: FrameCounts::default(),
            durations: FrameDurations::default(),
            active_phase: None,
        }
    }

    pub fn set_session_id(&mut self, session_id: u64) {
        self.session_id = Some(session_id);
    }

    pub fn set_tick_id(&mut self, tick_id: u64) {
        self.tick_id = Some(tick_id);
    }

    pub fn set_frame_id(&mut self, frame_id: u64) {
        self.frame_id = Some(frame_id);
    }

    pub fn set_surface_generation(&mut self, generation: SurfaceGeneration) {
        self.surface_generation = Some(generation);
    }

    #[must_use]
    pub const fn counts(&self) -> FrameCounts {
        self.counts
    }

    #[must_use]
    pub const fn durations(&self) -> FrameDurations {
        self.durations
    }

    pub fn record_dispatched_events(&mut self, count: u64) {
        self.counts.dispatched_events = self.counts.dispatched_events.saturating_add(count);
    }

    pub fn record_rejected_commit(&mut self) {
        self.counts.commit_attempts = self.counts.commit_attempts.saturating_add(1);
    }

    pub fn record_commit(&mut self, command_count: u64) {
        self.counts.commit_attempts = self.counts.commit_attempts.saturating_add(1);
        self.counts.commits = self.counts.commits.saturating_add(1);
        self.counts.mutation_commands = self.counts.mutation_commands.saturating_add(command_count);
    }

    /// Add commit observations collected outside the recorder's owner lock.
    pub fn record_commit_activity(&mut self, attempts: u64, commits: u64, mutation_commands: u64) {
        self.counts.commit_attempts = self.counts.commit_attempts.saturating_add(attempts);
        self.counts.commits = self.counts.commits.saturating_add(commits);
        self.counts.mutation_commands = self
            .counts
            .mutation_commands
            .saturating_add(mutation_commands);
    }

    pub fn record_layout_nodes(&mut self, node_count: u64) {
        self.counts.layout_nodes = self.counts.layout_nodes.saturating_add(node_count);
    }

    pub fn record_semantic_diffs(&mut self, diff_count: u64) {
        self.counts.semantic_diffs = self.counts.semantic_diffs.saturating_add(diff_count);
    }

    pub fn record_display_commands(&mut self, command_count: u64) {
        self.counts.display_commands = self.counts.display_commands.saturating_add(command_count);
    }

    pub fn begin_phase(&mut self, phase: FramePhase) -> Result<(), FrameMetricsRecorderError> {
        if let Some((active, _)) = self.active_phase {
            return Err(FrameMetricsRecorderError::PhaseAlreadyActive {
                active,
                requested: phase,
            });
        }
        match phase {
            FramePhase::Layout => {
                self.counts.layout_attempts = self.counts.layout_attempts.saturating_add(1);
            }
            FramePhase::Semantics => {
                self.counts.semantic_attempts = self.counts.semantic_attempts.saturating_add(1);
            }
            FramePhase::DisplayList => {
                self.counts.display_list_attempts =
                    self.counts.display_list_attempts.saturating_add(1);
            }
            FramePhase::Paint => {
                self.counts.paint_attempts = self.counts.paint_attempts.saturating_add(1);
            }
            FramePhase::Present => {
                self.counts.present_attempts = self.counts.present_attempts.saturating_add(1);
            }
            FramePhase::PlatformEvents
            | FramePhase::SystemCompletion
            | FramePhase::FrameworkMicrotasks
            | FramePhase::StateEffects
            | FramePhase::HostMutationCommit
            | FramePhase::DeferredCleanup => {}
        }
        self.active_phase = Some((phase, self.clock.now()));
        Ok(())
    }

    pub fn end_phase(&mut self, phase: FramePhase) -> Result<Duration, FrameMetricsRecorderError> {
        let Some((active, started)) = self.active_phase else {
            return Err(FrameMetricsRecorderError::NoActivePhase);
        };
        if active != phase {
            return Err(FrameMetricsRecorderError::PhaseMismatch {
                active,
                requested: phase,
            });
        }
        self.active_phase = None;
        let elapsed = self.clock.now().duration_since(started);
        self.durations.add(phase, elapsed);
        Ok(elapsed)
    }

    fn finish_active_phase(&mut self) -> Option<FramePhase> {
        let (phase, started) = self.active_phase.take()?;
        self.durations
            .add(phase, self.clock.now().duration_since(started));
        Some(phase)
    }

    fn finish(mut self, outcome: FrameOutcome) -> FrameMetrics {
        self.finish_active_phase();
        FrameMetrics {
            session_id: self.session_id,
            tick_id: self.tick_id,
            frame_id: self.frame_id,
            surface_generation: self.surface_generation,
            outcome,
            counts: self.counts,
            durations: self.durations,
        }
    }

    pub fn finish_presented(mut self) -> Result<FrameMetrics, FrameMetricsRecorderError> {
        if let Some((phase, _)) = self.active_phase {
            if phase != FramePhase::Present {
                return Err(FrameMetricsRecorderError::PresentedWhilePhaseActive(phase));
            }
            self.finish_active_phase();
        }
        if self.counts.present_attempts == 0 {
            return Err(FrameMetricsRecorderError::PresentedWithoutAttempt);
        }
        self.counts.successful_presents = 1;
        Ok(self.finish(FrameOutcome::Presented))
    }

    #[must_use]
    pub fn finish_dropped(mut self, stage: FrameDropStage) -> FrameMetrics {
        self.counts.successful_presents = 0;
        self.counts.dropped_frames = 1;
        self.finish(FrameOutcome::Dropped(stage))
    }

    #[must_use]
    pub fn finish_coalesced(mut self) -> FrameMetrics {
        self.counts.successful_presents = 0;
        self.counts.dropped_frames = 0;
        self.finish(FrameOutcome::Coalesced)
    }

    #[must_use]
    pub fn finish_no_present(mut self) -> FrameMetrics {
        self.counts.successful_presents = 0;
        self.counts.dropped_frames = 0;
        self.finish(FrameOutcome::NoPresentRequested)
    }
}

struct FrameMetricsObserverInner {
    history_limit: usize,
    history: VecDeque<FrameMetrics>,
    totals: FrameMetricsTotals,
    sink: Option<FrameMetricsSink>,
}

/// Cloneable bounded observer for native diagnostics and future Inspector
/// consumers.
#[derive(Clone)]
pub struct FrameMetricsObserver {
    inner: Arc<Mutex<FrameMetricsObserverInner>>,
}

impl std::fmt::Debug for FrameMetricsObserver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FrameMetricsObserver")
            .field("history_limit", &self.history_limit())
            .field("totals", &self.totals())
            .finish_non_exhaustive()
    }
}

impl Default for FrameMetricsObserver {
    fn default() -> Self {
        Self::with_history_limit(DEFAULT_FRAME_METRICS_HISTORY_LIMIT)
    }
}

impl FrameMetricsObserver {
    #[must_use]
    pub fn with_history_limit(history_limit: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(FrameMetricsObserverInner {
                history_limit,
                history: VecDeque::with_capacity(history_limit),
                totals: FrameMetricsTotals::default(),
                sink: None,
            })),
        }
    }

    /// Store and route a completed record. The sink runs after the observer
    /// lock is released so it may safely query history or totals.
    pub fn publish(&self, metrics: FrameMetrics) {
        let sink = {
            let mut inner = self.inner.lock().expect("frame metrics observer");
            inner.totals.add_assign(&metrics);
            if inner.history_limit > 0 {
                if inner.history.len() == inner.history_limit {
                    inner.history.pop_front();
                }
                inner.history.push_back(metrics.clone());
            }
            inner.sink.clone()
        };

        if let Some(sink) = sink {
            let _ = catch_unwind(AssertUnwindSafe(|| sink(&metrics)));
        }
    }

    #[must_use]
    pub fn history_limit(&self) -> usize {
        self.inner
            .lock()
            .expect("frame metrics observer")
            .history_limit
    }

    #[must_use]
    pub fn history(&self) -> Vec<FrameMetrics> {
        self.inner
            .lock()
            .expect("frame metrics observer")
            .history
            .iter()
            .cloned()
            .collect()
    }

    #[must_use]
    pub fn totals(&self) -> FrameMetricsTotals {
        self.inner.lock().expect("frame metrics observer").totals
    }

    pub fn set_sink(&self, sink: Option<FrameMetricsSink>) {
        self.inner.lock().expect("frame metrics observer").sink = sink;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use crate::ManualFrameClock;

    use super::{
        FrameDropStage, FrameMetricsObserver, FrameMetricsRecorder, FrameMetricsSink, FrameOutcome,
        FramePhase,
    };

    #[test]
    fn manual_clock_records_exact_real_phase_durations_across_callbacks() {
        let clock = Arc::new(ManualFrameClock::new());
        let mut recorder = FrameMetricsRecorder::new(clock.clone());
        recorder.set_session_id(5);
        recorder.set_tick_id(7);
        recorder.set_frame_id(11);

        recorder.begin_phase(FramePhase::Layout).unwrap();
        clock.advance(Duration::from_nanos(3));
        recorder.end_phase(FramePhase::Layout).unwrap();

        recorder.begin_phase(FramePhase::DisplayList).unwrap();
        clock.advance(Duration::from_nanos(5));
        recorder.end_phase(FramePhase::DisplayList).unwrap();
        recorder.record_display_commands(13);

        recorder.begin_phase(FramePhase::Paint).unwrap();
        clock.advance(Duration::from_nanos(7));
        recorder.end_phase(FramePhase::Paint).unwrap();

        // Present begins in the platform callback and ends in a later callback.
        recorder.begin_phase(FramePhase::Present).unwrap();
        clock.advance(Duration::from_nanos(11));
        let metrics = recorder.finish_presented().unwrap();

        assert_eq!(metrics.session_id, Some(5));
        assert_eq!(metrics.tick_id, Some(7));
        assert_eq!(metrics.frame_id, Some(11));
        assert_eq!(metrics.outcome, FrameOutcome::Presented);
        assert_eq!(metrics.durations.layout, Duration::from_nanos(3));
        assert_eq!(metrics.durations.display_list, Duration::from_nanos(5));
        assert_eq!(metrics.durations.paint, Duration::from_nanos(7));
        assert_eq!(metrics.durations.present, Duration::from_nanos(11));
        assert_eq!(metrics.counts.layout_attempts, 1);
        assert_eq!(metrics.counts.display_list_attempts, 1);
        assert_eq!(metrics.counts.display_commands, 13);
        assert_eq!(metrics.counts.paint_attempts, 1);
        assert_eq!(metrics.counts.present_attempts, 1);
        assert_eq!(metrics.counts.successful_presents, 1);
        assert_eq!(metrics.counts.dropped_frames, 0);
    }

    #[test]
    fn presented_and_dropped_frames_are_mutually_exclusive() {
        let presented_clock = Arc::new(ManualFrameClock::new());
        let mut presented = FrameMetricsRecorder::new(presented_clock);
        presented.begin_phase(FramePhase::Present).unwrap();
        let presented = presented.finish_presented().unwrap();

        let dropped_clock = Arc::new(ManualFrameClock::new());
        let mut dropped = FrameMetricsRecorder::new(dropped_clock);
        dropped.begin_phase(FramePhase::Paint).unwrap();
        let dropped = dropped.finish_dropped(FrameDropStage::Paint);

        assert_eq!(presented.counts.successful_presents, 1);
        assert_eq!(presented.counts.dropped_frames, 0);
        assert_eq!(dropped.counts.successful_presents, 0);
        assert_eq!(dropped.counts.dropped_frames, 1);
        assert_eq!(
            dropped.outcome,
            FrameOutcome::Dropped(FrameDropStage::Paint)
        );
    }

    #[test]
    fn coalesced_tick_is_not_counted_as_a_dropped_frame() {
        let clock = Arc::new(ManualFrameClock::new());
        let metrics = FrameMetricsRecorder::new(clock).finish_coalesced();

        assert_eq!(metrics.outcome, FrameOutcome::Coalesced);
        assert_eq!(metrics.counts.successful_presents, 0);
        assert_eq!(metrics.counts.dropped_frames, 0);
    }

    #[test]
    fn observer_retains_bounded_fifo_history() {
        let observer = FrameMetricsObserver::with_history_limit(2);
        let clock = Arc::new(ManualFrameClock::new());
        for tick_id in 1..=3 {
            let mut recorder = FrameMetricsRecorder::new(clock.clone());
            recorder.set_tick_id(tick_id);
            observer.publish(recorder.finish_no_present());
        }

        let tick_ids = observer
            .history()
            .into_iter()
            .map(|metrics| metrics.tick_id)
            .collect::<Vec<_>>();
        assert_eq!(tick_ids, [Some(2), Some(3)]);
    }

    #[test]
    fn observer_totals_include_records_evicted_from_history() {
        let observer = FrameMetricsObserver::with_history_limit(1);
        let clock = Arc::new(ManualFrameClock::new());
        for (command_count, elapsed) in [(2, 5), (3, 7)] {
            let mut recorder = FrameMetricsRecorder::new(clock.clone());
            recorder.record_commit(command_count);
            recorder.begin_phase(FramePhase::Layout).unwrap();
            clock.advance(Duration::from_nanos(elapsed));
            recorder.end_phase(FramePhase::Layout).unwrap();
            observer.publish(recorder.finish_no_present());
        }

        assert_eq!(observer.history().len(), 1);
        let totals = observer.totals();
        assert_eq!(totals.records, 2);
        assert_eq!(totals.counts.commit_attempts, 2);
        assert_eq!(totals.counts.commits, 2);
        assert_eq!(totals.counts.mutation_commands, 5);
        assert_eq!(totals.durations.layout, Duration::from_nanos(12));
    }

    #[test]
    fn observer_calls_reentrant_sink_after_releasing_its_lock() {
        let observer = FrameMetricsObserver::with_history_limit(4);
        let observed_lengths = Arc::new(Mutex::new(Vec::new()));
        let observer_from_sink = observer.clone();
        let lengths_from_sink = Arc::clone(&observed_lengths);
        let sink: FrameMetricsSink = Arc::new(move |_| {
            lengths_from_sink
                .lock()
                .expect("observed lengths")
                .push(observer_from_sink.history().len());
        });
        observer.set_sink(Some(sink));

        let clock = Arc::new(ManualFrameClock::new());
        observer.publish(FrameMetricsRecorder::new(clock).finish_no_present());

        assert_eq!(*observed_lengths.lock().expect("observed lengths"), [1]);
    }

    #[test]
    fn observer_contains_sink_panics_and_keeps_recording() {
        let observer = FrameMetricsObserver::with_history_limit(4);
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_from_sink = Arc::clone(&calls);
        observer.set_sink(Some(Arc::new(move |_| {
            calls_from_sink.fetch_add(1, Ordering::SeqCst);
            panic!("metrics sink panic");
        })));

        let clock = Arc::new(ManualFrameClock::new());
        observer.publish(FrameMetricsRecorder::new(clock.clone()).finish_no_present());
        observer.publish(FrameMetricsRecorder::new(clock).finish_coalesced());

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(observer.history().len(), 2);
    }

    #[test]
    fn recorder_counts_commits_without_treating_empty_phases_as_work() {
        let clock = Arc::new(ManualFrameClock::new());
        let mut recorder = FrameMetricsRecorder::new(clock);
        recorder.record_commit_activity(2, 1, 4);
        let metrics = recorder.finish_no_present();

        assert_eq!(metrics.counts.commit_attempts, 2);
        assert_eq!(metrics.counts.commits, 1);
        assert_eq!(metrics.counts.mutation_commands, 4);
        assert_eq!(metrics.counts.layout_attempts, 0);
        assert_eq!(metrics.counts.semantic_attempts, 0);
        assert_eq!(metrics.counts.paint_attempts, 0);
        assert_eq!(metrics.counts.present_attempts, 0);
    }
}

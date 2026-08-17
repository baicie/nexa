//! Bridge-owned frame metrics state spanning tick, paint, and present callbacks.

use std::sync::Arc;

use nui_app_runtime::{
    FrameClock, FrameDropStage, FrameMetricsObserver, FrameMetricsRecorder, FramePhase,
    SystemFrameClock,
};
use nui_core::SurfaceGeneration;

pub(crate) struct FrameMetricsState {
    observer: FrameMetricsObserver,
    clock: Arc<dyn FrameClock>,
    session_id: Option<u64>,
    pending_tick: Option<FrameMetricsRecorder>,
    active_frame: Option<FrameMetricsRecorder>,
    next_tick_id: u64,
    next_frame_id: u64,
    surface_generation: Option<SurfaceGeneration>,
}

impl FrameMetricsState {
    #[cfg(test)]
    pub(crate) fn new(observer: FrameMetricsObserver) -> Self {
        Self::with_clock_and_session(observer, Arc::new(SystemFrameClock::new()), None)
    }

    pub(crate) fn for_session(observer: FrameMetricsObserver, session_id: u64) -> Self {
        Self::with_clock_and_session(
            observer,
            Arc::new(SystemFrameClock::new()),
            Some(session_id),
        )
    }

    #[cfg(test)]
    pub(crate) fn with_clock(observer: FrameMetricsObserver, clock: Arc<dyn FrameClock>) -> Self {
        Self::with_clock_and_session(observer, clock, None)
    }

    fn with_clock_and_session(
        observer: FrameMetricsObserver,
        clock: Arc<dyn FrameClock>,
        session_id: Option<u64>,
    ) -> Self {
        Self {
            observer,
            clock,
            session_id,
            pending_tick: None,
            active_frame: None,
            next_tick_id: 1,
            next_frame_id: 1,
            surface_generation: None,
        }
    }

    pub(crate) fn begin_tick(&mut self) -> FrameMetricsRecorder {
        let mut recorder = FrameMetricsRecorder::new(Arc::clone(&self.clock));
        if let Some(session_id) = self.session_id {
            recorder.set_session_id(session_id);
        }
        recorder.set_tick_id(self.next_tick_id);
        self.next_tick_id = self.next_tick_id.saturating_add(1);
        recorder
    }

    pub(crate) fn finish_tick(&mut self, recorder: FrameMetricsRecorder, redraw: bool) {
        if redraw {
            if let Some(stale) = self.pending_tick.replace(recorder) {
                self.observer.publish(stale.finish_coalesced());
            }
        } else {
            self.observer.publish(recorder.finish_no_present());
        }
    }

    pub(crate) fn begin_frame(&mut self) -> FrameMetricsRecorder {
        let mut recorder = self
            .pending_tick
            .take()
            .unwrap_or_else(|| FrameMetricsRecorder::new(Arc::clone(&self.clock)));
        if let Some(session_id) = self.session_id {
            recorder.set_session_id(session_id);
        }
        recorder.set_frame_id(self.next_frame_id);
        self.next_frame_id = self.next_frame_id.saturating_add(1);
        if let Some(generation) = self.surface_generation {
            recorder.set_surface_generation(generation);
        }
        recorder
    }

    pub(crate) fn retain_for_present(&mut self, recorder: FrameMetricsRecorder) {
        if let Some(stale) = self.active_frame.replace(recorder) {
            self.observer
                .publish(stale.finish_dropped(FrameDropStage::Surface));
        }
    }

    pub(crate) fn publish_dropped(&self, recorder: FrameMetricsRecorder, stage: FrameDropStage) {
        self.observer.publish(recorder.finish_dropped(stage));
    }

    pub(crate) fn publish_acquire_drop(&mut self) {
        let recorder = self.begin_frame();
        self.publish_dropped(recorder, FrameDropStage::Acquire);
    }

    pub(crate) fn set_surface_generation(&mut self, generation: SurfaceGeneration) {
        self.surface_generation = Some(generation);
    }

    pub(crate) fn begin_present(&mut self, generation: SurfaceGeneration) {
        let Some(recorder) = self.active_frame.as_mut() else {
            return;
        };
        recorder.set_surface_generation(generation);
        recorder
            .begin_phase(FramePhase::Present)
            .expect("present begins after paint finishes");
    }

    pub(crate) fn finish_presented(&mut self, generation: SurfaceGeneration) {
        let Some(mut recorder) = self.active_frame.take() else {
            return;
        };
        recorder.set_surface_generation(generation);
        let metrics = recorder
            .finish_presented()
            .expect("presented hook follows a present attempt");
        self.observer.publish(metrics);
    }

    pub(crate) fn finish_present_drop(&mut self) {
        if let Some(recorder) = self.active_frame.take() {
            self.publish_dropped(recorder, FrameDropStage::Present);
        }
    }

    pub(crate) fn finish_session(&mut self) {
        if let Some(recorder) = self.pending_tick.take() {
            self.publish_dropped(recorder, FrameDropStage::Surface);
        }
        if let Some(recorder) = self.active_frame.take() {
            self.publish_dropped(recorder, FrameDropStage::Surface);
        }
    }
}

impl Drop for FrameMetricsState {
    fn drop(&mut self) {
        self.finish_session();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use nui_app_runtime::{FrameDropStage, FrameMetricsObserver, FrameOutcome, ManualFrameClock};
    use nui_core::SurfaceGeneration;

    use super::FrameMetricsState;

    fn state() -> (
        FrameMetricsState,
        FrameMetricsObserver,
        Arc<ManualFrameClock>,
    ) {
        let observer = FrameMetricsObserver::with_history_limit(8);
        let clock = Arc::new(ManualFrameClock::new());
        let state = FrameMetricsState::with_clock(observer.clone(), clock.clone());
        (state, observer, clock)
    }

    #[test]
    fn older_redraw_ticks_are_coalesced_and_latest_tick_owns_the_frame() {
        let (mut state, observer, _) = state();
        let first = state.begin_tick();
        state.finish_tick(first, true);
        let second = state.begin_tick();
        state.finish_tick(second, true);

        let frame = state.begin_frame();
        state.publish_dropped(frame, FrameDropStage::Surface);

        let history = observer.history();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].tick_id, Some(1));
        assert_eq!(history[0].frame_id, None);
        assert_eq!(history[0].outcome, FrameOutcome::Coalesced);
        assert_eq!(history[1].tick_id, Some(2));
        assert_eq!(history[1].frame_id, Some(1));
    }

    #[test]
    fn redraw_ticks_stay_bounded_even_when_no_frame_arrives() {
        let observer = FrameMetricsObserver::with_history_limit(256);
        let clock = Arc::new(ManualFrameClock::new());
        let mut state = FrameMetricsState::with_clock(observer.clone(), clock);
        for _ in 0..128 {
            let tick = state.begin_tick();
            state.finish_tick(tick, true);
        }

        assert!(state.pending_tick.is_some());
        let history = observer.history();
        assert_eq!(history.len(), 127);
        assert!(history
            .iter()
            .all(|metrics| metrics.outcome == FrameOutcome::Coalesced));

        let frame = state.begin_frame();
        state.publish_dropped(frame, FrameDropStage::Surface);
        assert_eq!(
            observer
                .history()
                .last()
                .and_then(|metrics| metrics.tick_id),
            Some(128)
        );
    }

    #[test]
    fn retained_observer_distinguishes_sessions_with_restarted_frame_ids() {
        let observer = FrameMetricsObserver::with_history_limit(4);
        let clock = Arc::new(ManualFrameClock::new());
        for session_id in [11, 12] {
            let mut state = FrameMetricsState::with_clock_and_session(
                observer.clone(),
                clock.clone(),
                Some(session_id),
            );
            let frame = state.begin_frame();
            state.publish_dropped(frame, FrameDropStage::Surface);
        }

        let history = observer.history();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].session_id, Some(11));
        assert_eq!(history[1].session_id, Some(12));
        assert_eq!(history[0].frame_id, Some(1));
        assert_eq!(history[1].frame_id, Some(1));
    }

    #[test]
    fn session_finish_publishes_pending_and_active_records_once() {
        let (mut state, observer, _) = state();
        let active = state.begin_frame();
        state.retain_for_present(active);
        let pending = state.begin_tick();
        state.finish_tick(pending, true);

        state.finish_session();
        state.finish_session();

        let history = observer.history();
        assert_eq!(history.len(), 2);
        assert!(history
            .iter()
            .all(|metrics| { metrics.outcome == FrameOutcome::Dropped(FrameDropStage::Surface) }));
        assert_eq!(history[0].tick_id, Some(1));
        assert_eq!(history[0].frame_id, None);
        assert_eq!(history[1].tick_id, None);
        assert_eq!(history[1].frame_id, Some(1));
    }

    #[test]
    fn no_redraw_tick_is_published_without_a_frame_or_drop() {
        let (mut state, observer, _) = state();
        let tick = state.begin_tick();

        state.finish_tick(tick, false);

        let metrics = observer.history().pop().expect("tick metrics");
        assert_eq!(metrics.outcome, FrameOutcome::NoPresentRequested);
        assert_eq!(metrics.frame_id, None);
        assert_eq!(metrics.counts.dropped_frames, 0);
    }

    #[test]
    fn present_hooks_finish_one_successful_frame_with_exact_duration() {
        let (mut state, observer, clock) = state();
        let generation = SurfaceGeneration::new(3);
        state.set_surface_generation(generation);
        let frame = state.begin_frame();
        state.retain_for_present(frame);

        state.begin_present(generation);
        clock.advance(Duration::from_nanos(9));
        state.finish_presented(generation);
        state.finish_presented(generation);

        let history = observer.history();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].outcome, FrameOutcome::Presented);
        assert_eq!(history[0].durations.present, Duration::from_nanos(9));
        assert_eq!(history[0].counts.present_attempts, 1);
        assert_eq!(history[0].counts.successful_presents, 1);
    }

    #[test]
    fn acquire_drop_consumes_pending_tick_without_counting_a_present_attempt() {
        let (mut state, observer, _) = state();
        let tick = state.begin_tick();
        state.finish_tick(tick, true);

        state.publish_acquire_drop();

        let metrics = observer.history().pop().expect("acquire drop");
        assert_eq!(
            metrics.outcome,
            FrameOutcome::Dropped(FrameDropStage::Acquire)
        );
        assert_eq!(metrics.counts.present_attempts, 0);
        assert_eq!(metrics.counts.dropped_frames, 1);
    }
}

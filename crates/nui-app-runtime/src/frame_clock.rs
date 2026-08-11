//! Monotonic clocks used by frame metrics.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Process-local monotonic timestamp represented as nanoseconds from a clock's
/// private epoch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FrameInstant(u64);

impl FrameInstant {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn from_nanos(nanoseconds: u64) -> Self {
        Self(nanoseconds)
    }

    #[must_use]
    pub const fn as_nanos(self) -> u64 {
        self.0
    }

    /// Return elapsed time without allowing a faulty or reset clock to produce
    /// a negative duration.
    #[must_use]
    pub fn duration_since(self, earlier: Self) -> Duration {
        Duration::from_nanos(self.0.saturating_sub(earlier.0))
    }
}

/// Injectable monotonic time source for frame instrumentation.
pub trait FrameClock: Send + Sync + 'static {
    fn now(&self) -> FrameInstant;
}

/// Production clock whose timestamps are relative to its construction time.
#[derive(Debug)]
pub struct SystemFrameClock {
    epoch: Instant,
}

impl Default for SystemFrameClock {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemFrameClock {
    #[must_use]
    pub fn new() -> Self {
        Self {
            epoch: Instant::now(),
        }
    }
}

impl FrameClock for SystemFrameClock {
    fn now(&self) -> FrameInstant {
        let nanoseconds = self.epoch.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64;
        FrameInstant::from_nanos(nanoseconds)
    }
}

/// Thread-safe deterministic clock advanced explicitly by tests or simulations.
#[derive(Debug, Default)]
pub struct ManualFrameClock {
    nanoseconds: AtomicU64,
}

impl ManualFrameClock {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            nanoseconds: AtomicU64::new(0),
        }
    }

    pub fn set(&self, instant: FrameInstant) {
        self.nanoseconds
            .store(instant.as_nanos(), Ordering::Release);
    }

    /// Advance by `duration`, saturating at the representable timestamp limit.
    pub fn advance(&self, duration: Duration) -> FrameInstant {
        let increment = duration.as_nanos().min(u128::from(u64::MAX)) as u64;
        let previous = self
            .nanoseconds
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                Some(current.saturating_add(increment))
            })
            .expect("manual clock update always returns a value");
        FrameInstant::from_nanos(previous.saturating_add(increment))
    }
}

impl FrameClock for ManualFrameClock {
    fn now(&self) -> FrameInstant {
        FrameInstant::from_nanos(self.nanoseconds.load(Ordering::Acquire))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{FrameClock, FrameInstant, ManualFrameClock};

    #[test]
    fn manual_clock_advances_by_exact_durations() {
        let clock = ManualFrameClock::new();
        assert_eq!(clock.now(), FrameInstant::ZERO);

        clock.set(FrameInstant::from_nanos(7));
        assert_eq!(
            clock.advance(Duration::from_nanos(11)),
            FrameInstant::from_nanos(18)
        );
        assert_eq!(clock.now(), FrameInstant::from_nanos(18));
    }

    #[test]
    fn frame_instant_duration_since_saturates_when_time_moves_backwards() {
        let earlier = FrameInstant::from_nanos(9);
        let later = FrameInstant::from_nanos(4);

        assert_eq!(later.duration_since(earlier), Duration::ZERO);
    }
}

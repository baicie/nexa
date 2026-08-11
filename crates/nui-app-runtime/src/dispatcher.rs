//! Thread-safe event queues for the application tick.
//!
//! Producers may enqueue platform events, system completions, and framework
//! work from different threads. The UI thread calls [`Dispatcher::drain_tick`]
//! once per tick; the returned stream is always grouped in the contract order
//! Platform -> System -> Framework while preserving FIFO order within a queue.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Source queue used to order work at a tick boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DispatchQueue {
    Platform,
    System,
    Framework,
}

/// A queued item with a process-local monotonic sequence for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchItem<T> {
    pub sequence: u64,
    pub queue: DispatchQueue,
    pub payload: T,
}

#[derive(Debug)]
struct Queues<T> {
    next_sequence: u64,
    platform: VecDeque<DispatchItem<T>>,
    system: VecDeque<DispatchItem<T>>,
    framework: VecDeque<DispatchItem<T>>,
}

impl<T> Default for Queues<T> {
    fn default() -> Self {
        Self {
            next_sequence: 1,
            platform: VecDeque::new(),
            system: VecDeque::new(),
            framework: VecDeque::new(),
        }
    }
}

type Wakeup = Arc<dyn Fn() + Send + Sync + 'static>;

/// Dispatcher shared by native producers and the UI thread.
pub struct Dispatcher<T> {
    queues: Arc<Mutex<Queues<T>>>,
    wakeup_requested: Arc<AtomicBool>,
    wakeup: Option<Wakeup>,
}

impl<T> Clone for Dispatcher<T> {
    fn clone(&self) -> Self {
        Self {
            queues: Arc::clone(&self.queues),
            wakeup_requested: Arc::clone(&self.wakeup_requested),
            wakeup: self.wakeup.clone(),
        }
    }
}

impl<T> std::fmt::Debug for Dispatcher<T> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Dispatcher")
            .field("pending", &self.pending_count())
            .field("wakeup_requested", &self.wakeup_requested())
            .finish_non_exhaustive()
    }
}

impl<T> Default for Dispatcher<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Dispatcher<T> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            queues: Arc::new(Mutex::new(Queues::default())),
            wakeup_requested: Arc::new(AtomicBool::new(false)),
            wakeup: None,
        }
    }

    /// Construct a dispatcher that invokes `wakeup` once when transitioning
    /// from idle to pending. The callback is called outside the queue lock.
    #[must_use]
    pub fn with_wakeup(wakeup: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            wakeup: Some(Arc::new(wakeup)),
            ..Self::new()
        }
    }

    /// Enqueue one item and return its monotonic sequence number.
    pub fn enqueue(&self, queue: DispatchQueue, payload: T) -> u64 {
        let mut queues = self.queues.lock().expect("dispatcher queues");
        let sequence = queues.next_sequence;
        queues.next_sequence = queues
            .next_sequence
            .checked_add(1)
            .expect("dispatcher sequence exhausted");
        let item = DispatchItem {
            sequence,
            queue,
            payload,
        };
        match queue {
            DispatchQueue::Platform => queues.platform.push_back(item),
            DispatchQueue::System => queues.system.push_back(item),
            DispatchQueue::Framework => queues.framework.push_back(item),
        }
        drop(queues);

        if !self.wakeup_requested.swap(true, Ordering::AcqRel) {
            if let Some(wakeup) = &self.wakeup {
                wakeup();
            }
        }
        sequence
    }

    /// Drain one ordered tick. Items enqueued after the lock is released are
    /// left for the next tick, preventing unbounded work in one frame.
    pub fn drain_tick(&self) -> Vec<DispatchItem<T>> {
        let mut queues = self.queues.lock().expect("dispatcher queues");
        let capacity = queues.platform.len() + queues.system.len() + queues.framework.len();
        let mut drained = Vec::with_capacity(capacity);
        drained.extend(queues.platform.drain(..));
        drained.extend(queues.system.drain(..));
        drained.extend(queues.framework.drain(..));
        self.wakeup_requested.store(false, Ordering::Release);
        drained
    }

    #[must_use]
    pub fn pending_count(&self) -> usize {
        let queues = self.queues.lock().expect("dispatcher queues");
        queues.platform.len() + queues.system.len() + queues.framework.len()
    }

    #[must_use]
    pub fn wakeup_requested(&self) -> bool {
        self.wakeup_requested.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;

    use super::{DispatchQueue, Dispatcher};

    #[test]
    fn drain_groups_queues_in_tick_order_and_preserves_fifo() {
        let dispatcher = Dispatcher::new();
        dispatcher.enqueue(DispatchQueue::Framework, "framework-1");
        dispatcher.enqueue(DispatchQueue::Platform, "platform-1");
        dispatcher.enqueue(DispatchQueue::Platform, "platform-2");
        dispatcher.enqueue(DispatchQueue::System, "system-1");

        let items = dispatcher.drain_tick();
        let values: Vec<_> = items.into_iter().map(|item| item.payload).collect();
        assert_eq!(
            values,
            ["platform-1", "platform-2", "system-1", "framework-1"]
        );
        assert_eq!(dispatcher.pending_count(), 0);
        assert!(!dispatcher.wakeup_requested());
    }

    #[test]
    fn concurrent_producers_are_lossless_and_sequences_are_unique() {
        let dispatcher = Dispatcher::new();
        let mut workers = Vec::new();
        for worker in 0..4 {
            let dispatcher = dispatcher.clone();
            workers.push(thread::spawn(move || {
                (0..100)
                    .map(|index| {
                        dispatcher.enqueue(
                            if index % 2 == 0 {
                                DispatchQueue::Platform
                            } else {
                                DispatchQueue::System
                            },
                            worker * 100 + index,
                        )
                    })
                    .collect::<Vec<_>>()
            }));
        }
        let mut submitted_sequences = workers
            .into_iter()
            .flat_map(|worker| worker.join().expect("producer"))
            .collect::<Vec<_>>();
        submitted_sequences.sort_unstable();
        submitted_sequences.dedup();
        assert_eq!(submitted_sequences.len(), 400);

        let drained = dispatcher.drain_tick();
        assert_eq!(drained.len(), 400);
        for queue in [DispatchQueue::Platform, DispatchQueue::System] {
            let sequences = drained
                .iter()
                .filter(|item| item.queue == queue)
                .map(|item| item.sequence)
                .collect::<Vec<_>>();
            assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
        }
    }

    #[test]
    fn wakeup_is_coalesced_until_the_tick_is_drained() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let dispatcher = Dispatcher::with_wakeup(move || {
            observed.fetch_add(1, Ordering::SeqCst);
        });
        dispatcher.enqueue(DispatchQueue::Platform, ());
        dispatcher.enqueue(DispatchQueue::Framework, ());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        dispatcher.drain_tick();
        dispatcher.enqueue(DispatchQueue::System, ());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}

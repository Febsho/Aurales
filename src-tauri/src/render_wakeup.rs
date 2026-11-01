//! Coalesces libmpv update callbacks without losing an undrawn frame.
//!
//! GTK may defer a queued draw. An update stays pending until the render
//! callback actually starts, so the frame clock can retry an invalidation.
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub(crate) struct RenderWakeup {
    pending: AtomicBool,
}

impl RenderWakeup {
    pub(crate) fn request(&self) {
        self.pending.store(true, Ordering::Release);
    }

    pub(crate) fn is_pending(&self) -> bool {
        self.pending.load(Ordering::Acquire)
    }

    /// Acknowledge only when a render callback is about to draw. An update
    /// arriving while it draws remains pending for the next frame.
    pub(crate) fn begin_render(&self) {
        self.pending.swap(false, Ordering::AcqRel);
    }

    pub(crate) fn clear(&self) {
        self.pending.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::RenderWakeup;
    use std::sync::{Arc, Barrier};

    #[test]
    fn retries_when_a_queued_draw_is_not_delivered() {
        let wakeup = RenderWakeup::default();
        wakeup.request();
        // Repeated frame-clock ticks only observe the request; neither a
        // queued invalidation nor an occluded/skipped draw acknowledges it.
        for _ in 0..5 {
            assert!(wakeup.is_pending());
        }
        wakeup.begin_render();
        assert!(!wakeup.is_pending());
    }

    #[test]
    fn retains_an_update_arriving_during_render() {
        let wakeup = Arc::new(RenderWakeup::default());
        let barrier = Arc::new(Barrier::new(2));
        wakeup.request();
        wakeup.begin_render();
        let producer = {
            let wakeup = Arc::clone(&wakeup);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                wakeup.request();
                barrier.wait();
            })
        };
        barrier.wait();
        barrier.wait();
        producer.join().unwrap();
        assert!(wakeup.is_pending());
        wakeup.begin_render();
        assert!(!wakeup.is_pending());
    }
}

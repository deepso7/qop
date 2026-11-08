//! Sleep/wake detection for live-auth invalidation (`lifecycle.ts`, `process-lifecycle.ts`).
//!
//! Rune exposes no macOS sleep/wake notification, so, like the CLI, the engine observes two
//! clocks every second: monotonic time ([`std::time::Instant`], which on macOS stops while the
//! machine sleeps) and wall time. A wall-minus-monotonic gap means the machine slept; a large
//! monotonic jump means the engine stalled (or slept with monotonic running); a wall clock that
//! went backwards was stepped. Any of them invalidates every live authorization. Spurious
//! invalidation is harmless: re-authorizing still needs a fresh read at a strictly newer head.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How often the engine observes (`LIFECYCLE_OBSERVE_MS`).
pub const OBSERVE_EVERY: Duration = Duration::from_secs(1);
/// A gap at least this large between observations counts (`stallThresholdMs`).
const STALL_THRESHOLD_MS: i128 = 2000;

/// The two clocks, in milliseconds. Tests drive [`ManualClock`]; the app uses [`SystemClock`].
pub trait Clock: Send + Sync + 'static {
    fn monotonic_ms(&self) -> i128;
    fn wall_ms(&self) -> i128;
}

/// Monotonic time since the clock was made, and Unix wall time.
pub struct SystemClock(Instant);

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock(Instant::now())
    }
}

impl Clock for SystemClock {
    fn monotonic_ms(&self) -> i128 {
        self.0.elapsed().as_millis() as i128
    }

    fn wall_ms(&self) -> i128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i128)
    }
}

/// Watches for clock gaps between observations; `take_invalidation` reports (once) that one
/// happened.
pub struct Lifecycle {
    last_monotonic: i128,
    last_wall: i128,
    pending: bool,
}

impl Lifecycle {
    pub fn new(clock: &dyn Clock) -> Lifecycle {
        Lifecycle {
            last_monotonic: clock.monotonic_ms(),
            last_wall: clock.wall_ms(),
            pending: false,
        }
    }

    /// Records the clocks; a sleep gap, stall or backwards wall step marks an invalidation.
    pub fn observe(&mut self, clock: &dyn Clock) {
        let (monotonic, wall) = (clock.monotonic_ms(), clock.wall_ms());
        let monotonic_delta = monotonic - self.last_monotonic;
        let wall_delta = wall - self.last_wall;
        self.last_monotonic = monotonic;
        self.last_wall = wall;
        let slept = wall_delta - monotonic_delta >= STALL_THRESHOLD_MS;
        let stalled = monotonic_delta >= STALL_THRESHOLD_MS;
        let stepped = wall_delta < 0;
        if slept || stalled || stepped {
            self.pending = true;
        }
    }

    /// A platform wake signal: always invalidates (`markInterrupted`).
    pub fn mark_interrupted(&mut self) {
        self.pending = true;
    }

    /// Observes, then reports and clears whether anything invalidated since the last call.
    pub fn take_invalidation(&mut self, clock: &dyn Clock) -> bool {
        self.observe(clock);
        std::mem::take(&mut self.pending)
    }
}

/// A clock tests set by hand; clones share it.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct ManualClock(std::sync::Arc<std::sync::Mutex<(i128, i128)>>);

#[cfg(test)]
impl ManualClock {
    /// Advances both clocks together (time passing while awake).
    pub fn advance(&self, ms: i128) {
        let mut clocks = self.0.lock().unwrap();
        clocks.0 += ms;
        clocks.1 += ms;
    }

    /// Advances only the wall clock (asleep: monotonic paused).
    pub fn sleep(&self, ms: i128) {
        self.0.lock().unwrap().1 += ms;
    }
}

#[cfg(test)]
impl Clock for ManualClock {
    fn monotonic_ms(&self) -> i128 {
        self.0.lock().unwrap().0
    }

    fn wall_ms(&self) -> i128 {
        self.0.lock().unwrap().1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_observation_never_invalidates() {
        let clock = ManualClock::default();
        let mut lifecycle = Lifecycle::new(&clock);
        for _ in 0..10 {
            clock.advance(1000);
            assert!(!lifecycle.take_invalidation(&clock));
        }
    }

    #[test]
    fn sleep_stall_and_clock_steps_invalidate_once() {
        let clock = ManualClock::default();
        let mut lifecycle = Lifecycle::new(&clock);

        clock.sleep(60_000);
        assert!(lifecycle.take_invalidation(&clock));
        assert!(!lifecycle.take_invalidation(&clock));

        clock.advance(5_000);
        lifecycle.observe(&clock);
        assert!(lifecycle.take_invalidation(&clock));

        clock.sleep(-10);
        assert!(lifecycle.take_invalidation(&clock));

        lifecycle.mark_interrupted();
        assert!(lifecycle.take_invalidation(&clock));
    }
}

//! Time as a trait, so timing tests can drive a clock by hand.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// Milliseconds on a monotonic clock. Only differences mean anything.
    fn mono_ms(&self) -> i64;
    /// Unix time in milliseconds, from the machine's wall clock.
    fn unix_ms(&self) -> i64;
}

pub struct SystemClock {
    start: Instant,
}

impl SystemClock {
    pub fn new() -> Arc<SystemClock> {
        Arc::new(SystemClock { start: Instant::now() })
    }
}

impl Clock for SystemClock {
    fn mono_ms(&self) -> i64 {
        self.start.elapsed().as_millis() as i64
    }
    fn unix_ms(&self) -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }
}

/// A clock that moves only when a test says so.
pub struct ManualClock {
    mono: AtomicI64,
    unix: AtomicI64,
}

impl ManualClock {
    pub fn new(unix_ms: i64) -> Arc<ManualClock> {
        Arc::new(ManualClock { mono: AtomicI64::new(0), unix: AtomicI64::new(unix_ms) })
    }
    pub fn advance(&self, ms: i64) {
        self.mono.fetch_add(ms, Ordering::SeqCst);
        self.unix.fetch_add(ms, Ordering::SeqCst);
    }
    /// Moves only the wall clock, as a person changing the date would. The monotonic clock stays.
    pub fn set_unix(&self, ms: i64) {
        self.unix.store(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn mono_ms(&self) -> i64 {
        self.mono.load(Ordering::SeqCst)
    }
    fn unix_ms(&self) -> i64 {
        self.unix.load(Ordering::SeqCst)
    }
}

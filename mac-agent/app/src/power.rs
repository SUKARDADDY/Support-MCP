//! Restart and shut down (call 3). A restart is refused while FileVault is on: the Mac would stop at the FileVault
//! unlock screen, before any login and before this service runs, and nobody could reach it until someone types the
//! password there. When FileVault's state cannot be read, a restart is refused too, for the same reason. A shutdown
//! needs someone at the Mac to turn it on again whatever FileVault says, so it is not refused.
//!
//! One action waits at a time, as on Windows: a second is answered `busy` until the first has gone or failed.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const FILEVAULT_ON: &str =
    "filevault_on: this Mac would wait at the FileVault unlock screen after a restart and could not reconnect until someone types the password there";
pub const FILEVAULT_UNKNOWN: &str =
    "filevault_unknown: this Mac could not tell whether FileVault is on, and a restart with FileVault on would leave it unreachable until someone types the password";
pub const BUSY: &str = "busy: a restart or shutdown is already waiting on this Mac; do not repeat it";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileVault {
    On,
    Off,
    Unknown,
}

/// `fdesetup isactive` prints `true` and exits 0 when FileVault is on, prints `false` and exits 1 when it is off.
/// Anything else (an error, a deferred enablement it reports differently) is unknown.
pub fn read_fdesetup(exit_code: Option<i32>, stdout: &str) -> FileVault {
    match (exit_code, stdout.trim()) {
        (Some(0), "true") => FileVault::On,
        (Some(1), "false") => FileVault::Off,
        _ => FileVault::Unknown,
    }
}

/// The refusal for an action, or None to go ahead. `action` is restart or shutdown (the core checked the rest).
pub fn refusal(action: &str, filevault: impl FnOnce() -> FileVault) -> Option<&'static str> {
    match action {
        "restart" => match filevault() {
            FileVault::Off => None,
            FileVault::On => Some(FILEVAULT_ON),
            FileVault::Unknown => Some(FILEVAULT_UNKNOWN),
        },
        "shutdown" => None,
        _ => Some("unknown power action"),
    }
}

/// The latch for one waiting action. It frees itself when the action failed, and a while after it went, since a
/// shutdown that was cancelled afterwards is not reported back.
pub struct PowerLatch {
    pending: AtomicBool,
    generation: AtomicU64,
    pub free_after: Duration,
}

impl PowerLatch {
    pub fn new() -> Arc<PowerLatch> {
        Arc::new(PowerLatch { pending: AtomicBool::new(false), generation: AtomicU64::new(0), free_after: Duration::from_secs(120) })
    }

    /// Takes the latch, or says busy.
    pub fn take(&self) -> Result<u64, &'static str> {
        if self.pending.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err(BUSY);
        }
        Ok(self.generation.fetch_add(1, Ordering::SeqCst) + 1)
    }

    pub fn release(&self, generation: u64) {
        if self.generation.load(Ordering::SeqCst) == generation {
            self.pending.store(false, Ordering::SeqCst);
        }
    }
}

/// Runs `perform` after `delay`, on its own thread, under the latch. Returns the Unix second it will happen at.
pub fn schedule(
    latch: &Arc<PowerLatch>,
    delay_s: i64,
    now_s: i64,
    perform: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<i64, String> {
    let generation = latch.take()?;
    let latch = latch.clone();
    let delay = Duration::from_secs(delay_s.max(0) as u64);
    std::thread::Builder::new()
        .name("support-power".into())
        .spawn(move || {
            std::thread::sleep(delay);
            match perform() {
                // It did not go: a new request may try again.
                Err(_) => latch.release(generation),
                Ok(()) => {
                    std::thread::sleep(latch.free_after);
                    latch.release(generation);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(now_s + delay_s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fdesetup_is_read_strictly() {
        assert_eq!(read_fdesetup(Some(0), "true\n"), FileVault::On);
        assert_eq!(read_fdesetup(Some(1), "false\n"), FileVault::Off);
        assert_eq!(read_fdesetup(Some(0), "false"), FileVault::Unknown);
        assert_eq!(read_fdesetup(Some(1), ""), FileVault::Unknown);
        assert_eq!(read_fdesetup(None, "true"), FileVault::Unknown);
        assert_eq!(read_fdesetup(Some(2), "Error: ..."), FileVault::Unknown);
    }

    #[test]
    fn a_restart_with_filevault_on_or_unknown_is_refused_and_a_shutdown_is_not() {
        assert_eq!(refusal("restart", || FileVault::On), Some(FILEVAULT_ON));
        assert_eq!(refusal("restart", || FileVault::Unknown), Some(FILEVAULT_UNKNOWN));
        assert_eq!(refusal("restart", || FileVault::Off), None);
        assert_eq!(refusal("shutdown", || panic!("not asked for a shutdown")), None);
        assert!(refusal("hibernate", || FileVault::Off).is_some());
        // The pinned text, word for word (research file, section 2.6).
        assert!(FILEVAULT_ON.starts_with("filevault_on: this Mac would wait at the FileVault unlock screen"));
    }

    #[test]
    fn one_action_waits_at_a_time_and_a_failed_one_frees_the_latch() {
        let latch = PowerLatch::new();
        let (tx, rx) = std::sync::mpsc::channel();
        let at = schedule(&latch, 0, 1000, move || {
            tx.send(()).unwrap();
            Err("refused".into())
        })
        .unwrap();
        assert_eq!(at, 1000);
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        // Free again after the failure.
        let g = latch.take().unwrap();
        assert_eq!(schedule(&latch, 5, 0, || Ok(())).unwrap_err(), BUSY);
        latch.release(g);
        assert!(latch.take().is_ok());
    }
}

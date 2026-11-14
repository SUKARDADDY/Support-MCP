//! One cancel signal that blocking code (a command, a file read) and async code (the session loop) can both watch.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tokio::sync::watch;

pub struct Stop {
    state: Mutex<bool>,
    cv: Condvar,
    tx: watch::Sender<bool>,
}

impl Stop {
    pub fn new() -> Arc<Stop> {
        let (tx, _rx) = watch::channel(false);
        Arc::new(Stop { state: Mutex::new(false), cv: Condvar::new(), tx })
    }

    pub fn set(&self) {
        *self.state.lock().unwrap() = true;
        self.cv.notify_all();
        self.tx.send_replace(true);
    }

    pub fn is_set(&self) -> bool {
        *self.state.lock().unwrap()
    }

    /// Blocks the calling thread for up to `d`, and returns true as soon as the signal is set.
    pub fn wait(&self, d: Duration) -> bool {
        let guard = self.state.lock().unwrap();
        let (guard, _) = self.cv.wait_timeout_while(guard, d, |set| !*set).unwrap();
        *guard
    }

    /// Resolves once the signal is set.
    pub async fn stopped(&self) {
        let mut rx = self.tx.subscribe();
        let _ = rx.wait_for(|set| *set).await;
    }
}

//! Runs one command in its own process group with its output capped, a timeout, and the whole group killed at the end.
//! The macOS platform wraps the `Command` (the shell, the user, the working folder). This is the part that does not
//! depend on macOS, so the fake platform and the real one share it.

use crate::stop::Stop;
use crate::wire::OUTPUT_MAX;
use std::io::Read;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// After the first process exits, what is left in its group gets this long to finish by itself before it is stopped.
pub const SETTLE_MS: u64 = 1_000;
const POLL_MS: u64 = 20;
const JOIN_MS: u64 = 5_000;

#[derive(Debug, Default)]
pub struct RunOutput {
    /// None when the command timed out and was killed.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

struct Capture {
    data: Vec<u8>,
    truncated: bool,
}

fn drain(mut pipe: impl Read + Send + 'static, into: Arc<Mutex<Capture>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut c = into.lock().unwrap();
                    let take = n.min(OUTPUT_MAX.saturating_sub(c.data.len()));
                    c.data.extend_from_slice(&buf[..take]);
                    // Keep reading what is left, so the command never blocks on a full pipe, but keep none of it.
                    if take < n {
                        c.truncated = true;
                    }
                }
            }
        }
    })
}

fn kill_group(pid: u32) {
    // SAFETY: kill(2) with a negative pid signals the group we made with process_group(0). No memory is involved.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

fn group_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the group exists.
    unsafe { libc::kill(-(pid as i32), 0) == 0 }
}

/// Runs `cmd` with no input. Output past 65,536 bytes per stream is dropped and flagged. At `timeout` the whole group is
/// killed and `exit_code` is None. When `stop` is set the group is killed and the call fails. After the first process
/// exits, up to `SETTLE_MS` is given to anything it started, then the group is killed.
pub fn run(cmd: &mut Command, timeout: Duration, stop: &Stop) -> Result<RunOutput, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let out = Arc::new(Mutex::new(Capture { data: vec![], truncated: false }));
    let err = Arc::new(Mutex::new(Capture { data: vec![], truncated: false }));
    let readers = [drain(child.stdout.take().ok_or("no stdout")?, out.clone()), drain(child.stderr.take().ok_or("no stderr")?, err.clone())];
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(e) => {
                kill_group(pid);
                return Err(e.to_string());
            }
        }
        if stop.is_set() {
            kill_group(pid);
            let _ = child.wait();
            return Err("stopped".to_string());
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            break None;
        }
        stop.wait(Duration::from_millis(POLL_MS));
    };
    if timed_out {
        kill_group(pid);
        let _ = child.wait();
    } else {
        // Give what the command started up to SETTLE_MS to finish by itself (a program that was only launched), so it
        // is not stopped before it did its work. Then stop the descendants that are still running.
        let settle = Instant::now();
        while settle.elapsed() < Duration::from_millis(SETTLE_MS) && group_alive(pid) && !stop.wait(Duration::from_millis(POLL_MS)) {}
        kill_group(pid);
    }
    let deadline = Instant::now() + Duration::from_millis(JOIN_MS);
    for r in &readers {
        while !r.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let (o, e) = (out.lock().unwrap(), err.lock().unwrap());
    let exit_code = status.and_then(|s| s.code().or_else(|| s.signal().map(|sig| 128 + sig)));
    Ok(RunOutput {
        exit_code: if timed_out { None } else { exit_code },
        timed_out,
        stdout: o.data.clone(),
        stderr: e.data.clone(),
        stdout_truncated: o.truncated,
        stderr_truncated: e.truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str, timeout_ms: u64) -> RunOutput {
        let stop = Stop::new();
        run(Command::new("sh").arg("-c").arg(script), Duration::from_millis(timeout_ms), &stop).unwrap()
    }

    #[test]
    fn output_and_exit_code_come_back() {
        let r = sh("echo hi; echo oops >&2; exit 3", 10_000);
        assert_eq!((r.stdout.as_slice(), r.stderr.as_slice(), r.exit_code, r.timed_out), (&b"hi\n"[..], &b"oops\n"[..], Some(3), false));
        assert!(!r.stdout_truncated && !r.stderr_truncated);
    }

    #[test]
    fn each_stream_is_capped_at_65536_bytes_and_flagged() {
        // 200,000 bytes on stdout, 65,536 exactly on stderr (not truncated), a command that must not block on the pipe.
        let r = sh("head -c 200000 /dev/zero | tr '\\0' a; head -c 65536 /dev/zero | tr '\\0' b >&2", 20_000);
        assert_eq!(r.stdout.len(), OUTPUT_MAX);
        assert!(r.stdout_truncated);
        assert_eq!(r.stderr.len(), OUTPUT_MAX);
        assert!(!r.stderr_truncated);
        assert_eq!(r.exit_code, Some(0));
        let r = sh("head -c 65537 /dev/zero | tr '\\0' b >&2", 20_000);
        assert!(r.stderr_truncated && r.stderr.len() == OUTPUT_MAX);
    }

    #[test]
    fn a_timeout_kills_the_whole_group_and_leaves_no_exit_code() {
        let marker = std::env::temp_dir().join(format!("support-core-exec-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        // A child that would write the marker after 2 s: it must die with the group.
        let script = format!("(sleep 2; echo late > {}) & sleep 30", marker.display());
        let started = Instant::now();
        let r = sh(&script, 300);
        assert!(r.timed_out);
        assert_eq!(r.exit_code, None);
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(2_500));
        assert!(!marker.exists(), "the grandchild survived the timeout");
    }

    #[test]
    fn a_program_that_was_only_launched_gets_a_second_to_finish_then_is_stopped() {
        let marker = std::env::temp_dir().join(format!("support-core-settle-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        // The shell exits at once. One child finishes within the settle window, one would not.
        let script = format!("(sleep 0.3; echo quick > {m}) & (sleep 3; echo slow > {m}.slow) & exit 0", m = marker.display());
        let r = sh(&script, 10_000);
        assert_eq!(r.exit_code, Some(0));
        assert!(marker.exists(), "the quick child had its settle time");
        std::thread::sleep(Duration::from_millis(3_200));
        assert!(!std::path::Path::new(&format!("{}.slow", marker.display())).exists(), "the slow child was stopped");
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn a_stop_signal_ends_the_command() {
        let stop = Stop::new();
        let s2 = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            s2.set();
        });
        let started = Instant::now();
        let r = run(Command::new("sh").arg("-c").arg("sleep 30"), Duration::from_secs(60), &stop);
        assert!(r.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_missing_program_is_an_error_not_a_panic() {
        let stop = Stop::new();
        assert!(run(&mut Command::new("/no/such/program"), Duration::from_secs(1), &stop).is_err());
    }
}

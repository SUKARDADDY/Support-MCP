use super::*;
use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::sync::atomic::AtomicI64;

const A: &str = "1.1.0";

fn timing() -> Timing {
    Timing {
        trial_ms: 200,
        stale_ms: 1_000,
        retry_ms: 3_600_000,
        retry_hello_ms: 30_000,
        decide_before_ms: 90,
        commit_retry_ms: 5_000,
        poll: Duration::from_millis(20),
    }
}

// ---- update.json -------------------------------------------------------------------------------------------------

#[test]
fn update_json_round_trips_and_damage_is_an_empty_state() {
    let mut st = UpdateState::default();
    st.add_failed("1.1.3");
    st.trial =
        Some(Trial { phase: Phase::Rollback, from_version: "1.1.0".into(), version: "1.1.1".into(), deadline: 1_790_000_000_000, started: true });
    st.last_error = Some(LastError { version: "1.1.2".into(), reason: "not signed".into(), at: 5 });
    assert_eq!(UpdateState::parse(&st.to_json()), st);
    let v: Value = serde_json::from_str(&st.to_json()).unwrap();
    assert_eq!(v["trial"]["phase"], "rollback");
    assert_eq!(v["trial"]["deadline"], 1_790_000_000_000i64);

    for damaged in ["", "not json", "[]", "null", "{\"failed\":5}"] {
        assert_eq!(UpdateState::parse(damaged), UpdateState::default(), "{damaged:?}");
    }
    // Only valid versions count as failed; a trial with a bad phase, version or deadline is no trial; started is only true.
    let st = UpdateState::parse(
        r#"{"failed":["1.1.1","nope","",3,"1.1.1"],"trial":{"phase":"maybe","from_version":"1.1.0","version":"1.1.1","deadline":5}}"#,
    );
    assert_eq!(st.failed, vec!["1.1.1".to_string()]);
    assert_eq!(st.trial, None);
    for t in [
        r#"{"phase":"trial","from_version":"x","version":"1.1.1","deadline":5}"#,
        r#"{"phase":"trial","from_version":"1.1.0","version":"1.1","deadline":5}"#,
        r#"{"phase":"trial","from_version":"1.1.0","version":"1.1.1","deadline":"5"}"#,
    ] {
        assert_eq!(UpdateState::parse(&format!("{{\"trial\":{t}}}")).trial, None, "{t}");
    }
    let st = UpdateState::parse(r#"{"trial":{"phase":"trial","from_version":"1.1.0","version":"1.1.1","deadline":5,"started":"yes"}}"#);
    assert!(!st.trial.unwrap().started);
}

#[test]
fn at_most_twenty_failed_versions_are_kept_the_oldest_dropped() {
    let mut st = UpdateState::default();
    for i in 0..25 {
        st.add_failed(&format!("1.2.{i}"));
    }
    st.add_failed("1.2.24");
    assert_eq!(st.failed.len(), FAILED_CAP);
    assert_eq!(st.failed[0], "1.2.5");
    assert_eq!(st.failed.last().unwrap(), "1.2.24");
}

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("support-upd-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn update_json_on_disk_missing_linked_or_unreadable() {
    let d = temp("load");
    assert_eq!(load(&d), Some(UpdateState::default()), "missing: empty");
    let mut st = UpdateState::default();
    st.add_failed("1.1.1");
    save(&d, &st).unwrap();
    assert_eq!(load(&d), Some(st.clone()));
    assert_eq!(fs::metadata(d.join(UPDATE_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
    // A link in its place is never followed: empty, and a save replaces the link, not its target.
    fs::remove_file(d.join(UPDATE_FILE)).unwrap();
    fs::write(d.join("target"), st.to_json()).unwrap();
    std::os::unix::fs::symlink(d.join("target"), d.join(UPDATE_FILE)).unwrap();
    assert_eq!(load(&d), Some(UpdateState::default()));
    save(&d, &UpdateState::default()).unwrap();
    assert_eq!(fs::read_to_string(d.join("target")).unwrap(), st.to_json());
    // Unreadable now: None, so nothing is saved over it.
    if me() != 0 {
        use std::os::unix::fs::PermissionsExt;
        fs::remove_file(d.join(UPDATE_FILE)).unwrap();
        save(&d, &st).unwrap();
        fs::set_permissions(d.join(UPDATE_FILE), fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(load(&d), None);
        fs::set_permissions(d.join(UPDATE_FILE), fs::Permissions::from_mode(0o600)).unwrap();
    }
    fs::remove_dir_all(&d).unwrap();
}

use std::os::unix::fs::PermissionsExt;

// ---- the rules ---------------------------------------------------------------------------------------------------

fn trial(phase: Phase, from: &str, version: &str, deadline: i64) -> UpdateState {
    UpdateState { trial: Some(Trial { phase, from_version: from.into(), version: version.into(), deadline, started: false }), ..Default::default() }
}

#[test]
fn what_a_service_does_at_start_follows_the_record_and_its_own_version() {
    let t = timing();
    let now = 10_000;
    assert_eq!(on_start(&UpdateState::default(), A, now, &t), Start::Normal);
    assert_eq!(on_start(&trial(Phase::Trial, "1.1.0", "1.1.1", now + 100), "1.1.1", now, &t), Start::Trial);
    // The old version runs while its switch's record is open: the switch never finished.
    assert_eq!(on_start(&trial(Phase::Trial, "1.1.0", "1.1.1", now + 100), "1.1.0", now, &t), Start::Interrupted);
    assert_eq!(on_start(&trial(Phase::Rollback, "1.1.0", "1.1.1", now + 100), "1.1.0", now, &t), Start::Interrupted);
    // The new version runs while its rollback was decided: the watcher does it.
    assert_eq!(on_start(&trial(Phase::Rollback, "1.1.0", "1.1.1", now + 100), "1.1.1", now, &t), Start::ResumeRollback);
    // Some other version: wait, then clear once the record is long past its deadline.
    assert_eq!(on_start(&trial(Phase::Trial, "1.0.9", "1.1.1", now), "1.1.5", now + t.stale_ms - 1, &t), Start::Waiting);
    assert_eq!(on_start(&trial(Phase::Trial, "1.0.9", "1.1.1", now), "1.1.5", now + t.stale_ms, &t), Start::Stale);
}

#[test]
fn a_check_in_on_trial_is_healthy_a_retry_or_unhealthy_as_on_windows() {
    use DeviceResult::*;
    assert_eq!(trial_health(Ok, 200), Health::Healthy);
    assert_eq!(trial_health(Pending, 202), Health::Healthy);
    assert_eq!(trial_health(Removed, 401), Health::Healthy, "a removed Mac is not the version's fault");
    assert_eq!(trial_health(Offline, 0), Health::Retry);
    assert_eq!(trial_health(Refused, 500), Health::Retry);
    assert_eq!(trial_health(Refused, 503), Health::Retry);
    assert_eq!(trial_health(UpdateNeeded, 426), Health::Unhealthy);
    assert_eq!(trial_health(Refused, 400), Health::Unhealthy);
    assert_eq!(trial_health(Refused, 403), Health::Unhealthy);
    assert_eq!(trial_health(CodeInvalid, 404), Health::Unhealthy);
}

#[test]
fn the_windows_numbers_are_the_shipped_ones() {
    let w = Timing::windows();
    assert_eq!(
        (w.trial_ms, w.stale_ms, w.retry_ms, w.retry_hello_ms, w.decide_before_ms, w.commit_retry_ms),
        (240_000, 600_000, 3_600_000, 30_000, 90_000, 5_000)
    );
    #[cfg(not(feature = "test-release"))]
    assert_eq!(Timing::built_in(), w);
}

#[test]
fn deciding_and_watching_follow_the_deadline() {
    let t = Timing::windows();
    let deadline = 1_000_000;
    assert!(!decide_now(deadline - 90_001, deadline, &t));
    assert!(decide_now(deadline - 90_000, deadline, &t));
    // The watcher waits a whole trial of its own before it acts, then the deadline counts; after two trials it acts anyway.
    assert!(!watch_due(deadline, deadline + 1, 239_999, &t));
    assert!(watch_due(deadline, deadline, 240_000, &t));
    assert!(!watch_due(deadline, deadline - 1, 240_000, &t));
    assert!(watch_due(i64::MAX, 0, 480_000, &t), "a damaged deadline far away is not waited for");
    // An uninstall waits for a trial, but not for one long past its deadline.
    let st = trial(Phase::Trial, "1.1.0", "1.1.1", deadline);
    assert!(uninstall_busy(&st, deadline + 599_999, &t));
    assert!(!uninstall_busy(&st, deadline + 600_000, &t));
    assert!(!uninstall_busy(&UpdateState::default(), 0, &t));
}

#[test]
fn an_offer_is_taken_only_when_newer_not_failed_idle_and_not_tried_this_hour() {
    let t = Timing::windows();
    let idle = UpdateState::default();
    assert_eq!(take_offer("1.1.1", A, Some(&idle), false, None, 0, &t), Ok(()));
    assert_eq!(take_offer("1.1.1", A, None, false, None, 0, &t), Err(Skip::Unreadable));
    assert_eq!(take_offer("1.1.0", A, Some(&idle), false, None, 0, &t), Err(Skip::NotNewer));
    assert_eq!(take_offer("1.0.9", A, Some(&idle), false, None, 0, &t), Err(Skip::NotNewer));
    assert_eq!(take_offer("1.1.0-rc.1", A, Some(&idle), false, None, 0, &t), Err(Skip::NotNewer));
    assert_eq!(take_offer("1.1.1", A, Some(&idle), true, None, 0, &t), Err(Skip::Busy), "never during a session");
    let mut failed = UpdateState::default();
    failed.add_failed("1.1.1");
    assert_eq!(take_offer("1.1.1", A, Some(&failed), false, None, 0, &t), Err(Skip::Failed));
    assert_eq!(take_offer("1.1.2", A, Some(&failed), false, None, 0, &t), Ok(()));
    assert_eq!(take_offer("1.1.1", A, Some(&trial(Phase::Trial, "1.1.0", "1.1.1", 0)), false, None, 0, &t), Err(Skip::TrialOpen));
    // A release whose download or checks failed waits an hour; another version does not.
    assert_eq!(take_offer("1.1.1", A, Some(&idle), false, Some(("1.1.1", 0)), 3_599_999, &t), Err(Skip::TriedRecently));
    assert_eq!(take_offer("1.1.1", A, Some(&idle), false, Some(("1.1.1", 0)), 3_600_000, &t), Ok(()));
    assert_eq!(take_offer("1.1.2", A, Some(&idle), false, Some(("1.1.1", 0)), 1, &t), Ok(()));
}

#[test]
fn launchctl_print_and_old_copies_are_read_exactly() {
    assert!(running_in("system/io.github.sukardaddy.supportmcp.update = {\n\tactive count = 1\n\tstate = running\n"));
    assert!(!running_in("system/io.github.sukardaddy.supportmcp.update = {\n\tstate = not running\n"));
    assert!(!running_in(""));
    let data = "/Library/Application Support/SupportMCP";
    assert!(old_copy("/Library/Application Support/SupportMCP/previous/Support.app/Contents/MacOS/support", data));
    assert!(old_copy("/Library/Application Support/SupportMCP/staging/update-1/expanded/x/Support.app/Contents/MacOS/support", data));
    assert!(!old_copy("/Applications/Support.app/Contents/MacOS/support", data));
    assert!(!old_copy("/Library/Application Support/SupportMCPX/previous/Support.app/Contents/MacOS/support", data));
    assert!(!old_copy("/Library/Application Support/SupportMCP/previous/Other.app/Contents/MacOS/support", data));
}

#[test]
fn the_watchers_job_runs_the_old_copy_once_as_root() {
    let read = |text: &str| plist::Value::from_reader_xml(text.as_bytes()).unwrap().into_dictionary().unwrap();
    let bin = "/Library/Application Support/SupportMCP/previous/Support.app/Contents/MacOS/support";
    let p = read(&watch_plist(bin, true));
    assert_eq!(p["Label"].as_string(), Some(paths::WATCH_LABEL));
    let args: Vec<_> = p["ProgramArguments"].as_array().unwrap().iter().map(|v| v.as_string().unwrap()).collect();
    assert_eq!(args, vec![bin, "update-watch", "--restart"]);
    assert_eq!(p["RunAtLoad"].as_boolean(), Some(true));
    assert_eq!(p["KeepAlive"].as_boolean(), Some(false));
    assert!(!p.contains_key("UserName"), "root");
    let p = read(&watch_plist(bin, false));
    assert_eq!(p["ProgramArguments"].as_array().unwrap().len(), 2);
    assert_eq!(paths::WATCH_PLIST, format!("/Library/LaunchDaemons/{}.plist", paths::WATCH_LABEL));
}

#[test]
fn the_lock_is_held_by_one_at_a_time() {
    let d = temp("lock");
    let first = lock(&d, Duration::ZERO).unwrap();
    assert!(lock(&d, Duration::from_millis(100)).is_none());
    drop(first);
    assert!(lock(&d, Duration::ZERO).is_some());
    fs::remove_dir_all(&d).unwrap();
}

// ---- the staged app ----------------------------------------------------------------------------------------------

/// Writes a Support.app at `app`: its Info.plist (with `id`) and an executable that holds `signer`, which the fake
/// codesign check reads.
fn make_app(app: &Path, version: &str, id: &str, signer: &str) {
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    fs::write(app.join("Contents/Info.plist"), plists::info_plist(version).replace(paths::BUNDLE_ID, id)).unwrap();
    fs::write(app.join("Contents/MacOS/support"), signer).unwrap();
}

#[test]
fn a_staged_app_must_be_support_at_the_notes_version() {
    let d = temp("app");
    let app = d.join("Support.app");
    make_app(&app, "1.1.1", paths::BUNDLE_ID, "A");
    assert_eq!(app_problem(&app, "1.1.1"), None);
    assert!(app_problem(&app, "1.1.2").unwrap().contains("version"));
    make_app(&app, "1.1.1", "com.example.other", "A");
    assert!(app_problem(&app, "1.1.1").unwrap().contains("not Support"));
    make_app(&app, "1.1.1", paths::BUNDLE_ID, "A");
    std::os::unix::fs::symlink("/etc", app.join("Contents/Resources")).unwrap();
    assert!(app_problem(&app, "1.1.1").unwrap().contains("leads out"));
    fs::remove_file(app.join("Contents/Resources")).unwrap();
    fs::remove_file(app.join("Contents/MacOS/support")).unwrap();
    std::os::unix::fs::symlink("/bin/sh", app.join("Contents/MacOS/support")).unwrap();
    assert!(app_problem(&app, "1.1.1").is_some());
    fs::remove_dir_all(&app).unwrap();
    assert!(app_problem(&app, "1.1.1").is_some(), "no app at all");
    assert_eq!(payload_app(Path::new("/x")), Path::new("/x/Support-component.pkg/Payload/Applications/Support.app"));
    fs::remove_dir_all(&d).unwrap();
}

// ---- the whole update, with a fake macOS -------------------------------------------------------------------------

/// pkgutil, codesign and launchctl, faked: a package is the text "FAKEPKG <version> <signer> <bundle id>"; an app is
/// signed as this one is when its executable says "A".
#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<String>>,
    load_fails: AtomicBool,
    running: AtomicBool,
}

impl Fake {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn count(&self, call: &str) -> usize {
        self.calls().iter().filter(|c| c.as_str() == call).count()
    }
}

impl System for Fake {
    fn expand(&self, pkg: &Path, into: &Path) -> Result<(), String> {
        self.calls.lock().unwrap().push("expand".into());
        let text = fs::read_to_string(pkg).map_err(|e| e.to_string())?;
        let parts: Vec<&str> = text.split_whitespace().collect();
        if parts.len() != 4 || parts[0] != "FAKEPKG" {
            return Err("not a package".into());
        }
        assert!(!into.exists(), "pkgutil --expand-full needs a new folder");
        make_app(&payload_app(into), parts[1], parts[3], parts[2]);
        Ok(())
    }
    fn verify_code(&self, app: &Path) -> Result<(), String> {
        self.calls.lock().unwrap().push("verify".into());
        match fs::read_to_string(app.join("Contents/MacOS/support")).as_deref() {
            Ok("A") => Ok(()),
            _ => Err("code failed to satisfy specified code requirement(s)".into()),
        }
    }
    fn load_watcher(&self, plist: &Path) -> Result<(), String> {
        let text = fs::read_to_string(plist).map_err(|e| e.to_string())?;
        self.calls.lock().unwrap().push(format!("load{}", if text.contains("--restart") { " --restart" } else { "" }));
        if self.load_fails.load(Ordering::SeqCst) {
            return Err("Bootstrap failed: 5: Input/output error".into());
        }
        Ok(())
    }
    fn watcher_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
    fn unload_watcher(&self) {
        self.calls.lock().unwrap().push("unload".into());
    }
    fn restart_service(&self) -> Result<(), String> {
        self.calls.lock().unwrap().push("restart service".into());
        Ok(())
    }
    fn restart_helpers(&self, _own_pid: i32) {
        self.calls.lock().unwrap().push("restart helpers".into());
    }
}

/// A loopback file server for the packages, at the paths their notes' GitHub URLs have.
fn file_server(files: Arc<Mutex<HashMap<String, Vec<u8>>>>) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for sock in listener.incoming() {
            let Ok(mut sock) = sock else { continue };
            let files = files.clone();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut b = [0u8; 2048];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut b) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&b[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                let body = files.lock().unwrap().get(&path).cloned();
                let (status, body) = match body {
                    Some(b) => ("200 OK", b),
                    None => ("404 Not Found", b"no".to_vec()),
                };
                let _ = write!(sock, "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = sock.write_all(&body);
            });
        }
    });
    origin
}

struct World {
    root: PathBuf,
    places: Places,
    sys: Arc<Fake>,
    clock: Arc<AtomicI64>,
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    origin: String,
}

impl World {
    fn new(name: &str) -> World {
        let root = temp(name);
        let places = Places { data: root.join("data"), apps: root.join("Applications"), watch_plist: root.join("LaunchDaemons/update.plist") };
        state::ensure_dir(&places.data, me()).unwrap();
        fs::create_dir_all(root.join("LaunchDaemons")).unwrap();
        make_app(&places.current(), A, paths::BUNDLE_ID, "A");
        let files: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
        let origin = file_server(files.clone());
        World { root, places, sys: Arc::new(Fake::default()), clock: Arc::new(AtomicI64::new(1_790_000_000_000)), files, origin }
    }

    fn updater(&self, version: &str) -> Arc<Updater> {
        self.updater_timed(version, timing())
    }

    fn updater_timed(&self, version: &str, timing: Timing) -> Arc<Updater> {
        let clock = self.clock.clone();
        let policy = Policy { allow_loopback: true, origin: Some(self.origin.clone()) };
        Updater::with(self.places.clone(), version, self.sys.clone(), policy, timing, Box::new(move || clock.load(Ordering::SeqCst)))
    }

    /// Puts a package on the server and gives its note (as the core hands it over, signature already checked).
    fn publish(&self, version: &str, signer: &str) -> MacNote {
        self.publish_as(version, signer, paths::BUNDLE_ID)
    }

    fn publish_as(&self, version: &str, signer: &str, id: &str) -> MacNote {
        let bytes = format!("FAKEPKG {version} {signer} {id}").into_bytes();
        let path = format!("/o/r/releases/download/mac-v{version}/Support-{version}.pkg");
        self.files.lock().unwrap().insert(path.clone(), bytes.clone());
        MacNote {
            version: version.into(),
            sha256: release::sha256_hex(&bytes),
            size: bytes.len() as u64,
            released: 1,
            url: format!("https://github.com{path}"),
        }
    }

    fn version_at(&self, app: &Path) -> Option<String> {
        programs::app_info(app).map(|i| i.version)
    }

    fn installed(&self) -> Option<String> {
        self.version_at(&self.places.current())
    }

    fn previous(&self) -> Option<String> {
        self.version_at(&self.places.previous())
    }

    fn state(&self) -> UpdateState {
        load(&self.places.data).unwrap()
    }

    fn history(&self) -> Vec<String> {
        state::load_history(&self.places.data)
    }

    fn staging_is_clean(&self) -> bool {
        fs::read_dir(self.places.data.join(paths::STAGING_DIR)).map(|d| d.count() == 0).unwrap_or(true)
    }

    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn idle() -> bool {
    false
}

#[test]
fn an_update_switches_commits_refuses_another_signer_and_rolls_a_broken_version_back() {
    let w = World::new("flow");
    let t = timing();

    // A takes B: B is in /Applications, A in previous/, the trial is written, and the watcher is loaded from A's copy.
    let a = w.updater(A);
    let start = w.clock.load(Ordering::SeqCst);
    a.attempt(&w.publish("1.1.1", "A"), &idle).unwrap();
    assert_eq!(w.installed().as_deref(), Some("1.1.1"));
    assert_eq!(w.previous().as_deref(), Some(A));
    let tr = w.state().trial.unwrap();
    assert_eq!(tr, Trial { phase: Phase::Trial, from_version: A.into(), version: "1.1.1".into(), deadline: start + t.trial_ms, started: false });
    let plist = fs::read_to_string(&w.places.watch_plist).unwrap();
    assert!(plist.contains(&format!("{}/Contents/MacOS/support", w.places.previous().display())), "the watcher runs from the old copy");
    assert!(plist.contains("--restart"));
    assert_eq!(fs::metadata(&w.places.watch_plist).unwrap().permissions().mode() & 0o777, 0o644);
    assert_eq!(w.sys.calls(), vec!["expand", "verify", "load --restart"]);
    assert!(w.staging_is_clean());

    // B starts on trial (the switch's watcher runs): it marks the trial started and renews its window.
    w.sys.running.store(true, Ordering::SeqCst);
    let b = w.updater("1.1.1");
    w.advance(50);
    assert_eq!(b.prepare(), None);
    assert!(b.on_trial());
    let tr = w.state().trial.unwrap();
    assert!(tr.started);
    assert_eq!(tr.deadline, start + 50 + t.trial_ms);
    // No network: it says hello again soon. Then an answer commits.
    assert_eq!(b.trial_pass(DeviceResult::Offline, 0), TrialStep { soon: Some(t.retry_hello_ms), line: None });
    assert!(b.on_trial());
    let step = b.trial_pass(DeviceResult::Ok, 200);
    assert_eq!(step, TrialStep { soon: None, line: Some("Support updated to version 1.1.1.".into()) });
    assert!(!b.on_trial());
    assert_eq!(w.state().trial, None);
    assert!(!w.places.watch_plist.exists());
    assert_eq!(w.sys.count("unload"), 1);
    assert_eq!(w.previous().as_deref(), Some(A), "the old copy stays as the last good one");
    // Another check-in does nothing more.
    assert_eq!(b.trial_pass(DeviceResult::Ok, 200), TrialStep::default());

    // C is signed by someone else: refused, nothing changes, nothing is left.
    w.sys.running.store(false, Ordering::SeqCst);
    let err = b.attempt(&w.publish("1.1.2", "C"), &idle).unwrap_err();
    assert!(err.contains("not signed as this one is"), "{err}");
    assert_eq!(w.installed().as_deref(), Some("1.1.1"));
    assert_eq!(w.previous().as_deref(), Some(A));
    assert_eq!(w.state().trial, None);
    assert!(w.staging_is_clean());
    // Nor is a package with another bundle id, or one whose bytes are not the note's.
    assert!(b.attempt(&w.publish_as("1.1.2", "A", "com.example.evil"), &idle).unwrap_err().contains("not Support"));
    let mut wrong = w.publish("1.1.2", "A");
    wrong.sha256 = "00".repeat(32);
    assert!(b.attempt(&wrong, &idle).unwrap_err().contains("SHA-256"));
    assert_eq!(w.installed().as_deref(), Some("1.1.1"));

    // D is broken: B switches to it, D never starts, and the watcher (B's copy) puts B back at the deadline.
    b.attempt(&w.publish("1.1.3", "A"), &idle).unwrap();
    assert_eq!(w.installed().as_deref(), Some("1.1.3"));
    assert_eq!(w.previous().as_deref(), Some("1.1.1"));
    let watcher = w.updater("1.1.1");
    w.advance(t.trial_ms + 1);
    let began = Instant::now();
    assert_eq!(watcher.watch(true), 0);
    assert!(began.elapsed() >= Duration::from_millis(t.trial_ms as u64), "the watcher waits a whole trial of its own");
    assert_eq!(w.installed().as_deref(), Some("1.1.1"));
    assert_eq!(w.previous(), None, "the failed version is gone");
    let st = w.state();
    assert_eq!(st.trial, None);
    assert_eq!(st.failed, vec!["1.1.3".to_string()]);
    assert_eq!(w.history().last().unwrap(), "Support couldn't update to version 1.1.3, so it went back to version 1.1.1.");
    // The watcher restarted the service and the helpers when it started (D had not run) and again after the rollback.
    assert_eq!(w.sys.count("restart service"), 2);
    assert_eq!(w.sys.count("restart helpers"), 2);
    assert!(!w.places.watch_plist.exists());
    // D is never taken again.
    assert_eq!(take_offer("1.1.3", "1.1.1", Some(&w.state()), false, None, 0, &t), Err(Skip::Failed));
}

#[test]
fn a_refusal_on_trial_rolls_back_at_once() {
    let w = World::new("refusal");
    w.updater(A).attempt(&w.publish("1.1.1", "A"), &idle).unwrap();
    let b = w.updater("1.1.1");
    assert_eq!(b.prepare(), None);
    // The watcher is not running (a restart of the Mac): B loads it again, without a restart.
    assert_eq!(w.sys.calls().last().unwrap(), "load");
    // A 426: this version cannot work with the relay. It records itself as failed and asks for the rollback.
    assert_eq!(b.trial_pass(DeviceResult::UpdateNeeded, 426), TrialStep::default());
    assert!(!b.on_trial());
    let st = w.state();
    assert_eq!(st.trial.as_ref().unwrap().phase, Phase::Rollback);
    assert_eq!(st.failed, vec!["1.1.1".to_string()]);
    // The watcher acts on it at once, without waiting for the deadline. Its trial is long here (10 s), so a watcher
    // that waited fails clearly, while the rollback's own file work has room on a slow or busy test machine (the 200 ms
    // trial of the other tests failed once on a CI runner).
    let long = Timing { trial_ms: 10_000, ..timing() };
    let began = Instant::now();
    assert_eq!(w.updater_timed(A, long).watch(false), 0);
    assert!(began.elapsed() < Duration::from_millis(long.trial_ms as u64 / 2));
    assert_eq!(w.installed().as_deref(), Some(A));
    assert_eq!(w.state().trial, None);
    assert_eq!(w.sys.count("restart service"), 1, "only after the rollback: no restart at start without --restart");
}

#[test]
fn a_trial_without_a_network_commits_just_before_its_deadline() {
    let w = World::new("offline");
    w.updater(A).attempt(&w.publish("1.1.1", "A"), &idle).unwrap();
    let b = w.updater("1.1.1");
    b.prepare();
    let deadline = w.state().trial.unwrap().deadline;
    w.clock.store(deadline - timing().decide_before_ms - 1, Ordering::SeqCst);
    assert_eq!(b.trial_pass(DeviceResult::Refused, 502).soon, Some(timing().retry_hello_ms));
    w.advance(1);
    assert_eq!(b.trial_pass(DeviceResult::Refused, 502).line.as_deref(), Some("Support updated to version 1.1.1."));
    assert_eq!(w.state().trial, None);
}

#[test]
fn a_commit_that_finds_the_lock_busy_tries_again_in_seconds() {
    let w = World::new("busylock");
    w.updater(A).attempt(&w.publish("1.1.1", "A"), &idle).unwrap();
    let b = w.updater("1.1.1");
    b.prepare();
    let held = lock(&w.places.data, Duration::ZERO).unwrap();
    assert_eq!(b.trial_pass(DeviceResult::Ok, 200), TrialStep { soon: Some(timing().commit_retry_ms), line: None });
    assert!(b.on_trial());
    drop(held);
    assert!(b.trial_pass(DeviceResult::Ok, 200).line.is_some());
}

#[test]
fn a_session_that_starts_during_the_download_stops_the_switch() {
    let w = World::new("session");
    let a = w.updater(A);
    let err = a.attempt(&w.publish("1.1.1", "A"), &|| true).unwrap_err();
    assert_eq!(err, SESSION_STARTED);
    assert_eq!(w.installed().as_deref(), Some(A));
    assert_eq!(w.state().trial, None);
    assert!(w.staging_is_clean());
    assert!(!w.sys.calls().iter().any(|c| c.starts_with("load")));
}

#[test]
fn a_watcher_that_cannot_be_loaded_undoes_the_switch() {
    let w = World::new("noload");
    w.sys.load_fails.store(true, Ordering::SeqCst);
    let err = w.updater(A).attempt(&w.publish("1.1.1", "A"), &idle).unwrap_err();
    assert!(err.contains("watcher"), "{err}");
    assert_eq!(w.installed().as_deref(), Some(A));
    assert_eq!(w.previous(), None);
    assert_eq!(w.state().trial, None);
    assert!(!w.places.watch_plist.exists());
    assert!(w.staging_is_clean());
}

#[test]
fn a_trial_is_never_started_over_an_open_one() {
    let w = World::new("open");
    let a = w.updater(A);
    a.attempt(&w.publish("1.1.1", "A"), &idle).unwrap();
    // update.json says a trial is open: no second switch, from any version.
    let err = a.attempt(&w.publish("1.1.2", "A"), &idle).unwrap_err();
    assert!(err.contains("trial is open"), "{err}");
    assert_eq!(w.installed().as_deref(), Some("1.1.1"));
    assert_eq!(w.previous().as_deref(), Some(A));
}

#[test]
fn the_start_of_a_service_takes_up_an_interrupted_or_stale_trial() {
    let w = World::new("start");
    let now = w.clock.load(Ordering::SeqCst);
    // The old version runs while the record says it switched to 1.1.1, which had started: 1.1.1 failed.
    let mut st = trial(Phase::Trial, A, "1.1.1", now + 100);
    st.trial.as_mut().unwrap().started = true;
    save(&w.places.data, &st).unwrap();
    assert_eq!(w.updater(A).prepare().as_deref(), Some("Support couldn't update to version 1.1.1."));
    assert_eq!(w.state(), UpdateState { failed: vec!["1.1.1".into()], ..Default::default() });
    // Not started: not blamed.
    save(&w.places.data, &trial(Phase::Trial, A, "1.1.2", now + 100)).unwrap();
    w.updater(A).prepare();
    assert_eq!(w.state().failed, Vec::<String>::new());
    assert_eq!(w.state().trial, None);
    // A record about other versions: left alone while recent, cleared once stale, the failed versions kept.
    let mut other = trial(Phase::Trial, "1.0.9", "1.1.2", now);
    other.add_failed("1.0.8");
    save(&w.places.data, &other).unwrap();
    assert_eq!(w.updater(A).prepare(), None);
    assert!(w.state().trial.is_some());
    w.advance(timing().stale_ms);
    assert_eq!(w.updater(A).prepare(), None);
    assert_eq!(w.state(), UpdateState { failed: vec!["1.0.8".into()], ..Default::default() });
    // A rollback decided but not done, and this is the version that failed: the watcher is started to finish it.
    save(&w.places.data, &trial(Phase::Rollback, A, "1.1.1", now)).unwrap();
    let calls = w.sys.calls().len();
    assert_eq!(w.updater("1.1.1").prepare(), None);
    assert_eq!(w.sys.calls()[calls..], ["load".to_string()]);
}

#[test]
fn a_trial_of_a_mac_that_never_checks_in_commits_at_once() {
    let w = World::new("commitnow");
    w.updater(A).attempt(&w.publish("1.1.1", "A"), &idle).unwrap();
    let b = w.updater("1.1.1");
    assert_eq!(b.commit_now(), None, "not on trial before prepare");
    b.prepare();
    assert_eq!(b.commit_now().as_deref(), Some("Support updated to version 1.1.1."));
    assert_eq!(w.state().trial, None);
}

#[test]
fn a_rollback_with_no_old_copy_ends_the_trial_on_the_new_version() {
    let w = World::new("gone");
    w.updater(A).attempt(&w.publish("1.1.1", "A"), &idle).unwrap();
    install::remove_tree(&w.places.previous());
    let _l = lock(&w.places.data, Duration::ZERO).unwrap();
    assert_eq!(w.updater("1.1.1").rollback_locked("1.1.1"), Ok(Rolled::Gone));
    assert_eq!(w.installed().as_deref(), Some("1.1.1"));
    let st = w.state();
    assert_eq!((st.trial, st.failed), (None, vec!["1.1.1".to_string()]));
    assert_eq!(w.history().last().unwrap(), "Support couldn't update to version 1.1.1.");
    assert_eq!(w.updater(A).rollback_locked("1.1.1"), Ok(Rolled::NoTrial));
}

/// A switch from A to 1.1.1 whose rollback was decided: 1.1.1 is in /Applications, A in previous/, the record in its
/// rollback phase with 1.1.1 failed.
fn decided_rollback(name: &str) -> World {
    let w = World::new(name);
    w.updater(A).attempt(&w.publish("1.1.1", "A"), &idle).unwrap();
    let mut st = w.state();
    st.trial.as_mut().unwrap().phase = Phase::Rollback;
    st.add_failed("1.1.1");
    save(&w.places.data, &st).unwrap();
    w
}

#[test]
fn bundle_version_reads_only_supports_own_app() {
    let d = temp("bundlever");
    let app = d.join("Support.app");
    assert_eq!(bundle_version(&app), None, "missing");
    make_app(&app, "1.1.1", paths::BUNDLE_ID, "A");
    assert_eq!(bundle_version(&app).as_deref(), Some("1.1.1"));
    make_app(&app, "1.1.1", "com.example.other", "A");
    assert_eq!(bundle_version(&app), None, "another app");
    make_app(&app, "1.1.1", paths::BUNDLE_ID, "A");
    std::os::unix::fs::symlink(&app, d.join("Link.app")).unwrap();
    assert_eq!(bundle_version(&d.join("Link.app")), None, "a link is not followed");
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn a_rollback_put_back_by_the_watcher_swaps_once() {
    let w = decided_rollback("rollnormal");
    let _l = lock(&w.places.data, Duration::ZERO).unwrap();
    assert_eq!(w.updater(A).rollback_locked("1.1.1"), Ok(Rolled::Back));
    assert_eq!(w.installed().as_deref(), Some(A));
    assert_eq!(w.previous(), None);
    let st = w.state();
    assert_eq!((st.trial, st.failed), (None, vec!["1.1.1".to_string()]));
    assert_eq!(w.history().last().unwrap(), "Support couldn't update to version 1.1.1, so it went back to version 1.1.0.");
    assert_eq!((w.sys.count("restart service"), w.sys.count("restart helpers")), (1, 1));
}

#[test]
fn a_rollback_cut_short_after_its_swap_finishes_without_swapping_again() {
    // The Mac lost power after the swap: A is back in /Applications, 1.1.1 in previous/, and the record still open.
    let w = decided_rollback("rollresume");
    install::swap(&w.places.previous(), &w.places.current()).unwrap();
    assert_eq!((w.installed().as_deref(), w.previous().as_deref()), (Some(A), Some("1.1.1")));
    let _l = lock(&w.places.data, Duration::ZERO).unwrap();
    // The next boot's watcher runs again, here as 1.1.1's copy would on a resumed rollback.
    assert_eq!(w.updater("1.1.1").rollback_locked("1.1.1"), Ok(Rolled::Back));
    assert_eq!(w.installed().as_deref(), Some(A), "the good version stays");
    assert_eq!(w.previous(), None, "the failed version is gone");
    let st = w.state();
    assert_eq!((st.trial, st.failed), (None, vec!["1.1.1".to_string()]));
    assert_eq!(w.history().last().unwrap(), "Support couldn't update to version 1.1.1, so it went back to version 1.1.0.");
    assert_eq!((w.sys.count("restart service"), w.sys.count("restart helpers")), (1, 1));

    // Cut short later, after previous/ was removed but before the record closed: it only finishes.
    let w = decided_rollback("rollresume2");
    install::swap(&w.places.previous(), &w.places.current()).unwrap();
    install::remove_tree(&w.places.previous());
    let _l = lock(&w.places.data, Duration::ZERO).unwrap();
    assert_eq!(w.updater("1.1.1").rollback_locked("1.1.1"), Ok(Rolled::Back));
    assert_eq!(w.installed().as_deref(), Some(A));
    assert_eq!(w.state().trial, None);
}

#[test]
fn a_resumed_rollback_through_the_watcher_keeps_the_good_version() {
    let w = decided_rollback("rollwatch");
    install::swap(&w.places.previous(), &w.places.current()).unwrap();
    // The failed version's service starts first and loads the watcher, which finishes the rollback at once.
    assert_eq!(w.updater("1.1.1").prepare(), None);
    let long = Timing { trial_ms: 10_000, ..timing() };
    assert_eq!(w.updater_timed(A, long).watch(false), 0);
    assert_eq!(w.installed().as_deref(), Some(A));
    assert_eq!(w.previous(), None);
    assert_eq!(w.state().trial, None);
    assert!(!w.places.watch_plist.exists());
}

#[test]
fn a_rollback_that_finds_an_unexpected_version_deletes_nothing_and_keeps_the_record() {
    let check = |w: &World, current: Option<&str>, previous: Option<&str>| {
        let before = w.state();
        let _l = lock(&w.places.data, Duration::ZERO).unwrap();
        let err = w.updater("1.1.1").rollback_locked("1.1.1").unwrap_err();
        assert!(err.contains("nothing was deleted"), "{err}");
        assert!(err.contains("update.json keeps the rollback"), "{err}");
        assert_eq!((w.installed().as_deref(), w.previous().as_deref()), (current, previous));
        assert_eq!(w.state(), before, "the record stays");
        assert_eq!(w.sys.count("restart service"), 0);
    };
    // Something else in previous/.
    let w = decided_rollback("rollodd1");
    make_app(&w.places.previous(), "1.0.5", paths::BUNDLE_ID, "A");
    check(&w, Some("1.1.1"), Some("1.0.5"));
    // Something else in /Applications.
    let w = decided_rollback("rollodd2");
    make_app(&w.places.current(), "1.0.5", paths::BUNDLE_ID, "A");
    check(&w, Some("1.0.5"), Some(A));
    // /Applications/Support.app missing.
    let w = decided_rollback("rollodd3");
    install::remove_tree(&w.places.current());
    check(&w, None, Some(A));
    // Both hold the failed version.
    let w = decided_rollback("rollodd4");
    make_app(&w.places.previous(), "1.1.1", paths::BUNDLE_ID, "A");
    check(&w, Some("1.1.1"), Some("1.1.1"));
}

#[test]
fn an_offer_runs_on_its_own_thread_once_and_a_failure_waits_an_hour() {
    let w = World::new("offer");
    let a = w.updater(A);
    let busy: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| false);
    // A wrong signer: refused in the background, noted in update.json, and not tried again within the hour.
    let c = w.publish("1.1.2", "C");
    assert_eq!(a.offer(&c, busy.clone()), Ok(()));
    let until = Instant::now() + Duration::from_secs(10);
    while w.state().last_error.is_none() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    let e = w.state().last_error.unwrap();
    assert_eq!(e.version, "1.1.2");
    assert!(e.reason.contains("not signed as this one is"), "{}", e.reason);
    while a.working.load(Ordering::SeqCst) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(a.offer(&c, busy.clone()), Err(Skip::TriedRecently));
    assert_eq!(a.offer(&c, Arc::new(|| true)), Err(Skip::Busy));
    // A good one switches.
    assert_eq!(a.offer(&w.publish("1.1.1", "A"), busy.clone()), Ok(()));
    while !w.sys.calls().iter().any(|c| c.starts_with("load")) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(w.installed().as_deref(), Some("1.1.1"));
    assert_eq!(a.offer(&w.publish("1.1.4", "A"), busy), Err(Skip::Working), "the service is about to be restarted");
}

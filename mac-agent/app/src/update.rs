//! Self-update of a saved Mac: a release signed with the project's key replaces the app, on trial, with an automatic
//! rollback. The model is the Windows app's (src/agent-app.cs `Updater`, `UpdateState`, `UpdateSwitch`, `DeviceUpdate`),
//! and its numbers are the same: a 4-minute trial, a hello retried every 30 s, a commit when still offline 90 s before
//! the deadline, a failed release retried after an hour, and at most 20 failed versions remembered.
//!
//! 1. **Offer.** The core checks the offer's signature against the built-in key, its note, that it is newer and not a
//!    version that failed here, and only outside a session (`support_core::device::Hooks::update_offered`).
//! 2. **Download** (`support_core::download`): from the note's `https://github.com/` URL, redirects only to GitHub's
//!    release storage, never more than the note's size (at most 40 MiB), kept only with the note's size and SHA-256.
//!    It goes into a new folder under `staging/` in the data folder, which only root can open.
//! 3. **Check.** The package is expanded there (`pkgutil --expand-full`). The one app in its payload must be a real
//!    folder with no link that leads out, carry this bundle id, the note's version and the `support` executable, be
//!    given to root with no write for others, and pass `codesign --verify --strict` against the designated requirement
//!    of the app that runs now. So only an app signed by the same identity is taken, and macOS keeps the Screen
//!    Recording and Accessibility permissions, which it ties to that identity.
//! 4. **Switch** (under `update.lock`, never during a session): the trial goes into `update.json`, the new app is
//!    swapped into `/Applications` in one step (`renamex_np`), the old one goes to `previous/Support.app`, and a one-shot
//!    launchd job, the watcher, is loaded from the old app's copy. The watcher restarts the service and the helpers.
//! 5. **Trial.** The new service marks the trial started and checks in. An answer (200 or 202) or a 401 commits it; a
//!    426 or another refusal asks the watcher to roll back at once; no network keeps trying, and commits 90 s before
//!    the deadline. The watcher rolls back when the trial is still open at its deadline, which covers a version that
//!    cannot even start. A rollback swaps the old app back, records the version as failed so it is never taken again,
//!    and restarts the service and the helpers. The watcher's property list is in /Library/LaunchDaemons for the
//!    trial, so a restart of the Mac in the middle starts it again.
//!
//! Everything that needs macOS is behind `System`, so the rest runs and is tested on Linux.

use crate::install;
use crate::paths;
use crate::plists;
use crate::programs;
use crate::state;
use serde_json::{json, Map, Value};
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use support_core::device::DeviceResult;
use support_core::download::{self, Policy};
use support_core::release::{self, MacNote};
use support_core::stop::Stop;

pub const UPDATE_FILE: &str = "update.json";
pub const PREVIOUS_DIR: &str = "previous";
pub const LOCK_FILE: &str = "update.lock";
/// The component package in the product archive build.sh makes, and the app in its payload.
pub const COMPONENT: &str = "Support-component.pkg";
pub const PAYLOAD_APP: &str = "Payload/Applications/Support.app";
pub const FAILED_CAP: usize = 20;
/// Why a switch did not happen when a session started during the download.
pub const SESSION_STARTED: &str = "a session started";

/// The timings, all in ms but the poll. A `test-release` build shortens the trial so the macOS test is quick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    /// How long a new version has to finish a healthy check-in.
    pub trial_ms: i64,
    /// Past its deadline by this much, a trial record about another version is cleared, and no longer holds up an
    /// uninstall.
    pub stale_ms: i64,
    /// A release whose download or checks failed is tried again after this long at the earliest.
    pub retry_ms: i64,
    /// A trial with no network (or a server error) says hello again this often.
    pub retry_hello_ms: u64,
    /// This close to the deadline, a trial still without a network commits, before the watcher would roll it back.
    pub decide_before_ms: i64,
    /// A commit that found the lock busy tries again this soon.
    pub commit_retry_ms: u64,
    /// How often the watcher reads update.json.
    pub poll: Duration,
}

impl Timing {
    #[cfg(not(feature = "test-release"))]
    pub const fn built_in() -> Timing {
        Timing::windows()
    }

    /// A `test-release` build: a 60 s trial and a 1 s poll, everything else as shipped.
    #[cfg(feature = "test-release")]
    pub const fn built_in() -> Timing {
        Timing { trial_ms: 60_000, decide_before_ms: 20_000, poll: Duration::from_secs(1), ..Timing::windows() }
    }

    /// The Windows app's numbers (`UpdateSwitch` in src/agent-app.cs).
    pub const fn windows() -> Timing {
        Timing {
            trial_ms: 240_000,
            stale_ms: 600_000,
            retry_ms: 3_600_000,
            retry_hello_ms: 30_000,
            decide_before_ms: 90_000,
            commit_retry_ms: 5_000,
            poll: Duration::from_secs(2),
        }
    }
}

// ---- update.json -------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// The new version is on trial: its check-ins decide.
    Trial,
    /// The rollback was decided (and the version recorded as failed) but may not be done yet.
    Rollback,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trial {
    pub phase: Phase,
    /// The version that switched, whose copy is in previous/.
    pub from_version: String,
    /// The version on trial, in /Applications.
    pub version: String,
    /// Unix ms.
    pub deadline: i64,
    /// The new version's service has run, so an interrupted trial may blame it.
    pub started: bool,
}

/// The last update that was not taken, and why: for a person reading update.json, never acted on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastError {
    pub version: String,
    pub reason: String,
    pub at: i64,
}

/// `update.json` in the data folder:
/// `{"failed":[...],"trial":{"phase":"trial"|"rollback","from_version","version","deadline","started"},"last_error":{"version","reason","at"}}`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UpdateState {
    pub failed: Vec<String>,
    pub trial: Option<Trial>,
    pub last_error: Option<LastError>,
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

impl UpdateState {
    /// The state a text holds. Damaged text is an empty state, so a bad file never blocks the service; a damaged trial
    /// is no trial, and only valid versions count as failed.
    pub fn parse(text_in: &str) -> UpdateState {
        let Ok(v) = serde_json::from_str::<Value>(text_in) else { return UpdateState::default() };
        let mut st = UpdateState::default();
        if let Some(list) = v.get("failed").and_then(Value::as_array) {
            for f in list.iter().filter_map(Value::as_str).filter(|f| release::valid_version(f)) {
                st.add_failed(f);
            }
        }
        if let Some(t) = v.get("trial").filter(|t| t.is_object()) {
            let phase = match t.get("phase").and_then(Value::as_str) {
                Some("trial") => Some(Phase::Trial),
                Some("rollback") => Some(Phase::Rollback),
                _ => None,
            };
            let (from_version, version) = (text(t, "from_version"), text(t, "version"));
            let deadline = t.get("deadline").and_then(Value::as_i64);
            if let (Some(phase), Some(deadline)) = (phase, deadline) {
                if release::valid_version(&from_version) && release::valid_version(&version) {
                    let started = t.get("started") == Some(&Value::Bool(true));
                    st.trial = Some(Trial { phase, from_version, version, deadline, started });
                }
            }
        }
        if let Some(e) = v.get("last_error").filter(|e| e.is_object()) {
            st.last_error = Some(LastError {
                version: support_core::wire::clean(&text(e, "version"), 40),
                reason: support_core::wire::clean(&text(e, "reason"), 300),
                at: e.get("at").and_then(Value::as_i64).unwrap_or(0),
            });
        }
        st
    }

    pub fn to_json(&self) -> String {
        let mut m = Map::new();
        m.insert("failed".into(), json!(self.failed));
        if let Some(t) = &self.trial {
            let phase = if t.phase == Phase::Trial { "trial" } else { "rollback" };
            m.insert(
                "trial".into(),
                json!({"phase": phase, "from_version": t.from_version, "version": t.version, "deadline": t.deadline, "started": t.started}),
            );
        }
        if let Some(e) = &self.last_error {
            m.insert("last_error".into(), json!({"version": e.version, "reason": e.reason, "at": e.at}));
        }
        Value::Object(m).to_string()
    }

    /// Records a version as failed for good, the oldest dropped past `FAILED_CAP`.
    pub fn add_failed(&mut self, version: &str) {
        if !self.failed.iter().any(|f| f == version) {
            self.failed.push(version.to_string());
        }
        while self.failed.len() > FAILED_CAP {
            self.failed.remove(0);
        }
    }

    pub fn in_trial(&self) -> bool {
        self.trial.is_some()
    }

    /// The open trial of `version`, in either phase.
    pub fn trial_of(&self, version: &str) -> Option<&Trial> {
        self.trial.as_ref().filter(|t| t.version == version)
    }
}

/// update.json as it is now. A missing file is an empty state. None when it exists but cannot be read now: a caller
/// that would save then changes nothing, so an unreadable record is never replaced by an empty one.
pub fn load(dir: &Path) -> Option<UpdateState> {
    let path = dir.join(UPDATE_FILE);
    let f = match fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Some(UpdateState::default()),
        // A link or anything else that is not a file of root's: damaged, so empty (a save replaces it).
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Some(UpdateState::default()),
        Err(_) => return None,
    };
    let m = f.metadata().ok()?;
    if !m.is_file() || m.len() > 1 << 20 {
        return Some(UpdateState::default());
    }
    let mut text = String::new();
    io::Read::read_to_string(&mut io::Read::take(f, 1 << 20), &mut text).ok()?;
    Some(UpdateState::parse(&text))
}

pub fn save(dir: &Path, st: &UpdateState) -> Result<(), String> {
    state::write_atomic(&dir.join(UPDATE_FILE), st.to_json().as_bytes())
}

// ---- the rules, as pure functions --------------------------------------------------------------------------------

/// What the service of version `me` does about update.json when it starts (src/agent-app.cs `UpdateSwitch.OnStart`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    /// No trial.
    Normal,
    /// This version is on trial: its check-ins decide.
    Trial,
    /// The trial away from this version never finished (the switch failed, or was undone), and this version runs: the
    /// record is closed, and the new version is failed only if its service ever ran.
    Interrupted,
    /// The rollback away from this version was decided but not done: the watcher does it.
    ResumeRollback,
    /// A record about other versions, long past its deadline: cleared, the failed versions kept.
    Stale,
    /// A rollback is under way elsewhere, or a recent record about other versions: touch nothing.
    Waiting,
}

pub fn on_start(st: &UpdateState, me: &str, now: i64, timing: &Timing) -> Start {
    let Some(t) = &st.trial else { return Start::Normal };
    if t.phase == Phase::Trial && t.version == me {
        return Start::Trial;
    }
    if t.from_version == me {
        return Start::Interrupted;
    }
    if t.phase == Phase::Rollback && t.version == me {
        return Start::ResumeRollback;
    }
    if now >= t.deadline.saturating_add(timing.stale_ms) {
        return Start::Stale;
    }
    Start::Waiting
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Health {
    Healthy,
    Unhealthy,
    Retry,
}

/// A check-in of a version on trial. Healthy: an answer (200 or 202), or a 401 (the Mac was removed, which is not the
/// version's fault). Retry: no answer or a server error. Unhealthy: a 426 or any other refusal, so the old version
/// comes back.
pub fn trial_health(result: DeviceResult, status: u16) -> Health {
    match result {
        DeviceResult::Ok | DeviceResult::Pending | DeviceResult::Removed => Health::Healthy,
        _ if result == DeviceResult::Offline || status == 0 || status >= 500 => Health::Retry,
        _ => Health::Unhealthy,
    }
}

/// A trial still without a network commits from `decide_before_ms` before its deadline on.
pub fn decide_now(now: i64, deadline: i64, timing: &Timing) -> bool {
    now >= deadline - timing.decide_before_ms
}

/// The watcher rolls back a trial still open at its deadline, once it has itself watched for a whole trial (so a
/// deadline in the past, or a clock that jumped, never cuts a new version short), or after two trials whatever the
/// deadline says (a damaged record).
pub fn watch_due(deadline: i64, now: i64, watched_ms: i64, timing: &Timing) -> bool {
    watched_ms >= timing.trial_ms && (now >= deadline || watched_ms >= 2 * timing.trial_ms)
}

/// Uninstall waits for an open trial, but not for one long past its deadline.
pub fn uninstall_busy(st: &UpdateState, now: i64, timing: &Timing) -> bool {
    st.trial.as_ref().is_some_and(|t| now < t.deadline.saturating_add(timing.stale_ms))
}

/// Why an offer is not taken now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Skip {
    /// update.json cannot be read now.
    Unreadable,
    /// A trial is open (this version's, or a rollback under way).
    TrialOpen,
    /// A session is running or about to.
    Busy,
    /// The version failed its trial here.
    Failed,
    /// Not newer than this version.
    NotNewer,
    /// The same version was tried less than `retry_ms` ago.
    TriedRecently,
    /// An update is being downloaded or switched now.
    Working,
}

/// Whether to start on an offered version now (the core has checked its signature already).
pub fn take_offer(
    version: &str,
    me: &str,
    st: Option<&UpdateState>,
    busy: bool,
    last_try: Option<(&str, i64)>,
    now_mono: i64,
    timing: &Timing,
) -> Result<(), Skip> {
    let st = st.ok_or(Skip::Unreadable)?;
    if st.in_trial() {
        return Err(Skip::TrialOpen);
    }
    if busy {
        return Err(Skip::Busy);
    }
    if release::compare_versions(version, me) != Some(std::cmp::Ordering::Greater) {
        return Err(Skip::NotNewer);
    }
    if st.failed.iter().any(|f| f == version) {
        return Err(Skip::Failed);
    }
    if let Some((v, at)) = last_try {
        if v == version && now_mono - at < timing.retry_ms {
            return Err(Skip::TriedRecently);
        }
    }
    Ok(())
}

/// Where the app is in an expanded package.
pub fn payload_app(expanded: &Path) -> PathBuf {
    expanded.join(COMPONENT).join(PAYLOAD_APP)
}

/// Why a staged app is not the release the note names, or None: a real folder with no link leading out, this bundle
/// id, the note's version and the `support` executable as a regular file.
pub fn app_problem(app: &Path, version: &str) -> Option<String> {
    if let Some(p) = install::bundle_problem(app) {
        return Some(p);
    }
    let Some(info) = programs::info_plist(app) else { return Some("the package's app has no readable Info.plist".into()) };
    let field = |k: &str| info.get(k).and_then(|v| v.as_string()).unwrap_or("").to_string();
    if field("CFBundleIdentifier") != paths::BUNDLE_ID {
        return Some(format!("the package's app is {:?}, not Support", support_core::wire::clean(&field("CFBundleIdentifier"), 100)));
    }
    if field("CFBundleShortVersionString") != version {
        return Some(format!(
            "the package's app is version {:?}, not {version}",
            support_core::wire::clean(&field("CFBundleShortVersionString"), 40)
        ));
    }
    if field("CFBundleExecutable") != "support" {
        return Some("the package's app does not run support".into());
    }
    match fs::symlink_metadata(app.join("Contents/MacOS/support")) {
        Ok(m) if m.file_type().is_file() => None,
        _ => Some("the package's app has no support executable".into()),
    }
}

/// The watcher's launchd job: the old app's copy, run once as root at load (and at boot, while its property list is
/// in /Library/LaunchDaemons for a trial). `restart`: it starts by restarting the service and the helpers (the switch).
pub fn watch_plist(binary: &str, restart: bool) -> String {
    use plists::P;
    let mut args = vec![P::Str(binary.into()), P::Str("update-watch".into())];
    if restart {
        args.push(P::Str("--restart".into()));
    }
    plists::xml(&P::Dict(vec![
        ("AbandonProcessGroup", P::Bool(true)),
        ("AssociatedBundleIdentifiers", P::Arr(vec![P::Str(paths::BUNDLE_ID.into())])),
        ("KeepAlive", P::Bool(false)),
        ("Label", P::Str(paths::WATCH_LABEL.into())),
        ("ProcessType", P::Str("Standard".into())),
        ("ProgramArguments", P::Arr(args)),
        ("RunAtLoad", P::Bool(true)),
    ]))
}

/// Whether `launchctl print` says the job has a process now.
pub fn running_in(print: &str) -> bool {
    print.lines().any(|l| l.trim() == "state = running")
}

/// Whether a process's executable is an old copy of the app: Support's binary under the data folder (previous/, or a
/// staged copy), never the installed one.
pub fn old_copy(exe: &str, data: &str) -> bool {
    exe.starts_with(&format!("{}/", data.trim_end_matches('/'))) && exe.ends_with("/Support.app/Contents/MacOS/support")
}

// ---- the lock ----------------------------------------------------------------------------------------------------

/// `update.lock` in the data folder: one switch, commit or rollback at a time, between the service and the watcher.
pub struct Lock {
    _file: fs::File,
}

/// Takes the lock, waiting up to `wait`. None when another holds it still.
pub fn lock(dir: &Path, wait: Duration) -> Option<Lock> {
    use std::os::fd::AsRawFd;
    let f = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join(LOCK_FILE))
        .ok()?;
    let until = Instant::now() + wait;
    loop {
        // SAFETY: flock(2) on a descriptor this function owns.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Some(Lock { _file: f });
        }
        if Instant::now() >= until {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ---- what needs macOS --------------------------------------------------------------------------------------------

/// The steps that need macOS's own tools and launchd. The Mac's is `mac::update::MacSystem`.
pub trait System: Send + Sync {
    /// `pkgutil --expand-full <pkg> <into>`; `into` does not exist yet.
    fn expand(&self, pkg: &Path, into: &Path) -> Result<(), String>;
    /// `codesign --verify --strict`, and the designated requirement of the app that runs now.
    fn verify_code(&self, app: &Path) -> Result<(), String>;
    /// Loads the watcher's job from its property list, after taking out one left from before.
    fn load_watcher(&self, plist: &Path) -> Result<(), String>;
    /// Whether the watcher's job has a process now.
    fn watcher_running(&self) -> bool;
    fn unload_watcher(&self);
    /// Restarts the service's job now.
    fn restart_service(&self) -> Result<(), String>;
    /// Restarts the helper in every signed-in session, and ends any other process of an old copy of the app.
    fn restart_helpers(&self, own_pid: i32);
}

/// For a platform with no update support: every step fails, and nothing runs.
pub struct Unsupported;

impl System for Unsupported {
    fn expand(&self, _pkg: &Path, _into: &Path) -> Result<(), String> {
        Err("updates need macOS".into())
    }
    fn verify_code(&self, _app: &Path) -> Result<(), String> {
        Err("updates need macOS".into())
    }
    fn load_watcher(&self, _plist: &Path) -> Result<(), String> {
        Err("updates need macOS".into())
    }
    fn watcher_running(&self) -> bool {
        false
    }
    fn unload_watcher(&self) {}
    fn restart_service(&self) -> Result<(), String> {
        Err("updates need macOS".into())
    }
    fn restart_helpers(&self, _own_pid: i32) {}
}

// ---- the updater -------------------------------------------------------------------------------------------------

/// Where the updater works.
#[derive(Clone, Debug)]
pub struct Places {
    /// Root's data folder: update.json, update.lock, previous/, staging/, history.json.
    pub data: PathBuf,
    /// Where Support.app is.
    pub apps: PathBuf,
    /// The watcher's property list (in /Library/LaunchDaemons, so it starts again at boot).
    pub watch_plist: PathBuf,
}

impl Places {
    pub fn mac() -> Places {
        Places { data: PathBuf::from(paths::DATA_DIR), apps: PathBuf::from("/Applications"), watch_plist: PathBuf::from(paths::WATCH_PLIST) }
    }

    fn current(&self) -> PathBuf {
        self.apps.join(format!("{}.app", paths::APP_NAME))
    }

    fn previous(&self) -> PathBuf {
        self.data.join(PREVIOUS_DIR).join(format!("{}.app", paths::APP_NAME))
    }
}

/// What a check-in of a version on trial came to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrialStep {
    /// Check in again this soon (ms).
    pub soon: Option<u64>,
    /// A line for the history.
    pub line: Option<String>,
}

/// What the watcher's rollback came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rolled {
    /// No trial was open: nothing to do.
    NoTrial,
    /// The old version is back.
    Back,
    /// The old copy was gone, so the trial ended on the new version.
    Gone,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub struct Updater {
    places: Places,
    /// The version of this process's code.
    version: String,
    sys: Arc<dyn System>,
    policy: Policy,
    timing: Timing,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
    started_at: Instant,
    /// This version is on trial: its check-ins decide.
    trial: AtomicBool,
    /// An update is being downloaded, checked or switched now (or has switched, and this service is about to stop).
    working: AtomicBool,
    /// The version last tried and when (ms since this updater started).
    last_try: Mutex<Option<(String, i64)>>,
    pub stop: Arc<Stop>,
}

impl Updater {
    pub fn new(places: Places, version: &str, sys: Arc<dyn System>) -> Arc<Updater> {
        Updater::with(places, version, sys, Policy::built_in(), Timing::built_in(), Box::new(now_ms))
    }

    pub fn with(
        places: Places,
        version: &str,
        sys: Arc<dyn System>,
        policy: Policy,
        timing: Timing,
        clock: Box<dyn Fn() -> i64 + Send + Sync>,
    ) -> Arc<Updater> {
        Arc::new(Updater {
            places,
            version: version.to_string(),
            sys,
            policy,
            timing,
            clock,
            started_at: Instant::now(),
            trial: AtomicBool::new(false),
            working: AtomicBool::new(false),
            last_try: Mutex::new(None),
            stop: Stop::new(),
        })
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn mono(&self) -> i64 {
        self.started_at.elapsed().as_millis() as i64
    }

    pub fn timing(&self) -> &Timing {
        &self.timing
    }

    pub fn on_trial(&self) -> bool {
        self.trial.load(Ordering::SeqCst)
    }

    /// The versions that failed their trial here.
    pub fn failed(&self) -> Vec<String> {
        load(&self.places.data).map(|s| s.failed).unwrap_or_default()
    }

    /// Whether an uninstall must wait for an open trial.
    pub fn uninstall_busy(&self) -> bool {
        load(&self.places.data).is_some_and(|s| uninstall_busy(&s, self.now(), &self.timing))
    }

    fn history(&self, line: &str) {
        let mut h = state::load_history(&self.places.data);
        h.push(line.to_string());
        support_core::device::trim_history(&mut h);
        let _ = state::save_history(&self.places.data, &h);
    }

    // ---- the service's start -------------------------------------------------------------------------------------

    /// What the service does about update.json before it checks in (src/agent-app.cs `DeviceService.Prepare`). Returns a
    /// line for the history when a trial away from this version ended without it.
    pub fn prepare(&self) -> Option<String> {
        let start = load(&self.places.data).map(|st| on_start(&st, &self.version, self.now(), &self.timing)).unwrap_or(Start::Waiting);
        match start {
            Start::Normal => {
                // A watcher job left loaded from an earlier trial, with nothing to watch.
                if !self.sys.watcher_running() {
                    self.sys.unload_watcher();
                    let _ = fs::remove_file(&self.places.watch_plist);
                }
                None
            }
            Start::Interrupted | Start::Stale => {
                let _l = lock(&self.places.data, Duration::from_secs(30))?;
                let mut st = load(&self.places.data)?;
                let again = on_start(&st, &self.version, self.now(), &self.timing);
                let t = st.trial.clone()?;
                let line = match again {
                    Start::Interrupted => {
                        if t.phase == Phase::Trial && t.started {
                            st.add_failed(&t.version);
                        }
                        Some(format!("Support couldn't update to version {}.", t.version))
                    }
                    Start::Stale => None,
                    _ => return None,
                };
                st.trial = None;
                save(&self.places.data, &st).ok()?;
                self.sys.unload_watcher();
                let _ = fs::remove_file(&self.places.watch_plist);
                line
            }
            Start::ResumeRollback => {
                self.ensure_watcher();
                None
            }
            Start::Trial => {
                self.begin_trial();
                None
            }
            Start::Waiting => None,
        }
    }

    /// This version starts on trial: it records that it ran, gives itself a fresh trial window, and makes sure the
    /// watcher runs (it does not after a restart of the Mac, or when the switch's watcher was stopped).
    fn begin_trial(&self) {
        if let Some(_l) = lock(&self.places.data, Duration::from_secs(30)) {
            if let Some(mut st) = load(&self.places.data) {
                if on_start(&st, &self.version, self.now(), &self.timing) == Start::Trial {
                    let fresh = self.now() + self.timing.trial_ms;
                    if let Some(t) = st.trial.as_mut() {
                        t.started = true;
                        t.deadline = t.deadline.max(fresh);
                    }
                    let _ = save(&self.places.data, &st);
                }
            }
        }
        self.trial.store(true, Ordering::SeqCst);
        self.ensure_watcher();
    }

    /// Loads the watcher unless it runs: from the old copy, or from this app when the old copy is gone (its rollback
    /// then ends the trial on this version, as there is nothing to go back to).
    fn ensure_watcher(&self) {
        if self.sys.watcher_running() {
            return;
        }
        let prev = self.places.previous().join("Contents/MacOS/support");
        let binary = if fs::symlink_metadata(&prev).is_ok_and(|m| m.file_type().is_file()) {
            prev
        } else {
            self.places.current().join("Contents/MacOS/support")
        };
        if state::write_atomic(&self.places.watch_plist, watch_plist(&binary.to_string_lossy(), false).as_bytes()).is_ok() {
            let _ = make_readable(&self.places.watch_plist);
            let _ = self.sys.load_watcher(&self.places.watch_plist);
        }
    }

    /// A version on trial whose Mac was removed or is not set up never checks in, so its trial commits at once.
    pub fn commit_now(&self) -> Option<String> {
        if !self.on_trial() {
            return None;
        }
        self.commit().line
    }

    // ---- the trial -------------------------------------------------------------------------------------------------

    /// A check-in of this version (src/agent-app.cs `FinishTrial`). Nothing when this version is not on trial.
    pub fn trial_pass(&self, result: DeviceResult, status: u16) -> TrialStep {
        if !self.on_trial() {
            return TrialStep::default();
        }
        match trial_health(result, status) {
            Health::Unhealthy => {
                self.ask_rollback();
                TrialStep::default()
            }
            Health::Retry => {
                let deadline = load(&self.places.data).and_then(|s| s.trial_of(&self.version).map(|t| t.deadline));
                match deadline {
                    Some(d) if decide_now(self.now(), d, &self.timing) => self.commit(),
                    _ => TrialStep { soon: Some(self.timing.retry_hello_ms), line: None },
                }
            }
            Health::Healthy => self.commit(),
        }
    }

    /// Closes this version's trial: the old copy stays in previous/ as the last good one.
    fn commit(&self) -> TrialStep {
        let busy = TrialStep { soon: Some(self.timing.commit_retry_ms), line: None };
        let Some(_l) = lock(&self.places.data, Duration::ZERO) else { return busy };
        let Some(mut st) = load(&self.places.data) else { return busy };
        let line = match st.trial_of(&self.version) {
            Some(t) if t.phase == Phase::Trial => {
                st.trial = None;
                if save(&self.places.data, &st).is_err() {
                    return busy;
                }
                Some(format!("Support updated to version {}.", self.version))
            }
            // A rollback was decided already, or the record is about something else: the trial is not this service's.
            _ => None,
        };
        self.trial.store(false, Ordering::SeqCst);
        let _ = fs::remove_file(&self.places.watch_plist);
        self.sys.unload_watcher();
        TrialStep { soon: None, line }
    }

    /// A refusal: this version records itself as failed and asks the watcher to put the old one back now.
    fn ask_rollback(&self) {
        if let Some(_l) = lock(&self.places.data, Duration::from_secs(5)) {
            if let Some(mut st) = load(&self.places.data) {
                if let Some(t) = st.trial.as_mut().filter(|t| t.version == self.version && t.phase == Phase::Trial) {
                    t.phase = Phase::Rollback;
                    st.add_failed(&self.version);
                    let _ = save(&self.places.data, &st);
                }
            }
        }
        self.trial.store(false, Ordering::SeqCst);
        self.ensure_watcher();
    }

    // ---- an offer ----------------------------------------------------------------------------------------------------

    /// An offered release (checked by the core): starts the download and the switch on a thread of its own, unless the
    /// rules say not now. `busy` says whether a session runs; it is asked again just before the switch.
    pub fn offer(self: &Arc<Self>, note: &MacNote, busy: Arc<dyn Fn() -> bool + Send + Sync>) -> Result<(), Skip> {
        if self.working.load(Ordering::SeqCst) {
            return Err(Skip::Working);
        }
        {
            let last = self.last_try.lock().unwrap();
            let st = load(&self.places.data);
            take_offer(&note.version, &self.version, st.as_ref(), busy(), last.as_ref().map(|(v, at)| (v.as_str(), *at)), self.mono(), &self.timing)?;
        }
        if self.working.swap(true, Ordering::SeqCst) {
            return Err(Skip::Working);
        }
        *self.last_try.lock().unwrap() = Some((note.version.clone(), self.mono()));
        let me = self.clone();
        let note = note.clone();
        std::thread::spawn(move || {
            match me.attempt(&note, &*busy) {
                // The watcher restarts this service: nothing more is started here.
                Ok(()) => {}
                Err(reason) => {
                    eprintln!("support: update to {} not taken: {reason}", note.version);
                    me.note_error(&note.version, &reason);
                    // A session that started meanwhile is no fault of the release: the next check-in may try again.
                    if reason == SESSION_STARTED {
                        *me.last_try.lock().unwrap() = None;
                    }
                    me.working.store(false, Ordering::SeqCst);
                }
            }
        });
        Ok(())
    }

    fn note_error(&self, version: &str, reason: &str) {
        if let Some(_l) = lock(&self.places.data, Duration::from_secs(5)) {
            if let Some(mut st) = load(&self.places.data) {
                st.last_error = Some(LastError { version: version.into(), reason: support_core::wire::clean(reason, 300), at: self.now() });
                let _ = save(&self.places.data, &st);
            }
        }
    }

    /// Downloads, checks and switches to the note's release. Blocking. On success the watcher is loaded and restarts this
    /// service; on any failure nothing has changed and the staging folder is gone.
    pub fn attempt(&self, note: &MacNote, busy: &dyn Fn() -> bool) -> Result<(), String> {
        let stage = StageDir::new(&self.places.data)?;
        let pkg = stage.dir.join(format!("Support-{}.pkg", note.version));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        rt.block_on(download::download(note, &pkg, &self.policy, &self.stop)).map_err(|e| e.to_string())?;
        drop(rt);
        // Read back from disk, where only root can write: still the note's bytes.
        if !download::file_matches(&pkg, note) {
            return Err("the saved package is not the one the note names".into());
        }
        let expanded = stage.dir.join("expanded");
        self.sys.expand(&pkg, &expanded)?;
        let app = payload_app(&expanded);
        if let Some(p) = app_problem(&app, &note.version) {
            return Err(p);
        }
        install::make_roots(&app)?;
        self.sys.verify_code(&app).map_err(|e| format!("the package's app is not signed as this one is: {e}"))?;
        self.switch(&app, &note.version, busy)
    }

    /// The switch, under the lock: the trial is written, the new app swapped in, the old one kept in previous/, and the
    /// watcher loaded from that copy. Anything that fails puts everything back as it was.
    pub fn switch(&self, staged: &Path, version: &str, busy: &dyn Fn() -> bool) -> Result<(), String> {
        let _l = lock(&self.places.data, Duration::ZERO).ok_or("an update, install or rollback is under way")?;
        let mut st = load(&self.places.data).ok_or("update.json cannot be read now")?;
        if st.in_trial() {
            return Err("a trial is open".into());
        }
        if busy() {
            return Err(SESSION_STARTED.into());
        }
        let prev_dir = self.places.data.join(PREVIOUS_DIR);
        state::ensure_dir(&prev_dir, me())?;
        let (current, previous) = (self.places.current(), self.places.previous());
        install::remove_tree(&previous);
        st.trial = Some(Trial {
            phase: Phase::Trial,
            from_version: self.version.clone(),
            version: version.to_string(),
            deadline: self.now() + self.timing.trial_ms,
            started: false,
        });
        save(&self.places.data, &st)?;
        let undo = |st: &mut UpdateState| {
            st.trial = None;
            let _ = save(&self.places.data, st);
        };
        // One step: /Applications/Support.app is never missing.
        if let Err(e) = install::swap(staged, &current) {
            undo(&mut st);
            return Err(format!("the new app could not be put in place: {e}"));
        }
        if let Err(e) = fs::rename(staged, &previous) {
            let _ = install::swap(staged, &current);
            undo(&mut st);
            return Err(format!("the old app could not be kept: {e}"));
        }
        let watcher = previous.join("Contents/MacOS/support");
        let loaded = state::write_atomic(&self.places.watch_plist, watch_plist(&watcher.to_string_lossy(), true).as_bytes())
            .and_then(|()| make_readable(&self.places.watch_plist))
            .and_then(|()| self.sys.load_watcher(&self.places.watch_plist));
        if let Err(e) = loaded {
            let _ = install::swap(&previous, &current);
            install::remove_tree(&previous);
            let _ = fs::remove_file(&self.places.watch_plist);
            undo(&mut st);
            return Err(format!("the update watcher could not be started: {e}"));
        }
        Ok(())
    }

    // ---- the watcher -------------------------------------------------------------------------------------------------

    /// The `update-watch` role, from the old app's copy. `restart` (the switch): first restart the service and the
    /// helpers, so the new version runs. Then watch the trial until it is committed, or roll it back when the new
    /// version asks or when it is still open at its deadline. Returns the exit code.
    pub fn watch(&self, restart: bool) -> i32 {
        let Some(st) = load(&self.places.data) else { return 1 };
        let Some(t) = st.trial.clone() else {
            let _ = fs::remove_file(&self.places.watch_plist);
            return 0;
        };
        // At boot the property list is loaded again: a new version that already ran is not restarted.
        if restart && t.phase == Phase::Trial && !t.started {
            if let Err(e) = self.sys.restart_service() {
                eprintln!("support: could not restart the service: {e}");
            }
            self.sys.restart_helpers(std::process::id() as i32);
        }
        let begun = Instant::now();
        loop {
            if self.stop.wait(self.timing.poll) {
                return 0;
            }
            let Some(now_st) = load(&self.places.data) else { continue };
            let watched = begun.elapsed().as_millis() as i64;
            let due = match now_st.trial_of(&t.version) {
                None => {
                    let _ = fs::remove_file(&self.places.watch_plist);
                    return 0;
                }
                Some(n) if n.phase == Phase::Rollback => true,
                Some(n) => watch_due(n.deadline, self.now(), watched, &self.timing),
            };
            if !due {
                continue;
            }
            let Some(_l) = lock(&self.places.data, Duration::from_secs(60)) else { continue };
            match self.rollback_locked(&t.version) {
                Ok(_) => {
                    let _ = fs::remove_file(&self.places.watch_plist);
                    return 0;
                }
                Err(e) => eprintln!("support: rollback of {} not finished: {e}", t.version),
            }
        }
    }

    /// Puts the old version back; the caller holds the lock. The version is recorded as failed first, so even a rollback
    /// cut short never takes it again. Only a rollback that put the old app back closes the trial; otherwise it stays in
    /// its rollback phase and the next watcher (or the old version's next start) finishes it.
    pub fn rollback_locked(&self, version: &str) -> Result<Rolled, String> {
        let mut st = load(&self.places.data).ok_or("update.json cannot be read now")?;
        let Some(t) = st.trial_of(version).cloned() else { return Ok(Rolled::NoTrial) };
        if t.phase == Phase::Trial {
            if let Some(x) = st.trial.as_mut() {
                x.phase = Phase::Rollback;
            }
            st.add_failed(version);
            save(&self.places.data, &st)?;
        }
        let (current, previous) = (self.places.current(), self.places.previous());
        let gone = !fs::symlink_metadata(&previous).is_ok_and(|m| m.file_type().is_dir());
        let line = if gone {
            format!("Support couldn't update to version {version}.")
        } else {
            install::swap(&previous, &current).map_err(|e| format!("the old app could not be put back: {e}"))?;
            // previous/ now holds the version that failed: it goes.
            install::remove_tree(&previous);
            format!("Support couldn't update to version {version}, so it went back to version {}.", t.from_version)
        };
        self.history(&line);
        let mut st = load(&self.places.data).ok_or("update.json cannot be read now")?;
        st.trial = None;
        save(&self.places.data, &st)?;
        // The service starts again on what is in /Applications now, and reads the history line from disk.
        if let Err(e) = self.sys.restart_service() {
            eprintln!("support: could not restart the service: {e}");
        }
        self.sys.restart_helpers(std::process::id() as i32);
        Ok(if gone { Rolled::Gone } else { Rolled::Back })
    }
}

fn me() -> u32 {
    // SAFETY: a getter.
    unsafe { libc::geteuid() }
}

/// launchd reads a daemon's property list only when it is root's and nobody else can write it: 0644.
fn make_readable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o644)).map_err(|e| format!("{}: {e}", path.display()))
}

/// A new folder for one update, only for root, under `<data>/staging/`. Removed when dropped, never through a link.
struct StageDir {
    dir: PathBuf,
}

impl StageDir {
    fn new(data: &Path) -> Result<StageDir, String> {
        state::ensure_dir(data, me())?;
        let root = data.join(paths::STAGING_DIR);
        state::ensure_dir(&root, me())?;
        for n in 0..100u32 {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let dir = root.join(format!("update-{}-{nanos}-{n}", std::process::id()));
            match fs::DirBuilder::new().mode(0o700).create(&dir) {
                Ok(()) => {
                    let m = fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
                    if !m.file_type().is_dir() || m.uid() != me() {
                        return Err("the staging folder is not root's".into());
                    }
                    return Ok(StageDir { dir });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("{}: {e}", dir.display())),
            }
        }
        Err("could not make a staging folder".into())
    }
}

impl Drop for StageDir {
    fn drop(&mut self) {
        install::remove_tree(&self.dir);
    }
}

#[cfg(test)]
mod tests;

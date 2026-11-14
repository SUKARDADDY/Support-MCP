//! The `device-service` role: the root LaunchDaemon. It pairs (on a setup request), runs the core's `DeviceService`
//! (check-ins, the doorbell, the session the relay points to), hosts the socket for its helpers, and is the core's
//! `Platform`:
//!
//! - `run` as the signed-in person (`launchctl asuser` and the `run-as` role) or, under full control, as root;
//! - files as the person (the `file-op` role) under limited control, or as root through `safe_files`;
//! - the screen through the helper of the person at the console (or the login window's, as root), with this Mac's
//!   own error when there is no helper or a permission is missing, never a black image;
//! - restart and shut down (refused while FileVault is on), and list and close programs.
//!
//! Under limited control a session is pinned to the person who allowed it (or who was signed in when it started):
//! once someone else is at the console, nothing runs, no file is opened and no screen is touched until they are back.
//! Everything that touches macOS itself is behind `Os`, so this runs and is tested on Linux.

use crate::as_user;
use crate::ipc::{self, SetupRequest, ToHelper};
use crate::peer::{Inspector, Peer};
use crate::power::{self, FileVault, PowerLatch};
use crate::programs::{self, Proc};
use crate::role::FileOp;
use crate::safe_files;
use crate::server::{Api, BoxFuture, HelperError, Helpers, Server};
use crate::setup;
use crate::state::{self, DeviceState};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use support_core::clock::SystemClock;
use support_core::device::{DeviceConfig, DeviceLink, DeviceService, DoorbellConfig, Hooks, Identity};
use support_core::exec::{self, RunOutput};
use support_core::files::FileChunk;
use support_core::keys::KeyCombo;
use support_core::platform::{Desktop, Platform, RunRequest, ScreenOutput, ASK_MARGIN_MS, ASK_MS};
use support_core::session::Target;
use support_core::stop::Stop;
use support_core::wire::{Control, Frame, HostInfo, ScreenAction};

pub const NO_HELPER: &str = "no screen helper is running for the signed-in user";
pub const NO_HELPER_LOGIN: &str = "no screen helper is running at the login window";
pub const SOMEONE_ELSE: &str = "another person is signed in at this Mac now; this session works only while the person who allowed it is";
pub const NOBODY: &str = "nobody is signed in to this Mac";
pub const NOT_ADMIN: &str = "An administrator's name and password are needed for this.";

/// What the service needs from macOS. The Mac's is `mac::os::MacOs`; tests use a fake.
pub trait Os: Send + Sync + 'static {
    /// The uid of the person at the console, None at the login window.
    fn console_uid(&self) -> Option<u32>;
    fn user_name(&self, uid: u32) -> Option<String> {
        as_user::account(uid).map(|a| a.name)
    }
    /// os, machine and app_version for pairing and check-ins.
    fn identity(&self) -> Identity;
    fn filevault(&self) -> FileVault;
    /// Restarts or shuts down now.
    fn power(&self, restart: bool) -> Result<(), String>;
    fn processes(&self) -> Vec<Proc>;
    /// Where list_programs looks.
    fn apps_dir(&self) -> PathBuf {
        PathBuf::from("/Applications")
    }
    /// The external form of an AuthorizationRef holds `system.privilege.admin`, and (for a person's peer) an
    /// administrator authenticated for it. Checked by this process, never taken on the word of whoever sent it.
    fn verify_admin(&self, auth: &[u8; ipc::AUTH_LEN], peer: Peer) -> Result<(), String>;
    /// A person's command (zsh in their home folder, in their bootstrap).
    fn user_command(&self, uid: u32, command: &str) -> Command;
    fn root_command(&self, command: &str) -> Command {
        as_user::root_command(command)
    }
    /// A file read or write as the person.
    fn file_as_user(&self, uid: u32, op: &FileOp, input: &[u8]) -> Result<Value, String>;
    /// Starts the last step of an uninstall (the jobs, the files, the permissions), detached from this service.
    fn uninstall_finish(&self) -> Result<(), String>;
}

/// The session's state on this Mac that the platform and the hooks share.
#[derive(Default)]
struct Live {
    /// Sessions started and not yet ended. A session the relay replaced may report its end after the new one
    /// started, so the record is cleared only when none is left.
    count: usize,
    /// Who drives it and since when (Unix ms), while one is hosted.
    by: Option<(String, i64)>,
    /// Under limited control: the person it belongs to.
    pin: Option<u32>,
    /// The person who answered the last question, for the pin of the session that follows.
    asked: Option<u32>,
}

pub struct MacPlatform {
    os: Arc<dyn Os>,
    helpers: Arc<Helpers>,
    live: Mutex<Live>,
    device: Mutex<Weak<DeviceService>>,
    /// The control a new hello reports before the device service exists (setup's answer).
    control: Mutex<String>,
    latch: Arc<PowerLatch>,
    own_pid: i32,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The screen actions that take a picture, and those that send input.
fn captures(a: &ScreenAction) -> bool {
    matches!(a.name.as_str(), "screenshot" | "zoom" | "wait")
}

fn inputs(a: &ScreenAction) -> bool {
    matches!(a.name.as_str(), "click" | "move" | "drag" | "scroll" | "type" | "type_secret" | "key")
}

/// The text for missing permissions (research file, section 2.5).
pub fn permission_text(screen: bool, accessibility: bool) -> Option<String> {
    let which = match (screen, accessibility) {
        (true, true) => return None,
        (false, true) => "Screen Recording",
        (true, false) => "Accessibility",
        (false, false) => "Screen Recording and Accessibility",
    };
    Some(format!("screen permission needed: {which}; someone at the Mac must allow Support in System Settings, Privacy & Security"))
}

/// How long the helper may take for an action: typing takes 20 ms a character, a wait its seconds.
fn screen_timeout(a: &ScreenAction) -> Duration {
    let base = Duration::from_secs(30);
    match a.name.as_str() {
        "type" | "type_secret" => base + Duration::from_millis(a.text.chars().count() as u64 * 25),
        "wait" => base + Duration::from_secs_f64(a.seconds.clamp(0.0, 600.0)),
        _ => base,
    }
}

impl MacPlatform {
    pub fn new(os: Arc<dyn Os>, helpers: Arc<Helpers>, control: &str) -> Arc<MacPlatform> {
        Arc::new(MacPlatform {
            os,
            helpers,
            live: Mutex::default(),
            device: Mutex::new(Weak::new()),
            control: Mutex::new(control.to_string()),
            latch: PowerLatch::new(),
            own_pid: std::process::id() as i32,
        })
    }

    fn device(&self) -> Option<Arc<DeviceService>> {
        self.device.lock().unwrap().upgrade()
    }

    fn limited(&self) -> bool {
        let control = self.device().map(|d| d.control()).unwrap_or_else(|| self.control.lock().unwrap().clone());
        control != "full"
    }

    /// The person a limited session works for, if they are at the console now.
    fn person(&self) -> Result<u32, String> {
        let console = self.os.console_uid();
        let pin = self.live.lock().unwrap().pin;
        match (pin, console) {
            (Some(p), Some(c)) if p == c => Ok(p),
            (Some(_), _) => Err(SOMEONE_ELSE.into()),
            (None, Some(c)) => Ok(c),
            (None, None) => Err(NOBODY.into()),
        }
    }

    /// The uid whose helper does the screen: the person under limited control, else whoever is at the console, or
    /// root's at the login window.
    fn screen_uid(&self) -> Result<u32, String> {
        if self.limited() {
            return self.person();
        }
        Ok(self.os.console_uid().unwrap_or(0))
    }

    fn helper_error(&self, e: HelperError, uid: u32) -> String {
        match e {
            HelperError::None | HelperError::Gone if uid == 0 => NO_HELPER_LOGIN.into(),
            HelperError::None | HelperError::Gone => NO_HELPER.into(),
            HelperError::Timeout => "the screen helper did not answer in time".into(),
            HelperError::Stopped => "stopped".into(),
        }
    }

    /// The hooks call this as a session starts (`by`) and ends (None).
    fn session(&self, by: Option<&str>) {
        let mut l = self.live.lock().unwrap();
        match by {
            Some(by) => {
                l.count += 1;
                l.by = Some((by.to_string(), now_ms()));
                l.pin = l.asked.take().or_else(|| self.os.console_uid());
            }
            None => {
                l.count = l.count.saturating_sub(1);
                if l.count == 0 {
                    *l = Live::default();
                }
            }
        }
    }

    fn live_by(&self) -> Option<(String, i64)> {
        self.live.lock().unwrap().by.clone()
    }
}

struct HelperCloser<'a> {
    p: &'a MacPlatform,
}

impl programs::Closer for HelperCloser<'_> {
    fn ask_quit(&self, pids: &[i32]) -> Vec<i32> {
        let Some(uid) = self.p.os.console_uid() else { return vec![] };
        let stop = Stop::new();
        let list = pids.to_vec();
        match self.p.helpers.request(uid, |id| ToHelper::CloseApps { id, pids: list }, Duration::from_secs(5), &stop) {
            Ok(body) => ipc::read_close_reply(&body, pids).unwrap_or_default(),
            Err(_) => vec![],
        }
    }
    fn signal(&self, pid: i32, sig: i32) {
        if pid > 1 {
            // SAFETY: kill(2) on one positive pid.
            unsafe {
                libc::kill(pid, sig);
            }
        }
    }
    fn alive(&self, pid: i32) -> bool {
        // SAFETY: signal 0 only checks the process exists.
        unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
    }
}

impl Platform for MacPlatform {
    fn info(&self) -> HostInfo {
        let id = self.os.identity();
        let user = self.os.console_uid().and_then(|u| self.os.user_name(u)).unwrap_or_default();
        HostInfo {
            machine: id.machine,
            user,
            // SAFETY: a getter.
            elevated: unsafe { libc::geteuid() } == 0,
            control: if self.limited() { Control::Normal } else { Control::Full },
            uia: false,
        }
    }

    fn run(&self, req: &RunRequest, stop: &Stop) -> Result<RunOutput, String> {
        let mut cmd = if req.as_system {
            if self.limited() {
                return Err("as: \"system\" needs full control".into());
            }
            self.os.root_command(&req.command)
        } else {
            let uid = self.person().map_err(|e| if e == NOBODY && !self.limited() { format!("{NOBODY}; use as: \"system\"") } else { e })?;
            self.os.user_command(uid, &req.command)
        };
        exec::run(&mut cmd, Duration::from_secs(req.timeout_s), stop)
    }

    fn put_file(&self, path: &str, data: &[u8], append: bool) -> Result<usize, String> {
        if !self.limited() {
            return safe_files::put(path, data, append);
        }
        let uid = self.person()?;
        let v = self.os.file_as_user(uid, &FileOp::Put { path: path.into(), append }, data)?;
        v.get("bytes").and_then(Value::as_u64).map(|n| n as usize).ok_or_else(|| "the file helper gave no answer".into())
    }

    fn get_file(&self, path: &str, offset: u64, length: usize) -> Result<FileChunk, String> {
        if !self.limited() {
            return safe_files::get(path, offset, length);
        }
        let uid = self.person()?;
        let v = self.os.file_as_user(uid, &FileOp::Get { path: path.into(), offset, length }, &[])?;
        let data = v.get("data").and_then(Value::as_str).and_then(|t| B64.decode(t).ok()).ok_or("the file helper gave no answer")?;
        Ok(FileChunk { data, size: v["size"].as_u64().unwrap_or(0), eof: v["eof"].as_bool().unwrap_or(true) })
    }

    fn screen(&self, action: &ScreenAction, _keys: &[KeyCombo], stop: &Stop) -> Result<ScreenOutput, String> {
        let uid = self.screen_uid()?;
        let helper = self.helpers.get(uid).ok_or_else(|| self.helper_error(HelperError::None, uid))?;
        // The permissions the helper last reported. Without a fresh tick, ask it anyway: it answers for itself.
        if let Some(t) = helper.tick() {
            let need_screen = captures(action);
            let need_input = inputs(action);
            if let Some(text) = permission_text(t.screen || !need_screen, t.accessibility || !need_input) {
                return Err(text);
            }
        }
        // The helper parses the action (and its keys) again with the same code; nothing it gets is trusted more.
        let body = self
            .helpers
            .request(uid, |id| ToHelper::Screen { id, action: ipc::action_json(action) }, screen_timeout(action), stop)
            .map_err(|e| self.helper_error(e, uid))?;
        ipc::read_screen_reply(&body)
    }

    fn power(&self, action: &str, delay_s: i64) -> Result<i64, String> {
        if let Some(refusal) = power::refusal(action, || self.os.filevault()) {
            return Err(refusal.to_string());
        }
        let os = self.os.clone();
        let restart = action == "restart";
        power::schedule(&self.latch, delay_s, now_ms() / 1000, move || os.power(restart))
    }

    fn programs(&self, frame: &Frame) -> Result<Value, String> {
        match frame.text("action").as_str() {
            "list" => Ok(programs::list_result(&programs::installed(&self.os.apps_dir()), &self.os.processes())),
            "close" => {
                let limited = self.limited();
                let console = if limited { Some(self.person()?) } else { self.os.console_uid() };
                let stop = Stop::new();
                programs::close(frame, &self.os.processes(), console, limited, self.own_pid, &HelperCloser { p: self }, &stop)
            }
            _ => Err("unknown programs action".into()),
        }
    }

    fn close_target(&self, frame: &Frame) -> Option<String> {
        match programs::target_of(frame) {
            (Some(name), _) => Some(name),
            (None, Some(pid)) => self.os.processes().into_iter().find(|p| p.pid == pid).map(|p| p.name().to_string()),
            (None, None) => None,
        }
    }

    fn session_target(&self) -> Target {
        if self.os.console_uid().is_some() {
            Target::Console
        } else {
            Target::Nobody
        }
    }

    fn desktop(&self) -> Desktop {
        let Some(uid) = self.os.console_uid() else { return Desktop::Secure };
        match self.helpers.get(uid).and_then(|h| h.tick()) {
            Some(t) if t.locked => Desktop::Secure,
            Some(_) => Desktop::Default,
            None => Desktop::Unknown,
        }
    }

    fn paused_until_ms(&self) -> Option<i64> {
        let uid = self.screen_uid().ok()?;
        let t = self.helpers.get(uid)?.tick()?;
        let pause = support_core::geometry::CUSTOMER_PAUSE_MS as i64;
        (0..pause).contains(&t.customer_ago_ms).then(|| now_ms() + pause - t.customer_ago_ms)
    }

    fn ask(&self, by: &str, team: &str, full: bool, stop: &Stop) -> bool {
        let Some(uid) = self.os.console_uid() else { return false };
        let (by, team) = (by.to_string(), team.to_string());
        let limit = Duration::from_millis(ASK_MS + ASK_MARGIN_MS / 2);
        let yes = match self.helpers.request(uid, |id| ToHelper::Ask { id, by, team, full }, limit, stop) {
            Ok(body) => ipc::read_ask_reply(&body).unwrap_or(false),
            Err(_) => false,
        };
        // The answer counts only if the same person is still at the console.
        let yes = yes && self.os.console_uid() == Some(uid);
        if yes {
            self.live.lock().unwrap().asked = Some(uid);
        }
        yes
    }
}

// ---- the service ------------------------------------------------------------------------------------------------

pub struct Service {
    os: Arc<dyn Os>,
    dir: PathBuf,
    state: Mutex<Option<DeviceState>>,
    history: Mutex<Vec<String>>,
    pub platform: Arc<MacPlatform>,
    device: Mutex<Option<Arc<DeviceService>>>,
    /// One setup or uninstall at a time.
    busy: tokio::sync::Mutex<()>,
    runtime: tokio::runtime::Handle,
}

struct ServiceHooks {
    svc: Weak<Service>,
}

impl Service {
    pub fn new(os: Arc<dyn Os>, helpers: Arc<Helpers>, dir: PathBuf, runtime: tokio::runtime::Handle) -> Arc<Service> {
        let saved = state::load(&dir);
        let history = state::load_history(&dir);
        let control = saved.as_ref().map(|s| s.control.clone()).unwrap_or_else(|| "limited".into());
        let platform = MacPlatform::new(os.clone(), helpers, &control);
        Arc::new(Service {
            os,
            dir,
            state: Mutex::new(saved),
            history: Mutex::new(history),
            platform,
            device: Mutex::new(None),
            busy: tokio::sync::Mutex::new(()),
            runtime,
        })
    }

    fn save(&self) {
        if let Some(s) = self.state.lock().unwrap().as_ref() {
            let _ = state::save(&self.dir, s);
        }
    }

    fn device(&self) -> Option<Arc<DeviceService>> {
        self.device.lock().unwrap().clone()
    }

    /// Starts the device service for the saved state, unless the Mac was removed.
    pub fn start_device(self: &Arc<Self>) -> Result<(), String> {
        let Some(s) = self.state.lock().unwrap().clone() else { return Ok(()) };
        if s.finished() {
            return Ok(());
        }
        let cfg = DeviceConfig {
            origin: s.origin.clone(),
            key: s.key.clone(),
            identity: self.os.identity(),
            access: s.access.clone(),
            control: s.control.clone(),
            accepted_session: s.accepted_session.clone(),
            doorbell: DoorbellConfig::default(),
        };
        *self.platform.control.lock().unwrap() = s.control.clone();
        let hooks = Arc::new(ServiceHooks { svc: Arc::downgrade(self) });
        let platform: Arc<dyn Platform> = self.platform.clone();
        let svc = DeviceService::new(cfg, platform, hooks, SystemClock::new(), s.rules.as_ref())?;
        *self.platform.device.lock().unwrap() = Arc::downgrade(&svc);
        *self.device.lock().unwrap() = Some(svc.clone());
        self.runtime.spawn(async move { svc.run().await });
        Ok(())
    }

    /// Stops the device service (a stopping LaunchDaemon, or an uninstall). The live session ends with `end`.
    pub async fn stop_device(&self) {
        let d = self.device.lock().unwrap().take();
        if let Some(d) = d {
            d.stop();
            let stop = d.stop_signal();
            let _ = tokio::time::timeout(Duration::from_secs(25), stop.stopped()).await;
            // The run loop ends its session and doorbell after the signal; give it a moment.
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    fn with_state(&self, f: impl FnOnce(&mut DeviceState)) {
        if let Some(s) = self.state.lock().unwrap().as_mut() {
            f(s);
        }
        self.save();
    }

    fn status_map(&self) -> Map<String, Value> {
        let s = self.state.lock().unwrap().clone();
        let d = self.device();
        let mut m = Map::new();
        m.insert("version".into(), json!(support_core::VERSION));
        m.insert("set_up".into(), json!(s.is_some()));
        if let Some(s) = s {
            let (access, control, st) = match &d {
                Some(d) => (d.access(), d.control(), d.state()),
                None => (s.access.clone(), s.control.clone(), s.state.clone()),
            };
            m.insert("name".into(), json!(s.name));
            m.insert("access".into(), json!(access));
            m.insert("control".into(), json!(control));
            m.insert("state".into(), json!(if s.finished() { s.state.clone() } else { st }));
            if let Some(c) = s.confirm.filter(|_| s.state == "pending") {
                m.insert("confirm".into(), json!(c));
            }
        } else {
            m.insert("state".into(), json!("not_set_up"));
        }
        m.insert("history".into(), json!(self.history.lock().unwrap().clone()));
        if let Some((by, since)) = self.platform.live_by() {
            m.insert("session".into(), json!({ "by": by, "since": since }));
        }
        m
    }

    async fn do_setup(self: Arc<Self>, req: SetupRequest, peer: Peer) -> Result<(), String> {
        let _one = self.busy.lock().await;
        let os = self.os.clone();
        let auth = req.auth;
        tokio::task::spawn_blocking(move || os.verify_admin(&auth, peer)).await.map_err(|_| NOT_ADMIN.to_string())??;
        if self.state.lock().unwrap().as_ref().is_some_and(|s| !s.finished()) {
            return Err("Support is already set up on this Mac.".into());
        }
        let link = setup::parse_link(&req.link, req.code.as_deref())?;
        let name = setup::check_name(&req.name)?;
        let saved = setup::pair(&link, &name, &req.access, &req.control, &self.os.identity()).await?;
        // A Mac set up again after it was removed starts without the old one's rules or history.
        state::save(&self.dir, &saved)?;
        *self.state.lock().unwrap() = Some(saved);
        self.history.lock().unwrap().clear();
        let _ = state::save_history(&self.dir, &[]);
        self.stop_device().await;
        self.start_device()
    }

    async fn do_uninstall(self: Arc<Self>, auth: [u8; ipc::AUTH_LEN], peer: Peer) -> Result<bool, String> {
        let _one = self.busy.lock().await;
        let os = self.os.clone();
        tokio::task::spawn_blocking(move || os.verify_admin(&auth, peer)).await.map_err(|_| NOT_ADMIN.to_string())??;
        self.stop_device().await;
        // Leave the team: a 200 or a 401 both mean this Mac is gone from the list.
        let saved = self.state.lock().unwrap().clone();
        let mut confirmed = true;
        if let Some(s) = saved.filter(|s| !s.finished()) {
            confirmed = match DeviceLink::new(&s.origin) {
                Ok(link) => {
                    let a = link.leave(&s.key).await;
                    a.status == 200 || a.status == 401
                }
                Err(_) => false,
            };
        }
        self.os.uninstall_finish()?;
        Ok(confirmed)
    }
}

impl Hooks for ServiceHooks {
    fn rules_changed(&self, saved: &Value) {
        if let Some(svc) = self.svc.upgrade() {
            let saved = saved.clone();
            svc.with_state(|s| s.rules = Some(saved));
        }
    }
    fn session_accepted(&self, id: &str) {
        if let Some(svc) = self.svc.upgrade() {
            svc.with_state(|s| s.accepted_session = Some(id.to_string()));
        }
    }
    fn history(&self, line: &str) {
        if let Some(svc) = self.svc.upgrade() {
            let mut h = svc.history.lock().unwrap();
            h.push(line.to_string());
            support_core::device::trim_history(&mut h);
            let _ = state::save_history(&svc.dir, &h);
        }
    }
    fn state(&self, st: &str) {
        if let Some(svc) = self.svc.upgrade() {
            svc.with_state(|s| {
                s.state = st.to_string();
                if st == "active" {
                    s.confirm = None;
                }
            });
        }
    }
    fn session(&self, by: Option<&str>) {
        if let Some(svc) = self.svc.upgrade() {
            svc.platform.session(by);
        }
    }
}

impl Api for Service {
    fn status(&self) -> Map<String, Value> {
        self.status_map()
    }

    fn refresh(&self) {
        if let Some(d) = self.device() {
            d.refresh();
        }
    }

    fn allow_any_time(&self) {
        let Some(d) = self.device() else { return };
        if d.access() != "ask" {
            return;
        }
        let Some(s) = self.state.lock().unwrap().clone() else { return };
        self.runtime.spawn(async move {
            if let Ok(link) = DeviceLink::new(&s.origin) {
                let a = link.update(&s.key, json!({ "access": "any" })).await;
                if a.is_ok() {
                    d.refresh();
                }
            }
        });
    }

    fn end_session(&self) {
        if let Some(d) = self.device() {
            d.end_session();
        }
    }

    fn setup(self: Arc<Self>, req: SetupRequest, peer: Peer) -> BoxFuture<'static, Map<String, Value>> {
        Box::pin(async move {
            let outcome = self.clone().do_setup(req, peer).await;
            let mut m = self.status_map();
            m.insert("ok".into(), json!(outcome.is_ok()));
            if let Err(e) = outcome {
                m.insert("error".into(), json!(e));
            }
            m
        })
    }

    fn uninstall(self: Arc<Self>, auth: [u8; ipc::AUTH_LEN], peer: Peer) -> BoxFuture<'static, Map<String, Value>> {
        Box::pin(async move {
            match self.do_uninstall(auth, peer).await {
                Ok(confirmed) => json!({ "ok": true, "relay_confirmed": confirmed }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
            .as_object()
            .cloned()
            .unwrap_or_default()
        })
    }
}

/// The role's body: the folder, the socket, the device service, until SIGTERM.
///
/// launchd sends SIGTERM when the Mac shuts down or restarts. The service then exits without ending the live session,
/// as the Windows service does at a shutdown: the session goes on after the restart, within its own end, and the
/// saved `accepted_session` lets the new service rejoin it without asking again. An uninstall ends the session
/// itself first.
pub async fn run(os: Arc<dyn Os>, inspector: Arc<dyn Inspector>, dir: PathBuf, owner: u32) -> Result<(), String> {
    state::ensure_dir(&dir, owner)?;
    let helpers = Helpers::new();
    let svc = Service::new(os, helpers.clone(), dir, tokio::runtime::Handle::current());
    let listener = crate::server::bind(std::path::Path::new(crate::paths::SOCKET_DIR), std::path::Path::new(crate::paths::SOCKET_PATH), owner)?;
    let api: Arc<dyn Api> = svc.clone();
    let server = Server::new(inspector, api, helpers, crate::paths::BINARY_PATH);
    let stop = Stop::new();
    tokio::spawn(server.serve(listener, stop.clone()));
    svc.start_device()?;
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| e.to_string())?;
    term.recv().await;
    stop.set();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame;
    use crate::ipc::Tick;
    use crate::peer::PeerFacts;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::net::UnixStream;

    const BIN: &str = "/Applications/Support.app/Contents/MacOS/support";

    struct FakeOs {
        console: Mutex<Option<u32>>,
        filevault: Mutex<FileVault>,
        powered: Mutex<Vec<bool>>,
        admin_ok: AtomicBool,
        files: Mutex<Vec<String>>,
    }

    impl Os for FakeOs {
        fn console_uid(&self) -> Option<u32> {
            *self.console.lock().unwrap()
        }
        fn user_name(&self, uid: u32) -> Option<String> {
            Some(format!("user{uid}"))
        }
        fn identity(&self) -> Identity {
            Identity { os: "macOS 26.1 (25B78)".into(), machine: "Test-Mac".into(), app_version: support_core::VERSION.into() }
        }
        fn filevault(&self) -> FileVault {
            *self.filevault.lock().unwrap()
        }
        fn power(&self, restart: bool) -> Result<(), String> {
            self.powered.lock().unwrap().push(restart);
            Ok(())
        }
        fn processes(&self) -> Vec<Proc> {
            vec![Proc { pid: 4000, uid: 501, path: "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit".into() }]
        }
        fn verify_admin(&self, _auth: &[u8; 32], _peer: Peer) -> Result<(), String> {
            if self.admin_ok.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(NOT_ADMIN.into())
            }
        }
        fn user_command(&self, uid: u32, command: &str) -> Command {
            let mut c = Command::new("sh");
            c.arg("-c").arg(format!("echo as {uid}; {command}"));
            c
        }
        fn root_command(&self, command: &str) -> Command {
            let mut c = Command::new("sh");
            c.arg("-c").arg(format!("echo as root; {command}"));
            c
        }
        fn file_as_user(&self, uid: u32, op: &FileOp, _input: &[u8]) -> Result<Value, String> {
            self.files.lock().unwrap().push(format!("{uid} {op:?}"));
            match op {
                FileOp::Put { .. } => Ok(json!({"bytes": 3})),
                FileOp::Get { .. } => Ok(json!({"data":"YWJj","size":3,"eof":true})),
            }
        }
        fn uninstall_finish(&self) -> Result<(), String> {
            Ok(())
        }
    }

    fn fake_os() -> Arc<FakeOs> {
        Arc::new(FakeOs {
            console: Mutex::new(Some(501)),
            filevault: Mutex::new(FileVault::Off),
            powered: Mutex::default(),
            admin_ok: AtomicBool::new(false),
            files: Mutex::default(),
        })
    }

    struct Insp {
        os: Arc<FakeOs>,
        uid: Mutex<u32>,
    }

    impl Inspector for Insp {
        fn inspect(&self, _fd: std::os::fd::RawFd) -> Result<PeerFacts, String> {
            Ok(PeerFacts { pid: 400, uid: *self.uid.lock().unwrap(), exe: Some(BIN.into()), code_path: Some(BIN.into()), signature_ok: true })
        }
        fn console_uid(&self) -> Option<u32> {
            self.os.console_uid()
        }
    }

    struct Rig {
        os: Arc<FakeOs>,
        svc: Arc<Service>,
        sock: PathBuf,
        dir: PathBuf,
        stop: Arc<Stop>,
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            self.stop.set();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn rig(name: &str, control: &str) -> Rig {
        // A short folder: a socket path is at most 104 bytes on a Mac, and its temp folder is long.
        let dir = PathBuf::from(format!("/tmp/smcp-svc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let os = fake_os();
        let helpers = Helpers::new();
        let data = dir.join("data");
        state::ensure_dir(&data, unsafe { libc::getuid() }).unwrap();
        let svc = Service::new(os.clone(), helpers.clone(), data, tokio::runtime::Handle::current());
        *svc.platform.control.lock().unwrap() = control.to_string();
        let sock = dir.join("s/helper.sock");
        let listener = crate::server::bind(&dir.join("s"), &sock, unsafe { libc::getuid() }).unwrap();
        let api: Arc<dyn Api> = svc.clone();
        let server = Server::new(Arc::new(Insp { os: os.clone(), uid: Mutex::new(501) }), api, helpers, BIN);
        let stop = Stop::new();
        tokio::spawn(server.serve(listener, stop.clone()));
        Rig { os, svc, sock, dir, stop }
    }

    /// A helper that reports `tick` and answers screen requests with a 2x2 picture, asks with `answer`.
    async fn helper(sock: &std::path::Path, tick: Tick, answer: bool) {
        let mut s = UnixStream::connect(sock).await.unwrap();
        frame::write(&mut s, &ipc::opening_helper(ipc::HelperSession::Aqua)).await.unwrap();
        frame::write(&mut s, &ipc::tick_message(&tick)).await.unwrap();
        tokio::spawn(async move {
            while let Ok(m) = frame::read(&mut s, Some(Duration::from_secs(5))).await {
                let reply = match ipc::read_to_helper(&m) {
                    Some(ToHelper::Screen { id, action }) => {
                        let a = ScreenAction::parse(&action);
                        let out = ScreenOutput {
                            image: Some(support_core::platform::Image { bytes: vec![0xff, 0xd8, 0xff], mime: "image/jpeg", width: 2, height: 2 }),
                            display: 0,
                            displays: 1,
                            desktop: Desktop::Default,
                            text: Some(format!("did {}", a.name)),
                        };
                        ipc::reply_message(id, ipc::screen_reply(Ok(out)))
                    }
                    Some(ToHelper::Ask { id, .. }) => ipc::reply_message(id, json!({"answer": answer}).as_object().unwrap().clone()),
                    Some(ToHelper::CloseApps { id, pids }) => ipc::reply_message(id, json!({"asked": pids}).as_object().unwrap().clone()),
                    _ => continue,
                };
                let _ = frame::write(&mut s, &ipc::tick_message(&tick)).await;
                if frame::write(&mut s, &reply).await.is_err() {
                    break;
                }
            }
        });
    }

    async fn wait_helper(svc: &Arc<Service>, uid: u32) {
        for _ in 0..100 {
            if svc.platform.helpers.get(uid).and_then(|h| h.tick()).is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("no helper");
    }

    fn on_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> tokio::task::JoinHandle<T> {
        tokio::task::spawn_blocking(f)
    }

    const ALL: Tick = Tick { screen: true, accessibility: true, customer_ago_ms: -1, locked: false };

    #[tokio::test]
    async fn the_hello_says_who_is_signed_in_and_the_control() {
        let r = rig("info", "full").await;
        let info = r.svc.platform.info();
        assert_eq!((info.machine.as_str(), info.user.as_str(), info.control, info.uia), ("Test-Mac", "user501", Control::Full, false));
        *r.os.console.lock().unwrap() = None;
        assert_eq!(r.svc.platform.info().user, "", "nobody at the login window");
        let hello = support_core::wire::hello(&r.svc.platform.info(), "1.0.0");
        assert_eq!(hello["caps"], json!(["screen", "lanes", "full"]), "screen and lanes even with no helper");
    }

    #[tokio::test]
    async fn a_screen_action_goes_to_the_persons_helper() {
        let r = rig("screen", "limited").await;
        helper(&r.sock, ALL, true).await;
        wait_helper(&r.svc, 501).await;
        let p = r.svc.platform.clone();
        let out = on_thread(move || {
            let stop = Stop::new();
            p.screen(&ScreenAction::parse(&json!({"name":"screenshot"})), &[], &stop)
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!((out.image.unwrap().width, out.text.as_deref()), (2, Some("did screenshot")));
    }

    #[tokio::test]
    async fn no_helper_or_a_missing_permission_is_the_macs_own_error_never_a_picture() {
        let r = rig("noperm", "full").await;
        let p = r.svc.platform.clone();
        let shot = |p: Arc<MacPlatform>, name: &'static str| {
            on_thread(move || {
                let stop = Stop::new();
                p.screen(&ScreenAction::parse(&json!({"name":name,"x":1,"y":1})), &[], &stop)
            })
        };
        assert_eq!(shot(p.clone(), "screenshot").await.unwrap().unwrap_err(), NO_HELPER);
        *r.os.console.lock().unwrap() = None;
        assert_eq!(shot(p.clone(), "screenshot").await.unwrap().unwrap_err(), NO_HELPER_LOGIN);
        *r.os.console.lock().unwrap() = Some(501);
        helper(&r.sock, Tick { screen: false, accessibility: true, customer_ago_ms: -1, locked: false }, true).await;
        wait_helper(&r.svc, 501).await;
        assert_eq!(
            shot(p.clone(), "screenshot").await.unwrap().unwrap_err(),
            "screen permission needed: Screen Recording; someone at the Mac must allow Support in System Settings, Privacy & Security"
        );
        // A click needs Accessibility, which it has; the helper then says it could not take the picture.
        assert!(shot(p.clone(), "click").await.unwrap().is_ok());
        assert_eq!(
            permission_text(true, false).unwrap(),
            "screen permission needed: Accessibility; someone at the Mac must allow Support in System Settings, Privacy & Security"
        );
        assert!(permission_text(false, false).unwrap().contains("Screen Recording and Accessibility"));
    }

    #[tokio::test]
    async fn a_limited_session_is_pinned_to_the_person_who_allowed_it() {
        let r = rig("pin", "limited").await;
        helper(&r.sock, ALL, true).await;
        wait_helper(&r.svc, 501).await;
        let p = r.svc.platform.clone();
        let asked = on_thread({
            let p = p.clone();
            move || p.ask("Dana", "Team", false, &Stop::new())
        })
        .await
        .unwrap();
        assert!(asked);
        p.session(Some("Dana"));
        let run = |p: Arc<MacPlatform>, sys: bool| {
            on_thread(move || p.run(&RunRequest { command: "true".into(), timeout_s: 5, as_system: sys }, &Stop::new()))
        };
        let out = run(p.clone(), false).await.unwrap().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "as 501\n");
        assert_eq!(run(p.clone(), true).await.unwrap().unwrap_err(), "as: \"system\" needs full control");
        // Someone else comes to the console: nothing works for them.
        *r.os.console.lock().unwrap() = Some(502);
        assert_eq!(run(p.clone(), false).await.unwrap().unwrap_err(), SOMEONE_ELSE);
        assert_eq!(p.put_file("/Users/x/f", b"abc", false).unwrap_err(), SOMEONE_ELSE);
        let shot = on_thread({
            let p = p.clone();
            move || p.screen(&ScreenAction::parse(&json!({"name":"screenshot"})), &[], &Stop::new())
        });
        assert_eq!(shot.await.unwrap().unwrap_err(), SOMEONE_ELSE);
        // Back: works again, files as that person.
        *r.os.console.lock().unwrap() = Some(501);
        assert_eq!(p.put_file("/Users/x/f", b"abc", false).unwrap(), 3);
        assert_eq!(p.get_file("/Users/x/f", 0, 10).unwrap().data, b"abc");
        assert!(r.os.files.lock().unwrap()[0].starts_with("501 Put"));
        p.session(None);
        assert!(p.live_by().is_none());
        // A replaced session's end that comes after the new one started leaves the new one's record.
        p.session(Some("Old"));
        p.session(Some("New"));
        p.session(None);
        assert_eq!(p.live_by().map(|(by, _)| by).as_deref(), Some("New"));
        p.session(None);
        assert!(p.live_by().is_none());
    }

    #[tokio::test]
    async fn full_control_runs_as_root_or_as_whoever_is_at_the_console() {
        let r = rig("full", "full").await;
        let p = r.svc.platform.clone();
        let out = on_thread({
            let p = p.clone();
            move || p.run(&RunRequest { command: "true".into(), timeout_s: 5, as_system: true }, &Stop::new())
        });
        assert_eq!(String::from_utf8_lossy(&out.await.unwrap().unwrap().stdout), "as root\n");
        *r.os.console.lock().unwrap() = None;
        let e = on_thread({
            let p = p.clone();
            move || p.run(&RunRequest { command: "true".into(), timeout_s: 5, as_system: false }, &Stop::new())
        });
        assert_eq!(e.await.unwrap().unwrap_err(), "nobody is signed in to this Mac; use as: \"system\"");
    }

    #[tokio::test]
    async fn no_answer_to_the_question_or_another_person_answering_is_no() {
        let r = rig("ask", "limited").await;
        let p = r.svc.platform.clone();
        assert!(
            !on_thread({
                let p = p.clone();
                move || p.ask("D", "T", false, &Stop::new())
            })
            .await
            .unwrap(),
            "no helper: no"
        );
        helper(&r.sock, ALL, false).await;
        wait_helper(&r.svc, 501).await;
        assert!(
            !on_thread({
                let p = p.clone();
                move || p.ask("D", "T", false, &Stop::new())
            })
            .await
            .unwrap(),
            "Don't allow"
        );
        *r.os.console.lock().unwrap() = None;
        assert!(!on_thread(move || p.ask("D", "T", false, &Stop::new())).await.unwrap(), "nobody at the console");
    }

    #[tokio::test]
    async fn a_restart_with_filevault_on_is_refused_and_a_shutdown_goes() {
        let r = rig("power", "full").await;
        *r.os.filevault.lock().unwrap() = FileVault::On;
        assert_eq!(r.svc.platform.power("restart", 5).unwrap_err(), power::FILEVAULT_ON);
        assert!(r.os.powered.lock().unwrap().is_empty());
        let at = r.svc.platform.power("shutdown", 0).unwrap();
        assert!(at > 0);
        for _ in 0..50 {
            if !r.os.powered.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(*r.os.powered.lock().unwrap(), vec![false]);
        assert_eq!(r.svc.platform.power("restart", 5).unwrap_err(), power::FILEVAULT_ON);
        *r.os.filevault.lock().unwrap() = FileVault::Off;
        assert_eq!(r.svc.platform.power("restart", 5).unwrap_err(), power::BUSY, "the shutdown still holds the latch");
    }

    #[tokio::test]
    async fn the_desktop_and_the_pause_come_from_the_helper() {
        let r = rig("desk", "full").await;
        assert_eq!(r.svc.platform.desktop(), Desktop::Unknown);
        helper(&r.sock, Tick { screen: true, accessibility: true, customer_ago_ms: 1000, locked: true }, true).await;
        wait_helper(&r.svc, 501).await;
        assert_eq!(r.svc.platform.desktop(), Desktop::Secure, "a locked screen");
        let until = r.svc.platform.paused_until_ms().unwrap();
        assert!((until - now_ms() - 2000).abs() < 500, "about 2 s left of the 3 s pause");
        *r.os.console.lock().unwrap() = None;
        assert_eq!(r.svc.platform.desktop(), Desktop::Secure, "the login window");
    }

    #[tokio::test]
    async fn programs_are_listed_and_a_close_asks_the_helper_first() {
        let r = rig("progs", "full").await;
        let list = r.svc.platform.programs(&Frame::parse(&json!({"type":"programs","id":"1","action":"list"})).unwrap()).unwrap();
        assert_eq!(list["running"][0]["name"], "TextEdit");
        let f = Frame::parse(&json!({"type":"programs","id":"1","action":"close","pid":4000})).unwrap();
        assert_eq!(r.svc.platform.close_target(&f).as_deref(), Some("TextEdit"));
    }

    #[tokio::test]
    async fn setup_and_uninstall_need_an_administrator_the_service_checked() {
        let r = rig("auth", "limited").await;
        let req = SetupRequest {
            auth: [7; 32],
            link: "https://support.example/install?code=ABCDEFGH23".into(),
            code: None,
            name: "Mac".into(),
            access: "ask".into(),
            control: "full".into(),
        };
        let out = r.svc.clone().setup(req.clone(), Peer::ConsoleUser(501)).await;
        assert_eq!((out["ok"].clone(), out["error"].clone()), (json!(false), json!(NOT_ADMIN)));
        assert_eq!(out["state"], "not_set_up");
        let out = r.svc.clone().uninstall([7; 32], Peer::ConsoleUser(501)).await;
        assert_eq!(out["error"], NOT_ADMIN);
        // With an administrator, a bad link is the next refusal (nothing reaches the network).
        r.os.admin_ok.store(true, Ordering::SeqCst);
        let mut bad = req.clone();
        bad.link = "https://support.example/elsewhere".into();
        assert_eq!(r.svc.clone().setup(bad, Peer::Root).await["error"], setup::BAD_LINK);
        let mut noname = req;
        noname.name = " ".into();
        assert!(r.svc.clone().setup(noname, Peer::Root).await["error"].as_str().unwrap().contains("name"));
        assert!(state::load(&r.svc.dir).is_none(), "nothing saved");
    }

    #[tokio::test]
    async fn the_status_says_not_set_up_then_what_was_saved() {
        let r = rig("status", "limited").await;
        assert_eq!(r.svc.status()["state"], "not_set_up");
        let saved = DeviceState {
            origin: "https://r.example".into(),
            key: "k".into(),
            device_id: "d".into(),
            workspace: "w".into(),
            name: "Mac".into(),
            access: "ask".into(),
            control: "limited".into(),
            state: "pending".into(),
            confirm: Some("123456".into()),
            accepted_session: None,
            rules: None,
        };
        *r.svc.state.lock().unwrap() = Some(saved);
        let s = r.svc.status();
        assert_eq!((s["state"].clone(), s["confirm"].clone(), s["set_up"].clone()), (json!("pending"), json!("123456"), json!(true)));
        assert!(s.get("key").is_none(), "the key never leaves the service");
        r.svc.platform.session(Some("Dana"));
        assert_eq!(r.svc.status()["session"]["by"], "Dana");
    }
}

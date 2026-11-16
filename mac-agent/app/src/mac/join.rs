//! `Support Join.app`'s process: the one-off join, run as the person who opened it. There is no root service, no
//! helper socket and no password prompt here. The screen, the input and the question run in this process, through the
//! same code the saved app's helper uses (`helper::act`), and the session is the core's session client with the key
//! the link's redeem gave.
//!
//! Two threads matter. The main thread runs the windows (`join_ui`). The controller thread owns the steps
//! (`crate::join::Machine`), does what each step asks (the relay calls, join.json, the session, the permission reset)
//! and publishes a `View` for the windows to draw. Everything between them goes through `JoinShared`.

use super::{helper, join_ui, os};
use crate::as_user::{self, Account};
use crate::ax_plan;
use crate::join::{self, Effect, EndHow, Event, Loaded, Saved, Step, TrashOffer};
use crate::paths;
use crate::service::{captures, inputs, permission_text, Os};
use objc2_foundation::MainThreadMarker;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support_core::exec;
use support_core::files::FileChunk;
use support_core::keys::KeyCombo;
use support_core::platform::{Desktop, Platform, RunRequest, ScreenOutput};
use support_core::redeem;
use support_core::session::{send_decline, Auth, Client, Events, HttpTransport, SessionConfig, SessionEnd};
use support_core::stop::Stop;
use support_core::wire::{Control, HostInfo, ScreenAction};

/// What the windows draw. The controller replaces it after each step.
#[derive(Clone)]
pub struct View {
    pub step: Step,
    pub notice: Option<String>,
    pub screen: bool,
    pub accessibility: bool,
    /// When the session connected, Unix ms, for the corner window's clock.
    pub since_ms: i64,
    /// What to offer once the session is over.
    pub trash: TrashOffer,
}

/// A message to the controller.
pub enum Msg {
    Ev(Event),
}

pub struct JoinShared {
    pub view: Mutex<View>,
    pub tx: Mutex<mpsc::Sender<Msg>>,
    /// Links that arrived from the page's button (an Apple event), waiting to be handed to the controller.
    pub inbox: Mutex<Vec<String>>,
    /// Lines the person must see at once: a refused second link, a file that could not be saved.
    pub alerts: Mutex<Vec<String>>,
    /// The helper's state, which `helper::act` reads: the app's own windows, for the click guard.
    pub helper: Arc<helper::Shared>,
}

impl JoinShared {
    pub fn send(&self, e: Event) {
        let _ = self.tx.lock().unwrap().send(Msg::Ev(e));
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ---- what the session runs on --------------------------------------------------------------------------------------

/// The platform of a one-off session: this process, as the person. `as: "system"` is refused (the control is normal),
/// power and programs are refused by the relay before they get here, and the screen is `helper::act`.
pub struct JoinPlatform {
    shared: Arc<helper::Shared>,
    account: Account,
    os: os::MacOs,
}

impl JoinPlatform {
    pub fn new(shared: Arc<helper::Shared>, account: Account) -> JoinPlatform {
        JoinPlatform { shared, account, os: os::MacOs::new() }
    }
}

impl Platform for JoinPlatform {
    fn info(&self) -> HostInfo {
        let id = self.os.identity();
        HostInfo {
            machine: id.machine,
            user: self.account.name.clone(),
            os: id.os,
            // Never administrator rights: the app runs as the person and never asks for more.
            elevated: false,
            control: Control::Normal,
            uia: true,
        }
    }

    fn run(&self, req: &RunRequest, stop: &Stop) -> Result<support_core::exec::RunOutput, String> {
        if req.as_system {
            return Err("as: \"system\" needs full control".into());
        }
        let home = if Path::new(&self.account.home).is_dir() { self.account.home.clone() } else { "/".to_string() };
        let mut cmd = Command::new(paths::SHELL);
        cmd.arg("-c").arg(&req.command).current_dir(home).env_clear().envs(as_user::user_env(&self.account)).stdin(Stdio::null());
        if let Ok(tmp) = std::env::var("TMPDIR") {
            cmd.env("TMPDIR", tmp);
        }
        exec::run(&mut cmd, Duration::from_secs(req.timeout_s), stop)
    }

    fn put_file(&self, path: &str, data: &[u8], append: bool) -> Result<usize, String> {
        support_core::files::put(path, data, append)
    }

    fn get_file(&self, path: &str, offset: u64, length: usize) -> Result<FileChunk, String> {
        support_core::files::get(path, offset, length)
    }

    fn screen(&self, action: &ScreenAction, _keys: &[KeyCombo], stop: &Stop) -> Result<ScreenOutput, String> {
        let action = &ax_plan::normalize(action)?;
        let screen_ok = helper::screen_access() || !captures(action);
        let ax_ok = helper::accessibility() || !inputs(action);
        if let Some(text) = permission_text(screen_ok, ax_ok) {
            return Err(text);
        }
        // The session's stop ends a long action the way the saved app's helper is told to: through the cancel flag.
        let cancel = AtomicBool::new(false);
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(std::sync::atomic::Ordering::SeqCst) {
                    if stop.wait(Duration::from_millis(100)) {
                        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                        break;
                    }
                }
            });
            let out = helper::act(action, &self.shared, &cancel);
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            out
        })
    }

    fn desktop(&self) -> Desktop {
        if helper::locked().unwrap_or(false) {
            Desktop::Secure
        } else {
            Desktop::Default
        }
    }

    fn paused_until_ms(&self) -> Option<i64> {
        let ago = super::input::customer_ago_ms();
        let pause = support_core::geometry::CUSTOMER_PAUSE_MS as i64;
        (0..pause).contains(&ago).then(|| now_ms() + pause - ago)
    }
}

struct SessionEvents {
    tx: Mutex<mpsc::Sender<Msg>>,
}

impl Events for SessionEvents {
    fn connected(&self) {
        let _ = self.tx.lock().unwrap().send(Msg::Ev(Event::Connected));
    }
}

// ---- the controller ------------------------------------------------------------------------------------------------

struct Controller {
    machine: join::Machine,
    shared: Arc<JoinShared>,
    tx: mpsc::Sender<Msg>,
    rt: Arc<tokio::runtime::Runtime>,
    dir: PathBuf,
    uid: u32,
    account: Account,
    stop: Option<Arc<Stop>>,
    screen: bool,
    accessibility: bool,
    since_ms: i64,
    trash: TrashOffer,
}

impl Controller {
    fn publish(&self) {
        *self.shared.view.lock().unwrap() = View {
            step: self.machine.step().clone(),
            notice: self.machine.notice().map(str::to_string),
            screen: self.screen,
            accessibility: self.accessibility,
            since_ms: self.since_ms,
            trash: self.trash.clone(),
        };
    }

    fn alert(&self, text: &str) {
        self.shared.alerts.lock().unwrap().push(text.to_string());
    }

    fn feed(&mut self, e: Event) {
        let fx = self.machine.handle(e);
        self.apply(fx);
    }

    fn transport(&self) -> Result<HttpTransport, String> {
        let s = self.machine.saved().ok_or("no session")?;
        HttpTransport::new(&s.origin, &s.sid, Auth::Attach(s.key.clone()))
    }

    fn apply(&mut self, effects: Vec<Effect>) {
        for fx in effects {
            match fx {
                Effect::Preview { origin, code } => {
                    let (tx, rt) = (self.tx.clone(), self.rt.clone());
                    std::thread::spawn(move || {
                        let ev = match rt.block_on(redeem::preview(&origin, &code)) {
                            Ok(p) => Event::PreviewOk { code, label: p.label },
                            Err(e) => Event::PreviewFailed { code, text: e.text().to_string() },
                        };
                        let _ = tx.send(Msg::Ev(ev));
                    });
                }
                Effect::Redeem { origin, code } => {
                    let (tx, rt) = (self.tx.clone(), self.rt.clone());
                    std::thread::spawn(move || {
                        let ev = match rt.block_on(redeem::redeem(&origin, &code)) {
                            Ok(r) => Event::RedeemOk(Saved {
                                sid: r.one_off.sid,
                                key: r.one_off.key,
                                origin: r.origin,
                                startup_deadline_ms: now_ms() + r.startup_ms as i64,
                                allowed: false,
                            }),
                            Err(e) => Event::RedeemFailed(e.text().to_string()),
                        };
                        let _ = tx.send(Msg::Ev(ev));
                    });
                }
                Effect::Save(s) => {
                    if let Err(e) = join::save(&self.dir, &s, self.uid) {
                        self.alert(&format!(
                            "Support Join could not save its state ({e}). If macOS restarts the app, ask your support team for a new link."
                        ));
                    }
                }
                // The question is drawn from the step itself.
                Effect::Ask => {}
                Effect::SendDecline => {
                    // Up to three tries, so a bad moment of the network does not leave the session open for the technician.
                    if let Ok(t) = self.transport() {
                        for attempt in 0..3 {
                            if self.rt.block_on(send_decline(&t, "declined")) {
                                break;
                            }
                            if attempt < 2 {
                                std::thread::sleep(Duration::from_secs(2));
                            }
                        }
                    }
                }
                Effect::StartSession(s) => self.start_session(s),
                Effect::StopSession => {
                    if let Some(stop) = &self.stop {
                        stop.set();
                    }
                }
                Effect::Cleanup => {
                    let lines = cleanup(&self.dir);
                    self.trash = trash_offer();
                    let _ = self.tx.send(Msg::Ev(Event::CleanupDone(lines)));
                }
                Effect::Notice(text) => self.alert(&text),
            }
        }
    }

    fn start_session(&mut self, s: Saved) {
        let stop = Stop::new();
        self.stop = Some(stop.clone());
        self.since_ms = now_ms();
        let platform = Arc::new(JoinPlatform::new(self.shared.helper.clone(), self.account.clone()));
        let tx = self.tx.clone();
        let rt = self.rt.clone();
        let startup = Duration::from_millis((s.startup_deadline_ms - now_ms()).max(1) as u64);
        std::thread::Builder::new()
            .name("support-join-session".into())
            .spawn(move || {
                let how = match HttpTransport::new(&s.origin, &s.sid, Auth::Attach(s.key.clone())) {
                    Ok(t) => {
                        let events = Arc::new(SessionEvents { tx: Mutex::new(tx.clone()) });
                        let client = Client::new(Arc::new(t), platform, None, events, SessionConfig::new(startup), stop.clone());
                        match rt.block_on(client.run()) {
                            SessionEnd::Relay => EndHow::Relay,
                            SessionEnd::Stopped if stop.is_set() => EndHow::Stopped,
                            // No one stopped it: the link's time, or the session's day, ran out.
                            SessionEnd::Stopped => EndHow::Failed("its time ran out".into()),
                            SessionEnd::Failed(e) => EndHow::Failed(e),
                        }
                    }
                    Err(e) => EndHow::Failed(e),
                };
                let _ = tx.send(Msg::Ev(Event::SessionEnded(how)));
            })
            .ok();
    }

    fn poll(&mut self) {
        self.screen = helper::screen_access();
        self.accessibility = helper::accessibility();
        let now = now_ms();
        if *self.machine.step() == Step::Permissions {
            let (screen, accessibility) = (self.screen, self.accessibility);
            self.feed(Event::Permissions { screen, accessibility });
        }
        self.feed(Event::Tick(now));
    }

    fn run(mut self, rx: mpsc::Receiver<Msg>, resume: Option<Saved>, note: Option<String>) {
        if let Some(n) = note {
            self.alert(&n);
        }
        if let Some(s) = resume {
            self.feed(Event::Resumed(s));
        }
        self.poll();
        self.publish();
        loop {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(Msg::Ev(e)) => {
                    if matches!(e, Event::Connected) {
                        self.since_ms = now_ms();
                    }
                    self.feed(e);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => self.poll(),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            self.publish();
        }
    }
}

/// The end: join.json goes, and each permission is reset for the join app's own bundle id and nothing else. The lines
/// say what macOS allowed.
fn cleanup(dir: &Path) -> Vec<String> {
    let mut lines = Vec::new();
    // The preview build never touches privacy settings, not even to reset an id of its own.
    if helper::PREVIEW_BUILD {
        return lines;
    }
    if let Err(e) = join::delete(dir) {
        lines.push(format!("The session's file could not be removed ({e}). Delete {}/{} yourself.", dir.display(), paths::JOIN_FILE));
    } else {
        lines.push("The session's file was removed.".into());
    }
    let results: Vec<(&str, Result<(), String>)> = join::TCC_SERVICES
        .iter()
        .map(|(service, name)| {
            let out = Command::new(paths::TCCUTIL).args(join::tcc_reset_args(service)).stdin(Stdio::null()).output();
            let r = match out {
                Ok(o) if o.status.success() => Ok(()),
                Ok(o) => Err(String::from_utf8_lossy(if o.stderr.is_empty() { &o.stdout } else { &o.stderr }).trim().to_string()),
                Err(e) => Err(e.to_string()),
            };
            (*name, r)
        })
        .collect();
    lines.extend(join::tcc_report(&results));
    lines
}

/// The folder this app runs from, found again when macOS translocated it (it runs a downloaded app from a read-only
/// copy; that mount's source is the file the person has).
fn trash_offer() -> TrashOffer {
    let running = std::env::current_exe().ok().and_then(|e| join::bundle_of(&e));
    let original = running.as_deref().filter(|r| join::is_translocated(r)).and_then(mount_source);
    join::trash_offer(running.as_deref(), original.as_deref())
}

/// Where a translocated app really is: the source of the nullfs mount it runs from.
fn mount_source(running: &Path) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(running.as_os_str().as_bytes()).ok()?;
    // SAFETY: a zeroed statfs is a valid out-parameter, and the path is a C string.
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    // SAFETY: the kernel NUL-terminates the name inside the fixed array.
    let from = unsafe { std::ffi::CStr::from_ptr(st.f_mntfromname.as_ptr()) }.to_string_lossy().into_owned();
    (!from.is_empty()).then(|| PathBuf::from(from))
}

pub fn main() -> i32 {
    let Some(mtm) = MainThreadMarker::new() else { return 2 };
    let origin = match join::build_origin() {
        Ok(o) => o,
        Err(e) => {
            join_ui::fatal(mtm, &e);
            return 1;
        }
    };
    // SAFETY: a getter.
    let uid = unsafe { libc::geteuid() };
    if uid == 0 {
        join_ui::fatal(mtm, "Support Join runs as the person who opened it, never as an administrator. Open it from your own account.");
        return 1;
    }
    let Some(account) = as_user::account(uid) else {
        join_ui::fatal(mtm, "Support Join could not tell who you are.");
        return 1;
    };
    let dir = join::data_dir(Path::new(&account.home));
    let (resume, note) = match join::load(&dir, &origin, uid, now_ms()) {
        Loaded::Live(s) => (Some(s), None),
        Loaded::Discarded(why) => (None, Some(why)),
        Loaded::None => (None, None),
    };
    let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(rt) => Arc::new(rt),
        Err(e) => {
            join_ui::fatal(mtm, &format!("Support Join could not start ({e})."));
            return 1;
        }
    };
    let (tx, rx) = mpsc::channel::<Msg>();
    let (unused_tx, _unused_rx) = mpsc::channel();
    let helper_shared = Arc::new(helper::Shared {
        session: crate::ipc::HelperSession::Aqua,
        status: Mutex::new(None),
        own_windows: Mutex::new(Vec::new()),
        asks: Mutex::new(Vec::new()),
        cancelled_asks: Mutex::new(Vec::new()),
        notice: Mutex::new(None),
        requests: Mutex::new(unused_tx),
    });
    let shared = Arc::new(JoinShared {
        view: Mutex::new(View { step: Step::Entry, notice: None, screen: false, accessibility: false, since_ms: 0, trash: TrashOffer::None }),
        tx: Mutex::new(tx.clone()),
        inbox: Mutex::new(Vec::new()),
        alerts: Mutex::new(Vec::new()),
        helper: helper_shared,
    });
    let controller = Controller {
        machine: join::Machine::new(&origin),
        shared: shared.clone(),
        tx,
        rt,
        dir,
        uid,
        account,
        stop: None,
        screen: false,
        accessibility: false,
        since_ms: 0,
        trash: TrashOffer::None,
    };
    std::thread::Builder::new().name("support-join-controller".into()).spawn(move || controller.run(rx, resume, note)).ok();
    join_ui::run(mtm, shared);
    0
}

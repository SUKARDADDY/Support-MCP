//! The `helper` role: one per signed-in session (as that person) and one at the login window (as root), started by
//! the LaunchAgent. It keeps a link to the root service and does what only a process in the session can: screenshots,
//! input, the question before a session, the corner window, the menu bar item and the setup window.
//!
//! The helper trusts the service only as far as the socket proves: the socket lives in a folder only root can write,
//! and the peer must be uid 0. Every message is read strictly (`ipc::read_to_helper`), and an action is parsed again
//! here with the core's own parser, so the helper does nothing the service could not have asked for on the wire.

use super::{capture, input, ui};
use crate::frame;
use crate::input_plan;
use crate::ipc::{self, HelperSession, Request, Tick, ToHelper};
use crate::paths;
use objc2_core_graphics::CGPreflightScreenCaptureAccess;
use objc2_foundation::MainThreadMarker;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use support_core::geometry::{self, Rect, CAPTURE_RETRY_FOR_MS, CAPTURE_RETRY_MS, OWN_FOCUS_TEXT, OWN_WINDOW_TEXT, PAUSE_TEXT, SETTLE_MS};
use support_core::keys;
use support_core::platform::{Desktop, Image, ScreenOutput};
use support_core::wire::ScreenAction;

/// A question the service asked, waiting for the window.
pub struct AskRequest {
    pub id: u64,
    pub by: String,
    pub team: String,
    pub full: bool,
    pub answer: mpsc::Sender<bool>,
}

/// What a window asks of the service, done on a worker thread (some of it waits for a password).
pub enum UiRequest {
    Simple(Request),
    Setup { link: String, code: Option<String>, name: String, access: String, control: String },
    Uninstall,
}

/// The state the windows (main thread) and the link (its own thread) share.
pub struct Shared {
    pub session: HelperSession,
    /// The service's last status, None when it cannot be reached.
    pub status: Mutex<Option<Map<String, Value>>>,
    /// The app's own visible windows, in global points (top-left origin), for the click guard.
    pub own_windows: Mutex<Vec<Rect>>,
    pub asks: Mutex<Vec<AskRequest>>,
    pub cancelled_asks: Mutex<Vec<u64>>,
    /// A line for the windows to show: the outcome of a setup or an uninstall.
    pub notice: Mutex<Option<(String, bool)>>,
    pub requests: Mutex<mpsc::Sender<UiRequest>>,
}

/// Whether the screen is locked, from the session's own dictionary. None outside a GUI session.
pub fn locked() -> Option<bool> {
    use objc2_core_foundation::{CFBoolean, CFDictionary, CFString, CFType};
    let d = objc2_core_graphics::CGSessionCopyCurrentDictionary()?;
    // SAFETY: the session dictionary maps strings to property list values.
    let d: &CFDictionary<CFString, CFType> = unsafe { d.cast_unchecked() };
    let v = d.get(&CFString::from_static_str("CGSSessionScreenIsLocked"));
    Some(v.and_then(|v| v.downcast_ref::<CFBoolean>().map(|b| b.as_bool())).unwrap_or(false))
}

pub fn accessibility() -> bool {
    // SAFETY: no arguments.
    unsafe { objc2_application_services::AXIsProcessTrusted() }
}

fn tick() -> Tick {
    Tick {
        screen: CGPreflightScreenCaptureAccess(),
        accessibility: accessibility(),
        customer_ago_ms: input::customer_ago_ms(),
        locked: locked().unwrap_or(false),
    }
}

// ---- screen actions ---------------------------------------------------------------------------------------------

struct Guards<'a> {
    shared: &'a Shared,
    cancel: &'a AtomicBool,
}

impl input::Guard for Guards<'_> {
    fn free(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err("support access ended".into());
        }
        if input::paused() {
            return Err(PAUSE_TEXT.into());
        }
        Ok(())
    }
    fn target(&self, x: f64, y: f64) -> Result<(), String> {
        if input_plan::in_own_window(&self.shared.own_windows.lock().unwrap(), x, y) {
            return Err(OWN_WINDOW_TEXT.into());
        }
        Ok(())
    }
    fn key_target(&self) -> Result<(), String> {
        let front = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication();
        if front.is_some_and(|a| a.processIdentifier() == std::process::id() as i32) {
            return Err(OWN_FOCUS_TEXT.into());
        }
        Ok(())
    }
}

fn pick(displays: &[capture::Display], n: i64) -> Result<&capture::Display, String> {
    if displays.is_empty() {
        return Err("no display is connected".into());
    }
    usize::try_from(n).ok().and_then(|i| displays.get(i)).ok_or_else(|| format!("display {n} does not exist; this Mac has {}", displays.len()))
}

fn shot(d: &capture::Display, index: i64, count: usize, desktop: Desktop) -> Result<ScreenOutput, String> {
    let img = capture::capture(d.id, None, (d.view.image_w, d.view.image_h))?;
    let bytes = capture::encode(&img)?;
    Ok(ScreenOutput {
        image: Some(Image { bytes, mime: "image/jpeg", width: d.view.image_w, height: d.view.image_h }),
        display: index,
        displays: count as i64,
        desktop,
        text: None,
    })
}

/// After an input: a moment for the screen to settle, then a picture, tried again for up to 2 seconds.
fn shot_after(d: &capture::Display, index: i64, count: usize, desktop: Desktop, cancel: &AtomicBool) -> ScreenOutput {
    std::thread::sleep(Duration::from_millis(SETTLE_MS));
    let until = Instant::now() + Duration::from_millis(CAPTURE_RETRY_FOR_MS);
    let mut last = String::new();
    while !cancel.load(Ordering::SeqCst) {
        match shot(d, index, count, desktop) {
            Ok(out) => return out,
            Err(e) => last = e,
        }
        if Instant::now() >= until {
            break;
        }
        std::thread::sleep(Duration::from_millis(CAPTURE_RETRY_MS));
    }
    ScreenOutput { image: None, display: index, displays: count as i64, desktop, text: Some(format!("input sent; no screenshot: {last}")) }
}

/// One screen action, as the core's own parser reads it.
pub fn act(a: &ScreenAction, shared: &Shared, cancel: &AtomicBool) -> Result<ScreenOutput, String> {
    let desktop = if shared.session == HelperSession::LoginWindow || locked().unwrap_or(false) { Desktop::Secure } else { Desktop::Default };
    let displays = capture::displays();
    let d = pick(&displays, a.display)?;
    let n = displays.len();
    let guard = Guards { shared, cancel };
    match a.name.as_str() {
        "screenshot" => shot(d, a.display, n, desktop),
        "zoom" => {
            let (x, y, w, h) = d.view.region(a.x1, a.y1, a.x2, a.y2)?;
            let scale_x = d.pixels.0 as f64 / d.view.bounds.width().max(1) as f64;
            let scale_y = d.pixels.1 as f64 / d.view.bounds.height().max(1) as f64;
            let size = geometry::fit((w as f64 * scale_x) as i64, (h as f64 * scale_y) as i64);
            let img = capture::capture(d.id, Some((x, y, w, h)), size)?;
            let bytes = capture::encode(&img)?;
            Ok(ScreenOutput {
                image: Some(Image { bytes, mime: "image/jpeg", width: size.0, height: size.1 }),
                display: a.display,
                displays: n as i64,
                desktop,
                text: None,
            })
        }
        "wait" => {
            let until = Instant::now() + Duration::from_secs_f64(a.seconds.clamp(0.0, 60.0));
            while Instant::now() < until {
                if cancel.load(Ordering::SeqCst) {
                    return Err("support access ended".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            shot(d, a.display, n, desktop)
        }
        "move" | "click" | "drag" | "scroll" | "type" | "type_secret" | "key" => {
            if !accessibility() {
                return Err(crate::service::permission_text(true, false).unwrap_or_default());
            }
            match a.name.as_str() {
                "move" => {
                    let (x, y) = d.view.point(a.x, a.y)?;
                    input::Guard::free(&guard)?;
                    input::move_to(x, y)?;
                }
                "click" => {
                    let b = input_plan::button(&a.button)?;
                    let (x, y) = d.view.point(a.x, a.y)?;
                    input::click(x, y, b, a.count, &guard, cancel)?;
                }
                "drag" => {
                    let from = d.view.point(a.x1, a.y1)?;
                    let to = d.view.point(a.x2, a.y2)?;
                    input::drag(from, to, &guard, cancel)?;
                }
                "scroll" => {
                    let wheels = input_plan::scroll_wheels(&a.direction, a.amount)?;
                    // A scroll at a point moves the pointer there first; without x and y it scrolls where it is.
                    let at = if a.x != 0 || a.y != 0 { Some(d.view.point(a.x, a.y)?) } else { None };
                    input::scroll(at, wheels, &guard)?;
                }
                "key" => {
                    let chords = input_plan::chords(&keys::parse(&a.keys)?)?;
                    input::chords(&chords, &guard, cancel)?;
                }
                _ => {
                    let n = a.text.chars().count();
                    let max = if a.name == "type_secret" { 1000 } else { support_core::wire::TYPE_MAX };
                    if n == 0 || n > max {
                        return Err(format!("text must be 1 to {max} characters"));
                    }
                    input::type_text(&a.text, &guard, cancel)?;
                }
            }
            if a.screenshot {
                Ok(shot_after(d, a.display, n, desktop, cancel))
            } else {
                Ok(ScreenOutput { image: None, display: a.display, displays: n as i64, desktop, text: None })
            }
        }
        other => Err(format!("Unknown screen action \"{}\".", support_core::wire::clean(other, 40))),
    }
}

// ---- the link to the service ------------------------------------------------------------------------------------

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

async fn link_once(shared: Arc<Shared>) -> Result<(), String> {
    let stream = tokio::net::UnixStream::connect(paths::SOCKET_PATH).await.map_err(|e| e.to_string())?;
    let (mut uid, mut gid) = (1u32, 1u32);
    // SAFETY: local out-parameters on a live socket.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != 0 {
        return Err("the socket's owner is not root".into());
    }
    let (mut rd, mut wr) = stream.into_split();
    frame::write(&mut wr, &ipc::opening_helper(shared.session)).await.map_err(|e| e.to_string())?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Map<String, Value>>();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if frame::write(&mut wr, &m).await.is_err() {
                break;
            }
        }
    });
    let ticker = tokio::spawn({
        let tx = tx.clone();
        async move {
            loop {
                let t = tokio::task::spawn_blocking(tick).await.unwrap_or_default();
                if tx.send(ipc::tick_message(&t)).is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    });
    let cancels: Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>> = Arc::default();
    let result = loop {
        let m = match frame::read(&mut rd, None).await {
            Ok(m) => m,
            Err(e) => break Err(e.to_string()),
        };
        let Some(msg) = ipc::read_to_helper(&m) else { break Err("the service sent a message the helper does not know".into()) };
        match msg {
            ToHelper::Screen { id, action } => {
                let cancel = Arc::new(AtomicBool::new(false));
                cancels.lock().unwrap().insert(id, cancel.clone());
                let (tx, shared, cancels) = (tx.clone(), shared.clone(), cancels.clone());
                std::thread::spawn(move || {
                    let a = ScreenAction::parse(&action);
                    let out = act(&a, &shared, &cancel);
                    cancels.lock().unwrap().remove(&id);
                    let _ = tx.send(ipc::reply_message(id, ipc::screen_reply(out)));
                });
            }
            ToHelper::Ask { id, by, team, full } => {
                let (answer, wait) = mpsc::channel();
                shared.asks.lock().unwrap().push(AskRequest { id, by, team, full, answer });
                let tx = tx.clone();
                std::thread::spawn(move || {
                    // No answer within the question's time and a margin is no.
                    let yes = wait.recv_timeout(Duration::from_millis(support_core::platform::ASK_MS + 5_000)).unwrap_or(false);
                    let _ = tx.send(ipc::reply_message(id, obj(json!({ "answer": yes }))));
                });
            }
            ToHelper::Cancel { id } => {
                if let Some(c) = cancels.lock().unwrap().get(&id) {
                    c.store(true, Ordering::SeqCst);
                }
                shared.cancelled_asks.lock().unwrap().push(id);
            }
            ToHelper::CloseApps { id, pids } => {
                let mut asked = Vec::new();
                for pid in pids {
                    if let Some(app) = objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
                        if app.terminate() {
                            asked.push(pid);
                        }
                    }
                }
                let _ = tx.send(ipc::reply_message(id, obj(json!({ "asked": asked }))));
            }
        }
    };
    ticker.abort();
    writer.abort();
    for c in cancels.lock().unwrap().values() {
        c.store(true, Ordering::SeqCst);
    }
    result
}

fn link_thread(shared: Arc<Shared>) {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
    loop {
        let _ = rt.block_on(link_once(shared.clone()));
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Reads the service's status every second for the menu bar, the corner window and the setup window.
fn status_thread(shared: Arc<Shared>) {
    loop {
        let s = super::cli::call(&Request::Status, Duration::from_secs(5)).ok();
        *shared.status.lock().unwrap() = s;
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Does what the windows ask, one at a time.
fn request_thread(shared: Arc<Shared>, rx: mpsc::Receiver<UiRequest>) {
    for r in rx {
        let outcome: Result<String, String> = match r {
            UiRequest::Simple(req) => super::cli::call(&req, Duration::from_secs(10)).map(|_| String::new()),
            UiRequest::Setup { link, code, name, access, control } => (|| {
                let auth = super::auth::acquire("Support wants to set up remote support on this Mac.")?;
                let req = Request::Setup(ipc::SetupRequest { auth: auth.external, link, code, name, access, control });
                let m = super::cli::call(&req, Duration::from_secs(90))?;
                drop(auth);
                if m.get("ok") == Some(&Value::Bool(true)) {
                    Ok(match m.get("confirm").and_then(Value::as_str) {
                        Some(c) => {
                            format!("Waiting for your support team to approve this Mac. Read them these six digits: {}", super::cli::digits(c))
                        }
                        None => "Support is set up. Your support team can now reach this Mac.".into(),
                    })
                } else {
                    Err(m.get("error").and_then(Value::as_str).unwrap_or("Setup failed.").to_string())
                }
            })(),
            UiRequest::Uninstall => (|| {
                let auth = super::auth::acquire("Support wants to remove itself from this Mac.")?;
                let m = super::cli::call(&Request::Uninstall { auth: auth.external }, Duration::from_secs(60))?;
                drop(auth);
                if m.get("ok") == Some(&Value::Bool(true)) {
                    Ok("Support was removed.".to_string())
                } else {
                    Err(m.get("error").and_then(Value::as_str).unwrap_or("Uninstall failed.").to_string())
                }
            })(),
        };
        match outcome {
            Ok(text) if text.is_empty() => {}
            Ok(text) => *shared.notice.lock().unwrap() = Some((text, true)),
            Err(e) => *shared.notice.lock().unwrap() = Some((e, false)),
        }
    }
}

pub fn main() -> i32 {
    let Some(mtm) = MainThreadMarker::new() else { return 2 };
    // SAFETY: a getter.
    let session = if unsafe { libc::geteuid() } == 0 { HelperSession::LoginWindow } else { HelperSession::Aqua };
    let (tx, rx) = mpsc::channel();
    let shared = Arc::new(Shared {
        session,
        status: Mutex::new(None),
        own_windows: Mutex::new(Vec::new()),
        asks: Mutex::new(Vec::new()),
        cancelled_asks: Mutex::new(Vec::new()),
        notice: Mutex::new(None),
        requests: Mutex::new(tx),
    });
    std::thread::spawn({
        let s = shared.clone();
        move || link_thread(s)
    });
    if session == HelperSession::Aqua {
        std::thread::spawn({
            let s = shared.clone();
            move || status_thread(s)
        });
        std::thread::spawn({
            let s = shared.clone();
            move || request_thread(s, rx)
        });
    }
    ui::run(mtm, shared);
    0
}

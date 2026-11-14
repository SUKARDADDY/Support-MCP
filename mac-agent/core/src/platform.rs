//! What the core needs from the operating system. The Mac app implements `Platform` with the real screen, input, shell
//! and files (PR 3 on). `FakePlatform` does the same for tests and for the end-to-end run on Linux: it runs commands
//! with `sh -c`, reads and writes real files, and serves one fixed JPEG for the screen.

use crate::exec::{self, RunOutput};
use crate::files::{self, FileChunk};
use crate::keys::KeyCombo;
use crate::stop::Stop;
use crate::wire::{Control, Frame, HostInfo, ScreenAction};
use serde_json::{json, Value};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desktop {
    Default,
    Secure,
    Unknown,
}

impl Desktop {
    pub fn as_str(self) -> &'static str {
        match self {
            Desktop::Default => "default",
            Desktop::Secure => "secure",
            Desktop::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RunRequest {
    pub command: String,
    /// 1 to 600.
    pub timeout_s: u64,
    /// `as:"system"` (root). Only ever true under full control.
    pub as_system: bool,
}

#[derive(Clone, Debug)]
pub struct Image {
    pub bytes: Vec<u8>,
    /// `image/jpeg` or `image/png`.
    pub mime: &'static str,
    pub width: i64,
    pub height: i64,
}

/// What a screen action gives back. An input that could not capture afterwards returns no image and a `text` that says
/// why ("input sent; no screenshot: <reason>").
#[derive(Clone, Debug)]
pub struct ScreenOutput {
    pub image: Option<Image>,
    pub display: i64,
    pub displays: i64,
    pub desktop: Desktop,
    pub text: Option<String>,
}

/// Every method blocks. The core calls them on a worker thread, one per lane, so a slow command never holds up a
/// screenshot. `stop` is set when the session ends, and long work should end when it is.
pub trait Platform: Send + Sync + 'static {
    /// The machine, the person signed in, whether this runs as root, the control level and whether `ui_tree` works.
    fn info(&self) -> HostInfo;

    fn run(&self, req: &RunRequest, stop: &Stop) -> Result<RunOutput, String>;

    /// `path` is absolute and already checked against the rules.
    fn put_file(&self, path: &str, data: &[u8], append: bool) -> Result<usize, String>;

    fn get_file(&self, path: &str, offset: u64, length: usize) -> Result<FileChunk, String>;

    /// Every screen action but the ones the core refuses itself (`send_sas`, `block_input`, `ui_*` before PR 4).
    /// `keys` is the parsed `keys` of a `key` action, else empty. Coordinates are in pixels of the screenshot the
    /// caller saw, as the relay sends them.
    fn screen(&self, action: &ScreenAction, keys: &[KeyCombo], stop: &Stop) -> Result<ScreenOutput, String>;

    /// Restart or shut down after `delay_s`. Returns the Unix second at which it will happen.
    fn power(&self, _action: &str, _delay_s: i64) -> Result<i64, String> {
        Err("not_supported: this action is not available here".to_string())
    }

    /// A `programs` frame that the rules let through: `list` or `close`. Returns the result fields.
    fn programs(&self, _frame: &Frame) -> Result<Value, String> {
        Err("not_supported: this action is not available here".to_string())
    }

    /// The name of the running program a `close` frame means.
    fn close_target(&self, frame: &Frame) -> Option<String> {
        let name = frame.text("name");
        (!name.trim().is_empty()).then_some(name)
    }

    /// Whom a new session would be shown to: someone signed in at the console, nobody, or too many to tell.
    fn session_target(&self) -> crate::session::Target {
        crate::session::Target::Console
    }

    /// Which desktop is up. A Mac has a login window, the equivalent of Windows' secure desktop.
    fn desktop(&self) -> Desktop {
        Desktop::Default
    }

    /// Unix milliseconds on this machine's clock until which the person's own input pauses ours, if it does.
    fn paused_until_ms(&self) -> Option<i64> {
        None
    }

    /// The question before a session ("<by> from <team> wants to connect"). Blocks until the person answers, at most
    /// `ASK_MS` plus a margin. `full` says the session has full control. No answer is no.
    fn ask(&self, _by: &str, _team: &str, _full: bool, _stop: &Stop) -> bool {
        false
    }
}

/// How long the person has to answer the question, and the margin the service waits on top of it.
pub const ASK_MS: u64 = 120_000;
pub const ASK_MARGIN_MS: u64 = 15_000;

/// The fixed picture the fake screen serves: 1280 x 800, a JPEG.
pub const FAKE_SCREEN_JPEG: &[u8] = include_bytes!("fake-screen.jpg");
pub const FAKE_SCREEN_SIZE: (i64, i64) = (1280, 800);

pub struct FakePlatform {
    info: HostInfo,
    /// Every screen action it was given, in order.
    pub screen_log: Mutex<Vec<ScreenAction>>,
    /// Every key chord list it was given.
    pub key_log: Mutex<Vec<Vec<KeyCombo>>>,
    pub power_log: Mutex<Vec<(String, i64)>>,
    pub asked: AtomicUsize,
    pub answer_yes: AtomicBool,
}

impl FakePlatform {
    pub fn new(control: Control) -> FakePlatform {
        FakePlatform {
            info: HostInfo { machine: "Fake-Mac".into(), user: "tester".into(), elevated: false, control, uia: false },
            screen_log: Mutex::new(vec![]),
            key_log: Mutex::new(vec![]),
            power_log: Mutex::new(vec![]),
            asked: AtomicUsize::new(0),
            answer_yes: AtomicBool::new(true),
        }
    }
}

impl Platform for FakePlatform {
    fn info(&self) -> HostInfo {
        self.info.clone()
    }

    fn run(&self, req: &RunRequest, stop: &Stop) -> Result<RunOutput, String> {
        exec::run(Command::new("sh").arg("-c").arg(&req.command), Duration::from_secs(req.timeout_s), stop)
    }

    fn put_file(&self, path: &str, data: &[u8], append: bool) -> Result<usize, String> {
        files::put(path, data, append)
    }

    fn get_file(&self, path: &str, offset: u64, length: usize) -> Result<FileChunk, String> {
        files::get(path, offset, length)
    }

    fn screen(&self, action: &ScreenAction, keys: &[KeyCombo], _stop: &Stop) -> Result<ScreenOutput, String> {
        self.screen_log.lock().unwrap().push(action.clone());
        if !keys.is_empty() {
            self.key_log.lock().unwrap().push(keys.to_vec());
        }
        let wants_image = matches!(action.name.as_str(), "screenshot" | "zoom") || action.screenshot;
        let image = wants_image.then(|| Image {
            bytes: FAKE_SCREEN_JPEG.to_vec(),
            mime: "image/jpeg",
            width: FAKE_SCREEN_SIZE.0,
            height: FAKE_SCREEN_SIZE.1,
        });
        Ok(ScreenOutput { image, display: 0, displays: 1, desktop: Desktop::Default, text: None })
    }

    fn power(&self, action: &str, delay_s: i64) -> Result<i64, String> {
        self.power_log.lock().unwrap().push((action.to_string(), delay_s));
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        Ok(now + delay_s)
    }

    fn programs(&self, frame: &Frame) -> Result<Value, String> {
        match frame.text("action").as_str() {
            "list" => Ok(json!({ "installed": [], "running": [{ "name": "sh", "pid": 1, "session": null }] })),
            "close" => Ok(json!({ "closed": 1 })),
            _ => Err("unknown programs action".to_string()),
        }
    }

    fn ask(&self, _by: &str, _team: &str, _full: bool, _stop: &Stop) -> bool {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.answer_yes.load(Ordering::SeqCst)
    }
}

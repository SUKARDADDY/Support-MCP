// The parts that reach the operating system or the Tauri shell: the system browser, events
// to the screens, and Windows notifications. The logic around them is in core.rs and feed.rs,
// which see only the Browser, Emitter and Notifier traits.
use crate::error::{CoreError, CoreResult};
use crate::feed::{Emitter, FeedItem, Notifier};
use crate::oauth::Browser;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter as _, Runtime};
use tauri_plugin_notification::NotificationExt;

/// Opens an address in the person's default browser. Only http and https addresses.
pub struct SystemBrowser;

impl Browser for SystemBrowser {
    fn open(&self, url: &str) -> CoreResult<()> {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(CoreError::invalid("Only web addresses are opened."));
        }
        open_in_browser(url)
    }
}

#[cfg(windows)]
fn open_in_browser(url: &str) -> CoreResult<()> {
    use windows::core::{w, HSTRING};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    // SAFETY: the strings outlive the call; ShellExecuteW opens the address with the default browser.
    let result = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), None, None, SW_SHOWNORMAL) };
    // The call succeeded when the value is greater than 32.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(CoreError::other("Windows could not open your browser."))
    }
}

#[cfg(not(windows))]
fn open_in_browser(url: &str) -> CoreResult<()> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|_| CoreError::other("Could not open your browser."))
}

/// Sends an event to every window.
pub struct TauriEmitter<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> Emitter for TauriEmitter<R> {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }
}

/// What a click on a notification opens.
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub account: String,
    pub device_id: Option<String>,
    pub task_id: Option<String>,
    pub session_id: Option<String>,
}

impl Target {
    pub fn payload(&self) -> Value {
        json!({ "account": self.account, "device_id": self.device_id, "task_id": self.task_id, "session_id": self.session_id })
    }
}

const TARGETS_MAX: usize = 64;

/// Raises Windows notifications and remembers what each opens, for as long as the toast is
/// on screen (a click on one in the Notification Center only opens the app).
pub struct ToastNotifier<R: Runtime> {
    app: AppHandle<R>,
    targets: Mutex<(i32, HashMap<i32, Target>)>,
}

impl<R: Runtime> ToastNotifier<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        ToastNotifier { app, targets: Mutex::new((0, HashMap::new())) }
    }

    pub fn target(&self, notification_id: i32) -> Option<Target> {
        self.targets.lock().unwrap_or_else(|p| p.into_inner()).1.get(&notification_id).cloned()
    }

    fn remember(&self, target: Target) -> i32 {
        let mut t = self.targets.lock().unwrap_or_else(|p| p.into_inner());
        t.0 = t.0.wrapping_add(1).max(1);
        let id = t.0;
        t.1.insert(id, target);
        if t.1.len() > TARGETS_MAX {
            let oldest = t.1.keys().copied().filter(|k| *k != id).min();
            if let Some(k) = oldest {
                t.1.remove(&k);
            }
        }
        id
    }
}

impl<R: Runtime> Notifier for ToastNotifier<R> {
    fn show(&self, account: &str, item: &FeedItem) {
        let id = self.remember(Target {
            account: account.to_string(),
            device_id: item.device_id.clone(),
            task_id: item.task_id.clone(),
            session_id: item.session_id.clone(),
        });
        // The title and body are plain text: the shell shows them as they are.
        let _ = self.app.notification().builder().id(id).title(&item.title).body(&item.body).show();
    }
}

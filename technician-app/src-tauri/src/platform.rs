// The parts that reach the operating system or the Tauri shell: the system browser, events
// to the screens, and Windows notifications. The logic around them is in core.rs and feed.rs,
// which see only the Browser, Emitter and Notifier traits.
use crate::error::{CoreError, CoreResult, Msg};
use crate::feed::{Emitter, FeedItem, Notifier};
use crate::oauth::Browser;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter as _, Manager, Runtime, WebviewWindow, WindowEvent};
use tauri_plugin_notification::NotificationExt;

/// Opens an address in the person's default browser. Only http and https addresses.
pub struct SystemBrowser;

impl Browser for SystemBrowser {
    fn open(&self, url: &str) -> CoreResult<()> {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(CoreError::invalid(Msg::WebOnly));
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
        Err(CoreError::other(Msg::BrowserOpen))
    }
}

#[cfg(not(windows))]
fn open_in_browser(url: &str) -> CoreResult<()> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|_| CoreError::other(Msg::BrowserOpen))
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

/// What each toast on screen opens when it is clicked, by the notification's number. The
/// oldest are forgotten, so the book stays small.
#[derive(Default)]
pub struct TargetBook {
    last: i32,
    map: HashMap<i32, Target>,
}

impl TargetBook {
    pub fn remember(&mut self, target: Target) -> i32 {
        self.last = self.last.wrapping_add(1).max(1);
        let id = self.last;
        self.map.insert(id, target);
        if self.map.len() > TARGETS_MAX {
            if let Some(oldest) = self.map.keys().copied().filter(|k| *k != id).min() {
                self.map.remove(&oldest);
            }
        }
        id
    }

    pub fn get(&self, id: i32) -> Option<Target> {
        self.map.get(&id).cloned()
    }
}

/// Raises Windows notifications and remembers what each opens, for as long as the toast is
/// on screen. Windows reports a click only while the toast is on screen: a click on one in
/// the Notification Center only opens the app (docs/technician-app.md).
pub struct ToastNotifier<R: Runtime> {
    app: AppHandle<R>,
    book: Mutex<TargetBook>,
}

impl<R: Runtime> ToastNotifier<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        ToastNotifier { app, book: Mutex::new(TargetBook::default()) }
    }

    pub fn target(&self, notification_id: i32) -> Option<Target> {
        self.book.lock().unwrap_or_else(|p| p.into_inner()).get(notification_id)
    }
}

impl<R: Runtime> Notifier for ToastNotifier<R> {
    fn show(&self, account: &str, item: &FeedItem) {
        let id = self.book.lock().unwrap_or_else(|p| p.into_inner()).remember(Target {
            account: account.to_string(),
            device_id: item.device_id.clone(),
            task_id: item.task_id.clone(),
            session_id: item.session_id.clone(),
        });
        // The title and body are plain text: the shell shows them as they are.
        let _ = self.app.notification().builder().id(id).title(&item.title).body(&item.body).show();
    }
}

/// A click on a toast opens the app on the PC or task it is about. The handler is registered
/// before the first notification, because the plugin reports clicks only for toasts shown
/// after a handler exists.
pub fn open_on_click<R: Runtime>(app: &AppHandle<R>, notifier: Arc<ToastNotifier<R>>) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        let Some(target) = action.notification().and_then(|n| notifier.target(n.id())) else { return };
        show_main_window(&handle);
        let _ = handle.emit("ui://open", target.payload());
    });
}

// ---- the window, the tray ------------------------------------------------------------

/// The words the app shows outside its web view, the tray's menu and tooltip. They are in
/// src/i18n/en.json with every other string (keys tray.*); the file is built into the app, so
/// the Rust side reads the same words the screens do.
const STRINGS: &str = include_str!("../../src/i18n/en.json");

pub fn label(key: &str) -> String {
    static TABLE: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    TABLE
        .get_or_init(|| serde_json::from_str(STRINGS).expect("src/i18n/en.json is a table of strings"))
        .get(key)
        .cloned()
        .unwrap_or_else(|| key.to_string())
}

/// The argument autostart passes, so the app starts in the tray with no window.
pub const BACKGROUND_ARG: &str = "--background";

pub fn started_in_background(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|a| a == BACKGROUND_ARG)
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit("ui://visibility", json!({ "visible": true }));
    }
}

/// Closing the window hides it: the app keeps running in the tray, so notifications and the
/// feed carry on. Quit in the tray menu ends it. The screens are told when the window is
/// hidden or minimised, so they stop taking pictures.
pub fn keep_in_tray<R: Runtime>(window: &WebviewWindow<R>) {
    let w = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = w.hide();
            let _ = w.app_handle().emit("ui://visibility", json!({ "visible": false }));
        }
        WindowEvent::Resized(_) => {
            let _ = w.app_handle().emit("ui://visibility", json!({ "visible": !w.is_minimized().unwrap_or(false) }));
        }
        _ => {}
    });
}

/// The tray icon: Open and Quit, and a click on the icon opens the window.
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", label("tray.open"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", label("tray.quit"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(label("tray.tooltip"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(n: &str) -> Target {
        Target { account: "acc".into(), device_id: Some(n.into()), task_id: None, session_id: None }
    }

    #[test]
    fn each_toast_remembers_what_it_opens_and_the_book_stays_small() {
        let mut book = TargetBook::default();
        let first = book.remember(target("one"));
        let second = book.remember(target("two"));
        assert_ne!(first, second);
        assert_eq!(book.get(first), Some(target("one")));
        assert_eq!(book.get(second).unwrap().payload()["device_id"], "two");
        assert_eq!(book.get(9999), None);
        for i in 0..200 {
            book.remember(target(&format!("n{i}")));
        }
        assert!(book.map.len() <= TARGETS_MAX);
        assert_eq!(book.get(first), None, "the oldest are forgotten");
        assert!(book.get(book.last).is_some(), "the newest stays");
    }

    #[test]
    fn the_tray_words_come_from_the_screens_string_table() {
        assert_eq!(label("tray.open"), "Open Support");
        assert_eq!(label("tray.quit"), "Quit");
        assert_eq!(label("tray.tooltip"), "Support");
        // A key with no entry shows itself, so a gap is easy to see.
        assert_eq!(label("tray.nothing"), "tray.nothing");
        // And the file holds no tray key that the code does not use.
        let table: HashMap<String, String> = serde_json::from_str(STRINGS).unwrap();
        let mut tray: Vec<&String> = table.keys().filter(|k| k.starts_with("tray.")).collect();
        tray.sort();
        assert_eq!(tray, ["tray.open", "tray.quit", "tray.tooltip"]);
    }

    #[test]
    fn the_autostart_argument_starts_the_app_in_the_tray() {
        assert!(started_in_background(["support-technician".to_string(), "--background".to_string()]));
        assert!(!started_in_background(["support-technician".to_string()]));
        assert!(!started_in_background(["support-technician".to_string(), "--bg".to_string()]));
    }

    #[test]
    fn the_target_payload_names_the_account_pc_task_and_session() {
        let t = Target { account: "a".into(), device_id: Some("d".into()), task_id: Some("t".into()), session_id: None };
        assert_eq!(t.payload(), json!({ "account": "a", "device_id": "d", "task_id": "t", "session_id": null }));
    }
}

//! The helper's windows, on the main thread: the menu bar item, the question before a session, the corner window and
//! the setup window. A timer every 100 ms reads what the other threads left in `Shared` and updates them.
//!
//! - The question: "Don't allow" is the default button (Return), "Allow" is off for its first 500 ms, and with no
//!   answer after 120 seconds it closes as Don't allow.
//! - The corner window: who is connected and for how long, and End session (a second click within 5 s confirms).
//! - The menu: the state, who is connected with End session, Check now, Allow any time (when asking), the six digits
//!   while pending, recent history, Set up or Uninstall, and the version.
//! - The setup window: the link, an optional code, the name, ask or any and full or limited with nothing chosen, the
//!   two permissions with their live state and Open Settings, and the outcome (the six digits while pending).

use super::helper::{AskRequest, Shared, UiRequest};
use crate::ipc::{HelperSession, Request};
use crate::paths;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, MainThreadOnly};
use objc2_app_kit::{
    NSAlert, NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSButton, NSControlStateValueOn, NSFloatingWindowLevel, NSFont,
    NSMenu, NSMenuItem, NSPanel, NSScreen, NSStatusBar, NSStatusItem, NSTextField, NSVariableStatusItemLength, NSView, NSWindow,
    NSWindowCollectionBehavior, NSWindowStyleMask, NSWorkspace,
};
use objc2_foundation::{ns_string, MainThreadMarker, NSObject, NSPoint, NSRect, NSRunLoop, NSRunLoopCommonModes, NSSize, NSString, NSTimer, NSURL};
use serde_json::{Map, Value};
use std::cell::{Cell, RefCell};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support_core::geometry::Rect;

const TAG_END: isize = 1;
const TAG_CHECK: isize = 2;
const TAG_ANY: isize = 3;
const TAG_SETUP: isize = 4;
const TAG_UNINSTALL: isize = 5;
const TAG_ASK_ALLOW: isize = 10;
const TAG_ASK_DENY: isize = 11;
const TAG_CORNER_END: isize = 20;
const TAG_SETUP_GO: isize = 30;
const TAG_OPEN_SCREEN: isize = 31;
const TAG_OPEN_AX: isize = 32;

const ASK_ARM: Duration = Duration::from_millis(500);
const ASK_LIMIT: Duration = Duration::from_millis(support_core::platform::ASK_MS);

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and Target does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SupportMcpUiTarget"]
    struct Target;

    impl Target {
        #[unsafe(method(act:))]
        fn act(&self, sender: &AnyObject) {
            // SAFETY: every sender is an NSMenuItem or an NSControl, and both answer `tag`.
            let tag: isize = unsafe { msg_send![sender, tag] };
            action(tag);
        }

        #[unsafe(method(tick:))]
        fn tick(&self, _timer: &NSTimer) {
            tick();
        }
    }
);

impl Target {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: NSObject's init.
        unsafe { msg_send![super(this), init] }
    }
}

struct AskPanel {
    id: u64,
    window: Retained<NSPanel>,
    allow: Retained<NSButton>,
    shown: Instant,
    answer: std::sync::mpsc::Sender<bool>,
}

struct Corner {
    window: Retained<NSPanel>,
    label: Retained<NSTextField>,
    end: Retained<NSButton>,
    armed_until: Option<Instant>,
    /// When the session ended, and what the window says until it goes.
    ended: Option<(Instant, String)>,
    since_ms: i64,
}

struct SetupWin {
    window: Retained<NSWindow>,
    link: Retained<NSTextField>,
    code: Retained<NSTextField>,
    name: Retained<NSTextField>,
    ask: Retained<NSButton>,
    any: Retained<NSButton>,
    full: Retained<NSButton>,
    limited: Retained<NSButton>,
    screen_state: Retained<NSTextField>,
    ax_state: Retained<NSTextField>,
    outcome: Retained<NSTextField>,
    go: Retained<NSButton>,
}

struct Ui {
    mtm: MainThreadMarker,
    shared: Arc<Shared>,
    target: Retained<Target>,
    status_item: Option<Retained<NSStatusItem>>,
    menu_key: String,
    ask: Option<AskPanel>,
    corner: Option<Corner>,
    setup: Option<SetupWin>,
    _timer: Option<Retained<NSTimer>>,
}

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
    /// Set while a modal alert runs, so the timer does not re-enter.
    static MODAL: Cell<bool> = const { Cell::new(false) };
}

fn s(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
}

fn status_text(m: &Map<String, Value>, key: &str) -> String {
    m.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn state_line(m: Option<&Map<String, Value>>) -> String {
    let Some(m) = m else { return "Support's service is not running.".into() };
    match status_text(m, "state").as_str() {
        "not_set_up" => "Support is not set up yet.".into(),
        "active" => "Your support team can reach this Mac.".into(),
        "pending" => "Waiting for your support team to approve this Mac.".into(),
        "offline" => "Support cannot reach your support team's server right now.".into(),
        "removed" => "Your support team removed this Mac.".into(),
        "expired" => "The request to join your support team expired.".into(),
        "update_needed" => "Support needs an update.".into(),
        other => format!("State: {other}"),
    }
}

fn elapsed(since_ms: i64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let secs = ((now - since_ms) / 1000).max(0);
    format!("{:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
}

fn send(r: UiRequest) {
    UI.with(|u| {
        if let Some(ui) = u.borrow().as_ref() {
            let _ = ui.shared.requests.lock().unwrap().send(r);
        }
    });
}

/// A modal alert, with the timer held off while it runs. Returns the index of the button clicked.
fn alert(mtm: MainThreadMarker, title: &str, text: &str, buttons: &[&str]) -> usize {
    MODAL.with(|m| m.set(true));
    let a = NSAlert::new(mtm);
    a.setMessageText(&s(title));
    a.setInformativeText(&s(text));
    for b in buttons {
        a.addButtonWithTitle(&s(b));
    }
    NSApplication::sharedApplication(mtm).activate();
    let r = a.runModal();
    MODAL.with(|m| m.set(false));
    // NSAlertFirstButtonReturn is 1000.
    (r - 1000).max(0) as usize
}

fn menu_item(mtm: MainThreadMarker, target: &Target, title: &str, tag: isize) -> Retained<NSMenuItem> {
    // SAFETY: a fresh item with a selector our target implements.
    let item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &s(title), Some(sel!(act:)), ns_string!("")) };
    if tag == 0 {
        item.setEnabled(false);
    } else {
        // SAFETY: the target outlives the menu (it lives in the UI state for the process).
        unsafe { item.setTarget(Some(target)) };
        item.setTag(tag);
    }
    item
}

fn rebuild_menu(ui: &mut Ui) {
    let Some(item) = ui.status_item.as_ref() else { return };
    let status = ui.shared.status.lock().unwrap().clone();
    let key = serde_json::to_string(&status).unwrap_or_default();
    if key == ui.menu_key {
        return;
    }
    ui.menu_key = key;
    let mtm = ui.mtm;
    let t = &ui.target;
    let menu = NSMenu::new(mtm);
    menu.setAutoenablesItems(false);
    menu.addItem(&menu_item(mtm, t, &state_line(status.as_ref()), 0));
    if let Some(m) = status.as_ref() {
        let set_up = m.get("set_up") == Some(&Value::Bool(true));
        let state = status_text(m, "state");
        if let Some(code) = m.get("confirm").and_then(Value::as_str) {
            menu.addItem(&menu_item(mtm, t, &format!("Read these digits to your support team: {}", super::cli::digits(code)), 0));
        }
        if set_up && state != "removed" && state != "expired" {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
            match m.get("session").and_then(Value::as_object) {
                Some(sess) => {
                    menu.addItem(&menu_item(mtm, t, &format!("Connected: {}", status_text(sess, "by")), 0));
                    menu.addItem(&menu_item(mtm, t, "End session", TAG_END));
                }
                None => menu.addItem(&menu_item(mtm, t, "No one is connected.", 0)),
            }
            let ask = status_text(m, "access") == "ask";
            menu.addItem(&menu_item(mtm, t, if ask { "Support asks you before each connection." } else { "Support can connect any time." }, 0));
            if ask && state == "active" {
                menu.addItem(&menu_item(mtm, t, "Allow any time", TAG_ANY));
            }
            menu.addItem(&menu_item(mtm, t, "Check now", TAG_CHECK));
        }
        let history: Vec<String> = m
            .get("history")
            .and_then(Value::as_array)
            .map(|h| h.iter().rev().take(10).filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        if !history.is_empty() {
            let sub = NSMenu::new(mtm);
            sub.setAutoenablesItems(false);
            for line in &history {
                sub.addItem(&menu_item(mtm, t, line, 0));
            }
            let h = menu_item(mtm, t, "Recent history", 0);
            h.setEnabled(true);
            h.setSubmenu(Some(&sub));
            menu.addItem(&h);
        }
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        if !set_up || state == "removed" || state == "expired" {
            menu.addItem(&menu_item(mtm, t, "Set up Support…", TAG_SETUP));
        }
        menu.addItem(&menu_item(mtm, t, "Uninstall Support…", TAG_UNINSTALL));
        menu.addItem(&menu_item(mtm, t, &format!("Version {}", status_text(m, "version")), 0));
    }
    item.setMenu(Some(&menu));
}

fn label(mtm: MainThreadMarker, text: &str, frame: NSRect, size: f64, bold: bool) -> Retained<NSTextField> {
    let l = NSTextField::wrappingLabelWithString(&s(text), mtm);
    l.setFrame(frame);
    let font = if bold { NSFont::boldSystemFontOfSize(size) } else { NSFont::systemFontOfSize(size) };
    l.setFont(Some(&font));
    l
}

fn button(mtm: MainThreadMarker, target: &Target, title: &str, tag: isize, frame: NSRect) -> Retained<NSButton> {
    // SAFETY: a selector our target implements; the target outlives the button.
    let b = unsafe { NSButton::buttonWithTitle_target_action(&s(title), Some(target), Some(sel!(act:)), mtm) };
    b.setFrame(frame);
    b.setTag(tag);
    b
}

fn panel(mtm: MainThreadMarker, frame: NSRect, style: NSWindowStyleMask) -> Retained<NSPanel> {
    // A fresh panel; it is kept in the UI state, so it is not released on close.
    let p = NSPanel::initWithContentRect_styleMask_backing_defer(NSPanel::alloc(mtm), frame, style, NSBackingStoreType::Buffered, false);
    // SAFETY: the UI state owns the window.
    unsafe { p.setReleasedWhenClosed(false) };
    p.setLevel(NSFloatingWindowLevel);
    p.setHidesOnDeactivate(false);
    p
}

// ---- the question -----------------------------------------------------------------------------------------------

fn show_ask(ui: &mut Ui, req: AskRequest) {
    // One question at a time: a second while one is open is no.
    if ui.ask.is_some() {
        let _ = req.answer.send(false);
        return;
    }
    let mtm = ui.mtm;
    let (w, h) = (460.0, 250.0);
    let window = panel(mtm, rect(0.0, 0.0, w, h), NSWindowStyleMask::Titled);
    window.setTitle(ns_string!("Remote support"));
    let Some(view) = window.contentView() else { return };
    let by = if req.by.is_empty() { "your support team".to_string() } else { req.by.clone() };
    let who =
        format!("{} from {}", if req.by.is_empty() { "Someone" } else { &req.by }, if req.team.is_empty() { "your support team" } else { &req.team });
    let what = if req.full {
        "They can see your screen, control your mouse and keyboard, run commands and change files, also as an administrator and at the login window."
    } else {
        "They can see your screen, control your mouse and keyboard, and run commands and change files as you."
    };
    view.addSubview(&label(mtm, &format!("Allow {by} to connect to this Mac?"), rect(20.0, h - 50.0, w - 40.0, 24.0), 15.0, true));
    let body = format!(
        "{who} wants to connect to this Mac. {what}\n\nA small window stays in the corner while they are connected. End session there, or in the Support menu, ends it at once.\n\nWith no answer, this says Don't allow by itself after 2 minutes."
    );
    view.addSubview(&label(mtm, &body, rect(20.0, 60.0, w - 40.0, h - 120.0), 12.5, false));
    let deny = button(mtm, &ui.target, "Don't allow", TAG_ASK_DENY, rect(w - 230.0, 16.0, 110.0, 32.0));
    // Return answers Don't allow: it is the default.
    deny.setKeyEquivalent(ns_string!("\r"));
    let allow = button(mtm, &ui.target, "Allow", TAG_ASK_ALLOW, rect(w - 110.0, 16.0, 90.0, 32.0));
    allow.setEnabled(false);
    view.addSubview(&deny);
    view.addSubview(&allow);
    window.center();
    NSApplication::sharedApplication(mtm).activate();
    window.makeKeyAndOrderFront(None);
    ui.ask = Some(AskPanel { id: req.id, window, allow, shown: Instant::now(), answer: req.answer });
}

fn close_ask(ui: &mut Ui, yes: bool) {
    if let Some(a) = ui.ask.take() {
        let _ = a.answer.send(yes);
        a.window.orderOut(None);
    }
}

fn tick_ask(ui: &mut Ui) {
    let cancelled: Vec<u64> = std::mem::take(&mut *ui.shared.cancelled_asks.lock().unwrap());
    if let Some(a) = ui.ask.as_ref() {
        if cancelled.contains(&a.id) || a.shown.elapsed() >= ASK_LIMIT {
            close_ask(ui, false);
        } else if a.shown.elapsed() >= ASK_ARM {
            a.allow.setEnabled(true);
        }
    }
    let pending: Vec<AskRequest> = std::mem::take(&mut *ui.shared.asks.lock().unwrap());
    for req in pending {
        if cancelled.contains(&req.id) {
            let _ = req.answer.send(false);
        } else {
            show_ask(ui, req);
        }
    }
}

// ---- the corner window ------------------------------------------------------------------------------------------

fn corner(ui: &mut Ui) -> &mut Corner {
    if ui.corner.is_none() {
        let mtm = ui.mtm;
        let (w, h) = (300.0, 64.0);
        let screen = NSScreen::mainScreen(mtm).map(|s| s.visibleFrame()).unwrap_or(rect(0.0, 0.0, 1280.0, 800.0));
        let frame = rect(screen.origin.x + screen.size.width - w - 16.0, screen.origin.y + 16.0, w, h);
        let window = panel(mtm, frame, NSWindowStyleMask::Titled | NSWindowStyleMask::UtilityWindow | NSWindowStyleMask::NonactivatingPanel);
        window.setTitle(ns_string!("Support"));
        window.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Stationary);
        let view = window.contentView().unwrap_or_else(|| NSView::new(mtm));
        let label = label(mtm, "", rect(12.0, 10.0, w - 130.0, h - 20.0), 12.0, false);
        let end = button(mtm, &ui.target, "End session", TAG_CORNER_END, rect(w - 116.0, (h - 32.0) / 2.0, 106.0, 32.0));
        view.addSubview(&label);
        view.addSubview(&end);
        ui.corner = Some(Corner { window, label, end, armed_until: None, ended: None, since_ms: 0 });
    }
    ui.corner.as_mut().unwrap()
}

fn tick_corner(ui: &mut Ui) {
    let status = ui.shared.status.lock().unwrap().clone();
    let session = status.as_ref().and_then(|m| m.get("session")).and_then(Value::as_object).cloned();
    let access_any = status.as_ref().is_some_and(|m| status_text(m, "access") == "any");
    match session {
        Some(sess) => {
            let by = status_text(&sess, "by");
            let since = sess.get("since").and_then(Value::as_i64).unwrap_or(0);
            let c = corner(ui);
            c.since_ms = since;
            c.ended = None;
            c.label.setStringValue(&s(&format!("{} is connected\n{}", if by.is_empty() { "Your support team" } else { &by }, elapsed(since))));
            if c.armed_until.is_some_and(|t| Instant::now() > t) {
                c.armed_until = None;
                c.end.setTitle(ns_string!("End session"));
            }
            c.end.setHidden(false);
            c.window.orderFrontRegardless();
        }
        None => {
            let Some(c) = ui.corner.as_mut() else { return };
            if !c.window.isVisible() {
                return;
            }
            match &c.ended {
                None => {
                    let follow = if access_any {
                        "Your support team can connect again later."
                    } else {
                        "Your support team will ask you before connecting again."
                    };
                    let text = format!("Session ended after {}.\n{follow}", elapsed(c.since_ms));
                    c.label.setStringValue(&s(&text));
                    c.end.setHidden(true);
                    c.ended = Some((Instant::now(), text));
                }
                Some((at, _)) if at.elapsed() > Duration::from_secs(4) => c.window.orderOut(None),
                Some(_) => {}
            }
        }
    }
}

// ---- the setup window -------------------------------------------------------------------------------------------

fn open_setup(ui: &mut Ui) {
    if let Some(w) = ui.setup.as_ref() {
        NSApplication::sharedApplication(ui.mtm).activate();
        w.window.makeKeyAndOrderFront(None);
        return;
    }
    let mtm = ui.mtm;
    let (w, h) = (520.0, 560.0);
    // SAFETY: a fresh window, kept in the UI state, so it is not released on close.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect(0.0, 0.0, w, h),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(ns_string!("Set up Support"));
    let Some(view) = window.contentView() else { return };
    let t = &ui.target;
    let y = Cell::new(h - 20.0);
    let row = |height: f64| {
        y.set(y.get() - height);
        y.get()
    };
    let field = |frame: NSRect, placeholder: &str| {
        let f = NSTextField::initWithFrame(NSTextField::alloc(mtm), frame);
        f.setPlaceholderString(Some(&s(placeholder)));
        f
    };
    view.addSubview(&label(mtm, "The setup link from your support team", rect(20.0, row(20.0), w - 40.0, 18.0), 13.0, true));
    let link = field(rect(20.0, row(28.0), w - 40.0, 24.0), "https://…/install?code=…");
    view.addSubview(&link);
    view.addSubview(&label(mtm, "Code, only if the link has none", rect(20.0, row(26.0), w - 40.0, 18.0), 12.0, false));
    let code = field(rect(20.0, row(28.0), 200.0, 24.0), "ABCDE-FGH23");
    view.addSubview(&code);
    view.addSubview(&label(mtm, "A name for this Mac", rect(20.0, row(26.0), w - 40.0, 18.0), 13.0, true));
    let name = field(rect(20.0, row(28.0), w - 40.0, 24.0), "For example: Front desk Mac");
    view.addSubview(&name);

    // Each pair of radio buttons sits in a view of its own, so the two groups stay apart. Neither is chosen.
    let group = |top: f64, first: &str, second: &str| {
        let g = NSView::initWithFrame(NSView::alloc(mtm), rect(20.0, top, w - 40.0, 48.0));
        // SAFETY: selectors our target implements; the tag 0 makes a click do nothing but select.
        let a = unsafe { NSButton::radioButtonWithTitle_target_action(&s(first), Some(t), Some(sel!(act:)), mtm) };
        let b = unsafe { NSButton::radioButtonWithTitle_target_action(&s(second), Some(t), Some(sel!(act:)), mtm) };
        a.setFrame(rect(0.0, 24.0, w - 40.0, 22.0));
        b.setFrame(rect(0.0, 0.0, w - 40.0, 22.0));
        a.setState(0);
        b.setState(0);
        g.addSubview(&a);
        g.addSubview(&b);
        (g, a, b)
    };
    view.addSubview(&label(mtm, "How your support team connects", rect(20.0, row(30.0), w - 40.0, 18.0), 13.0, true));
    let (g1, ask, any) = group(row(50.0), "Ask me before each connection", "Any time, without asking");
    view.addSubview(&g1);
    view.addSubview(&label(mtm, "How much they can do", rect(20.0, row(30.0), w - 40.0, 18.0), 13.0, true));
    let (g2, full, limited) =
        group(row(50.0), "Full control: also as an administrator and at the login window", "Limited: only as me, while I am signed in");
    view.addSubview(&g2);

    view.addSubview(&label(mtm, "Two permissions in System Settings, Privacy & Security", rect(20.0, row(30.0), w - 40.0, 18.0), 13.0, true));
    let screen_state = label(mtm, "", rect(20.0, row(30.0), 330.0, 20.0), 12.0, false);
    view.addSubview(&screen_state);
    view.addSubview(&button(mtm, t, "Open Settings", TAG_OPEN_SCREEN, rect(w - 160.0, y.get() - 4.0, 140.0, 28.0)));
    let ax_state = label(mtm, "", rect(20.0, row(30.0), 330.0, 20.0), 12.0, false);
    view.addSubview(&ax_state);
    view.addSubview(&button(mtm, t, "Open Settings", TAG_OPEN_AX, rect(w - 160.0, y.get() - 4.0, 140.0, 28.0)));

    let outcome = label(mtm, "", rect(20.0, 60.0, w - 40.0, y.get() - 70.0), 13.0, false);
    view.addSubview(&outcome);
    let go = button(mtm, t, "Set up", TAG_SETUP_GO, rect(w - 140.0, 14.0, 120.0, 32.0));
    go.setKeyEquivalent(ns_string!("\r"));
    view.addSubview(&go);
    window.center();
    NSApplication::sharedApplication(mtm).activate();
    window.makeKeyAndOrderFront(None);
    ui.setup = Some(SetupWin { window, link, code, name, ask, any, full, limited, screen_state, ax_state, outcome, go });
}

fn submit_setup(ui: &mut Ui) {
    let Some(w) = ui.setup.as_ref() else { return };
    let text = |f: &NSTextField| f.stringValue().to_string();
    let (link, code, name) = (text(&w.link), text(&w.code), text(&w.name));
    let on = |b: &NSButton| b.state() == NSControlStateValueOn;
    let access = if on(&w.ask) {
        "ask"
    } else if on(&w.any) {
        "any"
    } else {
        w.outcome.setStringValue(ns_string!("Choose how your support team connects."));
        return;
    };
    let control = if on(&w.full) {
        "full"
    } else if on(&w.limited) {
        "limited"
    } else {
        w.outcome.setStringValue(ns_string!("Choose how much they can do."));
        return;
    };
    let code = Some(code.trim().to_string()).filter(|c| !c.is_empty());
    if let Err(e) = crate::setup::parse_link(&link, code.as_deref()).and_then(|_| crate::setup::check_name(&name)) {
        w.outcome.setStringValue(&s(&e));
        return;
    }
    w.go.setEnabled(false);
    w.outcome.setStringValue(ns_string!("Setting up… macOS asks for an administrator's name and password."));
    let _ = ui.shared.requests.lock().unwrap().send(UiRequest::Setup { link, code, name, access: access.into(), control: control.into() });
}

fn tick_setup(ui: &mut Ui) {
    let notice = ui.shared.notice.lock().unwrap().take();
    let status = ui.shared.status.lock().unwrap().clone();
    let Some(w) = ui.setup.as_ref() else {
        if let Some((text, _)) = notice {
            let mtm = ui.mtm;
            // Shown after the timer's borrow ends.
            PENDING_ALERT.with(|p| *p.borrow_mut() = Some((mtm, text)));
        }
        return;
    };
    let screen = objc2_core_graphics::CGPreflightScreenCaptureAccess();
    let ax = super::helper::accessibility();
    w.screen_state.setStringValue(&s(&format!("Screen Recording: {}", if screen { "allowed" } else { "not allowed yet" })));
    w.ax_state.setStringValue(&s(&format!("Accessibility: {}", if ax { "allowed" } else { "not allowed yet" })));
    if let Some((text, ok)) = notice {
        w.outcome.setStringValue(&s(&text));
        w.go.setEnabled(!ok);
    }
    // While pending, the six digits stay in view.
    if let Some(code) = status.as_ref().and_then(|m| m.get("confirm")).and_then(Value::as_str) {
        let text = format!("Waiting for your support team to approve this Mac. Read them these six digits: {}", super::cli::digits(code));
        w.outcome.setStringValue(&s(&text));
        w.outcome.setFont(Some(&NSFont::boldSystemFontOfSize(15.0)));
    }
}

thread_local! {
    static PENDING_ALERT: RefCell<Option<(MainThreadMarker, String)>> = const { RefCell::new(None) };
}

// ---- actions and the timer --------------------------------------------------------------------------------------

fn open_url(text: &str) {
    if let Some(url) = NSURL::URLWithString(&s(text)) {
        NSWorkspace::sharedWorkspace().openURL(&url);
    }
}

fn action(tag: isize) {
    let mut confirm_uninstall = None;
    UI.with(|u| {
        let mut guard = u.borrow_mut();
        let Some(ui) = guard.as_mut() else { return };
        match tag {
            TAG_END => {
                let _ = ui.shared.requests.lock().unwrap().send(UiRequest::Simple(Request::EndSession));
            }
            TAG_CHECK => {
                let _ = ui.shared.requests.lock().unwrap().send(UiRequest::Simple(Request::Refresh));
            }
            TAG_ANY => {
                let _ = ui.shared.requests.lock().unwrap().send(UiRequest::Simple(Request::AllowAnyTime));
            }
            TAG_SETUP => open_setup(ui),
            TAG_UNINSTALL => confirm_uninstall = Some(ui.mtm),
            TAG_ASK_ALLOW => {
                // Allow does nothing for its first 500 ms, so a click meant for another window cannot answer.
                if ui.ask.as_ref().is_some_and(|a| a.shown.elapsed() >= ASK_ARM) {
                    close_ask(ui, true);
                }
            }
            TAG_ASK_DENY => close_ask(ui, false),
            TAG_CORNER_END => {
                if let Some(c) = ui.corner.as_mut() {
                    if c.armed_until.is_some_and(|t| Instant::now() <= t) {
                        c.armed_until = None;
                        let _ = ui.shared.requests.lock().unwrap().send(UiRequest::Simple(Request::EndSession));
                    } else {
                        c.armed_until = Some(Instant::now() + Duration::from_secs(5));
                        c.end.setTitle(ns_string!("End now?"));
                    }
                }
            }
            TAG_SETUP_GO => submit_setup(ui),
            TAG_OPEN_SCREEN => {
                // Puts Support in the list (and asks once), then opens the right page.
                let _ = objc2_core_graphics::CGRequestScreenCaptureAccess();
                open_url(paths::SETTINGS_SCREEN);
            }
            TAG_OPEN_AX => {
                prompt_accessibility();
                open_url(paths::SETTINGS_ACCESSIBILITY);
            }
            _ => {}
        }
    });
    if let Some(mtm) = confirm_uninstall {
        let choice = alert(
            mtm,
            "Remove Support from this Mac?",
            "Your support team will no longer be able to reach this Mac. macOS asks for an administrator's name and password.",
            &["Cancel", "Remove"],
        );
        if choice == 1 {
            send(UiRequest::Uninstall);
        }
    }
}

fn prompt_accessibility() {
    use objc2_core_foundation::{CFBoolean, CFDictionary, CFString, CFType};
    // SAFETY: a framework constant.
    let key: &CFString = unsafe { objc2_application_services::kAXTrustedCheckOptionPrompt };
    let value: &CFType = CFBoolean::new(true).as_ref();
    let options = CFDictionary::<CFString, CFType>::from_slices(&[key], &[value]);
    // SAFETY: the dictionary holds what the call expects.
    let _ = unsafe { objc2_application_services::AXIsProcessTrustedWithOptions(Some(options.as_opaque())) };
}

/// The app's visible windows, in global points with the origin at the top left, for the click guard.
fn own_windows(ui: &Ui) -> Vec<Rect> {
    let primary_h = NSScreen::screens(ui.mtm).firstObject().map(|s| s.frame().size.height).unwrap_or(0.0);
    let mut out = Vec::new();
    let mut add = |f: NSRect| {
        let top = primary_h - (f.origin.y + f.size.height);
        out.push(Rect {
            left: f.origin.x.floor() as i64,
            top: top.floor() as i64,
            right: (f.origin.x + f.size.width).ceil() as i64,
            bottom: (top + f.size.height).ceil() as i64,
        });
    };
    if let Some(a) = ui.ask.as_ref() {
        add(a.window.frame());
    }
    if let Some(c) = ui.corner.as_ref().filter(|c| c.window.isVisible()) {
        add(c.window.frame());
    }
    if let Some(w) = ui.setup.as_ref().filter(|w| w.window.isVisible()) {
        add(w.window.frame());
    }
    out
}

fn tick() {
    if MODAL.with(|m| m.get()) {
        return;
    }
    UI.with(|u| {
        let Ok(mut guard) = u.try_borrow_mut() else { return };
        let Some(ui) = guard.as_mut() else { return };
        tick_ask(ui);
        if ui.shared.session == HelperSession::Aqua {
            rebuild_menu(ui);
            tick_corner(ui);
            tick_setup(ui);
        }
        let rects = own_windows(ui);
        *ui.shared.own_windows.lock().unwrap() = rects;
    });
    if let Some((mtm, text)) = PENDING_ALERT.with(|p| p.borrow_mut().take()) {
        alert(mtm, "Support", &text, &["OK"]);
    }
}

/// Sets up the app and runs its loop. Never returns.
pub fn run(mtm: MainThreadMarker, shared: Arc<Shared>) {
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let target = Target::new(mtm);
    let status_item = (shared.session == HelperSession::Aqua).then(|| {
        let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
        if let Some(b) = item.button(mtm) {
            b.setTitle(ns_string!("Support"));
        }
        item
    });
    // SAFETY: a selector our target implements; the timer keeps the target alive.
    let timer = unsafe { NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(0.1, &target, sel!(tick:), None, true) };
    // The timer also fires while a menu is open.
    // SAFETY: the main run loop and a framework constant.
    unsafe { NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
    UI.with(|u| {
        *u.borrow_mut() =
            Some(Ui { mtm, shared, target, status_item, menu_key: String::new(), ask: None, corner: None, setup: None, _timer: Some(timer) });
    });
    app.run();
}

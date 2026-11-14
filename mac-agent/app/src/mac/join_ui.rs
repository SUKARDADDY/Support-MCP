//! The join app's windows, on the main thread: one window that walks through the steps (the link, the relay and label,
//! the question, the two switches, the end), a corner window while support is connected, and a main menu with Paste so
//! the link can be pasted. A timer every 100 ms reads the controller's `View` and redraws when it changed.
//!
//! - The question: "Don't allow" is the default button (Return), "Allow" is off for its first 500 ms, and with no
//!   answer after 2 minutes it closes as Don't allow. This is the saved app's question (src/mac/ui.rs).
//! - The two switches: live state of Screen Recording and Accessibility, a button to each page of System Settings.
//! - The corner window: End session, a second click within 5 seconds confirms.
//! - The page's button hands the code over as a `supportmcp://join?code=...` Apple event, which goes to the controller
//!   as a pasted link would.

use super::join::{JoinShared, View};
use super::ui::{alert, label, modal, open_url, panel, prompt_accessibility, rect, s};
use crate::join::{Event, Step, TrashOffer};
use crate::paths;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSButton, NSMenu, NSMenuItem, NSScreen, NSTextField, NSWindow,
    NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_foundation::{ns_string, MainThreadMarker, NSFileManager, NSObject, NSRunLoop, NSRunLoopCommonModes, NSTimer, NSURL};
use std::cell::RefCell;
use std::sync::Arc;
use std::time::{Duration, Instant};
use support_core::geometry::Rect;

const TAG_PRIMARY: isize = 1;
const TAG_SECONDARY: isize = 2;
const TAG_OPEN_SCREEN: isize = 3;
const TAG_OPEN_AX: isize = 4;
const TAG_CORNER_END: isize = 5;
const TAG_QUIT: isize = 6;

const ASK_ARM: Duration = Duration::from_millis(500);
const ASK_LIMIT: Duration = Duration::from_millis(support_core::platform::ASK_MS);
/// The 'GURL' Apple event: a link opened in an app that registered its scheme.
const GURL: u32 = 0x4755_524C;
/// The direct-object keyword '----' of an Apple event.
const KEY_DIRECT: u32 = 0x2D2D_2D2D;

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and JoinTarget does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SupportJoinTarget"]
    struct JoinTarget;

    impl JoinTarget {
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

        #[unsafe(method(handleURL:withReply:))]
        fn handle_url(&self, event: &AnyObject, _reply: &AnyObject) {
            // SAFETY: an NSAppleEventDescriptor answers paramDescriptorForKeyword: with another one or nil, and that
            // answers stringValue with a string or nil.
            let text: Option<String> = unsafe {
                let param: Option<Retained<AnyObject>> = msg_send![event, paramDescriptorForKeyword: KEY_DIRECT];
                param.and_then(|p| {
                    let v: Option<Retained<objc2_foundation::NSString>> = msg_send![&*p, stringValue];
                    v.map(|v| v.to_string())
                })
            };
            if let Some(t) = text {
                URLS.with(|u| u.borrow_mut().push(t));
            }
        }
    }
);

impl JoinTarget {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: NSObject's init.
        unsafe { msg_send![super(this), init] }
    }
}

struct Win {
    window: Retained<NSWindow>,
    title: Retained<NSTextField>,
    body: Retained<NSTextField>,
    field: Retained<NSTextField>,
    notice: Retained<NSTextField>,
    status: Retained<NSTextField>,
    primary: Retained<NSButton>,
    secondary: Retained<NSButton>,
    open_screen: Retained<NSButton>,
    open_ax: Retained<NSButton>,
}

struct Corner {
    window: Retained<objc2_app_kit::NSPanel>,
    label: Retained<NSTextField>,
    end: Retained<NSButton>,
    armed_until: Option<Instant>,
}

struct Ui {
    mtm: MainThreadMarker,
    shared: Arc<JoinShared>,
    target: Retained<JoinTarget>,
    win: Win,
    corner: Option<Corner>,
    /// What the window shows now, so it is redrawn only when it changes.
    drawn: String,
    /// When the question appeared.
    asked: Option<Instant>,
    _timer: Retained<NSTimer>,
}

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
    /// Links from the page's button, from the Apple event handler (which may run before the UI exists).
    static URLS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    static ALERTS: RefCell<Option<(MainThreadMarker, String)>> = const { RefCell::new(None) };
}

fn button(mtm: MainThreadMarker, target: &JoinTarget, title: &str, tag: isize, frame: objc2_foundation::NSRect) -> Retained<NSButton> {
    // SAFETY: a selector our target implements; the target outlives the button.
    let b = unsafe { NSButton::buttonWithTitle_target_action(&s(title), Some(target), Some(sel!(act:)), mtm) };
    b.setFrame(frame);
    b.setTag(tag);
    b
}

/// A problem before the app can start (no relay built in, run as root): one alert, then the app ends.
pub fn fatal(mtm: MainThreadMarker, text: &str) {
    NSApplication::sharedApplication(mtm).setActivationPolicy(NSApplicationActivationPolicy::Regular);
    alert(mtm, "Support Join", text, &["OK"]);
}

fn build_window(mtm: MainThreadMarker, target: &JoinTarget) -> Win {
    let (w, h) = (520.0, 380.0);
    // SAFETY: a fresh window, kept in the UI state, so it is not released on close.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect(0.0, 0.0, w, h),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Miniaturizable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: the UI state owns the window.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(ns_string!("Support Join"));
    let view = window.contentView().expect("a window has a content view");
    let title = label(mtm, "", rect(20.0, h - 52.0, w - 40.0, 26.0), 17.0, true);
    let body = label(mtm, "", rect(20.0, 150.0, w - 40.0, 170.0), 13.0, false);
    let field = NSTextField::initWithFrame(NSTextField::alloc(mtm), rect(20.0, 200.0, w - 40.0, 24.0));
    field.setPlaceholderString(Some(&s("Paste the link or type the code")));
    let notice = label(mtm, "", rect(20.0, 150.0, w - 40.0, 44.0), 12.0, false);
    let status = label(mtm, "", rect(20.0, 112.0, w - 40.0, 38.0), 13.0, true);
    let primary = button(mtm, target, "", TAG_PRIMARY, rect(w - 250.0, 16.0, 230.0, 32.0));
    let secondary = button(mtm, target, "", TAG_SECONDARY, rect(20.0, 16.0, 150.0, 32.0));
    let open_screen = button(mtm, target, "Open Screen Recording settings", TAG_OPEN_SCREEN, rect(20.0, 72.0, 240.0, 28.0));
    let open_ax = button(mtm, target, "Open Accessibility settings", TAG_OPEN_AX, rect(270.0, 72.0, 230.0, 28.0));
    for v in [&title, &body, &field, &notice, &status] {
        view.addSubview(v);
    }
    for b in [&primary, &secondary, &open_screen, &open_ax] {
        view.addSubview(b);
    }
    Win { window, title, body, field, notice, status, primary, secondary, open_screen, open_ax }
}

fn host_line(host: &str, label: &Option<String>) -> String {
    format!(
        "Support server: {host}\nSession: {}\n\nNothing has been used yet. If this is not the session your support team told you about, click Cancel.",
        label.as_deref().unwrap_or("(no name was given)")
    )
}

/// What the window says and shows for a view: (title, body, notice, status, primary, secondary, field shown, settings shown).
fn texts(v: &View) -> (String, String, String, String, Option<&'static str>, Option<&'static str>, bool, bool) {
    let none = String::new;
    match &v.step {
        Step::Entry => (
            "Join a support session".into(),
            "Paste the link your support team sent you, or type its 16-letter code. Nothing is installed, and Support Join runs as you, without an administrator password.".into(),
            v.notice.clone().unwrap_or_default(),
            none(),
            Some("Continue"),
            None,
            true,
            false,
        ),
        Step::Looking => ("Checking the link…".into(), "Asking the support server what this link is for.".into(), none(), none(), None, None, false, false),
        Step::Confirm { host, label } => (
            "Join this session?".into(),
            host_line(host, label),
            none(),
            none(),
            Some("Join this session"),
            Some("Cancel"),
            false,
            false,
        ),
        Step::Redeeming => ("Joining…".into(), "One moment.".into(), none(), none(), None, None, false, false),
        Step::Asking => (
            "Allow support to connect to this Mac?".into(),
            "Your support team can see your screen, control your mouse and keyboard, and run commands and change files as you. Not as an administrator, and not at the login window.\n\nA small window stays in the corner while they are connected. End session there ends it at once.\n\nWith no answer, this says Don't allow by itself after 2 minutes."
                .into(),
            none(),
            none(),
            Some("Allow"),
            Some("Don't allow"),
            false,
            false,
        ),
        Step::Permissions => (
            "Turn on two switches".into(),
            "macOS lets only you allow these two. Open each page, find Support Join in the list and switch it on. After the first one macOS may ask you to quit and reopen Support Join: do that, it carries on by itself.\n\nSupport connects when both are on. If you change your mind, click End session."
                .into(),
            none(),
            format!(
                "Screen Recording: {}\nAccessibility: {}",
                if v.screen { "on" } else { "not yet" },
                if v.accessibility { "on" } else { "not yet" }
            ),
            None,
            Some("End session"),
            false,
            true,
        ),
        Step::Connecting => ("Connecting…".into(), "Connecting to your support team.".into(), none(), none(), None, Some("End session"), false, false),
        Step::Connected => ("Support is connected".into(), "The window in the corner of your screen shows who is connected. End session there stops it.".into(), none(), none(), None, None, false, false),
        Step::Ending => ("Cleaning up…".into(), "Removing the session's file and the permissions you gave.".into(), none(), none(), None, None, false, false),
        Step::Done { lines } => {
            let trash = match &v.trash {
                TrashOffer::Move(_) => "\n\nSupport Join has nothing left to do. You can move it to the Trash now.",
                TrashOffer::Manual => "\n\nSupport Join has nothing left to do. Find it where you downloaded it and drag it to the Trash.",
                TrashOffer::None => "",
            };
            (
                "The session is over".into(),
                format!("{}{trash}", lines.join("\n")),
                none(),
                none(),
                match &v.trash {
                    TrashOffer::Move(_) => Some("Move Support Join to the Trash"),
                    _ => None,
                },
                Some("Quit"),
                false,
                false,
            )
        }
    }
}

fn draw(ui: &mut Ui, v: &View) {
    let (title, body, notice, status, primary, secondary, field, settings) = texts(v);
    let w = &ui.win;
    w.title.setStringValue(&s(&title));
    w.body.setStringValue(&s(&body));
    w.notice.setStringValue(&s(&notice));
    w.status.setStringValue(&s(&status));
    w.field.setHidden(!field);
    // The permission page puts its status where the body's second half would be, and the settings buttons below it.
    w.status.setHidden(status.is_empty());
    w.open_screen.setHidden(!settings);
    w.open_ax.setHidden(!settings);
    for (b, text) in [(&w.primary, primary), (&w.secondary, secondary)] {
        b.setHidden(text.is_none());
        if let Some(t) = text {
            b.setTitle(&s(t));
        }
    }
    // Return is Don't allow on the question, and the main button elsewhere.
    let asking = v.step == Step::Asking;
    w.primary.setKeyEquivalent(if asking { ns_string!("") } else { ns_string!("\r") });
    w.secondary.setKeyEquivalent(if asking { ns_string!("\r") } else { ns_string!("") });
    w.primary.setEnabled(!asking);
    ui.asked = asking.then(Instant::now);
    // The window is out of the way while support is connected; the corner window shows who is there.
    if v.step == Step::Connected {
        w.window.orderOut(None);
    } else {
        NSApplication::sharedApplication(ui.mtm).activate();
        w.window.makeKeyAndOrderFront(None);
    }
}

fn corner(ui: &mut Ui) -> &mut Corner {
    if ui.corner.is_none() {
        let mtm = ui.mtm;
        let (w, h) = (300.0, 64.0);
        let screen = NSScreen::mainScreen(mtm).map(|s| s.visibleFrame()).unwrap_or(rect(0.0, 0.0, 1280.0, 800.0));
        let frame = rect(screen.origin.x + screen.size.width - w - 16.0, screen.origin.y + 16.0, w, h);
        let window = panel(mtm, frame, NSWindowStyleMask::Titled | NSWindowStyleMask::UtilityWindow | NSWindowStyleMask::NonactivatingPanel);
        window.setTitle(ns_string!("Support"));
        window.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Stationary);
        let view = window.contentView().expect("a panel has a content view");
        let label = label(mtm, "", rect(12.0, 10.0, w - 130.0, h - 20.0), 12.0, false);
        let end = button(mtm, &ui.target, "End session", TAG_CORNER_END, rect(w - 116.0, (h - 32.0) / 2.0, 106.0, 32.0));
        view.addSubview(&label);
        view.addSubview(&end);
        ui.corner = Some(Corner { window, label, end, armed_until: None });
    }
    ui.corner.as_mut().unwrap()
}

fn elapsed(since_ms: i64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let secs = ((now - since_ms) / 1000).max(0);
    format!("{:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
}

fn tick_corner(ui: &mut Ui, v: &View) {
    let show = matches!(v.step, Step::Connecting | Step::Connected);
    if !show {
        if let Some(c) = ui.corner.as_ref() {
            c.window.orderOut(None);
        }
        return;
    }
    let text = if v.step == Step::Connected {
        format!("Your support team is connected\n{}", elapsed(v.since_ms))
    } else {
        "Connecting to your support team…".to_string()
    };
    let c = corner(ui);
    c.label.setStringValue(&s(&text));
    if c.armed_until.is_some_and(|t| Instant::now() > t) {
        c.armed_until = None;
        c.end.setTitle(ns_string!("End session"));
    }
    c.window.orderFrontRegardless();
}

fn own_windows(ui: &Ui) -> Vec<Rect> {
    let primary_h = NSScreen::screens(ui.mtm).firstObject().map(|s| s.frame().size.height).unwrap_or(0.0);
    let mut out = Vec::new();
    let mut add = |f: objc2_foundation::NSRect| {
        let top = primary_h - (f.origin.y + f.size.height);
        out.push(Rect {
            left: f.origin.x.floor() as i64,
            top: top.floor() as i64,
            right: (f.origin.x + f.size.width).ceil() as i64,
            bottom: (top + f.size.height).ceil() as i64,
        });
    };
    if ui.win.window.isVisible() {
        add(ui.win.window.frame());
    }
    if let Some(c) = ui.corner.as_ref().filter(|c| c.window.isVisible()) {
        add(c.window.frame());
    }
    out
}

fn tick() {
    if modal() {
        return;
    }
    UI.with(|u| {
        let Ok(mut guard) = u.try_borrow_mut() else { return };
        let Some(ui) = guard.as_mut() else { return };
        // Links from the page's button go to the controller as a pasted link would.
        for url in URLS.with(|x| std::mem::take(&mut *x.borrow_mut())) {
            ui.shared.send(Event::Submitted(url));
        }
        let v = ui.shared.view.lock().unwrap().clone();
        let key = format!("{:?}|{:?}|{}|{}", v.step, v.notice, v.screen, v.accessibility);
        if key != ui.drawn {
            ui.drawn = key;
            draw(ui, &v);
        }
        // The question: Allow wakes after 500 ms, and no answer in 2 minutes is Don't allow.
        if let Some(at) = ui.asked {
            if at.elapsed() >= ASK_LIMIT {
                ui.asked = None;
                ui.shared.send(Event::Answered(false));
            } else if at.elapsed() >= ASK_ARM {
                ui.win.primary.setEnabled(true);
            }
        }
        tick_corner(ui, &v);
        *ui.shared.helper.own_windows.lock().unwrap() = own_windows(ui);
        let alerts: Vec<String> = std::mem::take(&mut *ui.shared.alerts.lock().unwrap());
        if let Some(text) = alerts.into_iter().next() {
            ALERTS.with(|a| *a.borrow_mut() = Some((ui.mtm, text)));
        }
    });
    if let Some((mtm, text)) = ALERTS.with(|a| a.borrow_mut().take()) {
        alert(mtm, "Support Join", &text, &["OK"]);
    }
}

fn move_to_trash(path: &std::path::Path) -> Result<(), String> {
    let url = NSURL::fileURLWithPath(&s(&path.to_string_lossy()));
    NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None).map_err(|e| e.localizedDescription().to_string())
}

fn action(tag: isize) {
    let mut trash: Option<(MainThreadMarker, std::path::PathBuf)> = None;
    let mut quit = false;
    UI.with(|u| {
        let mut guard = u.borrow_mut();
        let Some(ui) = guard.as_mut() else { return };
        let v = ui.shared.view.lock().unwrap().clone();
        match (tag, &v.step) {
            (TAG_PRIMARY, Step::Entry) => {
                let text = ui.win.field.stringValue().to_string();
                ui.shared.send(Event::Submitted(text));
            }
            (TAG_PRIMARY, Step::Confirm { .. }) => ui.shared.send(Event::Confirmed),
            (TAG_PRIMARY, Step::Asking) => {
                // Allow does nothing for its first 500 ms, so a click meant for another window cannot answer.
                if ui.asked.is_some_and(|at| at.elapsed() >= ASK_ARM) {
                    ui.asked = None;
                    ui.shared.send(Event::Answered(true));
                }
            }
            (TAG_PRIMARY, Step::Done { .. }) => {
                if let TrashOffer::Move(p) = &v.trash {
                    trash = Some((ui.mtm, p.clone()));
                }
            }
            (TAG_SECONDARY, Step::Confirm { .. }) => ui.shared.send(Event::Back),
            (TAG_SECONDARY, Step::Asking) => {
                ui.asked = None;
                ui.shared.send(Event::Answered(false));
            }
            (TAG_SECONDARY, Step::Permissions | Step::Connecting) => ui.shared.send(Event::EndClicked),
            (TAG_SECONDARY, Step::Done { .. }) => quit = true,
            (TAG_OPEN_SCREEN, _) => {
                // Puts Support Join in the list (and asks once), then opens the right page.
                let _ = objc2_core_graphics::CGRequestScreenCaptureAccess();
                open_url(paths::SETTINGS_SCREEN);
            }
            (TAG_OPEN_AX, _) => {
                prompt_accessibility();
                open_url(paths::SETTINGS_ACCESSIBILITY);
            }
            (TAG_CORNER_END, _) => {
                if let Some(c) = ui.corner.as_mut() {
                    if c.armed_until.is_some_and(|t| Instant::now() <= t) {
                        c.armed_until = None;
                        ui.shared.send(Event::EndClicked);
                    } else {
                        c.armed_until = Some(Instant::now() + Duration::from_secs(5));
                        c.end.setTitle(ns_string!("End now?"));
                    }
                }
            }
            (TAG_QUIT, step) => match step {
                // Quitting a live session ends it first: the app stays until the cleanup is done.
                Step::Permissions | Step::Connecting | Step::Connected | Step::Asking => ui.shared.send(Event::EndClicked),
                Step::Redeeming | Step::Ending => {}
                _ => quit = true,
            },
            _ => {}
        }
    });
    if let Some((mtm, path)) = trash {
        match move_to_trash(&path) {
            Ok(()) => quit = true,
            Err(e) => {
                alert(mtm, "Support Join", &format!("Support Join could not move itself to the Trash ({e}). Drag it there yourself."), &["OK"]);
            }
        }
    }
    if quit {
        std::process::exit(0);
    }
}

fn menu_items(mtm: MainThreadMarker, target: &JoinTarget) -> Retained<NSMenu> {
    let main = NSMenu::new(mtm);
    // SAFETY (all four items): fresh items; the selectors are ours or the responder chain's.
    let app_item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), ns_string!(""), None, ns_string!("")) };
    main.addItem(&app_item);
    let app_menu = NSMenu::new(mtm);
    let quit = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), ns_string!("Quit Support Join"), Some(sel!(act:)), ns_string!("q"))
    };
    // SAFETY: the target lives for the process.
    unsafe { quit.setTarget(Some(target)) };
    quit.setTag(TAG_QUIT);
    app_menu.addItem(&quit);
    app_item.setSubmenu(Some(&app_menu));
    let edit_item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), ns_string!(""), None, ns_string!("")) };
    main.addItem(&edit_item);
    let edit = NSMenu::initWithTitle(NSMenu::alloc(mtm), ns_string!("Edit"));
    for (title, selector, key) in
        [("Cut", sel!(cut:), "x"), ("Copy", sel!(copy:), "c"), ("Paste", sel!(paste:), "v"), ("Select All", sel!(selectAll:), "a")]
    {
        let item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &s(title), Some(selector), &s(key)) };
        edit.addItem(&item);
    }
    edit_item.setSubmenu(Some(&edit));
    main
}

/// Sets up the app and runs its loop. Never returns.
pub fn run(mtm: MainThreadMarker, shared: Arc<JoinShared>) {
    let app = NSApplication::sharedApplication(mtm);
    // A visible app: a Dock icon, and a menu with Paste, because the link is pasted.
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    let target = JoinTarget::new(mtm);
    app.setMainMenu(Some(&menu_items(mtm, &target)));
    // The page's button opens supportmcp://join?code=...; macOS delivers it to the app as a 'GURL' Apple event.
    // SAFETY: the target answers handleURL:withReply:, and both codes are four-character codes.
    unsafe {
        let manager = objc2_foundation::NSAppleEventManager::sharedAppleEventManager();
        let _: () = msg_send![&*manager, setEventHandler: &*target, andSelector: sel!(handleURL:withReply:), forEventClass: GURL, andEventID: GURL];
    }
    let win = build_window(mtm, &target);
    // SAFETY: a selector our target implements; the timer keeps the target alive.
    let timer = unsafe { NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(0.1, &target, sel!(tick:), None, true) };
    // SAFETY: the main run loop and a framework constant.
    unsafe { NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
    win.window.center();
    UI.with(|u| {
        *u.borrow_mut() = Some(Ui { mtm, shared, target, win, corner: None, drawn: String::new(), asked: None, _timer: timer });
    });
    app.activate();
    app.run();
}

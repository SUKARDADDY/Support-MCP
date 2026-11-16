//! The permission list, shared by the saved app's Permissions window (`ui.rs`) and the join app's permission step
//! (`join_ui.rs`). One `PermPanel` is a view with a line at the top, a row for each permission (its state, a button that
//! opens its page of System Settings) and, when the person has waited long enough, Restart Support. What the items are,
//! the pages to try and when to restart are decided in `crate::permissions`, apart from macOS and tested on Linux.
//!
//! Everything here runs in the process that needs the permission, as the signed-in person: the saved app's helper, or the
//! join app. `CGRequestScreenCaptureAccess` and `AXIsProcessTrustedWithOptions` put the app in the list of its own pane,
//! and macOS adds the app that asks. Full Disk Access has no such call: the row says so, and "Show Support in Finder"
//! reveals the app to drag into the list. Its state is the root service's (`full_disk` in the service's status), because
//! the service and its file helpers are what need it, not this process.
//!
//! A build with the `preview-permissions` feature reads `SUPPORT_PREVIEW_PERMISSIONS` and shows the states it names,
//! without asking macOS anything and without opening Settings or restarting. A release build has no such code.

use super::ui::{label, rect, s};
use crate::paths;
use crate::permissions::{self, Kind, Perm, Preview, State, Tracker};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{sel, MainThreadOnly};
use objc2_app_kit::{NSButton, NSColor, NSTextField, NSView, NSWorkspace};
use objc2_foundation::{MainThreadMarker, NSArray, NSURL};
use std::cell::{Cell, RefCell};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Button tags. A row's "Open Settings" is `TAG_OPEN` plus its place in the list.
pub const TAG_OPEN: isize = 100;
pub const TAG_REVEAL: isize = 110;
pub const TAG_RESTART: isize = 111;

/// Whether a button belongs to a panel.
pub fn owns(tag: isize) -> bool {
    (TAG_OPEN..=TAG_RESTART).contains(&tag)
}

/// A line of the headline (12.5 points) is about 16 points tall. The room is `HEADLINE_LINES` lines, and the layout, the
/// window's height and the Join window's position all follow from it, so the longest headline is never cut off.
const HEADLINE_H: f64 = 8.0 + 16.0 * permissions::HEADLINE_LINES as f64;
const RESTART_H: f64 = 52.0;
const BUTTON_W: f64 = 150.0;
/// How often the permissions are read: about every second, as the window is open.
const POLL: Duration = Duration::from_millis(1000);

fn body_height(perm: Perm) -> f64 {
    if perm == Perm::FullDiskAccess {
        92.0
    } else {
        36.0
    }
}

fn row_height(perm: Perm) -> f64 {
    20.0 + body_height(perm) + 8.0
}

/// How tall a panel for `kind` is.
pub fn panel_height(kind: Kind) -> f64 {
    HEADLINE_H + permissions::items(kind).iter().map(|i| row_height(i.perm)).sum::<f64>() + RESTART_H
}

fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The states a build with the preview feature is told to show. None in a release build.
#[cfg(feature = "preview-permissions")]
fn preview() -> Option<Preview> {
    let text = std::env::var(permissions::PREVIEW_VAR).ok()?;
    match Preview::parse(&text) {
        Ok(p) => Some(p),
        Err(e) => {
            eprintln!("{}: {e}", permissions::PREVIEW_VAR);
            None
        }
    }
}

#[cfg(not(feature = "preview-permissions"))]
fn preview() -> Option<Preview> {
    None
}

struct Row {
    perm: Perm,
    state: Retained<NSTextField>,
    open: Retained<NSButton>,
    reveal: Option<Retained<NSButton>>,
}

pub struct PermPanel {
    pub view: Retained<NSView>,
    kind: Kind,
    rows: Vec<Row>,
    headline: Retained<NSTextField>,
    hint: Retained<NSTextField>,
    restart: Retained<NSButton>,
    tracker: RefCell<Tracker>,
    preview: Option<Preview>,
    last_read: Cell<Option<Instant>>,
}

fn button(mtm: MainThreadMarker, target: &AnyObject, title: &str, tag: isize, frame: objc2_foundation::NSRect) -> Retained<NSButton> {
    // SAFETY: a selector the window's target implements (`act:`, which reads the sender's tag); it outlives the button.
    let b = unsafe { NSButton::buttonWithTitle_target_action(&s(title), Some(target), Some(sel!(act:)), mtm) };
    b.setFrame(frame);
    b.setTag(tag);
    b
}

impl PermPanel {
    /// A panel `width` points wide. `target` must answer `act:` by reading the sender's tag, and pass tags `owns` says
    /// are the panel's to `handle`.
    pub fn new(mtm: MainThreadMarker, target: &AnyObject, kind: Kind, width: f64) -> PermPanel {
        let height = panel_height(kind);
        let view = NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, 0.0, width, height));
        let headline = label(mtm, "", rect(0.0, height - HEADLINE_H + 8.0, width, HEADLINE_H - 8.0), 12.5, false);
        view.addSubview(&headline);
        let mut y = height - HEADLINE_H;
        let mut rows = Vec::new();
        for (i, item) in permissions::items(kind).into_iter().enumerate() {
            let top = y;
            y -= row_height(item.perm);
            let tag = i as isize;
            let name = format!("{}{}", item.name, if item.required { "" } else { " (optional)" });
            view.addSubview(&label(mtm, &name, rect(0.0, top - 20.0, width - BUTTON_W - 16.0, 18.0), 13.0, true));
            let body = match item.help {
                Some(h) => format!("{}\n{h}", item.what),
                None => item.what.to_string(),
            };
            let body_h = body_height(item.perm);
            view.addSubview(&label(mtm, &body, rect(0.0, top - 20.0 - body_h, width - BUTTON_W - 16.0, body_h), 11.5, false));
            let state = label(mtm, "", rect(width - BUTTON_W, top - 20.0, BUTTON_W, 18.0), 13.0, true);
            view.addSubview(&state);
            let open = button(mtm, target, "Open Settings", TAG_OPEN + tag, rect(width - BUTTON_W, top - 52.0, BUTTON_W, 28.0));
            view.addSubview(&open);
            let reveal = (item.perm == Perm::FullDiskAccess).then(|| {
                let b = button(mtm, target, "Show Support in Finder", TAG_REVEAL, rect(width - BUTTON_W, top - 84.0, BUTTON_W, 28.0));
                view.addSubview(&b);
                b
            });
            rows.push(Row { perm: item.perm, state, open, reveal });
        }
        let hint = label(
            mtm,
            "You switched it on and it still says Not yet? macOS may need Support to start again to see it.",
            rect(0.0, 6.0, width - BUTTON_W - 16.0, 36.0),
            12.0,
            false,
        );
        let restart = button(mtm, target, "Restart Support", TAG_RESTART, rect(width - BUTTON_W, 10.0, BUTTON_W, 28.0));
        hint.setHidden(true);
        restart.setHidden(true);
        view.addSubview(&hint);
        view.addSubview(&restart);
        let preview = preview();
        let mut tracker = Tracker::new(kind);
        tracker.force_restart(preview.is_some_and(|p| p.restart));
        PermPanel { view, kind, rows, headline, hint, restart, tracker: RefCell::new(tracker), preview, last_read: Cell::new(None) }
    }

    /// Reads the permissions (about once a second) and redraws. `full_disk` is the service's answer, None when it cannot
    /// be reached. Returns whether a required permission is missing.
    pub fn update(&self, full_disk: Option<bool>) -> bool {
        if self.last_read.get().is_some_and(|t| t.elapsed() < POLL) {
            return self.tracker.borrow().required_missing();
        }
        self.last_read.set(Some(Instant::now()));
        let mut t = self.tracker.borrow_mut();
        for row in &self.rows {
            let forced = self.preview.and_then(|p| p.state(row.perm));
            let state = forced.unwrap_or_else(|| match row.perm {
                Perm::ScreenRecording => State::from_bool(super::helper::screen_access()),
                Perm::Accessibility => State::from_bool(super::helper::accessibility()),
                Perm::FullDiskAccess => full_disk.map_or(State::Unknown, State::from_bool),
            });
            t.observe(row.perm, state);
            row.state.setStringValue(&s(state.text()));
            let color = if state == State::Granted { NSColor::systemGreenColor() } else { NSColor::labelColor() };
            row.state.setTextColor(Some(&color));
            // A permission that is on needs no button.
            row.open.setHidden(state == State::Granted);
            if let Some(r) = &row.reveal {
                r.setHidden(state == State::Granted);
            }
        }
        self.headline.setStringValue(&s(&t.headline()));
        let restart = t.needs_restart(now_ms());
        self.hint.setHidden(!restart);
        self.restart.setHidden(!restart);
        t.required_missing()
    }

    /// Whether a required permission is missing now, read straight from macOS (or from the preview), for the decision to open
    /// the window at start and for the setup window's line.
    pub fn required_missing_now(kind: Kind) -> bool {
        let preview = preview();
        permissions::items(kind).iter().filter(|i| i.required).any(|i| {
            let state = preview.and_then(|p| p.state(i.perm)).unwrap_or_else(|| match i.perm {
                Perm::ScreenRecording => State::from_bool(super::helper::screen_access()),
                _ => State::from_bool(super::helper::accessibility()),
            });
            state != State::Granted
        })
    }

    /// Whether a required permission was missing at the last read.
    pub fn required_missing(&self) -> bool {
        self.tracker.borrow().required_missing()
    }

    /// Forces the next `update` to read now.
    pub fn read_soon(&self) {
        self.last_read.set(None);
    }

    /// A button of the panel was clicked.
    pub fn handle(&self, tag: isize) {
        match tag {
            TAG_REVEAL => reveal_app(),
            TAG_RESTART => self.restart_app(),
            _ => {
                let Some(row) = usize::try_from(tag - TAG_OPEN).ok().and_then(|i| self.rows.get(i)) else { return };
                self.tracker.borrow_mut().opened(row.perm, now_ms());
                // A preview build asks macOS nothing and opens nothing, even when it was given no states to show.
                if self.preview.is_none() && !super::helper::PREVIEW_BUILD {
                    register(row.perm);
                    open_settings(row.perm);
                }
                // The switch may flip while the page is open: read again at once when the person is back.
                self.read_soon();
            }
        }
    }

    fn restart_app(&self) {
        if self.preview.is_some() || super::helper::PREVIEW_BUILD {
            return;
        }
        // SAFETY: a getter.
        let uid = unsafe { libc::getuid() };
        let exe = std::env::current_exe().unwrap_or_default();
        let Some((program, args)) = permissions::restart_command(self.kind, uid, &exe) else {
            self.hint.setStringValue(&s("Support could not find itself to start again. Quit it and open it again."));
            return;
        };
        // The new helper opens this window again if a permission is still missing, even one that was just switched on.
        let _ = std::fs::write(reopen_marker(), b"");
        let mut c = Command::new(program);
        c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // SAFETY: setsid is async-signal-safe. The child leaves this process's group, so launchd stopping the helper (or
        // this app quitting) does not take it along before it has done its work.
        unsafe {
            c.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        match c.spawn() {
            // The join app quits now; its shell opens it again in a second. The saved app's helper is killed by launchd.
            Ok(_) if self.kind == Kind::Join => std::process::exit(0),
            Ok(_) => {}
            Err(e) => self.hint.setStringValue(&s(&format!("Support could not start again: {e}"))),
        }
    }
}

/// A file in the person's temporary folder that says "open the permission window at start": Restart Support leaves it.
fn reopen_marker() -> std::path::PathBuf {
    std::env::temp_dir().join("support-reopen-permissions")
}

/// Whether the last run asked for the permission window to open again. Reading it removes it.
pub fn take_reopen() -> bool {
    std::fs::remove_file(reopen_marker()).is_ok()
}

/// Puts the app in the list of the permission's pane, so the person only flips its switch. These calls must come from the
/// process that needs the permission, so they are made here, in the helper or the join app, never in the service.
fn register(perm: Perm) {
    match perm {
        Perm::ScreenRecording => {
            if !super::helper::PREVIEW_BUILD {
                let _ = objc2_core_graphics::CGRequestScreenCaptureAccess();
            }
        }
        Perm::Accessibility => {
            if !super::helper::PREVIEW_BUILD {
                super::ui::prompt_accessibility()
            }
        }
        // No call puts an app in this list. The row tells the person to use + or to drag the app from Finder.
        Perm::FullDiskAccess => {}
    }
}

fn open_settings(perm: Perm) {
    let opened = permissions::open_pane(perm, |text| match NSURL::URLWithString(&s(text)) {
        Some(url) => NSWorkspace::sharedWorkspace().openURL(&url),
        None => false,
    });
    if opened.is_none() {
        eprintln!("support: no page of System Settings opened for {perm:?}");
    }
}

/// Shows Support.app in a Finder window, selected, to drag into Full Disk Access's list.
fn reveal_app() {
    let app = std::env::current_exe().ok().and_then(|e| permissions::bundle_of(&e)).unwrap_or_else(|| paths::APP_PATH.into());
    let url = NSURL::fileURLWithPath(&s(&app.to_string_lossy()));
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&[url]));
}

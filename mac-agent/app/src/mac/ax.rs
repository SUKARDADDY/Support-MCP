//! `ui_tree` and `ui_act` through Accessibility, in the helper (the session's own process, so it sees the person's
//! apps). The line format, the verbs and the texts are `ax_plan`, tested on Linux; this file only reads and drives
//! `AXUIElement`s.
//!
//! The tree starts at the frontmost app's focused window and, beside it, the app's menu bar: a menu's items are in the
//! tree only while it is open, so a menu item can be read and used after its menu bar item is invoked.
//!
//! Needs the Accessibility permission, which the caller has already checked. Each call to an app waits at most a
//! second while reading and five seconds while acting, so one stuck app cannot hold the screen lane.

use super::capture::Display;
use crate::ax_plan::{self, Frame, Limits, Node, NodeInfo, Refs, Step, Traits};
use objc2_application_services::{AXError, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{CFArray, CFBoolean, CFRetained, CFString, CFType, CGPoint, CGSize};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use support_core::geometry::{self, Rect};
use support_core::wire::ScreenAction;

/// An element of the latest tree, kept for `ui_act`.
pub struct El(CFRetained<AXUIElement>);

// SAFETY: an AXUIElement is an immutable reference to an element in another process; the Accessibility API may be called
// from any thread.
unsafe impl Send for El {}

static REFS: Mutex<Refs<El>> = Mutex::new(Refs::new());

/// What one `ui_tree` gives back.
pub struct Tree {
    pub text: String,
    /// The display the window is on, in the relay's numbering: the coordinates in the text are pixels of its screenshot.
    pub display: i64,
}

/// The display `ui_act`'s picture comes from: the one of the latest tree.
pub fn tree_display() -> i64 {
    REFS.lock().unwrap().display()
}

// ---- attribute reads ---------------------------------------------------------------------------------------------

fn attr(el: &AXUIElement, name: &str) -> Result<CFRetained<CFType>, AXError> {
    let key = CFString::from_str(name);
    let mut out: *const CFType = std::ptr::null();
    // SAFETY: `out` is a valid place for one object reference.
    let err = unsafe { el.copy_attribute_value(&key, NonNull::from(&mut out)) };
    if err != AXError::Success {
        return Err(err);
    }
    // SAFETY: on success the call returns a retained object, which we now own.
    NonNull::new(out.cast_mut()).map(|p| unsafe { CFRetained::from_raw(p) }).ok_or(AXError::NoValue)
}

fn string_attr(el: &AXUIElement, name: &str) -> Option<String> {
    attr(el, name).ok()?.downcast_ref::<CFString>().map(|s| s.to_string())
}

fn bool_attr(el: &AXUIElement, name: &str) -> Option<bool> {
    attr(el, name).ok()?.downcast_ref::<CFBoolean>().map(|b| b.as_bool())
}

fn element_attr(el: &AXUIElement, name: &str) -> Option<CFRetained<AXUIElement>> {
    attr(el, name).ok()?.downcast::<AXUIElement>().ok()
}

fn children_of(el: &AXUIElement, name: &str) -> Vec<CFRetained<AXUIElement>> {
    let Ok(v) = attr(el, name) else { return Vec::new() };
    let Some(list) = v.downcast_ref::<CFArray>() else { return Vec::new() };
    // SAFETY: AXChildren and AXWindows are arrays of AXUIElements.
    let list: &CFArray<AXUIElement> = unsafe { list.cast_unchecked() };
    list.iter().collect()
}

fn point_attr(el: &AXUIElement, name: &str) -> Option<CGPoint> {
    let v = attr(el, name).ok()?;
    let v = v.downcast_ref::<AXValue>()?;
    let mut p = CGPoint::default();
    // SAFETY: `p` is a CGPoint, the type asked for.
    unsafe { v.value(AXValueType::CGPoint, NonNull::from(&mut p).cast()) }.then_some(p)
}

fn size_attr(el: &AXUIElement, name: &str) -> Option<CGSize> {
    let v = attr(el, name).ok()?;
    let v = v.downcast_ref::<AXValue>()?;
    let mut s = CGSize::default();
    // SAFETY: `s` is a CGSize, the type asked for.
    unsafe { v.value(AXValueType::CGSize, NonNull::from(&mut s).cast()) }.then_some(s)
}

fn frame_of(el: &AXUIElement) -> Option<Frame> {
    let (p, s) = (point_attr(el, "AXPosition")?, size_attr(el, "AXSize")?);
    Some(Frame { x: p.x, y: p.y, w: s.width, h: s.height })
}

fn settable(el: &AXUIElement, name: &str) -> bool {
    let key = CFString::from_str(name);
    let mut yes: u8 = 0;
    // SAFETY: `yes` is a valid place for one Boolean.
    let err = unsafe { el.is_attribute_settable(&key, NonNull::from(&mut yes)) };
    err == AXError::Success && yes != 0
}

fn has_action(el: &AXUIElement, name: &str) -> bool {
    let mut out: *const CFArray = std::ptr::null();
    // SAFETY: `out` is a valid place for one array reference.
    let err = unsafe { el.copy_action_names(NonNull::from(&mut out)) };
    if err != AXError::Success {
        return false;
    }
    // SAFETY: on success the call returns a retained array, which we now own.
    let Some(list) = NonNull::new(out.cast_mut()).map(|p| unsafe { CFRetained::from_raw(p) }) else { return false };
    // SAFETY: the array holds the action names, strings.
    let names: &CFArray<CFString> = unsafe { list.cast_unchecked() };
    names.iter().any(|n| n.to_string() == name)
}

fn pid_of(el: &AXUIElement) -> Option<i32> {
    let mut pid: i32 = 0;
    // SAFETY: `pid` is a valid place for one pid.
    (unsafe { el.pid(NonNull::from(&mut pid)) } == AXError::Success).then_some(pid)
}

fn set_timeout(seconds: f32) {
    // SAFETY: no arguments; the system-wide element's timeout applies to every call this process makes.
    let system = unsafe { AXUIElement::new_system_wide() };
    // SAFETY: a live element.
    unsafe { system.set_messaging_timeout(seconds) };
}

// ---- the tree ----------------------------------------------------------------------------------------------------

impl Node for CFRetained<AXUIElement> {
    fn info(&self) -> Option<NodeInfo> {
        let el: &AXUIElement = self;
        let role = match attr(el, "AXRole") {
            Ok(v) => v.downcast_ref::<CFString>().map(|s| s.to_string()).unwrap_or_default(),
            // The element is gone, or its app does not answer: not part of the tree.
            Err(e) if e == AXError::InvalidUIElement || e == AXError::CannotComplete => return None,
            Err(_) => String::new(),
        };
        let mut name = string_attr(el, "AXTitle").filter(|t| !t.trim().is_empty());
        if name.is_none() {
            name = string_attr(el, "AXDescription").filter(|t| !t.trim().is_empty());
        }
        // The text of a label or a field is its name. A document's text, a password and a number are not.
        if name.is_none() && matches!(role.as_str(), "AXStaticText" | "AXTextField") {
            name = string_attr(el, "AXValue");
        }
        // A closed menu's items are not on screen: their frames are stale. Open menus are the selected ones.
        let closed_menu = matches!(role.as_str(), "AXMenuBarItem" | "AXMenuItem") && !bool_attr(el, "AXSelected").unwrap_or(false);
        let descend = !closed_menu && !matches!(role.as_str(), "AXPopUpButton" | "AXMenuButton");
        Some(NodeInfo { role, name: name.unwrap_or_default(), frame: frame_of(el), descend })
    }

    fn traits(&self) -> Traits {
        let el: &AXUIElement = self;
        Traits {
            role: string_attr(el, "AXRole").unwrap_or_default(),
            press: has_action(el, "AXPress"),
            value_settable: settable(el, "AXValue"),
            selected_settable: settable(el, "AXSelected"),
            focus_settable: settable(el, "AXFocused"),
            disclosing_settable: settable(el, "AXDisclosing"),
            enabled: bool_attr(el, "AXEnabled").unwrap_or(true),
        }
    }

    fn children(&self) -> Vec<Self> {
        children_of(self, "AXChildren")
    }
}

/// The frontmost app: the system's focused application, else the one NSWorkspace calls frontmost.
fn front_app() -> Option<CFRetained<AXUIElement>> {
    // SAFETY: no arguments.
    let system = unsafe { AXUIElement::new_system_wide() };
    element_attr(&system, "AXFocusedApplication").or_else(|| {
        let pid = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication()?.processIdentifier();
        // SAFETY: a pid is the only argument.
        Some(unsafe { AXUIElement::new_application(pid) })
    })
}

fn focused_window(app: &AXUIElement) -> Option<CFRetained<AXUIElement>> {
    element_attr(app, "AXFocusedWindow").or_else(|| element_attr(app, "AXMainWindow")).or_else(|| children_of(app, "AXWindows").into_iter().next())
}

/// Reads the tree of the frontmost app's focused window and keeps its elements as the refs `ui_act` takes.
pub fn read_tree(a: &ScreenAction, displays: &[Display], cancel: &AtomicBool) -> Result<Tree, String> {
    set_timeout(1.0);
    let app = front_app().ok_or(ax_plan::NO_WINDOW)?;
    if pid_of(&app) == Some(std::process::id() as i32) {
        return Err(ax_plan::OWN_WINDOW.into());
    }
    let window = focused_window(&app).ok_or(ax_plan::NO_WINDOW)?;
    // The display that holds the middle of the window, as the Windows client takes the foreground window's monitor.
    let rects: Vec<Rect> = displays.iter().map(|d| d.view.bounds).collect();
    let index = frame_of(&window)
        .filter(|f| !f.is_empty())
        .and_then(|f| {
            let (cx, cy) = f.centre();
            geometry::monitor_at(&rects, cx as i64, cy as i64)
        })
        .unwrap_or(0);
    let view = &displays.get(index).ok_or("no display is connected")?.view;
    let bar = element_attr(&app, "AXMenuBar");
    // With a menu open its items come first: they are what the caller is looking at.
    let menu_open = bar.as_ref().is_some_and(|b| children_of(b, "AXChildren").iter().any(|i| bool_attr(i, "AXSelected") == Some(true)));
    let mut roots = vec![window];
    if let Some(bar) = bar {
        if menu_open {
            roots.insert(0, bar);
        } else {
            roots.push(bar);
        }
    }
    let walked = ax_plan::walk(roots, view, a.max_lines, &Limits::default(), &|| cancel.load(Ordering::SeqCst));
    let items = walked.items.into_iter().map(El).collect();
    REFS.lock().unwrap().replace(items, index as i64);
    Ok(Tree { text: walked.text, display: index as i64 })
}

// ---- acting ------------------------------------------------------------------------------------------------------

/// Does the verb on the element of the latest tree. Returns a note to add to the answer, if any.
pub fn act(a: &ScreenAction) -> Result<Option<String>, String> {
    let n = a.ref_id;
    let el = REFS.lock().unwrap().get(n)?.0.clone();
    set_timeout(5.0);
    let own = std::process::id() as i32;
    if pid_of(&el) == Some(own) {
        return Err(ax_plan::OWN_ELEMENT.into());
    }
    // An element the app has dropped since the tree was read.
    if let Err(e) = attr(&el, "AXRole") {
        if e == AXError::InvalidUIElement {
            return Err(ax_plan::gone(n));
        }
    }
    let traits = el.traits();
    let step = ax_plan::plan(n, &a.verb, a.value.as_deref().unwrap_or(""), &traits)?;
    let err = match &step {
        Step::Press => {
            let action = CFString::from_str("AXPress");
            // SAFETY: a live element and action name.
            unsafe { el.perform_action(&action) }
        }
        Step::SetValue(text) => set(&el, "AXValue", &CFString::from_str(text)),
        Step::Select => set(&el, "AXSelected", CFBoolean::new(true)),
        Step::Focus => set(&el, "AXFocused", CFBoolean::new(true)),
        Step::Disclose(open) => set(&el, "AXDisclosing", CFBoolean::new(*open)),
    };
    ax_plan::failure(err.0, n, &a.verb, &step)
}

fn set(el: &AXUIElement, name: &str, value: &CFType) -> AXError {
    let key = CFString::from_str(name);
    // SAFETY: the value is of the type the attribute takes: a string for AXValue, a Boolean for the others.
    unsafe { el.set_attribute_value(&key, value) }
}

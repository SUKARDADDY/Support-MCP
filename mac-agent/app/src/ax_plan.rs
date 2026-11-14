//! What `ui_tree` and `ui_act` do, worked out apart from the Accessibility calls so it is tested on Linux: the line
//! format and its caps, the verbs an element offers, the verb to action table, the ref registry, the walk (over a
//! trait, so a test can feed it a fake tree) and the refusal texts. `mac/ax.rs` holds the only code that talks to
//! macOS.
//!
//! The line format and the texts are the Windows client's (`UiLines` and `UiAct` in `src/agent-app.cs`): the relay and
//! the people reading the lines see one format on both. The differences are the roles (`Button`, `MenuItem` from the
//! `AX` role names) and the `locked` text, which says Mac.

use crate::input_plan::View;
use std::time::{Duration, Instant};
use support_core::geometry::{self, Rect};
use support_core::wire::ScreenAction;

/// The relay takes at most 200,000 characters of result text. The tree stops at this many (UTF-16 units, as the relay
/// counts them), with room for the closing line.
pub const MAX_CHARS: usize = 190_000;
pub const MORE_BY_COUNT: &str = "[more elements not shown; raise max_lines]";
pub const MORE_BY_CHARS: &str = "[more elements not shown; the text limit was reached]";
/// A name is cut to this many characters, with `...` at the end.
pub const NAME_MAX: usize = 80;
pub const LINES_MAX: i64 = 2000;
pub const LINES_DEFAULT: i64 = 300;
/// The relay's bounds on a `ui_act`.
pub const REF_MAX: i64 = 1_000_000;
pub const VALUE_MAX: usize = 5000;
/// The walk visits at most this many elements, for at most this long, to this depth: one slow app must not hold the
/// screen lane (the Windows client's numbers).
pub const VISIT_MAX: usize = 4000;
pub const WALK_MS: u64 = 8000;
pub const DEPTH_MAX: usize = 40;

pub const NO_WINDOW: &str = "no window is in the foreground";
pub const OWN_WINDOW: &str = "the foreground window is the support window";
pub const OWN_ELEMENT: &str = "that element belongs to the support window";
pub const BAD_VERB: &str = "verb must be invoke, set_value, toggle, focus, expand, collapse or select";
pub const SLOW_NOTE: &str = "still running after 5 s; a dialog may be open";
/// The Windows text says "Windows may be locked or showing a security prompt".
pub const LOCKED: &str = "cannot reach the screen; the Mac may be locked or showing the login window";

pub fn unknown_ref(n: i64) -> String {
    format!("unknown ref {n}; call ui_tree first")
}

pub fn gone(n: i64) -> String {
    format!("element {n} is gone; call ui_tree again")
}

pub fn unsupported(n: i64, verb: &str) -> String {
    format!("element {n} does not support {verb}")
}

pub fn cannot(n: i64, verb: &str, why: &str) -> String {
    format!("element {n} cannot do {verb}: {why}")
}

// ---- lines -------------------------------------------------------------------------------------------------------

/// The role as the line shows it: `AXButton` is `Button`.
pub fn role_name(role: &str) -> &str {
    let r = role.strip_prefix("AX").unwrap_or(role);
    if r.is_empty() {
        "Unknown"
    } else {
        r
    }
}

/// `[12] Button "OK" (640,412) invoke,focus`: the ref, the role, the name and the centre in screenshot pixels. A name
/// has control characters made spaces and quotes made apostrophes, and is cut to 80 characters.
pub fn line(n: usize, role: &str, name: &str, x: i64, y: i64, verbs: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_control() {
                ' '
            } else if c == '"' {
                '\''
            } else {
                c
            }
        })
        .collect();
    let text = clean.trim();
    let text = if text.chars().count() > NAME_MAX { format!("{}...", text.chars().take(NAME_MAX - 3).collect::<String>()) } else { text.to_string() };
    let mut out = format!("[{n}] {}", role_name(role));
    if !text.is_empty() {
        out.push_str(&format!(" \"{text}\""));
    }
    out.push_str(&format!(" ({x},{y})"));
    if !verbs.is_empty() {
        out.push(' ');
        out.push_str(verbs);
    }
    out
}

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The lines as text, stopping before `max_chars`, with the closing line when some are left out (`more_by_count`: the
/// line limit was reached). Returns the text and how many lines it shows.
pub fn join(lines: &[String], more_by_count: bool, max_chars: usize) -> (String, usize) {
    let mut text = String::new();
    // `used` is the length of `text` so far, as the Windows client's `text.Length`.
    let (mut used, mut kept, mut cut) = (0usize, 0usize, false);
    for l in lines {
        let n = utf16(l);
        if used + n + 1 > max_chars.saturating_sub(utf16(MORE_BY_CHARS) + 1) {
            cut = true;
            break;
        }
        if kept > 0 {
            text.push('\n');
            used += 1;
        }
        text.push_str(l);
        used += n;
        kept += 1;
    }
    if cut || more_by_count {
        if kept > 0 {
            text.push('\n');
        }
        text.push_str(if cut { MORE_BY_CHARS } else { MORE_BY_COUNT });
    }
    (text, kept)
}

// ---- verbs -------------------------------------------------------------------------------------------------------

/// What an element offers, read from its Accessibility attributes and actions.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Traits {
    /// `AXRole`, for example `AXCheckBox`.
    pub role: String,
    /// It has the `AXPress` action.
    pub press: bool,
    /// `AXValue` is settable.
    pub value_settable: bool,
    /// `AXSelected` is settable.
    pub selected_settable: bool,
    /// `AXFocused` is settable.
    pub focus_settable: bool,
    /// `AXDisclosing` is settable (a leaf has no such attribute).
    pub disclosing_settable: bool,
    pub enabled: bool,
}

/// A check box or a switch: pressing it flips it, so its verb is `toggle` and not `invoke`.
pub fn is_toggle_role(role: &str) -> bool {
    matches!(role, "AXCheckBox" | "AXSwitch")
}

/// Roles that only hold other elements. They are listed when they have a name, never for their verbs alone, or every
/// group that can take the keyboard focus would be a line.
pub fn is_structural(role: &str) -> bool {
    matches!(role, "AXGroup" | "AXScrollArea" | "AXSplitGroup" | "AXLayoutArea" | "AXLayoutItem" | "AXUnknown" | "AXSplitter" | "")
}

/// The verbs `ui_act` can use, comma separated, in the Windows order. A disabled element has none and is marked
/// `disabled` instead, because every verb on it would fail.
pub fn verbs(t: &Traits) -> String {
    if !t.enabled {
        return "disabled".into();
    }
    let toggle = is_toggle_role(&t.role);
    let mut list: Vec<&str> = Vec::new();
    if t.press && !toggle {
        list.push("invoke");
    }
    if t.value_settable {
        list.push("set_value");
    }
    if t.press && toggle {
        list.push("toggle");
    }
    if t.disclosing_settable {
        list.push("expand");
        list.push("collapse");
    }
    if t.selected_settable {
        list.push("select");
    }
    if t.focus_settable {
        list.push("focus");
    }
    list.join(",")
}

/// Whether an element with this name and these verbs is worth a line: it is named, or it can be acted on and is not a
/// bare container.
pub fn listed(role: &str, name: &str, verbs: &str) -> bool {
    !name.trim().is_empty() || (!verbs.is_empty() && verbs != "disabled" && !is_structural(role))
}

/// What to do on the element, one Accessibility call each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Perform the `AXPress` action.
    Press,
    /// Set `AXValue` to this text.
    SetValue(String),
    /// Set `AXSelected` to true.
    Select,
    /// Set `AXFocused` to true.
    Focus,
    /// Set `AXDisclosing` to this.
    Disclose(bool),
}

/// The step a verb is on an element, or the refusal. The ref is checked before this, as on Windows.
pub fn plan(n: i64, verb: &str, value: &str, t: &Traits) -> Result<Step, String> {
    let toggle = is_toggle_role(&t.role);
    let step = match verb {
        "invoke" if t.press && !toggle => Step::Press,
        "toggle" if t.press && toggle => Step::Press,
        "set_value" if t.value_settable => {
            if value.chars().count() > VALUE_MAX {
                return Err(format!("value must be at most {VALUE_MAX} characters"));
            }
            Step::SetValue(value.to_string())
        }
        "expand" if t.disclosing_settable => Step::Disclose(true),
        "collapse" if t.disclosing_settable => Step::Disclose(false),
        "select" if t.selected_settable => Step::Select,
        "focus" if t.focus_settable => Step::Focus,
        "invoke" | "toggle" | "set_value" | "expand" | "collapse" | "select" | "focus" => return Err(unsupported(n, verb)),
        _ => return Err(BAD_VERB.into()),
    };
    if !t.enabled {
        return Err(cannot(n, verb, "the control is disabled"));
    }
    Ok(step)
}

/// The Accessibility error codes (`AXError`) that matter here.
pub const AX_INVALID_ELEMENT: i32 = -25202;
pub const AX_CANNOT_COMPLETE: i32 = -25204;
pub const AX_ATTRIBUTE_UNSUPPORTED: i32 = -25205;
pub const AX_ACTION_UNSUPPORTED: i32 = -25206;
pub const AX_API_DISABLED: i32 = -25211;
pub const AX_NO_VALUE: i32 = -25212;

fn code_text(code: i32) -> &'static str {
    match code {
        -25200 => "the app failed to do it",
        -25201 => "the app refused the value",
        AX_CANNOT_COMPLETE => "the app did not answer in time",
        AX_ATTRIBUTE_UNSUPPORTED | AX_ACTION_UNSUPPORTED => "the app does not allow it",
        -25208 => "the app has not implemented it",
        AX_API_DISABLED => "Accessibility is switched off for Support",
        AX_NO_VALUE => "the control has no value to change",
        _ => "the app refused it",
    }
}

/// What a failed Accessibility call becomes. A press that did not finish within the timeout is not a failure: the
/// action may have opened a dialog, so it is a note (`Ok(Some(note))`).
pub fn failure(code: i32, n: i64, verb: &str, step: &Step) -> Result<Option<String>, String> {
    match code {
        0 => Ok(None),
        AX_INVALID_ELEMENT => Err(gone(n)),
        AX_CANNOT_COMPLETE if *step == Step::Press => Ok(Some(SLOW_NOTE.into())),
        AX_ACTION_UNSUPPORTED | AX_ATTRIBUTE_UNSUPPORTED if matches!(step, Step::Press) => Err(unsupported(n, verb)),
        c => Err(cannot(n, verb, code_text(c))),
    }
}

// ---- refs --------------------------------------------------------------------------------------------------------

/// The elements of the latest `ui_tree`, numbered from 1, and the display that tree was read on. A new tree replaces
/// all of them, so an old ref is never read as a new element.
pub struct Refs<T> {
    items: Vec<T>,
    display: i64,
}

impl<T> Default for Refs<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Refs<T> {
    pub const fn new() -> Self {
        Refs { items: Vec::new(), display: 0 }
    }

    pub fn replace(&mut self, items: Vec<T>, display: i64) {
        self.items = items;
        self.display = display;
    }

    pub fn get(&self, n: i64) -> Result<&T, String> {
        usize::try_from(n).ok().filter(|i| (1..=self.items.len()).contains(i)).map(|i| &self.items[i - 1]).ok_or_else(|| unknown_ref(n))
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// The display of the latest tree.
    pub fn display(&self) -> i64 {
        self.display
    }
}

// ---- requests ----------------------------------------------------------------------------------------------------

/// The action the service sends the helper: the relay's own bounds, applied once more. A `max_lines` out of range is
/// brought in as the Windows client does, and a value over the bound is refused.
pub fn normalize(a: &ScreenAction) -> Result<ScreenAction, String> {
    let mut a = a.clone();
    match a.name.as_str() {
        "ui_tree" => a.max_lines = a.max_lines.clamp(1, LINES_MAX),
        "ui_act" => {
            a.ref_id = a.ref_id.clamp(0, REF_MAX);
            if a.verb.chars().count() > 40 || a.verb.chars().any(char::is_control) {
                return Err(BAD_VERB.into());
            }
            if a.value.as_deref().is_some_and(|v| v.chars().count() > VALUE_MAX) {
                return Err(format!("value must be at most {VALUE_MAX} characters"));
            }
        }
        _ => {}
    }
    Ok(a)
}

// ---- the walk ----------------------------------------------------------------------------------------------------

/// An element's frame in global points, top-left origin.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Frame {
    pub fn is_empty(&self) -> bool {
        !(self.w > 0.0 && self.h > 0.0)
    }

    pub fn centre(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    fn overlaps(&self, r: &Rect) -> bool {
        self.x < r.right as f64 && self.x + self.w > r.left as f64 && self.y < r.bottom as f64 && self.y + self.h > r.top as f64
    }
}

/// A global point as a pixel of the display's screenshot, or None when it is not on that display.
pub fn to_screenshot(view: &View, gx: f64, gy: f64) -> Option<(i64, i64)> {
    let b = view.bounds;
    let (lx, ly) = (gx.floor() as i64 - b.left, gy.floor() as i64 - b.top);
    if lx < 0 || ly < 0 || lx >= b.width() || ly >= b.height() {
        return None;
    }
    Some((geometry::to_image(lx, view.image_w, b.width()), geometry::to_image(ly, view.image_h, b.height())))
}

/// What the walk reads of an element before it decides to list it.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeInfo {
    pub role: String,
    pub name: String,
    pub frame: Option<Frame>,
    /// False for a subtree that is not on screen (the menu of a closed menu bar item).
    pub descend: bool,
}

/// One element of an Accessibility tree. The Mac implementation reads the real one; a test implements it over a
/// vector.
pub trait Node: Sized {
    /// None when the element cannot be read (it went away, or its app does not answer).
    fn info(&self) -> Option<NodeInfo>;
    /// Read only for an element about to be listed.
    fn traits(&self) -> Traits;
    fn children(&self) -> Vec<Self>;
}

pub struct Limits {
    pub visits: usize,
    pub time: Duration,
    pub depth: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { visits: VISIT_MAX, time: Duration::from_millis(WALK_MS), depth: DEPTH_MAX }
    }
}

pub struct Walked<N> {
    pub text: String,
    /// The elements the text shows, in ref order: ref `n` is `items[n - 1]`.
    pub items: Vec<N>,
}

struct Walk<'a, N> {
    view: &'a View,
    max: usize,
    limits: &'a Limits,
    started: Instant,
    cancel: &'a dyn Fn() -> bool,
    visited: usize,
    more: bool,
    lines: Vec<String>,
    items: Vec<N>,
}

impl<N: Node> Walk<'_, N> {
    fn visit(&mut self, node: N, depth: usize) {
        self.visited += 1;
        if self.lines.len() >= self.max || self.visited > self.limits.visits || self.started.elapsed() > self.limits.time || (self.cancel)() {
            self.more = true;
            return;
        }
        let Some(info) = node.info() else { return };
        if let Some(f) = info.frame.filter(|f| !f.is_empty()) {
            // An element wholly off this display is off screen: it and what it holds are skipped.
            if !f.overlaps(&self.view.bounds) {
                return;
            }
            let (cx, cy) = f.centre();
            if let Some((x, y)) = to_screenshot(self.view, cx, cy) {
                let t = node.traits();
                let v = verbs(&t);
                if listed(&info.role, &info.name, &v) {
                    self.lines.push(line(self.items.len() + 1, &info.role, &info.name, x, y, &v));
                    // The node moves into the list once its children are read.
                    let kids = if depth < self.limits.depth && info.descend { node.children() } else { Vec::new() };
                    self.items.push(node);
                    for k in kids {
                        self.visit(k, depth + 1);
                    }
                    return;
                }
            }
        }
        if depth < self.limits.depth && info.descend {
            for k in node.children() {
                self.visit(k, depth + 1);
            }
        }
    }
}

/// Walks the trees under `roots` in order and writes the lines. Only the elements whose centre is on `view` are
/// listed. `cancel` ends the walk early (the session ended).
pub fn walk<N: Node>(roots: Vec<N>, view: &View, max_lines: i64, limits: &Limits, cancel: &dyn Fn() -> bool) -> Walked<N> {
    let mut w = Walk {
        view,
        max: max_lines.clamp(1, LINES_MAX) as usize,
        limits,
        started: Instant::now(),
        cancel,
        visited: 0,
        more: false,
        lines: Vec::new(),
        items: Vec::new(),
    };
    for r in roots {
        w.visit(r, 0);
    }
    let (text, kept) = join(&w.lines, w.more, MAX_CHARS);
    // A ref the text does not show is not offered.
    w.items.truncate(kept);
    Walked { text, items: w.items }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn view() -> View {
        // A 2880x1800 display shown as 1280 x 800, in 1440 x 900 points at the origin.
        View::of(Rect { left: 0, top: 0, right: 1440, bottom: 900 }, (2880, 1800))
    }

    #[derive(Clone)]
    struct Fake {
        role: &'static str,
        name: String,
        frame: Option<Frame>,
        traits: Traits,
        descend: bool,
        kids: Vec<Fake>,
    }

    fn fake(role: &'static str, name: &str, x: f64, y: f64) -> Fake {
        Fake {
            role,
            name: name.into(),
            frame: Some(Frame { x, y, w: 20.0, h: 20.0 }),
            traits: Traits { role: role.into(), enabled: true, ..Default::default() },
            descend: true,
            kids: vec![],
        }
    }

    impl Node for Fake {
        fn info(&self) -> Option<NodeInfo> {
            Some(NodeInfo { role: self.role.into(), name: self.name.clone(), frame: self.frame, descend: self.descend })
        }
        fn traits(&self) -> Traits {
            self.traits.clone()
        }
        fn children(&self) -> Vec<Fake> {
            self.kids.clone()
        }
    }

    fn never() -> bool {
        false
    }

    #[test]
    fn a_line_is_the_windows_line() {
        assert_eq!(line(12, "AXButton", "OK", 640, 412, "invoke,focus"), "[12] Button \"OK\" (640,412) invoke,focus");
        // No name and no verbs: just the role and the place.
        assert_eq!(line(3, "AXGroup", "", 10, 20, ""), "[3] Group (10,20)");
        assert_eq!(line(1, "", "x", 1, 2, "disabled"), "[1] Unknown \"x\" (1,2) disabled");
    }

    #[test]
    fn a_name_is_cleaned_trimmed_and_cut_at_80() {
        assert_eq!(line(1, "AXButton", "  a\"b\nc\t ", 1, 2, ""), "[1] Button \"a'b c\" (1,2)");
        let long = "x".repeat(100);
        let l = line(1, "AXButton", &long, 1, 2, "");
        assert_eq!(l, format!("[1] Button \"{}...\" (1,2)", "x".repeat(77)));
        // Exactly 80 is kept whole; the cut counts characters, not bytes.
        assert!(line(1, "AXButton", &"é".repeat(80), 1, 2, "").contains(&"é".repeat(80)));
        assert!(line(1, "AXButton", &"é".repeat(81), 1, 2, "").contains(&format!("{}...", "é".repeat(77))));
    }

    #[test]
    fn the_text_stops_at_the_cap_and_says_so() {
        let lines: Vec<String> = (1..=10).map(|n| line(n, "AXButton", "b", 1, 1, "invoke")).collect();
        let (text, kept) = join(&lines, false, 10_000);
        assert_eq!((kept, text.lines().count()), (10, 10));
        let (text, kept) = join(&lines, true, 10_000);
        assert_eq!(kept, 10);
        assert!(text.ends_with(MORE_BY_COUNT));
        // A cap that fits three lines keeps three and ends with the limit line.
        let one = utf16(&lines[0]);
        let cap = 3 * one + utf16(MORE_BY_CHARS) + 3;
        let (text, kept) = join(&lines, false, cap);
        assert_eq!(kept, 3);
        assert!(text.ends_with(MORE_BY_CHARS) && utf16(&text) <= cap);
        // The real cap leaves room under the relay's 200,000.
        let big: Vec<String> = (1..=20_000).map(|n| line(n, "AXButton", "a button with a name", 100, 100, "invoke,focus")).collect();
        let (text, kept) = join(&big, false, MAX_CHARS);
        assert!(kept < big.len() && utf16(&text) <= MAX_CHARS && text.ends_with(MORE_BY_CHARS));
        // Astral characters count twice, as the relay's string length does: this line is 85 characters but 165 units.
        let wide = [line(1, "AXButton", &"😀".repeat(70), 1, 1, "")];
        let chars = wide[0].chars().count();
        assert!(utf16(&wide[0]) > chars + 60);
        let room = chars + utf16(MORE_BY_CHARS) + 3;
        assert_eq!(join(&wide, false, room).1, 0, "counted in characters it would fit");
    }

    #[test]
    fn the_verbs_follow_the_windows_order() {
        let t = |f: fn(&mut Traits)| {
            let mut t = Traits { role: "AXButton".into(), enabled: true, ..Default::default() };
            f(&mut t);
            verbs(&t)
        };
        assert_eq!(t(|_| {}), "");
        assert_eq!(t(|t| t.press = true), "invoke");
        assert_eq!(t(|t| t.value_settable = true), "set_value");
        assert_eq!(
            t(|t| {
                t.press = true;
                t.value_settable = true;
                t.disclosing_settable = true;
                t.selected_settable = true;
                t.focus_settable = true;
            }),
            "invoke,set_value,expand,collapse,select,focus"
        );
        // A check box presses as toggle, never invoke.
        assert_eq!(
            t(|t| {
                t.role = "AXCheckBox".into();
                t.press = true;
                t.focus_settable = true;
            }),
            "toggle,focus"
        );
        // A disabled element has no verbs, only the word.
        assert_eq!(
            t(|t| {
                t.press = true;
                t.enabled = false;
            }),
            "disabled"
        );
    }

    #[test]
    fn each_verb_maps_to_one_step() {
        let all = Traits {
            role: "AXTextField".into(),
            press: true,
            value_settable: true,
            selected_settable: true,
            focus_settable: true,
            disclosing_settable: true,
            enabled: true,
        };
        assert_eq!(plan(1, "invoke", "", &all), Ok(Step::Press));
        assert_eq!(plan(1, "set_value", "hi", &all), Ok(Step::SetValue("hi".into())));
        assert_eq!(plan(1, "expand", "", &all), Ok(Step::Disclose(true)));
        assert_eq!(plan(1, "collapse", "", &all), Ok(Step::Disclose(false)));
        assert_eq!(plan(1, "select", "ignored", &all), Ok(Step::Select));
        assert_eq!(plan(1, "focus", "", &all), Ok(Step::Focus));
        let check = Traits { role: "AXCheckBox".into(), press: true, enabled: true, ..Default::default() };
        assert_eq!(plan(2, "toggle", "", &check), Ok(Step::Press));
        assert_eq!(plan(2, "invoke", "", &check), Err("element 2 does not support invoke".into()));
        assert_eq!(plan(1, "toggle", "", &all), Err("element 1 does not support toggle".into()));
    }

    #[test]
    fn refusals_use_the_windows_texts() {
        let bare = Traits { enabled: true, ..Default::default() };
        assert_eq!(plan(7, "invoke", "", &bare), Err("element 7 does not support invoke".into()));
        assert_eq!(plan(7, "set_value", "x", &bare), Err("element 7 does not support set_value".into()));
        assert_eq!(plan(7, "fly", "", &bare), Err(BAD_VERB.into()));
        let off = Traits { press: true, enabled: false, ..Default::default() };
        assert_eq!(plan(7, "invoke", "", &off), Err("element 7 cannot do invoke: the control is disabled".into()));
        let value = Traits { value_settable: true, enabled: true, ..Default::default() };
        assert!(plan(7, "set_value", &"x".repeat(VALUE_MAX + 1), &value).is_err());
        assert!(plan(7, "set_value", &"x".repeat(VALUE_MAX), &value).is_ok());
        assert_eq!(unknown_ref(9), "unknown ref 9; call ui_tree first");
        assert_eq!(gone(9), "element 9 is gone; call ui_tree again");
    }

    #[test]
    fn a_failed_call_becomes_the_matching_text() {
        let press = Step::Press;
        assert_eq!(failure(0, 4, "invoke", &press), Ok(None));
        assert_eq!(failure(AX_INVALID_ELEMENT, 4, "invoke", &press), Err(gone(4)));
        assert_eq!(failure(AX_CANNOT_COMPLETE, 4, "invoke", &press), Ok(Some(SLOW_NOTE.into())));
        assert_eq!(failure(AX_ACTION_UNSUPPORTED, 4, "invoke", &press), Err(unsupported(4, "invoke")));
        let set = Step::SetValue("x".into());
        assert_eq!(failure(AX_CANNOT_COMPLETE, 4, "set_value", &set), Err("element 4 cannot do set_value: the app did not answer in time".into()));
        assert_eq!(failure(-25201, 4, "set_value", &set), Err("element 4 cannot do set_value: the app refused the value".into()));
        assert!(failure(-1, 4, "focus", &Step::Focus).unwrap_err().starts_with("element 4 cannot do focus: "));
    }

    #[test]
    fn refs_count_from_one_and_a_new_tree_replaces_them() {
        let mut refs: Refs<&str> = Refs::default();
        assert_eq!(refs.get(1), Err(unknown_ref(1)));
        refs.replace(vec!["a", "b"], 2);
        assert_eq!((refs.get(1), refs.get(2), refs.display(), refs.len()), (Ok(&"a"), Ok(&"b"), 2, 2));
        for bad in [0, 3, -1, i64::MAX] {
            assert_eq!(refs.get(bad), Err(unknown_ref(bad)));
        }
        refs.replace(vec!["c"], 0);
        assert_eq!((refs.get(1), refs.get(2)), (Ok(&"c"), Err(unknown_ref(2))));
    }

    #[test]
    fn a_request_is_brought_inside_the_relays_bounds() {
        let tree = |n: i64| ScreenAction { name: "ui_tree".into(), max_lines: n, ..Default::default() };
        assert_eq!(normalize(&tree(0)).unwrap().max_lines, 1);
        assert_eq!(normalize(&tree(99_999)).unwrap().max_lines, 2000);
        assert_eq!(normalize(&tree(300)).unwrap().max_lines, 300);
        let act = ScreenAction { name: "ui_act".into(), ref_id: -4, verb: "invoke".into(), ..Default::default() };
        assert_eq!(normalize(&act).unwrap().ref_id, 0);
        let long = ScreenAction { value: Some("x".repeat(VALUE_MAX + 1)), ..act.clone() };
        assert!(normalize(&long).is_err());
        let rude = ScreenAction { verb: "a\nb".into(), ..act };
        assert_eq!(normalize(&rude), Err(BAD_VERB.into()));
    }

    #[test]
    fn a_point_is_a_pixel_of_the_displays_screenshot() {
        let v = view();
        // The display is 1440 points wide and the picture 1280: the middle stays the middle.
        assert_eq!(to_screenshot(&v, 720.0, 450.0), Some((640, 400)));
        assert_eq!(to_screenshot(&v, 0.0, 0.0), Some((0, 0)));
        assert_eq!(to_screenshot(&v, 1439.9, 899.9), Some((1279, 799)));
        assert_eq!(to_screenshot(&v, 1440.0, 10.0), None);
        assert_eq!(to_screenshot(&v, -1.0, 10.0), None);
        // A second display to the right: its own points start at its own left edge.
        let right = View::of(Rect { left: 1440, top: 0, right: 2440, bottom: 800 }, (1000, 800));
        assert_eq!(to_screenshot(&right, 1440.0, 0.0), Some((0, 0)));
        assert_eq!(to_screenshot(&right, 100.0, 10.0), None);
    }

    #[test]
    fn the_walk_lists_named_or_actable_elements_in_ref_order() {
        let mut window = fake("AXWindow", "Untitled", 0.0, 0.0);
        window.frame = Some(Frame { x: 0.0, y: 0.0, w: 800.0, h: 600.0 });
        let mut ok = fake("AXButton", "OK", 100.0, 100.0);
        ok.traits.press = true;
        let mut group = fake("AXGroup", "", 200.0, 200.0);
        group.traits.focus_settable = true; // a bare group is not listed for its focus alone
        let mut field = fake("AXTextField", "", 300.0, 300.0);
        field.traits.value_settable = true; // an unnamed field with a verb is
        let mut off = fake("AXButton", "Gone", 100.0, 100.0);
        off.traits.press = true;
        off.traits.enabled = false;
        window.kids = vec![ok, group, field, off];
        let w = walk(vec![window], &view(), 300, &Limits::default(), &never);
        let lines: Vec<&str> = w.text.lines().collect();
        assert_eq!(
            lines,
            vec![
                "[1] Window \"Untitled\" (356,267)",
                "[2] Button \"OK\" (98,98) invoke",
                "[3] TextField (276,276) set_value",
                "[4] Button \"Gone\" (98,98) disabled",
            ]
        );
        assert_eq!(w.items.len(), 4);
        assert_eq!(w.items[1].name, "OK");
    }

    #[test]
    fn the_walk_honours_max_lines_and_drops_refs_it_does_not_show() {
        let mut root = fake("AXWindow", "W", 0.0, 0.0);
        root.kids = (0..10).map(|i| fake("AXButton", &format!("b{i}"), 10.0 + i as f64 * 30.0, 10.0)).collect();
        let w = walk(vec![root.clone()], &view(), 3, &Limits::default(), &never);
        assert_eq!(w.text.lines().count(), 4);
        assert!(w.text.ends_with(MORE_BY_COUNT));
        assert_eq!(w.items.len(), 3);
        let all = walk(vec![root], &view(), 300, &Limits::default(), &never);
        assert_eq!((all.text.lines().count(), all.items.len()), (11, 11));
        assert!(!all.text.contains("more elements"));
    }

    #[test]
    fn the_walk_skips_what_is_off_the_display_and_closed_menus() {
        let mut root = fake("AXWindow", "W", 0.0, 0.0);
        let far = fake("AXButton", "Far", 5000.0, 10.0);
        let mut menu = fake("AXMenu", "Format", 10.0, 10.0);
        menu.descend = false;
        menu.kids = vec![fake("AXMenuItem", "Hidden", 10.0, 40.0)];
        // A wholly off-screen parent hides its children too.
        let mut panel = fake("AXGroup", "Panel", 6000.0, 0.0);
        panel.kids = vec![fake("AXButton", "Inside", 10.0, 10.0)];
        root.kids = vec![far, menu, panel];
        let w = walk(vec![root], &view(), 300, &Limits::default(), &never);
        assert!(w.text.contains("Format") && !w.text.contains("Far") && !w.text.contains("Hidden") && !w.text.contains("Inside"));
    }

    #[test]
    fn the_walk_stops_at_its_limits_and_when_cancelled() {
        let mut root = fake("AXWindow", "W", 0.0, 0.0);
        root.kids = (0..50).map(|i| fake("AXButton", &format!("b{i}"), 10.0, 10.0 + i as f64)).collect();
        let few = Limits { visits: 5, ..Limits::default() };
        let w = walk(vec![root.clone()], &view(), 300, &few, &never);
        assert!(w.items.len() <= 5 && w.text.ends_with(MORE_BY_COUNT));
        let shallow = Limits { depth: 0, ..Limits::default() };
        assert_eq!(walk(vec![root.clone()], &view(), 300, &shallow, &never).items.len(), 1);
        let calls = Cell::new(0);
        let stop = || {
            calls.set(calls.get() + 1);
            calls.get() > 3
        };
        let w = walk(vec![root], &view(), 300, &Limits::default(), &stop);
        assert_eq!(w.items.len(), 3);
    }

    #[test]
    fn an_unreadable_element_is_skipped_without_ending_the_walk() {
        struct Flaky(Vec<bool>);
        impl Node for Flaky {
            fn info(&self) -> Option<NodeInfo> {
                self.0.first().copied().unwrap_or(false).then(|| NodeInfo {
                    role: "AXButton".into(),
                    name: "ok".into(),
                    frame: Some(Frame { x: 10.0, y: 10.0, w: 10.0, h: 10.0 }),
                    descend: true,
                })
            }
            fn traits(&self) -> Traits {
                Traits { enabled: true, ..Default::default() }
            }
            fn children(&self) -> Vec<Flaky> {
                vec![]
            }
        }
        let w = walk(vec![Flaky(vec![false]), Flaky(vec![true])], &view(), 300, &Limits::default(), &never);
        assert_eq!(w.text, "[1] Button \"ok\" (13,13)");
    }
}

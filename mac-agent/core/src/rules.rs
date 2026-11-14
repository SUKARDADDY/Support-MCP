//! The team's rules for a saved Mac, enforced on the Mac itself: reading the relay's answer strictly, `decide` (the
//! same function as src/rules.js, run against the same cases), the rules tag, the POSIX path check and the raw-command
//! screen. A frame the rules forbid is refused here even when it came straight from the relay. An action that needs
//! approval was approved by a technician in the technician app, and its frame says by whom (`approved_by`).
//!
//! Nothing in this file shows anything to the person at the Mac.

use crate::clock::Clock;
use crate::files;
use crate::stop::Stop;
use crate::wire::{clean, Frame};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const LIST_MAX: usize = 50;
pub const PROGRAM_MAX: usize = 100;
pub const FOLDER_MAX: usize = 260;
pub const SPANS_MAX: usize = 64;
/// How long a frame that carries a newer rules tag waits for a check-in before it is decided.
pub const CATCH_UP_MS: u64 = 15_000;
/// How far a frame's `decided_at` may be from this Mac's own reckoning before it is ignored, in seconds.
pub const DECIDED_SKEW_S: i64 = 60;

const VALUES: [&str; 5] = ["allow", "approve", "approve_in_hours", "outside_hours", "never"];

// ---- the document -------------------------------------------------------------------------------------------------

/// The rules in force for one Mac: the five action values and the two lists of the relay's effective document. The
/// time zone and the hours text are the relay's business: it turns them into exact UTC spans (`Hours`).
#[derive(Clone, Debug, PartialEq)]
pub struct RulesDoc {
    pub rev: i64,
    pub restart: String,
    pub shutdown: String,
    pub install: String,
    pub uninstall: String,
    pub close_program: String,
    pub programs: Vec<String>,
    pub folders: Vec<String>,
    /// The document exactly as the relay sent it, kept so the tag can be checked and device.json can store it.
    pub raw: Value,
}

impl Default for RulesDoc {
    /// The same defaults as DEFAULT_RULES in src/rules.js, used before the first answer arrives.
    fn default() -> Self {
        RulesDoc {
            rev: 0,
            restart: "approve".into(),
            shutdown: "approve".into(),
            install: "approve".into(),
            uninstall: "approve".into(),
            close_program: "allow".into(),
            programs: vec![],
            folders: vec![],
            raw: Value::Null,
        }
    }
}

impl RulesDoc {
    /// The value of one guarded action. An action this client does not know counts as never.
    pub fn of(&self, action: &str) -> &str {
        match action {
            "restart" => &self.restart,
            "shutdown" => &self.shutdown,
            "install" => &self.install,
            "uninstall" => &self.uninstall,
            "close_program" => &self.close_program,
            _ => "never",
        }
    }
}

/// The business-hour spans of a check-in answer in Unix seconds, and the end of the horizon they cover. A fresh
/// `Hours` (no spans, no horizon) judges every moment as business hours.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Hours {
    pub spans: Vec<(i64, i64)>,
    pub until: i64,
}

impl Hours {
    /// Whether any moment from `now` to `now + delay` (both included) is inside business hours. A restart or shutdown
    /// that waits lands at the end of its window, so an hour rule holds for all of it. A span is [start, end). Past
    /// the horizon every moment counts as business hours: the stricter side, as in src/rules.js.
    pub fn inside(&self, now: i64, delay: i64) -> bool {
        let last = now + delay;
        if last >= self.until {
            return true;
        }
        self.spans.iter().any(|&(start, end)| now < end && last >= start)
    }
}

/// What the rules say of one action.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    /// Go ahead only with a technician's approval.
    Approve,
    Refuse {
        code: &'static str,
        text: &'static str,
    },
}

impl Verdict {
    /// The refusal as the wire has it: `<code>: <text>`.
    pub fn error(&self) -> Option<String> {
        match self {
            Verdict::Refuse { code, text } => Some(err(code, text)),
            _ => None,
        }
    }
}

pub fn err(code: &str, text: &str) -> String {
    format!("{code}: {text}")
}

/// The relay's own refusal texts (src/rules.js REFUSALS).
pub fn refuse(code: &'static str) -> Verdict {
    let text = match code {
        "rule_never" => "the team's rules never allow this action on this PC",
        "business_hours" => "the team's rules allow this action only outside business hours",
        "protected_program" => "the team's rules protect this program",
        "protected_folder" => "the team's rules protect this folder",
        "needs_full_control" => "this action needs a PC set to full control",
        _ => "",
    };
    Verdict::Refuse { code, text }
}

// ---- reading the answer, strictly ---------------------------------------------------------------------------------

/// A whole number the wire may carry, 0 to 1e13. Never a bool, a string or a fraction.
pub fn num(v: Option<&Value>) -> Option<i64> {
    let n = match v? {
        Value::Number(n) => n.as_i64().or_else(|| {
            let x = n.as_f64()?;
            (x.is_finite() && x == x.floor() && x <= 1e13).then_some(x as i64)
        })?,
        _ => return None,
    };
    (0..=10_000_000_000_000).contains(&n).then_some(n)
}

pub fn valid_tag(t: &str) -> bool {
    !t.is_empty() && t.len() <= 64 && t.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

/// The value of an action field. The field must be there. A value that is not one of ours counts as never.
fn action_value(m: &Value, key: &str) -> Option<String> {
    let v = m.get(key)?;
    Some(match v.as_str() {
        Some(s) if VALUES.contains(&s) => s.to_string(),
        _ => "never".to_string(),
    })
}

fn read_list(m: &Value, key: &str, max: usize) -> Option<Vec<String>> {
    let list = m.get(key)?.as_array()?;
    if list.len() > LIST_MAX {
        return None;
    }
    let mut out = Vec::new();
    for item in list {
        let text = item.as_str()?.trim();
        if text.is_empty() || text.chars().count() > max || has_control(text) {
            return None;
        }
        out.push(text.to_string());
    }
    Some(out)
}

/// The effective document of an answer (`rules`), or None when any field has the wrong type or size. Missing fields
/// are not filled in: the relay always sends them all.
pub fn parse_doc(m: &Value) -> Option<RulesDoc> {
    if !m.is_object() {
        return None;
    }
    let rev = num(m.get("rev"))?;
    if let Some(tz) = m.get("time_zone") {
        if !(tz.is_null() || tz.as_str().is_some_and(|s| s.chars().count() <= 100)) {
            return None;
        }
    }
    if let Some(h) = m.get("hours") {
        if !(h.is_null() || h.is_object()) {
            return None;
        }
    }
    Some(RulesDoc {
        rev,
        restart: action_value(m, "restart")?,
        shutdown: action_value(m, "shutdown")?,
        install: action_value(m, "install")?,
        uninstall: action_value(m, "uninstall")?,
        close_program: action_value(m, "close_program")?,
        programs: read_list(m, "protected_programs", PROGRAM_MAX)?,
        folders: read_list(m, "protected_folders", FOLDER_MAX)?,
        raw: m.clone(),
    })
}

fn read_hours(body: &Value) -> Option<Hours> {
    let until = num(body.get("hours_until"))?;
    let list = body.get("hours_utc")?.as_array()?;
    if list.len() > SPANS_MAX {
        return None;
    }
    let mut spans = Vec::new();
    for item in list {
        let pair = item.as_array()?;
        if pair.len() != 2 {
            return None;
        }
        let (a, b) = (num(pair.first())?, num(pair.get(1))?);
        if b <= a {
            return None;
        }
        spans.push((a, b));
    }
    Some(Hours { spans, until })
}

/// The rules, tag, hours and the relay's clock of a check-in answer.
#[derive(Clone, Debug)]
pub struct Answer {
    pub doc: RulesDoc,
    pub tag: String,
    pub hours: Hours,
    pub server_time: i64,
}

/// None when any of the five fields is missing or malformed.
pub fn read_answer(body: &Value) -> Option<Answer> {
    let doc = parse_doc(body.get("rules")?)?;
    let tag = body.get("rules_tag")?.as_str()?;
    if !valid_tag(tag) {
        return None;
    }
    let server_time = num(body.get("server_time"))?;
    if server_time <= 0 || server_time > 100_000_000_000 {
        return None;
    }
    Some(Answer { doc, tag: tag.to_string(), hours: read_hours(body)?, server_time })
}

// ---- the tag ------------------------------------------------------------------------------------------------------

/// JSON with object keys sorted and no spaces, as `canonical` in src/rules.js writes it.
fn canonical(v: &Value) -> String {
    match v {
        Value::Array(items) => format!("[{}]", items.iter().map(canonical).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> =
                keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), canonical(&map[*k]))).collect();
            format!("{{{}}}", parts.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// The first 16 hex characters of the SHA-256 of the document without `rev`, as canonical JSON (src/rules.js
/// rulesTag). The relay sends the tag with the document. Making it here lets a test, and the end-to-end run, check
/// that this client reads the document the way the relay hashed it.
pub fn rules_tag(doc: &Value) -> String {
    let mut content = doc.clone();
    if let Some(map) = content.as_object_mut() {
        map.remove("rev");
    }
    let digest = Sha256::digest(canonical(&content).as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

// ---- what the Mac knows of its rules -------------------------------------------------------------------------------

/// A snapshot of the rules: the last good document and its tag, the hours, whether an answer could not be read, and
/// the relay's time now (its `server_time` plus the time since, on a monotonic clock, never the Mac's wall clock).
#[derive(Clone, Debug)]
pub struct View {
    pub doc: RulesDoc,
    pub tag: String,
    pub stale: bool,
    pub timed: bool,
    pub now_s: i64,
    pub hours: Hours,
}

#[derive(Default)]
struct Inner {
    doc: RulesDoc,
    tag: String,
    hours: Hours,
    stale: bool,
    known: bool,
    timed: bool,
    server_time: i64,
    since_ms: i64,
    generation: u64,
}

/// An answer that cannot be read keeps the last good rules and marks them stale: a guarded action is then refused
/// with `rules_stale` until a good answer comes. device.json keeps the document and the tag, not the hours.
pub struct RulesState {
    inner: Mutex<Inner>,
    clock: Arc<dyn Clock>,
}

impl RulesState {
    pub fn new(clock: Arc<dyn Clock>) -> RulesState {
        RulesState { inner: Mutex::new(Inner::default()), clock }
    }

    /// The count of good answers, so a caller that waited for another's check-in can tell that one came.
    pub fn generation(&self) -> u64 {
        self.inner.lock().unwrap().generation
    }

    /// Takes the rules of an active check-in answer. Returns (read ok, the document changed so device.json needs a write).
    pub fn apply(&self, body: &Value) -> (bool, bool) {
        let answer = read_answer(body);
        let mut s = self.inner.lock().unwrap();
        let Some(a) = answer else {
            s.stale = true;
            return (false, false);
        };
        let persist = !s.known || a.tag != s.tag;
        s.doc = a.doc;
        s.tag = a.tag;
        s.hours = a.hours;
        s.server_time = a.server_time;
        s.since_ms = self.clock.mono_ms();
        s.stale = false;
        s.known = true;
        s.timed = true;
        s.generation += 1;
        (true, persist)
    }

    pub fn now(&self) -> View {
        let s = self.inner.lock().unwrap();
        let now_s = if s.timed { s.server_time + (self.clock.mono_ms() - s.since_ms) / 1000 } else { 0 };
        View { doc: s.doc.clone(), tag: s.tag.clone(), stale: s.stale, timed: s.timed, now_s, hours: s.hours.clone() }
    }

    /// The document and tag device.json keeps. A damaged or missing one leaves the defaults.
    pub fn load(&self, saved: &Value) {
        let Some(doc) = saved.get("rules").and_then(parse_doc) else { return };
        let Some(tag) = saved.get("rules_tag").and_then(Value::as_str).filter(|t| valid_tag(t)) else { return };
        let mut s = self.inner.lock().unwrap();
        s.doc = doc;
        s.tag = tag.to_string();
        s.known = true;
    }

    pub fn save(&self) -> Option<Value> {
        let s = self.inner.lock().unwrap();
        s.known.then(|| json!({ "rules": s.doc.raw, "rules_tag": s.tag }))
    }
}

/// What a saved Mac's session offers the rules: its own state, a check-in it can wait on, and who closes programs.
/// A one-off session has none (`None` where this is taken), so `power` and `programs` are refused there.
pub trait Ruled: Send + Sync {
    fn state(&self) -> View;
    /// Checks in with the relay now, outside the refresh limit, and waits at most `wait_ms`. True when the answer had
    /// good rules. Blocking: it runs on a command's own thread.
    fn catch_up(&self, wait_ms: u64, stop: &Stop) -> bool;
    /// The name of the running program a `close` frame means, from its name or its pid. None when there is none.
    fn close_target(&self, frame: &Frame) -> Option<String>;
    /// The folders of the Support app itself, which its tools never touch whatever the rules say.
    fn app_folders(&self) -> Vec<String> {
        app_folders()
    }
}

/// The Mac app and its data folder (src/rules.js isAppPath holds the same two).
pub fn app_folders() -> Vec<String> {
    vec!["/Applications/Support.app".to_string(), "/Library/Application Support/SupportMCP".to_string()]
}

// ---- names and paths (the same as src/rules.js) ---------------------------------------------------------------------

/// A program name for comparison: trimmed, lower case, the trailing dots and spaces dropped, and without a
/// trailing .exe, so a protected "Outlook.exe" also covers "outlook".
pub fn program_key(name: &str) -> String {
    let k = name.trim().to_lowercase();
    let k = k.trim_end_matches(['.', ' ']);
    k.strip_suffix(".exe").unwrap_or(k).to_string()
}

/// The same for the name of a running program to close: a folder in front of it is dropped first (the relay does the
/// same), so "/Applications/Mail.app/Contents/MacOS/Mail" is "mail".
pub fn process_key(name: &str) -> String {
    let t = name.trim();
    program_key(&t[t.rfind(['\\', '/']).map_or(0, |i| i + 1)..])
}

fn is_posix(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next() == Some('/') && chars.next() != Some('/')
}

/// A path as lower-case components: / the same as \, repeated and trailing separators dropped, . and .. resolved
/// (never above the drive, but a POSIX path has no drive, so .. may take away its first component), the \\?\ prefix
/// dropped, and the trailing dots and spaces Windows drops dropped too. Links stay as written.
pub fn path_parts(path: &str) -> Vec<String> {
    let floor = if is_posix(path.trim()) { 0 } else { 1 };
    let mut parts: Vec<String> = Vec::new();
    let body = path.strip_prefix("\\\\?\\").unwrap_or(path);
    for raw in body.split(['\\', '/']) {
        if raw.is_empty() || raw == "." {
            continue;
        }
        if raw == ".." {
            if parts.len() > floor {
                parts.pop();
            }
            continue;
        }
        let name = raw.trim_end_matches(['.', ' ']).to_lowercase();
        if !name.is_empty() {
            parts.push(name);
        }
    }
    parts
}

/// Whether `path` is the folder or inside it, by whole components: /Users/a/Database is not inside /Users/a/Data. A
/// drive-letter path is never inside a Mac folder, nor the reverse.
pub fn path_inside(folder: &str, path: &str) -> bool {
    let (f, p) = (path_parts(folder), path_parts(path));
    !f.is_empty() && p.len() >= f.len() && f.iter().zip(p.iter()).all(|(a, b)| a == b)
}

/// `^support(?:-.+-[0-9a-f]{8})?$` on a process name. The Mac app's binary is `support`.
pub fn is_app_program(name: &str) -> bool {
    let s = process_key(name);
    if s == "support" {
        return true;
    }
    let Some(rest) = s.strip_prefix("support-") else { return false };
    let n = rest.len();
    n >= 10
        && rest.is_char_boundary(n - 9)
        && rest.as_bytes()[n - 9] == b'-'
        && rest.as_bytes()[n - 8..].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        && !rest[..n - 9].contains('\n')
}

pub fn is_app_path(path: &str) -> bool {
    let p = path_parts(path);
    if is_posix(path.trim()) {
        // The Mac app and its data folder, from the root.
        return (p.first().map(String::as_str) == Some("applications") && p.get(1).map(String::as_str) == Some("support.app"))
            || (p.first().map(String::as_str) == Some("library")
                && p.get(1).map(String::as_str) == Some("application support")
                && p.get(2).map(String::as_str) == Some("supportmcp"));
    }
    p.len() >= 3 && p[1].starts_with("program files") && (p[2] == "supportmcp" || p[2].starts_with("supportmcp-"))
}

// ---- the decision ---------------------------------------------------------------------------------------------------

/// What is being decided. `name` is restart, shutdown, install, uninstall, close_program, put_file or get_file.
/// `delay_s` is for a restart or shutdown: an hour rule is judged over the whole window from `now_s` to
/// `now_s + delay_s`, not at the moment of the decision.
#[derive(Clone, Copy, Debug, Default)]
pub struct Action<'a> {
    pub name: &'a str,
    pub program: Option<&'a str>,
    pub path: Option<&'a str>,
    pub delay_s: i64,
}

/// Judges one action against the rules, in the order src/rules.js fixes (both sides run the same cases): the rule's
/// own `never`, full control, protected programs and folders, and last the value (allow, approve, or an hour rule).
/// `control` is "full" or "limited".
pub fn decide(r: &RulesDoc, hours: &Hours, now_s: i64, control: &str, a: &Action) -> Verdict {
    let (action, program, path, delay_s) = (a.name, a.program, a.path, a.delay_s);
    let file = action == "put_file" || action == "get_file";
    let guarded = matches!(action, "restart" | "shutdown" | "install" | "uninstall" | "close_program");
    if !guarded && !file {
        return refuse("rule_never");
    }
    let value = if guarded { r.of(action) } else { "allow" };
    if !VALUES.contains(&value) || value == "never" {
        return refuse("rule_never");
    }
    if guarded && action != "close_program" && control == "limited" {
        return refuse("needs_full_control");
    }
    if (action == "close_program" || action == "uninstall") && program.is_some() {
        let program = program.unwrap_or_default();
        // A close names a running program, maybe with a folder. An uninstall names an installed program (no folder).
        let key = if action == "close_program" { process_key(program) } else { program_key(program) };
        if r.programs.iter().any(|p| program_key(p) == key) {
            return refuse("protected_program");
        }
        if action == "close_program" && is_app_program(program) {
            return refuse("protected_program");
        }
    }
    if let Some(path) = path.filter(|_| file || action == "install") {
        if r.folders.iter().any(|f| path_inside(f, path)) || is_app_path(path) {
            return refuse("protected_folder");
        }
    }
    match value {
        "allow" => return Verdict::Allow,
        "approve" => return Verdict::Approve,
        _ => {}
    }
    let window = if matches!(action, "restart" | "shutdown") && delay_s > 0 { delay_s } else { 0 };
    let inside = hours.inside(now_s, window);
    if value == "approve_in_hours" {
        return if inside { Verdict::Approve } else { Verdict::Allow };
    }
    // outside_hours
    if inside {
        refuse("business_hours")
    } else {
        Verdict::Allow
    }
}

// ---- real paths ---------------------------------------------------------------------------------------------------------

/// The path with its deepest existing folder resolved through links; the part below it, which does not exist yet,
/// stays as written. A path that is not absolute is returned as it is.
pub fn resolve(path: &str) -> String {
    if !path.starts_with('/') {
        return path.to_string();
    }
    let mut dir = PathBuf::from(path);
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while !dir.is_dir() {
        match (dir.file_name().map(|n| n.to_os_string()), dir.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                dir = parent;
            }
            _ => return path.to_string(),
        }
    }
    let mut real = std::fs::canonicalize(&dir).unwrap_or(dir);
    for name in rest.iter().rev() {
        real.push(name);
    }
    real.to_string_lossy().into_owned()
}

/// Whether `path` is inside any of `folders`, as written or with its links resolved, on either side. The relay
/// compares the path as written. This Mac also follows links first, so a link into a protected folder is caught.
pub fn inside_any(folders: &[String], path: &str) -> bool {
    if folders.is_empty() {
        return false;
    }
    let real = resolve(path);
    folders.iter().any(|f| {
        let real_folder = resolve(f);
        path_inside(f, path) || path_inside(f, &real) || path_inside(&real_folder, path) || path_inside(&real_folder, &real)
    })
}

// ---- the raw command's screen -----------------------------------------------------------------------------------------

/// The Support app's own names on a Mac: its data folder's name (also the end of its launchd labels and its bundle
/// id) and its bundle.
const APP_WORDS: [&str; 2] = ["supportmcp", "support.app"];

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn name_char(c: char) -> bool {
    word_char(c) || c == '-' || c == '.' || c == '~'
}

/// `needle` (lower case) appears in `hay` on its own: not inside a longer word, or, for a folder, a longer name.
fn mentions(hay: &str, needle: &str, folder: bool) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut from = 0;
    while from + needle.len() <= hay.len() {
        let Some(rel) = hay[from..].find(needle) else { return false };
        let at = from + rel;
        let end = at + needle.len();
        let before = hay[..at].chars().next_back().is_none_or(|c| !word_char(c));
        let after = hay[end..].chars().next().is_none_or(|c| !(if folder { name_char(c) } else { word_char(c) }));
        if before && after {
            return true;
        }
        from = at + hay[at..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// Repeated slashes as one.
fn flat(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if !(c == '/' && out.ends_with('/')) {
            out.push(c);
        }
    }
    out
}

/// The command split into statements at ; & | and line ends, each into tokens at spaces, quotes and brackets.
fn statements(c: &str) -> Vec<Vec<String>> {
    let mut all = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut tok = String::new();
    for ch in c.chars().chain(['\n']) {
        let end = matches!(ch, ';' | '&' | '|' | '\n' | '\r');
        let gap = matches!(ch, ' ' | '\t' | '"' | '\'' | '`' | '(' | ')' | ',' | '{' | '}');
        if !end && !gap {
            tok.push(ch);
            continue;
        }
        if !tok.is_empty() {
            cur.push(std::mem::take(&mut tok));
        }
        if end && !cur.is_empty() {
            all.push(std::mem::take(&mut cur));
        }
    }
    all
}

/// A token as a command name: the part after the last slash.
fn verb(token: &str) -> &str {
    &token[token.rfind('/').map_or(0, |i| i + 1)..]
}

/// The guarded action a verb stands for, from its own token and the rest of its statement, or None. Only the actions
/// that have a tool on a Mac are here: restart_pc, shutdown_pc and close_program. Installing and uninstalling have no
/// tool on a Mac yet (they answer not_supported), so a raw installer is not sent to a tool that would refuse it.
fn verb_action(v: &str, statement: &[String], from: usize) -> Option<&'static str> {
    let rest = &statement[from.min(statement.len())..];
    match v {
        "reboot" => Some("restart"),
        "halt" | "poweroff" => Some("shutdown"),
        "kill" | "killall" | "pkill" | "skill" => Some("close_program"),
        "shutdown" => {
            // -r reboots, -h and -p halt (macOS shutdown also has -s, sleep, which is no guarded action).
            let flags: Vec<&String> = rest.iter().filter(|f| f.len() >= 2 && f.starts_with('-') && !f.starts_with("--")).collect();
            if flags.iter().any(|f| f[1..].contains('r')) {
                Some("restart")
            } else if flags.iter().any(|f| f[1..].contains('h') || f[1..].contains('p')) {
                Some("shutdown")
            } else {
                None
            }
        }
        "launchctl" => match rest.first().map(String::as_str) {
            Some("reboot") => Some("restart"),
            Some("kill" | "stop" | "bootout" | "remove" | "unload" | "disable") => Some("close_program"),
            _ => None,
        },
        "osascript" => {
            if rest.iter().any(|t| t == "restart") {
                Some("restart")
            } else if rest.iter().any(|t| t == "shutdown") || rest.windows(2).any(|w| w[0] == "shut" && w[1] == "down") {
                Some("shutdown")
            } else {
                None
            }
        }
        _ => None,
    }
}

fn use_tool(action: &str) -> String {
    let (what, tool) = match action {
        "restart" => ("restarts the PC", "restart_pc"),
        "shutdown" => ("shuts the PC down", "shutdown_pc"),
        _ => ("closes a program", "close_program"),
    };
    err("use_tool", &format!("this command {what}, which the team's rules govern. Use the {tool} tool, not a raw command"))
}

/// The raw run command's screen for a saved Mac. A guardrail, not a boundary: a command runs in a shell, so a
/// determined one gets round any text check (a variable, a glob, `cd` and a relative name). It refuses the obvious: a
/// verb of a guarded action whose rule is not allow (`use_tool`, pointing at the tool), and any mention of a protected
/// program or folder. Simple tokens, any case. The Support app is protected whatever the rules say.
pub fn run_screen(command: &str, doc: &RulesDoc, app_folders: &[String]) -> Option<String> {
    let c = command.to_lowercase();
    for p in &doc.programs {
        if mentions(&c, &program_key(p), false) {
            return refuse("protected_program").error();
        }
    }
    let flat_command = flat(&c);
    for f in doc.folders.iter().chain(app_folders.iter()) {
        let needle = flat(&f.to_lowercase());
        if mentions(&flat_command, needle.trim_end_matches('/'), true) {
            return refuse("protected_folder").error();
        }
    }
    for app in APP_WORDS {
        if mentions(&c, app, false) {
            return refuse("protected_program").error();
        }
    }
    for statement in statements(&c) {
        for i in 0..statement.len() {
            let Some(action) = verb_action(verb(&statement[i]), &statement, i + 1) else { continue };
            // A command that ends programs must not name the app (killall support, pkill -f support).
            if action == "close_program" && statement[i + 1..].iter().any(|t| is_app_program(t)) {
                return refuse("protected_program").error();
            }
            if doc.of(action) != "allow" {
                return Some(use_tool(action));
            }
        }
    }
    None
}

// ---- the check at the top of every command ----------------------------------------------------------------------------

/// The seconds before a restart or shutdown happens: 5 to 600, 30 when none is given. The relay judges, sends, logs and
/// shows a power action with this one value.
pub fn power_delay(frame: &Frame) -> i64 {
    match frame.raw.get("delay_s").and_then(Value::as_f64) {
        Some(n) if n.is_finite() => (n.floor() as i64).clamp(5, 600),
        _ => 30,
    }
}

pub const NOT_SUPPORTED_PROGRAMS: &str = "installing and uninstalling programs is not available on a Mac yet";

/// The frame's decided_at in Unix seconds (a value in milliseconds is read as such), 0 when it has none.
fn decided_at(frame: &Frame) -> i64 {
    match num(frame.raw.get("decided_at")) {
        Some(n) if n > 100_000_000_000 => n / 1000,
        Some(n) => n,
        None => 0,
    }
}

/// The moment hour rules are judged at: the relay's decided_at when it is within a minute of this Mac's own reckoning
/// (so a slow frame is judged as the relay decided), else this Mac's own time.
fn judge_time(frame: &Frame, view: &View) -> i64 {
    let decided = decided_at(frame);
    if decided > 0 && view.timed && (decided - view.now_s).abs() <= DECIDED_SKEW_S {
        decided
    } else {
        view.now_s
    }
}

fn hour_value(value: &str) -> bool {
    value == "approve_in_hours" || value == "outside_hours"
}

/// The one check at the top of every command of a saved Mac's session. Returns None to go ahead, else the refusal as
/// the result's error. A frame whose `rules_tag` differs from the stored one first gets a check-in it waits on (at most
/// `CATCH_UP_MS`), and is decided with the new rules or refused `rules_stale`. An action that needs approval must carry
/// `approved_by`. A raw `run` gets the screen only. A one-off session (`ruled` None) refuses the frames that exist for
/// saved Macs only. `install` and `uninstall` are refused first: there is no such tool on a Mac yet.
pub fn check(ruled: Option<&dyn Ruled>, limited: bool, frame: &Frame, stop: &Stop) -> Option<String> {
    let kind = frame.kind.as_str();
    let Some(ruled) = ruled else {
        return (kind == "power" || kind == "programs").then(|| err("not_saved_pc", "this works only in a session on a saved PC"));
    };
    let sub = frame.text("action");
    if kind == "run" {
        // The screen reads the protected lists, so a run that carries a newer tag first gets a try at the new ones. It
        // goes ahead with the last good ones when there is no answer: the screen is a guardrail, not a boundary.
        let mut current = ruled.state();
        let seen = frame.text("rules_tag");
        if !seen.is_empty() && seen != current.tag {
            ruled.catch_up(CATCH_UP_MS, stop);
            current = ruled.state();
        }
        return run_screen(&frame.text("command"), &current.doc, &ruled.app_folders());
    }
    let mut program: Option<String> = None;
    let mut path: Option<String> = None;
    let mut delay_s = 0;
    let action = match kind {
        "put_file" | "get_file" => {
            // The file code answers a bad path itself.
            path = Some(files::absolute_path(&frame.text("path")).ok()?);
            kind.to_string()
        }
        "power" => {
            if sub != "restart" && sub != "shutdown" {
                return Some("power needs action restart or shutdown".to_string());
            }
            delay_s = power_delay(frame);
            sub
        }
        "programs" => match sub.as_str() {
            "list" => return None,
            "install" | "uninstall" => return Some(err("not_supported", NOT_SUPPORTED_PROGRAMS)),
            "close" => {
                if frame.text("name").trim().is_empty() && frame.number("pid") <= 0 {
                    return Some("close needs a name or a pid".to_string());
                }
                match ruled.close_target(frame) {
                    Some(name) => program = Some(name),
                    None => return Some(err("not_found", "no running program has that name or pid")),
                }
                "close_program".to_string()
            }
            _ => return Some("unknown programs action".to_string()),
        },
        _ => return None,
    };

    let guarded = kind != "put_file" && kind != "get_file";
    let mut view = ruled.state();
    let tag = frame.text("rules_tag");
    let mut at = judge_time(frame, &view);
    let behind = !tag.is_empty() && tag != view.tag;
    if behind || (guarded && view.stale) || (guarded && hour_value(view.doc.of(&action)) && at + delay_s >= view.hours.until) {
        ruled.catch_up(CATCH_UP_MS, stop);
        view = ruled.state();
        at = judge_time(frame, &view);
        if behind && tag != view.tag {
            return Some(err("rules_stale", "this PC could not get the team's current rules in time; try again"));
        }
    }
    if guarded && view.stale {
        return Some(err("rules_stale", "this PC could not read the team's rules from its last check-in; try again in a minute"));
    }
    let what = Action { name: &action, program: program.as_deref(), path: path.as_deref(), delay_s };
    let verdict = decide(&view.doc, &view.hours, at, if limited { "limited" } else { "full" }, &what);
    if let Some(e) = verdict.error() {
        return Some(e);
    }
    // The relay's cases compare the path as written. This Mac also follows links first, and adds the folders of the
    // Support app itself to the protected ones.
    if let Some(path) = &path {
        let mut folders = view.doc.folders.clone();
        folders.extend(ruled.app_folders());
        if inside_any(&folders, path) {
            return refuse("protected_folder").error();
        }
    }
    if verdict == Verdict::Approve && clean(&frame.text("approved_by"), 320).is_empty() {
        return Some(err("approval_unavailable", "this action needs a technician's approval in the technician app, and the request carries none"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::ManualClock;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn doc_json() -> Value {
        json!({
            "rev": 4, "time_zone": "Asia/Jerusalem", "hours": null,
            "restart": "approve", "shutdown": "never", "install": "approve", "uninstall": "approve", "close_program": "allow",
            "protected_programs": ["Finder"], "protected_folders": ["/Users/a/Customer Data"],
        })
    }

    fn answer_json() -> Value {
        json!({ "rules": doc_json(), "rules_tag": "0123456789abcdef", "hours_utc": [[100, 200], [300, 400]], "hours_until": 99_999, "server_time": 1_794_000_000 })
    }

    fn doc(f: impl FnOnce(&mut Value)) -> RulesDoc {
        let mut d = doc_json();
        f(&mut d);
        parse_doc(&d).unwrap()
    }

    // ---- reading the answer ------------------------------------------------------------------------------------

    #[test]
    fn a_good_answer_is_read_whole() {
        let a = read_answer(&answer_json()).unwrap();
        assert_eq!(
            (a.doc.rev, a.doc.restart.as_str(), a.doc.shutdown.as_str(), a.tag.as_str(), a.server_time),
            (4, "approve", "never", "0123456789abcdef", 1_794_000_000)
        );
        assert_eq!((a.doc.programs, a.doc.folders), (vec!["Finder".to_string()], vec!["/Users/a/Customer Data".to_string()]));
        assert_eq!((a.hours.spans, a.hours.until), (vec![(100, 200), (300, 400)], 99_999));
    }

    #[test]
    fn every_malformed_answer_is_refused_and_none_is_half_read() {
        type Mutation = Box<dyn Fn(&mut Value)>;
        let bad: Vec<(&str, Mutation)> = vec![
            (
                "no rules",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("rules");
                }),
            ),
            ("rules not an object", Box::new(|v| v["rules"] = json!([1]))),
            (
                "rev missing",
                Box::new(|v| {
                    v["rules"].as_object_mut().unwrap().remove("rev");
                }),
            ),
            ("rev a string", Box::new(|v| v["rules"]["rev"] = json!("4"))),
            ("rev a bool", Box::new(|v| v["rules"]["rev"] = json!(true))),
            ("rev a fraction", Box::new(|v| v["rules"]["rev"] = json!(4.5))),
            ("rev negative", Box::new(|v| v["rules"]["rev"] = json!(-1))),
            ("rev too big", Box::new(|v| v["rules"]["rev"] = json!(2e13))),
            (
                "an action field missing",
                Box::new(|v| {
                    v["rules"].as_object_mut().unwrap().remove("shutdown");
                }),
            ),
            (
                "lists missing",
                Box::new(|v| {
                    v["rules"].as_object_mut().unwrap().remove("protected_folders");
                }),
            ),
            ("list not an array", Box::new(|v| v["rules"]["protected_programs"] = json!("Finder"))),
            ("list item not text", Box::new(|v| v["rules"]["protected_programs"] = json!([5]))),
            ("empty list item", Box::new(|v| v["rules"]["protected_programs"] = json!(["  "]))),
            ("control character", Box::new(|v| v["rules"]["protected_folders"] = json!(["/a\nb"]))),
            ("long program", Box::new(|v| v["rules"]["protected_programs"] = json!(["a".repeat(101)]))),
            ("long folder", Box::new(|v| v["rules"]["protected_folders"] = json!([format!("/{}", "a".repeat(260))]))),
            ("51 entries", Box::new(|v| v["rules"]["protected_programs"] = json!((0..51).map(|i| format!("p{i}")).collect::<Vec<_>>()))),
            ("time zone a number", Box::new(|v| v["rules"]["time_zone"] = json!(5))),
            ("hours an array", Box::new(|v| v["rules"]["hours"] = json!([]))),
            (
                "tag missing",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("rules_tag");
                }),
            ),
            ("tag with a dash", Box::new(|v| v["rules_tag"] = json!("abc-def"))),
            ("tag empty", Box::new(|v| v["rules_tag"] = json!(""))),
            ("tag too long", Box::new(|v| v["rules_tag"] = json!("a".repeat(65)))),
            ("server_time zero", Box::new(|v| v["server_time"] = json!(0))),
            (
                "server_time missing",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("server_time");
                }),
            ),
            ("server_time absurd", Box::new(|v| v["server_time"] = json!(200_000_000_000i64))),
            (
                "hours_until missing",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("hours_until");
                }),
            ),
            (
                "hours_utc missing",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("hours_utc");
                }),
            ),
            ("a span ends before it starts", Box::new(|v| v["hours_utc"] = json!([[200, 100]]))),
            ("a span of three", Box::new(|v| v["hours_utc"] = json!([[1, 2, 3]]))),
            ("a span of text", Box::new(|v| v["hours_utc"] = json!([["1", "2"]]))),
            ("65 spans", Box::new(|v| v["hours_utc"] = json!((0..65).map(|i| json!([i * 10, i * 10 + 5])).collect::<Vec<_>>()))),
        ];
        for (name, mutate) in bad {
            let mut v = answer_json();
            mutate(&mut v);
            assert!(read_answer(&v).is_none(), "{name}");
        }
    }

    #[test]
    fn an_action_value_that_is_not_one_of_ours_counts_as_never() {
        let d = doc(|v| {
            v["restart"] = json!("sometimes");
            v["shutdown"] = json!(7);
            v["install"] = Value::Null;
        });
        assert_eq!((d.restart.as_str(), d.shutdown.as_str(), d.install.as_str()), ("never", "never", "never"));
        assert_eq!(d.of("format_disk"), "never");
        assert_eq!(decide(&d, &Hours::default(), 0, "full", &Action { name: "restart", ..Default::default() }), refuse("rule_never"));
    }

    #[test]
    fn list_items_are_trimmed() {
        let d = doc(|v| v["protected_programs"] = json!(["  Mail  "]));
        assert_eq!(d.programs, vec!["Mail".to_string()]);
    }

    // ---- the tag ---------------------------------------------------------------------------------------------------

    #[test]
    fn the_tag_ignores_rev_and_key_order_and_follows_content() {
        let a = doc_json();
        let mut b = doc_json();
        b["rev"] = json!(99);
        assert_eq!(rules_tag(&a), rules_tag(&b));
        let reordered: Value = serde_json::from_str(r#"{"protected_folders":["/Users/a/Customer Data"],"protected_programs":["Finder"],"close_program":"allow","uninstall":"approve","install":"approve","shutdown":"never","restart":"approve","hours":null,"time_zone":"Asia/Jerusalem"}"#).unwrap();
        assert_eq!(rules_tag(&a), rules_tag(&reordered));
        let mut c = doc_json();
        c["protected_folders"] = json!(["/Users/a/Other"]);
        assert_ne!(rules_tag(&a), rules_tag(&c));
        assert_eq!(rules_tag(&a).len(), 16);
    }

    // ---- what the Mac knows -------------------------------------------------------------------------------------------

    #[test]
    fn the_relays_time_runs_on_the_monotonic_clock_never_the_wall_clock() {
        let clock = ManualClock::new(5_000_000);
        let state = RulesState::new(clock.clone());
        assert!(!state.now().timed);
        assert_eq!(state.now().now_s, 0);
        assert_eq!(state.apply(&answer_json()), (true, true));
        assert_eq!(state.now().now_s, 1_794_000_000);
        clock.advance(90_500);
        assert_eq!(state.now().now_s, 1_794_000_090);
        // Someone sets the date back a year: the Mac's reckoning of the relay's time does not move.
        clock.set_unix(1_000);
        assert_eq!(state.now().now_s, 1_794_000_090);
    }

    #[test]
    fn an_answer_that_cannot_be_read_keeps_the_last_good_rules_and_marks_them_stale() {
        let state = RulesState::new(ManualClock::new(0));
        assert_eq!(state.apply(&answer_json()), (true, true));
        assert_eq!(state.generation(), 1);
        // The same tag again: good, nothing new to save.
        assert_eq!(state.apply(&answer_json()), (true, false));
        let mut bad = answer_json();
        bad["rules"]["restart"] = Value::Null;
        bad["rules"].as_object_mut().unwrap().remove("shutdown");
        assert_eq!(state.apply(&bad), (false, false));
        let v = state.now();
        assert!(v.stale);
        assert_eq!(v.doc.shutdown, "never");
        assert_eq!(state.generation(), 2, "a bad answer is not a good one");
        // A new tag is worth a write, and a good answer clears the stale mark.
        let mut next = answer_json();
        next["rules_tag"] = json!("fedcba9876543210");
        assert_eq!(state.apply(&next), (true, true));
        assert!(!state.now().stale);
        assert_eq!(state.now().tag, "fedcba9876543210");
    }

    #[test]
    fn the_document_and_tag_are_kept_in_device_json_and_read_back() {
        let a = RulesState::new(ManualClock::new(0));
        assert!(a.save().is_none(), "nothing to keep before the first answer");
        a.apply(&answer_json());
        let saved = a.save().unwrap();
        let b = RulesState::new(ManualClock::new(0));
        b.load(&saved);
        let v = b.now();
        assert_eq!((v.tag.as_str(), v.doc.shutdown.as_str(), v.timed), ("0123456789abcdef", "never", false));
        // A damaged file leaves the defaults.
        let c = RulesState::new(ManualClock::new(0));
        c.load(&json!({"rules": {"rev": "x"}, "rules_tag": "abc"}));
        c.load(&json!({"rules": doc_json(), "rules_tag": "bad tag!"}));
        assert_eq!(c.now().doc, RulesDoc::default());
        assert!(c.save().is_none());
    }

    // ---- hours ---------------------------------------------------------------------------------------------------------

    #[test]
    fn hours_are_judged_over_the_whole_wait_and_past_the_horizon_everything_is_business_time() {
        let h = Hours { spans: vec![(100, 200)], until: 1000 };
        assert!(h.inside(100, 0) && h.inside(199, 0));
        assert!(!h.inside(200, 0), "a span is [start, end)");
        assert!(!h.inside(99, 0));
        assert!(!h.inside(50, 49), "the window ends before the span");
        assert!(h.inside(50, 50), "the window reaches the start");
        assert!(h.inside(150, 500));
        assert!(!h.inside(300, 100));
        assert!(h.inside(900, 100), "the window reaches the horizon");
        assert!(h.inside(5000, 0));
        assert!(Hours::default().inside(0, 0), "no horizon known: every moment counts");
    }

    // ---- paths and names ----------------------------------------------------------------------------------------------

    #[test]
    fn paths_compare_by_whole_components_and_dots_resolve() {
        assert!(path_inside("/Users/a/Data", "/users/A/data/x.txt"));
        assert!(path_inside("/Users/a/Data", "/Users/a/Data"));
        assert!(!path_inside("/Users/a/Data", "/Users/a/Database/x"));
        assert!(path_inside("/Users/a/Data", "/Users/a/./Data//sub/../x"));
        assert!(path_inside("/Users/a/Data", "/Users/a/Data/../Data/y"));
        assert!(!path_inside("/Users/a/Data", "/Users/a/Data/../x"));
        // A POSIX path has no drive, so .. may take the first component.
        assert!(!path_inside("/Users/a/Data", "/../Users/a/Data/../../../etc"));
        // A drive-letter path is never inside a Mac folder, nor the reverse.
        assert!(!path_inside("/Users/a/Data", "C:\\Users\\a\\Data\\x"));
        assert!(path_inside("C:\\Data", "c:/data/sub"));
        assert!(!path_inside("", "/x"));
        assert_eq!(path_parts("/"), Vec::<String>::new());
    }

    #[test]
    fn the_support_app_is_known_by_name_and_by_folder() {
        for yes in ["support", "Support", "/Applications/Support.app/Contents/MacOS/support", "support-1.2.3-0a1b2c3d", "SUPPORT-x-y-deadbeef"] {
            assert!(is_app_program(yes), "{yes}");
        }
        for no in ["supporter", "support-1.2.3-0a1b2c3", "support-0a1b2c3d", "support-x-0a1b2c3g", "mail", "support.app", ""] {
            assert!(!is_app_program(no), "{no}");
        }
        for yes in [
            "/Applications/Support.app",
            "/applications/support.app/Contents/MacOS/support",
            "/Library/Application Support/SupportMCP/device.json",
            "/library/application support/supportmcp",
            "/Applications/../Applications/Support.app/x",
            "C:\\Program Files\\SupportMCP\\support.exe",
            "d:/program files (x86)/SupportMCP-ab12/x",
        ] {
            assert!(is_app_path(yes), "{yes}");
        }
        for no in [
            "/Applications/Mail.app",
            "/Applications/Support.application",
            "/Library/Application Support/Other",
            "/Users/a/Support.app/x",
            "/Applications",
            "C:\\Program Files\\Other\\x",
        ] {
            assert!(!is_app_path(no), "{no}");
        }
        assert_eq!(app_folders(), vec!["/Applications/Support.app".to_string(), "/Library/Application Support/SupportMCP".to_string()]);
    }

    #[test]
    fn program_names_compare_trimmed_lowercase_without_exe_and_a_close_drops_the_folder() {
        assert_eq!(program_key("  Outlook.EXE. "), "outlook");
        assert_eq!(process_key("/Applications/Mail.app/Contents/MacOS/Mail"), "mail");
        assert_eq!(process_key("C:\\Office\\outlook.exe"), "outlook");
        let d = doc(|v| v["protected_programs"] = json!(["Outlook.exe"]));
        let h = Hours::default();
        let on = |name, program, control| decide(&d, &h, 0, control, &Action { name, program: Some(program), ..Default::default() });
        assert_eq!(on("close_program", "/Applications/Outlook", "full"), refuse("protected_program"));
        assert_eq!(on("uninstall", "OUTLOOK", "full"), refuse("protected_program"));
        assert_eq!(on("close_program", "Safari", "limited"), Verdict::Allow);
        // A close of the Support app itself is refused whatever the lists say.
        assert_eq!(on("close_program", "support", "full"), refuse("protected_program"));
    }

    // ---- real paths ---------------------------------------------------------------------------------------------------------

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("support-core-rules-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The temp folder itself may be a link (/tmp on a Mac): work from its real path.
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn a_link_into_a_protected_folder_is_caught_though_the_path_as_written_looks_fine() {
        let dir = temp("links");
        let protected = dir.join("Customer Data");
        std::fs::create_dir_all(protected.join("deep")).unwrap();
        let link = dir.join("shortcut");
        std::os::unix::fs::symlink(&protected, &link).unwrap();
        let folders = vec![protected.to_string_lossy().into_owned()];
        let via_link = link.join("deep/new.txt").to_string_lossy().into_owned();
        assert!(!path_inside(&folders[0], &via_link), "as written it is outside, which is all the relay can see");
        assert!(inside_any(&folders, &via_link));
        assert!(inside_any(&folders, &link.join("not-yet-made/x.txt").to_string_lossy()), "the part that does not exist yet stays as written");
        assert!(!inside_any(&folders, &dir.join("elsewhere/x.txt").to_string_lossy()));
        // The folder named through a link works too.
        let by_link = vec![link.to_string_lossy().into_owned()];
        assert!(inside_any(&by_link, &protected.join("a.txt").to_string_lossy()));
        assert!(!inside_any(&[], "/anything"));
        assert_eq!(resolve("relative/path"), "relative/path");
        assert_eq!(resolve(&link.to_string_lossy()), protected.to_string_lossy());
        std::fs::remove_dir_all(dir).unwrap();
    }

    // ---- the raw command's screen ---------------------------------------------------------------------------------------------

    fn screen(command: &str, d: &RulesDoc) -> Option<String> {
        run_screen(command, d, &app_folders())
    }

    #[test]
    fn a_command_that_names_a_protected_program_or_folder_is_refused() {
        let d = doc(|_| {});
        let pp = Some(err("protected_program", "the team's rules protect this program"));
        let pf = Some(err("protected_folder", "the team's rules protect this folder"));
        assert_eq!(screen("open -a Finder", &d), pp);
        assert_eq!(screen("killall FINDER", &d), pp);
        assert_eq!(screen("open -a Finders", &d), None, "a longer word is another word");
        assert_eq!(screen("cat '/Users/a/Customer Data/ledger.xlsx'", &d), pf);
        assert_eq!(screen("cat //Users//a//Customer Data//x", &d), pf, "repeated slashes are one");
        assert_eq!(screen("ls /USERS/A/CUSTOMER DATA", &d), pf);
        assert_eq!(screen("cat '/Users/a/Customer Database/x'", &d), None, "a longer folder name is another folder");
        assert_eq!(screen("cat /Users/a/Customer Data-old/x", &d), None);
        assert_eq!(screen("ls /Users/a", &d), None);
    }

    #[test]
    fn the_support_app_is_protected_by_the_screen_whatever_the_rules_say() {
        let d = RulesDoc::default();
        let pp = Some(err("protected_program", "the team's rules protect this program"));
        let pf = Some(err("protected_folder", "the team's rules protect this folder"));
        assert_eq!(screen("launchctl bootout system/io.github.sukardaddy.supportmcp.device", &d), pp);
        assert_eq!(screen("rm -rf '/Library/Application Support/SupportMCP'", &d), pf);
        assert_eq!(screen("ls /Applications/Support.app/Contents", &d), pf);
        assert_eq!(screen("killall support", &d), pp);
        assert_eq!(screen("pkill -f support", &d), pp);
        assert_eq!(screen("kill 123", &d), None);
        assert_eq!(screen("echo support", &d), None, "the word alone is just a word");
    }

    #[test]
    fn a_verb_of_a_guarded_action_is_sent_to_its_tool_unless_the_rule_is_allow() {
        let tool = |what: &str, tool: &str| {
            Some(err("use_tool", &format!("this command {what}, which the team's rules govern. Use the {tool} tool, not a raw command")))
        };
        let d = doc(|v| {
            v["restart"] = json!("approve");
            v["shutdown"] = json!("never");
            v["close_program"] = json!("outside_hours");
            v["protected_programs"] = json!([]);
        });
        for c in [
            "reboot",
            "sudo /sbin/reboot",
            "shutdown -r now",
            "sudo shutdown -rf +0",
            "launchctl reboot system",
            "echo hi && reboot",
            "ls; reboot",
            "osascript -e 'tell application \"System Events\" to restart'",
            "\"reboot\"",
        ] {
            assert_eq!(screen(c, &d), tool("restarts the PC", "restart_pc"), "{c}");
        }
        for c in ["halt", "poweroff", "shutdown -h now", "shutdown -p now", "osascript -e 'tell application \"System Events\" to shut down'"] {
            assert_eq!(screen(c, &d), tool("shuts the PC down", "shutdown_pc"), "{c}");
        }
        for c in ["kill 123", "killall Safari", "pkill -9 Mail", "launchctl stop com.example.thing", "launchctl bootout gui/501/com.example"] {
            assert_eq!(screen(c, &d), tool("closes a program", "close_program"), "{c}");
        }
        // Not verbs: a longer word, a path argument, a plain mention, a shutdown with no flag, other launchctl verbs.
        for c in ["rebooted", "reboot-info", "echo rebooting", "cat reboot.txt", "shutdown", "shutdown now", "launchctl list", "ls", ""] {
            assert_eq!(screen(c, &d), None, "{c}");
        }
        // With every rule allow, every verb goes through.
        let open = doc(|v| {
            v["restart"] = json!("allow");
            v["shutdown"] = json!("allow");
            v["close_program"] = json!("allow");
            v["protected_programs"] = json!([]);
        });
        for c in ["reboot", "shutdown -h now", "killall Safari"] {
            assert_eq!(screen(c, &open), None, "{c}");
        }
        // Installing and uninstalling have no tool on a Mac, so a raw installer is not sent to one.
        let never = doc(|v| {
            v["install"] = json!("never");
            v["uninstall"] = json!("never");
            v["protected_programs"] = json!([]);
        });
        assert_eq!(screen("installer -pkg /tmp/x.pkg -target /", &never), None);
    }

    // ---- the check at the top of every command -----------------------------------------------------------------------------------

    struct FakeRuled {
        view: Mutex<View>,
        /// What the view becomes when a catch-up check-in happens, if anything.
        after_catch_up: Mutex<Option<View>>,
        catch_ups: AtomicUsize,
        target: Option<String>,
    }

    impl FakeRuled {
        fn new(d: RulesDoc) -> FakeRuled {
            let view = View { doc: d, tag: "tagA".into(), stale: false, timed: true, now_s: 1000, hours: Hours { spans: vec![], until: 1_000_000 } };
            FakeRuled { view: Mutex::new(view), after_catch_up: Mutex::new(None), catch_ups: AtomicUsize::new(0), target: Some("Safari".into()) }
        }
    }

    impl Ruled for FakeRuled {
        fn state(&self) -> View {
            self.view.lock().unwrap().clone()
        }
        fn catch_up(&self, _: u64, _: &Stop) -> bool {
            self.catch_ups.fetch_add(1, Ordering::SeqCst);
            if let Some(v) = self.after_catch_up.lock().unwrap().take() {
                *self.view.lock().unwrap() = v;
                return true;
            }
            false
        }
        fn close_target(&self, _: &Frame) -> Option<String> {
            self.target.clone()
        }
    }

    fn frame(v: Value) -> Frame {
        Frame::parse(&v).unwrap()
    }

    fn chk(r: &FakeRuled, limited: bool, v: Value) -> Option<String> {
        check(Some(r as &dyn Ruled), limited, &frame(v), &Stop::new())
    }

    #[test]
    fn a_one_off_session_has_no_rules_and_refuses_the_saved_pc_frames() {
        let stop = Stop::new();
        let refusal = Some("not_saved_pc: this works only in a session on a saved PC".to_string());
        assert_eq!(check(None, false, &frame(json!({"type":"power","id":"1","action":"restart"})), &stop), refusal);
        assert_eq!(check(None, false, &frame(json!({"type":"programs","id":"1","action":"list"})), &stop), refusal);
        assert_eq!(check(None, false, &frame(json!({"type":"run","id":"1","command":"reboot"})), &stop), None);
        assert_eq!(check(None, false, &frame(json!({"type":"put_file","id":"1","path":"/x"})), &stop), None);
        assert_eq!(check(None, false, &frame(json!({"type":"screen","id":"1"})), &stop), None);
    }

    #[test]
    fn files_are_judged_by_the_protected_folders() {
        let r = FakeRuled::new(doc(|_| {}));
        assert_eq!(
            chk(&r, false, json!({"type":"put_file","id":"1","path":"/Users/a/Customer Data/x"})),
            Some(err("protected_folder", "the team's rules protect this folder"))
        );
        assert_eq!(
            chk(&r, false, json!({"type":"get_file","id":"1","path":"/Users/a/Customer Data/../Customer Data/x"})),
            Some(err("protected_folder", "the team's rules protect this folder"))
        );
        assert_eq!(chk(&r, false, json!({"type":"get_file","id":"1","path":"/Users/a/Other/x"})), None);
        assert_eq!(
            chk(&r, false, json!({"type":"get_file","id":"1","path":"/Applications/Support.app/Contents/Info.plist"})),
            Some(err("protected_folder", "the team's rules protect this folder"))
        );
        assert_eq!(
            chk(&r, false, json!({"type":"put_file","id":"1","path":"/Library/Application Support/SupportMCP/device.json"})),
            Some(err("protected_folder", "the team's rules protect this folder"))
        );
        // A relative path is the file code's to refuse.
        assert_eq!(chk(&r, false, json!({"type":"put_file","id":"1","path":"relative/x"})), None);
    }

    #[test]
    fn power_follows_the_rule_the_control_level_and_the_approval() {
        let r = FakeRuled::new(doc(|v| {
            v["restart"] = json!("approve");
            v["shutdown"] = json!("allow");
        }));
        let restart = |extra: Value| {
            let mut v = json!({"type":"power","id":"1","action":"restart","delay_s":30,"rules_tag":"tagA"});
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        assert_eq!(chk(&r, true, restart(json!({}))), Some(err("needs_full_control", "this action needs a PC set to full control")));
        assert_eq!(
            chk(&r, false, restart(json!({}))),
            Some(err("approval_unavailable", "this action needs a technician's approval in the technician app, and the request carries none"))
        );
        assert_eq!(
            chk(&r, false, restart(json!({"approved_by": "   "}))),
            Some(err("approval_unavailable", "this action needs a technician's approval in the technician app, and the request carries none"))
        );
        assert_eq!(chk(&r, false, restart(json!({"approved_by": "boss@example.com"}))), None);
        assert_eq!(chk(&r, false, json!({"type":"power","id":"1","action":"shutdown","delay_s":30,"rules_tag":"tagA"})), None);
        assert_eq!(chk(&r, false, json!({"type":"power","id":"1","action":"dance"})), Some("power needs action restart or shutdown".to_string()));
        let never = FakeRuled::new(doc(|v| v["shutdown"] = json!("never")));
        assert_eq!(
            chk(&never, false, json!({"type":"power","id":"1","action":"shutdown","rules_tag":"tagA"})),
            Some(err("rule_never", "the team's rules never allow this action on this PC"))
        );
    }

    #[test]
    fn the_power_delay_is_5_to_600_and_30_when_none() {
        let d = |v: Value| power_delay(&frame(json!({"type":"power","id":"1","delay_s":v})));
        assert_eq!(
            (d(json!(1)), d(json!(5)), d(json!(45.9)), d(json!(600)), d(json!(9999)), d(json!(-3)), d(json!("x")), d(Value::Null)),
            (5, 5, 45, 600, 600, 5, 30, 30)
        );
        assert_eq!(power_delay(&frame(json!({"type":"power","id":"1"}))), 30);
    }

    #[test]
    fn programs_list_and_close_are_judged_and_install_and_uninstall_are_not_supported() {
        let r = FakeRuled::new(doc(|_| {}));
        let ns = Some(err("not_supported", "installing and uninstalling programs is not available on a Mac yet"));
        assert_eq!(chk(&r, false, json!({"type":"programs","id":"1","action":"list"})), None);
        assert_eq!(chk(&r, false, json!({"type":"programs","id":"1","action":"install","path":"/tmp/a.pkg"})), ns);
        assert_eq!(chk(&r, false, json!({"type":"programs","id":"1","action":"uninstall","program_id":"x"})), ns);
        assert_eq!(chk(&r, false, json!({"type":"programs","id":"1","action":"dance"})), Some("unknown programs action".to_string()));
        assert_eq!(chk(&r, false, json!({"type":"programs","id":"1","action":"close"})), Some("close needs a name or a pid".to_string()));
        assert_eq!(chk(&r, false, json!({"type":"programs","id":"1","action":"close","name":"Safari","rules_tag":"tagA"})), None);
        // The target the Mac resolves is what the rules judge: here a pid that means the protected Finder.
        let mut finder = FakeRuled::new(doc(|_| {}));
        finder.target = Some("Finder".into());
        assert_eq!(
            chk(&finder, false, json!({"type":"programs","id":"1","action":"close","pid":321,"rules_tag":"tagA"})),
            Some(err("protected_program", "the team's rules protect this program"))
        );
        let mut app = FakeRuled::new(doc(|_| {}));
        app.target = Some("/Applications/Support.app/Contents/MacOS/support".into());
        assert_eq!(
            chk(&app, false, json!({"type":"programs","id":"1","action":"close","pid":1,"rules_tag":"tagA"})),
            Some(err("protected_program", "the team's rules protect this program"))
        );
        let mut gone = FakeRuled::new(doc(|_| {}));
        gone.target = None;
        assert_eq!(
            chk(&gone, false, json!({"type":"programs","id":"1","action":"close","pid":9})),
            Some(err("not_found", "no running program has that name or pid"))
        );
    }

    #[test]
    fn a_frame_with_a_newer_tag_waits_for_a_check_in_and_is_decided_with_the_new_rules() {
        let r = FakeRuled::new(doc(|v| v["shutdown"] = json!("never")));
        let mut newer = r.state();
        newer.tag = "tagB".into();
        newer.doc = doc(|v| v["shutdown"] = json!("allow"));
        *r.after_catch_up.lock().unwrap() = Some(newer);
        let f = json!({"type":"power","id":"1","action":"shutdown","delay_s":30,"rules_tag":"tagB"});
        assert_eq!(chk(&r, false, f.clone()), None, "decided with the rules the catch-up brought");
        assert_eq!(r.catch_ups.load(Ordering::SeqCst), 1);
        // Another frame that carries the same tag needs no more check-ins.
        assert_eq!(chk(&r, false, f), None);
        assert_eq!(r.catch_ups.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn when_the_catch_up_brings_nothing_the_frame_is_refused_as_stale() {
        let r = FakeRuled::new(doc(|v| v["shutdown"] = json!("allow")));
        let f = json!({"type":"power","id":"1","action":"shutdown","delay_s":30,"rules_tag":"tagZ"});
        assert_eq!(chk(&r, false, f), Some(err("rules_stale", "this PC could not get the team's current rules in time; try again")));
        assert_eq!(r.catch_ups.load(Ordering::SeqCst), 1);
        // A stale view (the last answer could not be read) refuses a guarded action, after one try at a fresh one.
        let s = FakeRuled::new(doc(|v| v["shutdown"] = json!("allow")));
        s.view.lock().unwrap().stale = true;
        assert_eq!(
            chk(&s, false, json!({"type":"power","id":"1","action":"shutdown","delay_s":30,"rules_tag":"tagA"})),
            Some(err("rules_stale", "this PC could not read the team's rules from its last check-in; try again in a minute"))
        );
        assert_eq!(s.catch_ups.load(Ordering::SeqCst), 1);
        // A file is not a guarded action: a stale view does not stop it.
        assert_eq!(chk(&s, false, json!({"type":"get_file","id":"1","path":"/tmp/x","rules_tag":"tagA"})), None);
        assert_eq!(s.catch_ups.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_run_is_screened_and_a_newer_tag_gets_a_try_at_the_new_lists() {
        let r = FakeRuled::new(doc(|v| v["protected_programs"] = json!([])));
        let mut newer = r.state();
        newer.tag = "tagB".into();
        newer.doc = doc(|v| v["protected_programs"] = json!(["Mail"]));
        *r.after_catch_up.lock().unwrap() = Some(newer);
        assert_eq!(
            chk(&r, false, json!({"type":"run","id":"1","command":"open -a Mail","rules_tag":"tagB"})),
            Some(err("protected_program", "the team's rules protect this program"))
        );
        // Without an answer it goes ahead with the last good lists: the screen is a guardrail, not a boundary.
        let quiet = FakeRuled::new(doc(|v| v["protected_programs"] = json!([])));
        assert_eq!(chk(&quiet, false, json!({"type":"run","id":"1","command":"open -a Mail","rules_tag":"tagZ"})), None);
        assert_eq!(quiet.catch_ups.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn hours_are_judged_at_the_relays_decided_at_when_it_is_close_to_the_macs_own_reckoning() {
        // Business hours [2000, 3000). The Mac thinks it is 1990; a restart waits 5 s.
        let outside_hours = || {
            let r = FakeRuled::new(doc(|v| {
                v["restart"] = json!("outside_hours");
                v["hours"] = json!({"mon": ["08:00", "18:00"]});
            }));
            {
                let mut v = r.view.lock().unwrap();
                v.now_s = 1990;
                v.hours = Hours { spans: vec![(2000, 3000)], until: 100_000 };
            }
            r
        };
        let refused = Some(err("business_hours", "the team's rules allow this action only outside business hours"));
        let f = |extra: Value| {
            let mut v = json!({"type":"power","id":"1","action":"restart","delay_s":5,"rules_tag":"tagA"});
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        // On the Mac's own reckoning the window 1990..1995 ends before the span: allowed.
        assert_eq!(chk(&outside_hours(), false, f(json!({}))), None);
        // The relay decided at 2010, 20 s from the Mac's reckoning: judged there, inside, refused.
        assert_eq!(chk(&outside_hours(), false, f(json!({"decided_at": 2010}))), refused);
        // The same time in milliseconds is read as such.
        assert_eq!(
            chk(&outside_hours(), false, f(json!({"decided_at": 2_010_000i64 * 100}))),
            None,
            "a value in ms that is far from the Mac's reckoning is ignored"
        );
        // 90 s off is more than the 60 s allowed: the Mac's own time stands.
        assert_eq!(chk(&outside_hours(), false, f(json!({"decided_at": 2080}))), None);
    }

    #[test]
    fn an_hour_rule_near_the_end_of_the_known_hours_asks_for_a_fresh_answer_first() {
        let r = FakeRuled::new(doc(|v| {
            v["restart"] = json!("approve_in_hours");
            v["hours"] = json!({"mon": ["08:00", "18:00"]});
        }));
        {
            let mut v = r.view.lock().unwrap();
            v.now_s = 1000;
            v.hours = Hours { spans: vec![], until: 1010 };
        }
        // The wait runs past the horizon, so the Mac gets a fresh answer before it decides.
        let f = json!({"type":"power","id":"1","action":"restart","delay_s":30,"rules_tag":"tagA","approved_by":"a@b.c"});
        assert_eq!(chk(&r, false, f.clone()), None);
        assert_eq!(r.catch_ups.load(Ordering::SeqCst), 1);
        let early = FakeRuled::new(doc(|v| {
            v["restart"] = json!("approve_in_hours");
            v["hours"] = json!({"mon": ["08:00", "18:00"]});
        }));
        assert_eq!(chk(&early, false, f), None);
        assert_eq!(early.catch_ups.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_link_in_a_file_frame_is_caught_by_the_check_with_real_folders() {
        let dir = temp("check");
        let protected = dir.join("Secret");
        std::fs::create_dir_all(&protected).unwrap();
        let link = dir.join("alias");
        std::os::unix::fs::symlink(&protected, &link).unwrap();
        let folder = protected.to_string_lossy().into_owned();
        let r = FakeRuled::new(doc(|v| v["protected_folders"] = json!([folder])));
        let through = link.join("x.txt").to_string_lossy().into_owned();
        assert_eq!(
            chk(&r, false, json!({"type":"put_file","id":"1","path":through,"rules_tag":"tagA"})),
            Some(err("protected_folder", "the team's rules protect this folder"))
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}

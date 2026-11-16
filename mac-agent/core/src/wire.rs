//! The relay's wire as this client reads and writes it: constants, small JSON readers, the session hello,
//! command frames and result bodies. Numbers match the Windows client (src/agent-app.cs).

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};

pub const PROTOCOL: i64 = 1;
/// The hello's `agent` field. The relay stores it as free text, cut to 40 characters.
pub const AGENT: &str = "macos-app-1";

/// The longest answer the client reads from /agent, and the longest body it sends (the relay's AGENT_BODY_MAX).
pub const AGENT_BODY_MAX: usize = 750_000;
/// A /device answer is read up to this many bytes.
pub const DEVICE_RESPONSE_MAX: usize = 65_536;
/// Raw bytes kept of each of a command's output streams. 65,536 bytes is 87,384 base64 characters, under the
/// relay's 90,000-character check (src/session.js decodeHttpResult).
pub const OUTPUT_MAX: usize = 65_536;
/// `put_file`: the most base64 characters in one chunk (src/session.js PUT_B64_MAX).
pub const PUT_B64_MAX: usize = 700_000;
/// `get_file`: the most bytes in one read.
pub const GET_LENGTH_MAX: i64 = 524_288;
/// A screenshot's base64 must stay under this many characters (the relay accepts 700,000).
pub const IMAGE_B64_MAX: usize = 700_000;
/// The longest text a `type` action may carry.
pub const TYPE_MAX: usize = 5_000;

/// The text of a string field, or "" when it is missing or not text. Numbers and booleans read as text too, as the
/// Windows client's `Wire.Text` does.
pub fn text(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// A whole number field, or 0. A fraction is cut toward zero.
pub fn number(v: &Value, key: &str) -> i64 {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        _ => 0,
    }
}

pub fn flag(v: &Value, key: &str) -> bool {
    matches!(v.get(key), Some(Value::Bool(true)))
}

/// Text from the relay for a window or a log: control characters dropped, trimmed, at most `max` characters.
pub fn clean(text: &str, max: usize) -> String {
    let kept: String = text.chars().filter(|c| !c.is_control()).collect();
    kept.trim().chars().take(max).collect()
}

/// A session id: 64 lowercase hex characters.
pub fn is_session_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(text: &str) -> Option<Vec<u8>> {
    B64.decode(text).ok()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    Full,
    Normal,
}

impl Control {
    pub fn as_str(self) -> &'static str {
        match self {
            Control::Full => "full",
            Control::Normal => "normal",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    Cmd,
    Screen,
}

impl Lane {
    pub const ALL: [Lane; 2] = [Lane::Cmd, Lane::Screen];

    pub fn name(self) -> &'static str {
        match self {
            Lane::Cmd => "cmd",
            Lane::Screen => "screen",
        }
    }

    pub fn index(self) -> usize {
        match self {
            Lane::Cmd => 0,
            Lane::Screen => 1,
        }
    }

    /// The lane a frame type runs on, or None for a type this client does not know.
    pub fn of_type(frame_type: &str) -> Option<Lane> {
        match frame_type {
            "run" | "put_file" | "get_file" | "power" | "programs" => Some(Lane::Cmd),
            "screen" | "control" => Some(Lane::Screen),
            _ => None,
        }
    }
}

/// What the Mac says about itself in its session hello (docs/relay-v1-spec.md, "A Mac on the wire").
#[derive(Clone, Debug)]
pub struct HostInfo {
    pub machine: String,
    pub user: String,
    pub elevated: bool,
    pub control: Control,
    /// `uia` joins the caps only once the Mac can answer ui_tree and ui_act (PR 4).
    pub uia: bool,
}

/// The session hello. `screen` and `lanes` are always in the caps once the Mac is set up, so the caps never change
/// inside a session: a new hello would fail the commands in flight. A missing permission is answered per frame.
pub fn hello(info: &HostInfo, version: &str) -> Value {
    let mut caps = vec!["screen"];
    if info.uia {
        caps.push("uia");
    }
    caps.push("lanes");
    if info.control == Control::Full {
        caps.push("full");
    }
    json!({
        "type": "hello",
        "machine": info.machine,
        "user": info.user,
        "ps": "",
        "agent": AGENT,
        "version": version,
        "elevated": info.elevated,
        "caps": caps,
        "control": info.control.as_str(),
    })
}

/// One command frame from the relay.
#[derive(Clone, Debug)]
pub struct Frame {
    pub kind: String,
    pub id: String,
    pub lane: Lane,
    pub raw: Value,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// No id, or a type this client does not know. The Windows client ends the session on either.
    Invalid,
}

impl Frame {
    pub fn parse(raw: &Value) -> Result<Frame, FrameError> {
        let kind = text(raw, "type");
        let id = text(raw, "id");
        match Lane::of_type(&kind) {
            Some(lane) if !id.is_empty() => Ok(Frame { kind, id, lane, raw: raw.clone() }),
            _ => Err(FrameError::Invalid),
        }
    }

    pub fn text(&self, key: &str) -> String {
        text(&self.raw, key)
    }

    pub fn number(&self, key: &str) -> i64 {
        number(&self.raw, key)
    }

    pub fn flag(&self, key: &str) -> bool {
        flag(&self.raw, key)
    }

    /// A short line for the corner window's log. Never holds file contents, typed text or images.
    pub fn describe(&self) -> String {
        match self.kind.as_str() {
            "run" => format!("$ {}", self.text("command")),
            "screen" | "control" => self.kind.clone(),
            "power" | "programs" => format!("{} {}", self.kind, self.text("action")),
            _ => format!("{} {}", self.kind, self.text("path")),
        }
    }
}

/// A screen action after the relay normalised it. Every field has the relay's default, so a missing one reads as that.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScreenAction {
    pub name: String,
    pub display: i64,
    /// Whether a fresh screenshot follows an input (default true).
    pub screenshot: bool,
    pub x: i64,
    pub y: i64,
    pub x1: i64,
    pub y1: i64,
    pub x2: i64,
    pub y2: i64,
    pub button: String,
    pub count: i64,
    pub direction: String,
    pub amount: i64,
    pub text: String,
    pub keys: String,
    pub seconds: f64,
    pub max_lines: i64,
    pub ref_id: i64,
    pub verb: String,
    pub value: Option<String>,
    pub on: bool,
    pub minutes: i64,
}

impl ScreenAction {
    pub fn parse(action: &Value) -> ScreenAction {
        let num_or = |key: &str, def: i64| if action.get(key).is_some_and(|v| v.is_number()) { number(action, key) } else { def };
        ScreenAction {
            name: text(action, "name"),
            display: number(action, "display"),
            screenshot: !matches!(action.get("screenshot"), Some(Value::Bool(false))),
            x: number(action, "x"),
            y: number(action, "y"),
            x1: number(action, "x1"),
            y1: number(action, "y1"),
            x2: number(action, "x2"),
            y2: number(action, "y2"),
            button: {
                let b = text(action, "button");
                if b.is_empty() {
                    "left".into()
                } else {
                    b
                }
            },
            count: num_or("count", 1),
            direction: text(action, "direction"),
            amount: num_or("amount", 3),
            text: text(action, "text"),
            keys: text(action, "keys"),
            seconds: action.get("seconds").and_then(Value::as_f64).unwrap_or(1.0),
            max_lines: num_or("max_lines", 300),
            ref_id: number(action, "ref"),
            verb: text(action, "verb"),
            value: action.get("value").and_then(Value::as_str).map(str::to_string),
            on: flag(action, "on"),
            minutes: num_or("minutes", 10),
        }
    }
}

/// A relay address as the Mac accepts it: https, or http on loopback (for local development), with no path, user,
/// query or fragment. Returns it without a trailing slash. The same rule as `CheckOrigin` in src/agent-app.cs.
pub fn check_origin(origin: &str) -> Result<String, String> {
    let bad = || "Invalid support server.".to_string();
    let url = url::Url::parse(origin).map_err(|_| bad())?;
    let loopback = match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !scheme_ok
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host().is_none()
    {
        return Err(bad());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// `{"ok":false,"error":...}`.
pub fn error_result(message: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("ok".into(), Value::Bool(false));
    m.insert("error".into(), Value::String(message.to_string()));
    m
}

pub fn into_value(m: Map<String, Value>) -> Value {
    Value::Object(m)
}

/// The envelope a lane's result goes out in.
pub fn result_message(id: &str, generation: i64, mut body: Map<String, Value>) -> Value {
    body.insert("type".into(), Value::String("result".into()));
    body.insert("id".into(), Value::String(id.to_string()));
    body.insert("generation".into(), Value::from(generation));
    Value::Object(body)
}

/// What replaces a result the relay refused (400 or 413) or that is over the size limit. It carries only the five
/// fields the relay always accepts.
pub fn rejected_result(id: &str, generation: i64) -> Value {
    json!({ "type": "result", "id": id, "generation": generation, "ok": false, "error": "result rejected by relay" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hello_has_screen_and_lanes_always_and_full_only_for_full_control() {
        let mut info = HostInfo { machine: "Neo".into(), user: "ariel".into(), elevated: true, control: Control::Full, uia: false };
        let h = hello(&info, "1.0.0");
        assert_eq!(h["caps"], json!(["screen", "lanes", "full"]));
        assert_eq!(h["control"], "full");
        assert_eq!(h["agent"], "macos-app-1");
        assert_eq!(h["ps"], "");
        info.control = Control::Normal;
        info.uia = true;
        info.elevated = false;
        let h = hello(&info, "1.0.0");
        assert_eq!(h["caps"], json!(["screen", "uia", "lanes"]));
        assert_eq!(h["control"], "normal");
        assert_eq!(h["elevated"], false);
    }

    #[test]
    fn frames_need_a_known_type_and_an_id() {
        let ok = Frame::parse(&json!({"type":"run","id":"a","lane":"cmd","command":"ls"})).unwrap();
        assert_eq!((ok.lane, ok.describe().as_str()), (Lane::Cmd, "$ ls"));
        assert_eq!(Frame::parse(&json!({"type":"screen","id":"b"})).unwrap().lane, Lane::Screen);
        assert!(Frame::parse(&json!({"type":"run"})).is_err());
        assert!(Frame::parse(&json!({"type":"dance","id":"x"})).is_err());
        assert!(Frame::parse(&json!({"type":"idle"})).is_err());
    }

    #[test]
    fn screen_actions_take_the_relays_defaults() {
        let a = ScreenAction::parse(&json!({"name":"click","x":5,"y":6}));
        assert_eq!((a.button.as_str(), a.count, a.screenshot, a.display), ("left", 1, true, 0));
        let s = ScreenAction::parse(&json!({"name":"scroll","direction":"down"}));
        assert_eq!(s.amount, 3);
        let n = ScreenAction::parse(&json!({"name":"key","keys":"ctrl+s","screenshot":false}));
        assert!(!n.screenshot);
    }

    #[test]
    fn clean_drops_control_characters_and_cuts() {
        assert_eq!(clean("  a\u{0}b\nc  ", 10), "abc");
        assert_eq!(clean("abcdef", 3), "abc");
    }

    #[test]
    fn an_origin_is_https_or_loopback_http_with_nothing_after_the_host() {
        assert_eq!(check_origin("https://support.example.com").unwrap(), "https://support.example.com");
        assert_eq!(check_origin("https://support.example.com/").unwrap(), "https://support.example.com");
        assert_eq!(check_origin("http://127.0.0.1:8787").unwrap(), "http://127.0.0.1:8787");
        assert_eq!(check_origin("http://localhost:8787/").unwrap(), "http://localhost:8787");
        assert_eq!(check_origin("http://[::1]:8787").unwrap(), "http://[::1]:8787");
        for bad in [
            "http://support.example.com",
            "https://a.example/x",
            "https://a.example/?q=1",
            "https://a.example/#f",
            "https://u:p@a.example",
            "ftp://a.example",
            "support.example.com",
            "",
            "https://",
            "http://127.0.0.1.example.com",
        ] {
            assert!(check_origin(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_session_id_is_64_lowercase_hex() {
        assert!(is_session_id(&"a1".repeat(32)));
        assert!(!is_session_id(&"A1".repeat(32)));
        assert!(!is_session_id("abc"));
    }

    #[test]
    fn a_rejected_result_carries_only_the_five_fields() {
        let v = rejected_result("id1", 4);
        let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["error", "generation", "id", "ok", "type"]);
    }
}

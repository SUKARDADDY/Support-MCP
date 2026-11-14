//! The messages on the socket between the root service and the helpers, read strictly: every message has a fixed set
//! of keys with fixed types and bounded sizes, and anything else is refused (the connection then closes). The service
//! treats everything a peer sends as hostile, even from a peer that passed the checks in `peer`; the helper reads the
//! service's messages just as strictly.
//!
//! A connection's first frame says what it is:
//! - `{"type":"helper","session":"aqua"|"loginwindow"}` makes it a helper's link. The service then sends `screen`,
//!   `ask`, `cancel` and `close_apps` with an `id`, and the helper answers each with `{"type":"reply","id",...}`. The
//!   helper also sends a `tick` every second: its permissions, the person's last input and whether the screen is locked.
//! - Any request below makes it a request link: one answer for each request, in order.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};
use support_core::platform::{Desktop, Image, ScreenOutput};
use support_core::wire::{self, ScreenAction, IMAGE_B64_MAX};

/// The length of an Authorization Services external form.
pub const AUTH_LEN: usize = 32;
pub const LINK_MAX: usize = 2048;
pub const NAME_MAX: usize = 100;
pub const CODE_MAX: usize = 20;
pub const PERSON_MAX: usize = 200;
pub const ERROR_MAX: usize = 300;
/// The most processes one close asks the helper about.
pub const PIDS_MAX: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperSession {
    /// A signed-in person's session, as that person.
    Aqua,
    /// The login window, as root.
    LoginWindow,
}

impl HelperSession {
    pub fn as_str(self) -> &'static str {
        match self {
            HelperSession::Aqua => "aqua",
            HelperSession::LoginWindow => "loginwindow",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupRequest {
    pub auth: [u8; AUTH_LEN],
    pub link: String,
    pub code: Option<String>,
    pub name: String,
    pub access: String,
    pub control: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Status,
    /// Check in now (at most once every 30 s; the service decides).
    Refresh,
    /// The person at the Mac lets the team connect without asking. Never the other way: nothing here sets `ask`.
    AllowAnyTime,
    /// End the live session, from the menu bar or the corner window.
    EndSession,
    Setup(SetupRequest),
    Uninstall {
        auth: [u8; AUTH_LEN],
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opening {
    Helper(HelperSession),
    Request(Request),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Tick {
    /// Screen Recording is allowed.
    pub screen: bool,
    /// Accessibility is allowed (input).
    pub accessibility: bool,
    /// Milliseconds since the person last used the mouse or keyboard, -1 when the last input was the app's own.
    pub customer_ago_ms: i64,
    /// The screen is locked (or a screen saver asks for the password).
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FromHelper {
    Tick(Tick),
    Reply { id: u64, body: Map<String, Value> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToHelper {
    Screen {
        id: u64,
        action: Value,
    },
    Ask {
        id: u64,
        by: String,
        team: String,
        full: bool,
    },
    Cancel {
        id: u64,
    },
    /// Ask these apps to quit (NSRunningApplication terminate). The helper answers with the pids it asked.
    CloseApps {
        id: u64,
        pids: Vec<i32>,
    },
}

/// True when `m` has every key of `required` and no key outside `required` and `optional`.
fn exact(m: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|k| m.contains_key(*k)) && m.keys().all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
}

fn string(m: &Map<String, Value>, key: &str, max: usize) -> Option<String> {
    match m.get(key) {
        Some(Value::String(s)) if s.chars().count() <= max && !s.chars().any(|c| c.is_control()) => Some(s.clone()),
        _ => None,
    }
}

fn boolean(m: &Map<String, Value>, key: &str) -> Option<bool> {
    m.get(key).and_then(Value::as_bool)
}

/// A request or helper id: a whole number from 1 to 2^53.
fn id(m: &Map<String, Value>) -> Option<u64> {
    m.get("id").and_then(Value::as_u64).filter(|n| (1..=(1u64 << 53)).contains(n))
}

fn auth(m: &Map<String, Value>) -> Option<[u8; AUTH_LEN]> {
    let text = string(m, "auth", 64)?;
    let bytes = B64.decode(text).ok()?;
    bytes.try_into().ok()
}

pub fn auth_text(auth: &[u8; AUTH_LEN]) -> String {
    B64.encode(auth)
}

fn kind(m: &Map<String, Value>) -> &str {
    m.get("type").and_then(Value::as_str).unwrap_or("")
}

/// A request, as any connection's frame. None for anything else.
pub fn read_request(m: &Map<String, Value>) -> Option<Request> {
    let bare = || exact(m, &["type"], &[]);
    match kind(m) {
        "status" if bare() => Some(Request::Status),
        "refresh" if bare() => Some(Request::Refresh),
        "allow_any_time" if bare() => Some(Request::AllowAnyTime),
        "end_session" if bare() => Some(Request::EndSession),
        "uninstall" if exact(m, &["type", "auth"], &[]) => Some(Request::Uninstall { auth: auth(m)? }),
        "setup" if exact(m, &["type", "auth", "link", "name", "access", "control"], &["code"]) => {
            let access = string(m, "access", 3).filter(|a| a == "ask" || a == "any")?;
            let control = string(m, "control", 7).filter(|c| c == "full" || c == "limited")?;
            let code = match m.get("code") {
                None | Some(Value::Null) => None,
                Some(_) => Some(string(m, "code", CODE_MAX)?),
            };
            Some(Request::Setup(SetupRequest {
                auth: auth(m)?,
                link: string(m, "link", LINK_MAX)?,
                code,
                name: string(m, "name", NAME_MAX)?,
                access,
                control,
            }))
        }
        _ => None,
    }
}

/// The first frame of a connection.
pub fn read_opening(m: &Map<String, Value>) -> Option<Opening> {
    if kind(m) == "helper" {
        if !exact(m, &["type", "session"], &[]) {
            return None;
        }
        return match m.get("session").and_then(Value::as_str) {
            Some("aqua") => Some(Opening::Helper(HelperSession::Aqua)),
            Some("loginwindow") => Some(Opening::Helper(HelperSession::LoginWindow)),
            _ => None,
        };
    }
    read_request(m).map(Opening::Request)
}

/// A helper's frame on its link. A reply's body is checked by whoever asked (it knows what it asked for).
pub fn read_from_helper(m: &Map<String, Value>) -> Option<FromHelper> {
    match kind(m) {
        "tick" if exact(m, &["type", "screen", "accessibility", "customer_ago_ms", "locked"], &[]) => {
            let ago = m.get("customer_ago_ms").and_then(Value::as_i64).filter(|n| *n >= -1)?;
            Some(FromHelper::Tick(Tick {
                screen: boolean(m, "screen")?,
                accessibility: boolean(m, "accessibility")?,
                customer_ago_ms: ago,
                locked: boolean(m, "locked")?,
            }))
        }
        "reply" if exact(m, &["type", "id", "body"], &[]) => match m.get("body") {
            Some(Value::Object(body)) => Some(FromHelper::Reply { id: id(m)?, body: body.clone() }),
            _ => None,
        },
        _ => None,
    }
}

pub fn opening_helper(session: HelperSession) -> Map<String, Value> {
    obj(json!({ "type": "helper", "session": session.as_str() }))
}

pub fn tick_message(t: &Tick) -> Map<String, Value> {
    obj(json!({ "type": "tick", "screen": t.screen, "accessibility": t.accessibility, "customer_ago_ms": t.customer_ago_ms, "locked": t.locked }))
}

pub fn reply_message(id: u64, body: Map<String, Value>) -> Map<String, Value> {
    obj(json!({ "type": "reply", "id": id, "body": Value::Object(body) }))
}

pub fn request_message(r: &Request) -> Map<String, Value> {
    match r {
        Request::Status => obj(json!({ "type": "status" })),
        Request::Refresh => obj(json!({ "type": "refresh" })),
        Request::AllowAnyTime => obj(json!({ "type": "allow_any_time" })),
        Request::EndSession => obj(json!({ "type": "end_session" })),
        Request::Uninstall { auth } => obj(json!({ "type": "uninstall", "auth": auth_text(auth) })),
        Request::Setup(s) => {
            let mut m = obj(json!({
                "type": "setup", "auth": auth_text(&s.auth), "link": s.link, "name": s.name, "access": s.access, "control": s.control,
            }));
            if let Some(code) = &s.code {
                m.insert("code".into(), Value::String(code.clone()));
            }
            m
        }
    }
}

pub fn to_helper_message(t: &ToHelper) -> Map<String, Value> {
    match t {
        ToHelper::Screen { id, action } => obj(json!({ "type": "screen", "id": id, "action": action })),
        ToHelper::Ask { id, by, team, full } => obj(json!({ "type": "ask", "id": id, "by": by, "team": team, "full": full })),
        ToHelper::Cancel { id } => obj(json!({ "type": "cancel", "id": id })),
        ToHelper::CloseApps { id, pids } => obj(json!({ "type": "close_apps", "id": id, "pids": pids })),
    }
}

/// The service's message, as the helper reads it.
pub fn read_to_helper(m: &Map<String, Value>) -> Option<ToHelper> {
    match kind(m) {
        "screen" if exact(m, &["type", "id", "action"], &[]) => match m.get("action") {
            Some(a @ Value::Object(_)) => Some(ToHelper::Screen { id: id(m)?, action: a.clone() }),
            _ => None,
        },
        "ask" if exact(m, &["type", "id", "by", "team", "full"], &[]) => {
            Some(ToHelper::Ask { id: id(m)?, by: string(m, "by", PERSON_MAX)?, team: string(m, "team", PERSON_MAX)?, full: boolean(m, "full")? })
        }
        "cancel" if exact(m, &["type", "id"], &[]) => Some(ToHelper::Cancel { id: id(m)? }),
        "close_apps" if exact(m, &["type", "id", "pids"], &[]) => {
            let list = m.get("pids")?.as_array()?;
            if list.len() > PIDS_MAX {
                return None;
            }
            let pids = list.iter().map(|v| v.as_i64().filter(|p| *p > 1 && *p <= i32::MAX as i64).map(|p| p as i32)).collect::<Option<Vec<_>>>()?;
            Some(ToHelper::CloseApps { id: id(m)?, pids })
        }
        _ => None,
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

// ---- screen actions and their results ---------------------------------------------------------------------------

/// A parsed screen action as JSON again, for the helper to parse with the same reader. `ScreenAction::parse` of this
/// gives back the same action.
pub fn action_json(a: &ScreenAction) -> Value {
    let mut v = json!({
        "name": a.name, "display": a.display, "screenshot": a.screenshot, "x": a.x, "y": a.y, "x1": a.x1, "y1": a.y1,
        "x2": a.x2, "y2": a.y2, "button": a.button, "count": a.count, "direction": a.direction, "amount": a.amount,
        "text": a.text, "keys": a.keys, "seconds": a.seconds, "max_lines": a.max_lines, "ref": a.ref_id, "verb": a.verb,
        "on": a.on, "minutes": a.minutes,
    });
    if let Some(value) = &a.value {
        v["value"] = Value::String(value.clone());
    }
    v
}

/// The helper's answer to a screen action.
pub fn screen_reply(out: Result<ScreenOutput, String>) -> Map<String, Value> {
    match out {
        Err(e) => obj(json!({ "ok": false, "error": wire::clean(&e, ERROR_MAX) })),
        Ok(o) => {
            let mut m = obj(json!({ "ok": true, "display": o.display, "displays": o.displays, "desktop": o.desktop.as_str() }));
            if let Some(img) = o.image {
                m.insert("image_b64".into(), Value::String(B64.encode(&img.bytes)));
                m.insert("mime".into(), Value::String(img.mime.into()));
                m.insert("width".into(), json!(img.width));
                m.insert("height".into(), json!(img.height));
            }
            if let Some(text) = o.text {
                m.insert("text".into(), Value::String(wire::clean(&text, ERROR_MAX)));
            }
            m
        }
    }
}

/// The service's check of a helper's answer to a screen action. Every field is bounded: the image fits the relay's
/// limit and the screenshot size, the numbers are in range, the texts are short and clean. A malformed answer is an
/// error, never passed on.
pub fn read_screen_reply(m: &Map<String, Value>) -> Result<ScreenOutput, String> {
    const BAD: &str = "the screen helper sent a malformed answer";
    match m.get("ok") {
        Some(Value::Bool(false)) => {
            if !exact(m, &["ok", "error"], &[]) {
                return Err(BAD.into());
            }
            let e = m.get("error").and_then(Value::as_str).ok_or(BAD)?;
            return Err(wire::clean(e, ERROR_MAX));
        }
        Some(Value::Bool(true)) => {}
        _ => return Err(BAD.into()),
    }
    if !exact(m, &["ok", "display", "displays", "desktop"], &["image_b64", "mime", "width", "height", "text"]) {
        return Err(BAD.into());
    }
    let display = m.get("display").and_then(Value::as_i64).filter(|d| (0..16).contains(d)).ok_or(BAD)?;
    let displays = m.get("displays").and_then(Value::as_i64).filter(|d| (1..=16).contains(d)).ok_or(BAD)?;
    let desktop = match m.get("desktop").and_then(Value::as_str) {
        Some("default") => Desktop::Default,
        Some("secure") => Desktop::Secure,
        Some("unknown") => Desktop::Unknown,
        _ => return Err(BAD.into()),
    };
    let image_keys = ["image_b64", "mime", "width", "height"];
    let present = image_keys.iter().filter(|k| m.contains_key(**k)).count();
    let image = match present {
        0 => None,
        4 => {
            let text = m.get("image_b64").and_then(Value::as_str).filter(|t| !t.is_empty() && t.len() < IMAGE_B64_MAX).ok_or(BAD)?;
            let bytes = B64.decode(text).map_err(|_| BAD)?;
            let mime = match m.get("mime").and_then(Value::as_str) {
                Some("image/jpeg") => "image/jpeg",
                Some("image/png") => "image/png",
                _ => return Err(BAD.into()),
            };
            let width = m.get("width").and_then(Value::as_i64).filter(|w| (1..=support_core::geometry::MAX_W).contains(w)).ok_or(BAD)?;
            let height = m.get("height").and_then(Value::as_i64).filter(|h| (1..=support_core::geometry::MAX_H).contains(h)).ok_or(BAD)?;
            Some(Image { bytes, mime, width, height })
        }
        _ => return Err(BAD.into()),
    };
    let text = match m.get("text") {
        None => None,
        Some(Value::String(t)) if t.chars().count() <= ERROR_MAX => Some(wire::clean(t, ERROR_MAX)),
        Some(_) => return Err(BAD.into()),
    };
    Ok(ScreenOutput { image, display, displays, desktop, text })
}

/// The helper's answer to `ask`.
pub fn read_ask_reply(m: &Map<String, Value>) -> Option<bool> {
    if !exact(m, &["answer"], &[]) {
        return None;
    }
    m.get("answer").and_then(Value::as_bool)
}

/// The helper's answer to `close_apps`: the pids it asked to quit, each one of those it was given.
pub fn read_close_reply(m: &Map<String, Value>, given: &[i32]) -> Option<Vec<i32>> {
    if !exact(m, &["asked"], &[]) {
        return None;
    }
    let list = m.get("asked")?.as_array()?;
    let mut out = Vec::new();
    for v in list {
        let p = v.as_i64()? as i32;
        if !given.contains(&p) || out.contains(&p) {
            return None;
        }
        out.push(p);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(v: Value) -> Map<String, Value> {
        obj(v)
    }

    const AUTH: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    #[test]
    fn requests_are_read_only_with_their_exact_keys() {
        assert_eq!(read_request(&m(json!({"type":"status"}))), Some(Request::Status));
        assert_eq!(read_request(&m(json!({"type":"refresh"}))), Some(Request::Refresh));
        assert_eq!(read_request(&m(json!({"type":"allow_any_time"}))), Some(Request::AllowAnyTime));
        assert_eq!(read_request(&m(json!({"type":"end_session"}))), Some(Request::EndSession));
        // An extra key, a missing one, or a type that sets "ask": refused.
        assert_eq!(read_request(&m(json!({"type":"status","x":1}))), None);
        assert_eq!(read_request(&m(json!({"type":"set_ask"}))), None);
        assert_eq!(read_request(&m(json!({"type":"uninstall"}))), None);
        assert_eq!(read_request(&m(json!({"type":7}))), None);
        assert_eq!(read_request(&m(json!({}))), None);
        let u = read_request(&m(json!({"type":"uninstall","auth":AUTH}))).unwrap();
        let Request::Uninstall { auth } = u else { panic!() };
        assert_eq!(auth[..4], [0, 1, 2, 3]);
        // The external form is exactly 32 bytes.
        assert_eq!(read_request(&m(json!({"type":"uninstall","auth":"AAEC"}))), None);
        assert_eq!(read_request(&m(json!({"type":"uninstall","auth":"!!!"}))), None);
    }

    #[test]
    fn a_setup_request_is_bounded_and_chooses_nothing_for_the_person() {
        let good = json!({"type":"setup","auth":AUTH,"link":"https://r.example/install?code=ABCDE-FGH23","name":"Ariel's Mac","access":"ask","control":"limited"});
        let Some(Request::Setup(s)) = read_request(&m(good.clone())) else { panic!() };
        assert_eq!((s.name.as_str(), s.access.as_str(), s.control.as_str(), s.code.clone()), ("Ariel's Mac", "ask", "limited", None));
        // The message survives a round trip.
        assert_eq!(read_request(&request_message(&Request::Setup(s.clone()))), Some(Request::Setup(s)));
        let with = |k: &str, v: Value| {
            let mut x = good.clone();
            x[k] = v;
            read_request(&m(x))
        };
        assert!(with("code", json!("ABCDEFGH23")).is_some());
        assert!(with("access", json!("always")).is_none());
        assert!(with("control", json!("root")).is_none());
        assert!(with("name", json!("x".repeat(101))).is_none());
        assert!(with("name", json!("a\nb")).is_none());
        assert!(with("link", json!("x".repeat(LINK_MAX + 1))).is_none());
        assert!(with("code", json!(12)).is_none());
        assert!(with("extra", json!(1)).is_none());
        let mut missing = good.clone();
        missing.as_object_mut().unwrap().remove("control");
        assert!(read_request(&m(missing)).is_none());
    }

    #[test]
    fn the_opening_frame_says_helper_or_is_a_request() {
        assert_eq!(read_opening(&m(json!({"type":"helper","session":"aqua"}))), Some(Opening::Helper(HelperSession::Aqua)));
        assert_eq!(read_opening(&opening_helper(HelperSession::LoginWindow)), Some(Opening::Helper(HelperSession::LoginWindow)));
        assert_eq!(read_opening(&m(json!({"type":"helper","session":"root"}))), None);
        assert_eq!(read_opening(&m(json!({"type":"helper","session":"aqua","uid":0}))), None);
        assert_eq!(read_opening(&m(json!({"type":"status"}))), Some(Opening::Request(Request::Status)));
        assert_eq!(read_opening(&m(json!({"type":"reply","id":1,"body":{}}))), None);
    }

    #[test]
    fn helper_frames_are_ticks_or_replies() {
        let t = Tick { screen: true, accessibility: false, customer_ago_ms: 1200, locked: false };
        assert_eq!(read_from_helper(&tick_message(&t)), Some(FromHelper::Tick(t)));
        assert_eq!(read_from_helper(&m(json!({"type":"tick","screen":true,"accessibility":true,"customer_ago_ms":-2,"locked":false}))), None);
        assert_eq!(read_from_helper(&m(json!({"type":"tick","screen":1,"accessibility":true,"customer_ago_ms":0,"locked":false}))), None);
        let r = read_from_helper(&reply_message(9, m(json!({"answer":true})))).unwrap();
        assert_eq!(r, FromHelper::Reply { id: 9, body: m(json!({"answer":true})) });
        assert_eq!(read_from_helper(&m(json!({"type":"reply","id":0,"body":{}}))), None);
        assert_eq!(read_from_helper(&m(json!({"type":"reply","id":-1,"body":{}}))), None);
        assert_eq!(read_from_helper(&m(json!({"type":"reply","id":1,"body":[]}))), None);
        assert_eq!(read_from_helper(&m(json!({"type":"status"}))), None, "a helper link carries no requests");
    }

    #[test]
    fn the_services_messages_round_trip_and_are_read_strictly_by_the_helper() {
        let all = [
            ToHelper::Screen { id: 1, action: json!({"name":"screenshot"}) },
            ToHelper::Ask { id: 2, by: "Dana".into(), team: "Team".into(), full: true },
            ToHelper::Cancel { id: 3 },
            ToHelper::CloseApps { id: 4, pids: vec![400, 401] },
        ];
        for t in all {
            assert_eq!(read_to_helper(&to_helper_message(&t)), Some(t));
        }
        assert_eq!(read_to_helper(&m(json!({"type":"close_apps","id":4,"pids":[1]}))), None, "never launchd");
        assert_eq!(read_to_helper(&m(json!({"type":"ask","id":2,"by":"x".repeat(201),"team":"","full":false}))), None);
        assert_eq!(read_to_helper(&m(json!({"type":"screen","id":1,"action":"screenshot"}))), None);
    }

    #[test]
    fn an_action_survives_the_trip_to_the_helper() {
        let raw = json!({"name":"click","x":10,"y":20,"button":"right","count":2,"screenshot":false,"value":"v","seconds":2.5});
        let a = ScreenAction::parse(&raw);
        assert_eq!(ScreenAction::parse(&action_json(&a)), a);
        let defaults = ScreenAction::parse(&json!({"name":"screenshot"}));
        assert_eq!(ScreenAction::parse(&action_json(&defaults)), defaults);
    }

    #[test]
    fn a_screen_reply_round_trips_and_a_bad_one_is_refused() {
        let out = ScreenOutput {
            image: Some(Image { bytes: vec![0xff, 0xd8, 0xff, 1, 2], mime: "image/jpeg", width: 1280, height: 800 }),
            display: 0,
            displays: 2,
            desktop: Desktop::Secure,
            text: Some("note".into()),
        };
        let back = read_screen_reply(&screen_reply(Ok(out))).unwrap();
        assert_eq!(
            (back.image.as_ref().unwrap().bytes.len(), back.displays, back.desktop, back.text.as_deref()),
            (5, 2, Desktop::Secure, Some("note"))
        );
        assert_eq!(
            read_screen_reply(&screen_reply(Err("customer is using the PC; try again in a few seconds".into()))).unwrap_err(),
            "customer is using the PC; try again in a few seconds"
        );
        let good = screen_reply(Ok(ScreenOutput { image: None, display: 0, displays: 1, desktop: Desktop::Default, text: None }));
        assert!(read_screen_reply(&good).is_ok());
        let with = |k: &str, v: Value| {
            let mut x = good.clone();
            x.insert(k.into(), v);
            read_screen_reply(&x)
        };
        assert!(with("display", json!(16)).is_err());
        assert!(with("displays", json!(0)).is_err());
        assert!(with("desktop", json!("other")).is_err());
        assert!(with("extra", json!(1)).is_err());
        assert!(with("image_b64", json!("AAAA")).is_err(), "an image needs all four fields");
        let mut img = screen_reply(Ok(ScreenOutput {
            image: Some(Image { bytes: vec![1], mime: "image/png", width: 1, height: 1 }),
            display: 0,
            displays: 1,
            desktop: Desktop::Default,
            text: None,
        }));
        assert!(read_screen_reply(&img).is_ok());
        img.insert("width".into(), json!(1281));
        assert!(read_screen_reply(&img).is_err());
        img.insert("width".into(), json!(1));
        img.insert("mime".into(), json!("text/html"));
        assert!(read_screen_reply(&img).is_err());
        img.insert("mime".into(), json!("image/png"));
        img.insert("image_b64".into(), json!("A".repeat(IMAGE_B64_MAX)));
        assert!(read_screen_reply(&img).is_err());
        assert!(read_screen_reply(&m(json!({"ok":"yes"}))).is_err());
        assert!(read_screen_reply(&m(json!({"ok":false,"error":"x","image_b64":"AA"}))).is_err());
        assert_eq!(read_screen_reply(&m(json!({"ok":false,"error":"bad\u{7}text"}))).unwrap_err(), "badtext");
    }

    #[test]
    fn ask_and_close_replies_are_strict() {
        assert_eq!(read_ask_reply(&m(json!({"answer":true}))), Some(true));
        assert_eq!(read_ask_reply(&m(json!({"answer":"yes"}))), None);
        assert_eq!(read_ask_reply(&m(json!({"answer":true,"x":1}))), None);
        assert_eq!(read_close_reply(&m(json!({"asked":[5,6]})), &[5, 6, 7]), Some(vec![5, 6]));
        assert_eq!(read_close_reply(&m(json!({"asked":[8]})), &[5]), None, "a pid it was not given");
        assert_eq!(read_close_reply(&m(json!({"asked":[5,5]})), &[5]), None);
    }
}

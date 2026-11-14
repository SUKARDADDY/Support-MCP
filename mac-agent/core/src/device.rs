//! The saved Mac's side of the relay: pair, check in, the schedule, the doorbell, and the service loop that turns a
//! session pointer into a question and a session (docs/relay-v1-spec.md, "The PC wire", "The doorbell", "The check-in
//! schedule"). `DeviceService` of src/agent-app.cs is the model, and the numbers are its.

use crate::clock::Clock;
use crate::platform::Platform;
use crate::release;
use crate::rules::{RulesState, View};
use crate::session::{self, Auth, Client, HttpTransport, NoEvents, SessionConfig, Start};
use crate::stop::Stop;
use crate::wire::{self, clean, Frame, PROTOCOL};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::{sleep, Instant};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

// ---- numbers ---------------------------------------------------------------------------------------------------------

pub const CHECK_EVERY_MS: i64 = 300_000;
pub const JITTER_MAX_MS: i64 = 30_000;
pub const RETRY_MIN_MS: i64 = 60_000;
pub const RETRY_MAX_MS: i64 = 900_000;
/// A 426 (the relay speaks another protocol) is tried again every 6 hours.
pub const UPDATE_EVERY_MS: i64 = 6 * 3_600_000;
/// While the doorbell is up: every 6 hours, plus up to 10 minutes so a staged update does not reach every Mac at once.
pub const DOORBELL_EVERY_MS: i64 = 6 * 3_600_000;
pub const DOORBELL_JITTER_MAX_MS: i64 = 600_000;
/// A refresh forces a check-in at most this often.
pub const REFRESH_MIN_MS: i64 = 30_000;
pub const HISTORY_CAP: usize = 50;
/// A /device answer is read up to this many bytes, and a request takes at most this long.
pub const DEVICE_TIMEOUT: Duration = Duration::from_secs(30);

// ---- the link --------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceResult {
    Ok,
    Pending,
    CodeInvalid,
    Removed,
    UpdateNeeded,
    Offline,
    Refused,
}

/// What a /device call came to. `status` is the HTTP status, 0 when the request never got an answer.
#[derive(Debug, Clone)]
pub struct Answer {
    pub result: DeviceResult,
    pub status: u16,
    pub body: Option<Value>,
    pub message: String,
}

impl Answer {
    /// A 2xx answer, whether the Mac is active (Ok) or waiting for approval (Pending).
    pub fn is_ok(&self) -> bool {
        matches!(self.result, DeviceResult::Ok | DeviceResult::Pending)
    }
}

/// The pinned mapping of a status and body to an outcome. A 2xx with no readable body is unexpected, so it counts as
/// offline and the caller retries.
pub fn map_answer(status: u16, body: Option<Value>) -> Answer {
    let (mut code, mut message) = (String::new(), String::new());
    if let Some(err) = body.as_ref().and_then(|b| b.get("error")).filter(|e| e.is_object()) {
        code = wire::text(err, "code");
        message = wire::text(err, "message");
    }
    let offline = || Answer { result: DeviceResult::Offline, status: 0, body: None, message: String::new() };
    let with = |result, body| Answer { result, status, body, message: message.clone() };
    match status {
        200 | 201 => {
            if body.is_some() {
                with(DeviceResult::Ok, body)
            } else {
                offline()
            }
        }
        202 => {
            if body.is_some() {
                with(DeviceResult::Pending, body)
            } else {
                offline()
            }
        }
        401 => with(DeviceResult::Removed, body),
        426 => with(DeviceResult::UpdateNeeded, body),
        404 if code == "code_invalid" => with(DeviceResult::CodeInvalid, body),
        _ => with(DeviceResult::Refused, body),
    }
}

/// POSTs to /device/*. TLS 1.2 or later on the system's roots, no redirects, no Origin header, a 30 s limit.
pub struct DeviceLink {
    client: reqwest::Client,
    origin: String,
}

impl DeviceLink {
    pub fn new(origin: &str) -> Result<DeviceLink, String> {
        let origin = wire::check_origin(origin)?;
        crate::tls::init();
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
        Ok(DeviceLink { client, origin })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub async fn pair(&self, body: Value) -> Answer {
        self.send("/device/pair", body, None).await
    }

    pub async fn hello(&self, key: &str, body: Value) -> Answer {
        self.send("/device/hello", body, Some(key)).await
    }

    pub async fn update(&self, key: &str, body: Value) -> Answer {
        self.send("/device/update", body, Some(key)).await
    }

    pub async fn leave(&self, key: &str) -> Answer {
        self.send("/device/leave", json!({}), Some(key)).await
    }

    async fn send(&self, path: &str, mut body: Value, key: Option<&str>) -> Answer {
        let offline = Answer { result: DeviceResult::Offline, status: 0, body: None, message: String::new() };
        if let Some(map) = body.as_object_mut() {
            map.insert("protocol".into(), json!(PROTOCOL));
        }
        let Ok(bytes) = serde_json::to_vec(&body) else { return offline };
        let mut req =
            self.client.post(format!("{}{path}", self.origin)).header("content-type", "application/json").timeout(DEVICE_TIMEOUT).body(bytes);
        if let Some(key) = key {
            req = req.header("authorization", format!("Bearer {key}"));
        }
        let Ok(mut response) = req.send().await else { return offline };
        let status = response.status().as_u16();
        let mut data = Vec::new();
        // Read up to the cap and stop. What was read may still parse (a small answer), or it does not and there is no body.
        while let Ok(Some(chunk)) = response.chunk().await {
            if data.len() + chunk.len() > wire::DEVICE_RESPONSE_MAX {
                break;
            }
            data.extend_from_slice(&chunk);
        }
        map_answer(status, serde_json::from_slice(&data).ok())
    }
}

/// `macOS <ProductVersion> (<BuildVersion>)`, cut to 100 characters: the one text that tells the relay this is a Mac.
pub fn os_string(product_version: &str, build_version: &str) -> String {
    format!("macOS {product_version} ({build_version})").chars().take(100).collect()
}

/// What pairing gives back.
#[derive(Debug, Clone)]
pub struct Paired {
    pub key: String,
    pub device_id: String,
    pub workspace: String,
    /// "active" (a technician's code) or "pending" (the owner's own request, which a technician approves).
    pub status: String,
    /// The six digits an owner reads to a technician. Only for a pending Mac.
    pub confirm: Option<String>,
}

/// What a Mac says about itself when it pairs or checks in.
#[derive(Debug, Clone)]
pub struct Identity {
    pub os: String,
    pub machine: String,
    pub app_version: String,
}

fn pair_fields(name: &str, access: &str, control: &str, id: &Identity) -> Value {
    json!({ "name": name, "access": access, "control": control, "os": id.os, "machine": id.machine, "app_version": id.app_version })
}

/// Pairs with a technician's code. `access` is "ask" or "any", `control` "full" or "limited".
pub async fn pair_with_code(link: &DeviceLink, code: &str, name: &str, access: &str, control: &str, id: &Identity) -> Result<Paired, Answer> {
    let mut body = pair_fields(name, access, control, id);
    body["code"] = json!(code);
    paired(link.pair(body).await)
}

/// Asks to join a team the owner named (a slug): the answer is pending until a technician approves it.
pub async fn pair_with_workspace(
    link: &DeviceLink,
    workspace: &str,
    name: &str,
    access: &str,
    control: &str,
    id: &Identity,
) -> Result<Paired, Answer> {
    let mut body = pair_fields(name, access, control, id);
    body["workspace"] = json!(workspace);
    paired(link.pair(body).await)
}

fn paired(answer: Answer) -> Result<Paired, Answer> {
    if !answer.is_ok() {
        return Err(answer);
    }
    let b = answer.body.clone().unwrap_or(Value::Null);
    let key = wire::text(&b, "key");
    if key.is_empty() {
        return Err(Answer { result: DeviceResult::Offline, status: 0, body: None, message: String::new() });
    }
    let confirm = Some(wire::text(&b, "confirm")).filter(|c| !c.is_empty());
    Ok(Paired { key, device_id: wire::text(&b, "device_id"), workspace: wire::text(&b, "workspace"), status: wire::text(&b, "status"), confirm })
}

// ---- the schedule ------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Schedule {
    Normal,
    Backoff,
    Update,
    Stopped,
}

/// The state shown for a Mac, and what to do next, from the status before the call and the wire result. `status` is
/// the last server-known status ("active" or "pending"), not the display state, so a 401 is read correctly.
pub fn classify(status: &str, result: DeviceResult, body_status: &str) -> (&'static str, Schedule) {
    match result {
        DeviceResult::Ok => (if body_status == "pending" { "pending" } else { "active" }, Schedule::Normal),
        DeviceResult::Removed => (if status == "pending" { "expired" } else { "removed" }, Schedule::Stopped),
        DeviceResult::UpdateNeeded => ("update_needed", Schedule::Update),
        // Offline, or an unexpected refusal: keep trying.
        _ => ("offline", Schedule::Backoff),
    }
}

/// The next check-in delay after a network error: one minute, doubling each time, capped at fifteen.
pub fn next_backoff(current: i64) -> i64 {
    if current <= 0 {
        RETRY_MIN_MS
    } else {
        (current * 2).min(RETRY_MAX_MS)
    }
}

/// Five minutes from the last answer, with up to thirty seconds of jitter on top. `jitter(max)` returns 0 to max.
pub fn next_check_delay(jitter: &mut dyn FnMut(i64) -> i64) -> i64 {
    CHECK_EVERY_MS + jitter(JITTER_MAX_MS)
}

/// The time to the next check-in. Backoff and a 426 keep their own. Otherwise six hours plus jitter while the doorbell is
/// connected and the Mac is active, and five minutes plus jitter while it is not, or the Mac is pending (the six digits
/// ring a pending Mac anyway).
pub fn next_delay(schedule: Schedule, doorbell: bool, status: &str, backoff: i64, jitter: &mut dyn FnMut(i64) -> i64) -> i64 {
    match schedule {
        Schedule::Backoff => backoff,
        Schedule::Update => UPDATE_EVERY_MS,
        _ if doorbell && status == "active" => DOORBELL_EVERY_MS + jitter(DOORBELL_JITTER_MAX_MS),
        _ => next_check_delay(jitter),
    }
}

/// A refresh forces a check-in at most once every thirty seconds.
pub fn refresh_due(last_refresh_ms: i64, now_ms: i64) -> bool {
    now_ms - last_refresh_ms >= REFRESH_MIN_MS
}

/// The history lines a 200 adds: approval, and any change the team made to the access or control mode.
pub fn history_for(old_status: &str, old_access: &str, old_control: &str, new_status: &str, new_access: &str, new_control: &str) -> Vec<String> {
    let mut lines = Vec::new();
    if old_status == "pending" && new_status == "active" {
        lines.push("Your support team approved this PC.".to_string());
    }
    if old_access != new_access {
        lines.push(if new_access == "any" { "Access set to connect any time." } else { "Access set to ask each time." }.to_string());
    }
    if old_control != new_control {
        lines.push(if new_control == "full" { "Control set to full control." } else { "Control set to limited support." }.to_string());
    }
    lines
}

/// The last `HISTORY_CAP` lines are kept, newest last.
pub fn trim_history(list: &mut Vec<String>) {
    if list.len() > HISTORY_CAP {
        list.drain(..list.len() - HISTORY_CAP);
    }
}

/// Control comes from this Mac's own setup. A check-in may lower full control to limited, never raise it.
pub fn next_control<'a>(own: &str, offered: &str) -> &'a str {
    if own == "full" && offered != "limited" {
        "full"
    } else {
        "limited"
    }
}

/// A hello answer's `session`: the one live session the Mac should pick up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPointer {
    pub id: String,
    pub by: String,
    pub team: String,
    pub ask: bool,
    /// The session's hard end, Unix ms on the relay's clock.
    pub expires_at: i64,
}

/// The pointer, or None when there is none or it is malformed. An `ask` that is not exactly false counts as true.
pub fn read_session(body: &Value) -> Option<SessionPointer> {
    let m = body.get("session")?;
    let id = m.get("id")?.as_str().filter(|s| wire::is_session_id(s))?.to_string();
    Some(SessionPointer {
        id,
        by: clean(&wire::text(m, "by"), 200),
        team: clean(&wire::text(m, "team"), 200),
        ask: m.get("ask") != Some(&Value::Bool(false)),
        expires_at: m.get("expires_at").and_then(Value::as_f64).map_or(0, |n| n as i64),
    })
}

// ---- the doorbell ------------------------------------------------------------------------------------------------------

pub const RING_PATH: &str = "/device/ring?protocol=1";
/// The relay closes the socket on a frame over 1 KB, and a ring is a few bytes, so a bigger frame is not from the relay.
pub const FRAME_MAX: usize = 1024;

#[derive(Clone, Debug)]
pub struct DoorbellConfig {
    pub ping: Duration,
    /// Dead after this long with nothing heard, not even a pong.
    pub pong: Duration,
    pub ring_gap: Duration,
    pub connect: Duration,
    pub min_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for DoorbellConfig {
    fn default() -> Self {
        DoorbellConfig {
            ping: Duration::from_secs(30),
            pong: Duration::from_secs(60),
            ring_gap: Duration::from_secs(2),
            connect: Duration::from_secs(30),
            min_backoff: Duration::from_secs(5),
            max_backoff: Duration::from_secs(300),
        }
    }
}

/// The wait before the next connection attempt: `min`, doubling, at most `max`.
pub fn doorbell_backoff(current: Duration, min: Duration, max: Duration) -> Duration {
    if current.is_zero() {
        min
    } else {
        (current * 2).min(max)
    }
}

/// At most one wake every `gap`. A ring that comes sooner is not lost: it waits for the end of the gap.
pub struct RingGate {
    gap_ms: i64,
    last_wake_ms: i64,
    queued: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Ring {
    /// Wake the check-in now.
    Now,
    /// A wake is already waiting for the end of the gap.
    Queued,
    /// Wake in this many milliseconds.
    Later(i64),
}

impl RingGate {
    pub fn new(gap_ms: i64) -> RingGate {
        RingGate { gap_ms, last_wake_ms: i64::MIN / 2, queued: false }
    }

    pub fn offer(&mut self, now_ms: i64) -> Ring {
        if now_ms - self.last_wake_ms >= self.gap_ms {
            self.last_wake_ms = now_ms;
            Ring::Now
        } else if !self.queued {
            self.queued = true;
            Ring::Later((self.last_wake_ms + self.gap_ms - now_ms).max(1))
        } else {
            Ring::Queued
        }
    }

    /// The queued wake is due. True when it is still wanted.
    pub fn due(&mut self, now_ms: i64) -> bool {
        if !self.queued {
            return false;
        }
        self.queued = false;
        self.last_wake_ms = now_ms;
        true
    }
}

/// One quiet WebSocket to `GET <origin>/device/ring?protocol=1` with the device key as a Bearer header. The relay sends
/// text frames only to ring: any text frame wakes the check-in (at most once per `ring_gap`) and its content is never
/// read. A frame over 1,024 bytes, a binary or fragmented frame closes the connection. A protocol ping goes out every
/// `ping`, and nothing heard for `pong` means the connection is dead. Reconnects wait 5 s, doubling to 5 minutes; a ring
/// resets that. Each (re)connect wakes the check-in too.
pub struct Doorbell {
    connected: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
    stop: Arc<Stop>,
    task: tokio::task::JoinHandle<()>,
}

impl Doorbell {
    pub fn start(origin: &str, key: &str, wake: Arc<Notify>, cfg: DoorbellConfig) -> Result<Doorbell, String> {
        let origin = wire::check_origin(origin)?;
        let url = format!("{}{RING_PATH}", origin.replacen("http", "ws", 1));
        let connected = Arc::new(AtomicBool::new(false));
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Stop::new();
        let task = tokio::spawn(doorbell_loop(url, key.to_string(), wake, cfg, connected.clone(), connections.clone(), stop.clone()));
        Ok(Doorbell { connected, connections, stop, task })
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Successful handshakes so far.
    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    pub async fn stop(self) {
        self.stop.set();
        let _ = self.task.await;
    }
}

async fn doorbell_loop(
    url: String,
    key: String,
    wake: Arc<Notify>,
    cfg: DoorbellConfig,
    connected: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
    stop: Arc<Stop>,
) {
    let mut backoff = Duration::ZERO;
    let started = Instant::now();
    let mut gate = RingGate::new(cfg.ring_gap.as_millis() as i64);
    while !stop.is_set() {
        let mut rang = false;
        doorbell_session(&url, &key, &wake, &cfg, &connected, &connections, &stop, &mut gate, started, &mut rang).await;
        connected.store(false, Ordering::SeqCst);
        if rang {
            backoff = Duration::ZERO;
        }
        backoff = doorbell_backoff(backoff, cfg.min_backoff, cfg.max_backoff);
        tokio::select! {
            _ = sleep(backoff) => {}
            _ = stop.stopped() => break,
        }
    }
    connected.store(false, Ordering::SeqCst);
}

fn now_ms(started: Instant) -> i64 {
    started.elapsed().as_millis() as i64
}

#[allow(clippy::too_many_arguments)]
async fn doorbell_session(
    url: &str,
    key: &str,
    wake: &Notify,
    cfg: &DoorbellConfig,
    connected: &AtomicBool,
    connections: &AtomicUsize,
    stop: &Stop,
    gate: &mut RingGate,
    started: Instant,
    rang: &mut bool,
) {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let Ok(mut request) = url.into_client_request() else { return };
    let Ok(auth) = format!("Bearer {key}").parse() else { return };
    request.headers_mut().insert("authorization", auth);
    let connector = if url.starts_with("wss://") {
        match crate::tls::client_config() {
            Ok(c) => Some(tokio_tungstenite::Connector::Rustls(c)),
            Err(_) => return,
        }
    } else {
        Some(tokio_tungstenite::Connector::Plain)
    };
    let ws_config = WebSocketConfig::default().max_frame_size(Some(FRAME_MAX)).max_message_size(Some(FRAME_MAX));
    let connect = tokio_tungstenite::connect_async_tls_with_config(request, Some(ws_config), true, connector);
    let mut ws = tokio::select! {
        r = tokio::time::timeout(cfg.connect, connect) => match r {
            Ok(Ok((ws, _response))) => ws,
            _ => return,
        },
        _ = stop.stopped() => return,
    };
    connected.store(true, Ordering::SeqCst);
    connections.fetch_add(1, Ordering::SeqCst);
    let mut last_heard = Instant::now();
    let mut last_ping = Instant::now();
    // Each (re)connect wakes the check-in too.
    let mut deferred: Option<Instant> = None;
    ring(gate, started, wake, &mut deferred);
    let tick = (cfg.ping / 4).clamp(Duration::from_millis(10), Duration::from_secs(1));
    let mut ticker = tokio::time::interval(tick);
    loop {
        let deferred_at = deferred;
        tokio::select! {
            _ = stop.stopped() => break,
            _ = async { match deferred_at { Some(t) => tokio::time::sleep_until(t).await, None => std::future::pending().await } } => {
                deferred = None;
                if gate.due(now_ms(started)) {
                    wake.notify_one();
                }
            }
            _ = ticker.tick() => {
                if last_heard.elapsed() >= cfg.pong {
                    // Nothing, not even a pong: dead.
                    break;
                }
                if last_ping.elapsed() >= cfg.ping {
                    last_ping = Instant::now();
                    if ws.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
            msg = ws.next() => match msg {
                // An error covers a frame over the cap, a bad frame and a dropped connection.
                None | Some(Err(_)) => break,
                Some(Ok(m)) => {
                    last_heard = Instant::now();
                    match m {
                        // A ring: its text is never read.
                        Message::Text(_) => {
                            *rang = true;
                            ring(gate, started, wake, &mut deferred);
                        }
                        Message::Ping(_) | Message::Pong(_) => {}
                        // Close, binary and anything else end the connection.
                        _ => break,
                    }
                }
            },
        }
    }
    let _ = ws.close(None).await;
}

fn ring(gate: &mut RingGate, started: Instant, wake: &Notify, deferred: &mut Option<Instant>) {
    match gate.offer(now_ms(started)) {
        Ring::Now => wake.notify_one(),
        Ring::Later(ms) => *deferred = Some(Instant::now() + Duration::from_millis(ms as u64)),
        Ring::Queued => {}
    }
}

// ---- the service loop ----------------------------------------------------------------------------------------------------

/// What the service tells its owner. The Mac app (PR 3) saves device.json, shows the menu bar and installs updates here.
pub trait Hooks: Send + Sync {
    /// The rules changed, so device.json needs a write. Gets `{rules, rules_tag}`.
    fn rules_changed(&self, _saved: &Value) {}
    /// The person at the Mac allowed this session, so a restarted service rejoins it without asking again.
    fn session_accepted(&self, _id: &str) {}
    /// A line for the menu bar's history.
    fn history(&self, _line: &str) {}
    /// The display state changed (active, pending, offline, removed, expired, update_needed).
    fn state(&self, _state: &str) {}
    /// A verified update is on offer (`release::check_update` passed). Installing it is the app's job.
    fn update_offered(&self, _note: &release::MacNote) {}
    /// A session started or ended.
    fn session(&self, _by: Option<&str>) {}
}

pub struct NoHooks;
impl Hooks for NoHooks {}

#[derive(Clone)]
pub struct DeviceConfig {
    pub origin: String,
    pub key: String,
    pub identity: Identity,
    /// What this Mac was set up with. `control` is its own and is never raised by a check-in.
    pub access: String,
    pub control: String,
    /// The session the person at the Mac already allowed, if a previous run saved one.
    pub accepted_session: Option<String>,
    pub doorbell: DoorbellConfig,
}

/// The unsaved state a service keeps between check-ins.
struct Shared {
    status: String,
    state: String,
    access: String,
    control: String,
    last_refresh_ms: i64,
    accepted: String,
    failed_updates: Vec<String>,
    session: Option<RunningSession>,
}

struct RunningSession {
    id: String,
    stop: Arc<Stop>,
    done: tokio::task::JoinHandle<()>,
}

/// The service: it checks in on schedule, listens on the doorbell, and runs the session the relay points it to.
pub struct DeviceService {
    cfg: DeviceConfig,
    link: DeviceLink,
    platform: Arc<dyn Platform>,
    hooks: Arc<dyn Hooks>,
    rules: Arc<RulesState>,
    clock: Arc<dyn Clock>,
    shared: Mutex<Shared>,
    last: Mutex<Schedule>,
    bell: Mutex<Option<Doorbell>>,
    /// Wakes the loop: a ring, a refresh, or a frame that needs fresh rules.
    wake: Arc<Notify>,
    /// Set by a command that needs a check-in outside the refresh limit.
    catch_up: Arc<Notify>,
    stop: Arc<Stop>,
}

impl DeviceService {
    pub fn new(
        cfg: DeviceConfig,
        platform: Arc<dyn Platform>,
        hooks: Arc<dyn Hooks>,
        clock: Arc<dyn Clock>,
        saved_rules: Option<&Value>,
    ) -> Result<Arc<DeviceService>, String> {
        let rules = Arc::new(RulesState::new(clock.clone()));
        if let Some(saved) = saved_rules {
            rules.load(saved);
        }
        let shared = Shared {
            status: "active".into(),
            state: "active".into(),
            access: cfg.access.clone(),
            control: cfg.control.clone(),
            last_refresh_ms: i64::MIN / 2,
            accepted: cfg.accepted_session.clone().unwrap_or_default(),
            failed_updates: vec![],
            session: None,
        };
        Ok(Arc::new(DeviceService {
            link: DeviceLink::new(&cfg.origin)?,
            cfg,
            platform,
            hooks,
            rules,
            clock,
            shared: Mutex::new(shared),
            last: Mutex::new(Schedule::Normal),
            bell: Mutex::new(None),
            wake: Arc::new(Notify::new()),
            catch_up: Arc::new(Notify::new()),
            stop: Stop::new(),
        }))
    }

    pub fn rules(&self) -> &Arc<RulesState> {
        &self.rules
    }

    pub fn state(&self) -> String {
        self.shared.lock().unwrap().state.clone()
    }

    /// Whether the doorbell is connected now (the service then checks in every 6 hours instead of every 5 minutes).
    pub fn doorbell_connected(&self) -> bool {
        self.bell.lock().unwrap().as_ref().is_some_and(Doorbell::connected)
    }

    /// Asks for a check-in now, at most once every 30 s.
    pub fn refresh(&self) {
        let now = self.clock.mono_ms();
        let mut s = self.shared.lock().unwrap();
        if refresh_due(s.last_refresh_ms, now) {
            s.last_refresh_ms = now;
            self.wake.notify_one();
        }
    }

    pub fn stop(&self) {
        self.stop.set();
        self.wake.notify_one();
    }

    pub fn stop_signal(&self) -> Arc<Stop> {
        self.stop.clone()
    }

    fn jitter(max: i64) -> i64 {
        use rand::Rng;
        rand::rng().random_range(0..=max)
    }

    fn body(&self) -> Value {
        let id = &self.cfg.identity;
        json!({ "os": id.os, "machine": id.machine, "app_version": id.app_version })
    }

    /// One check-in. Returns the schedule to follow.
    async fn check_in(self: &Arc<Self>, backoff: &mut i64) -> Schedule {
        let answer = self.link.hello(&self.cfg.key, self.body()).await;
        let (old_status, old_access, old_control) = {
            let s = self.shared.lock().unwrap();
            (s.status.clone(), s.access.clone(), s.control.clone())
        };
        let body_status = answer.body.as_ref().and_then(|b| b.get("device")).map(|d| wire::text(d, "status")).unwrap_or_default();
        let (state, schedule) = classify(&old_status, answer.result, &body_status);
        self.set_state(state);
        match schedule {
            Schedule::Normal => *backoff = 0,
            Schedule::Backoff => *backoff = next_backoff(*backoff),
            _ => {}
        }
        if answer.result != DeviceResult::Ok {
            return schedule;
        }
        let body = answer.body.unwrap_or(Value::Null);
        let device = body.get("device").cloned().unwrap_or(Value::Null);
        let new_status = if body_status == "pending" { "pending" } else { "active" };
        let new_access = Some(wire::text(&device, "access")).filter(|a| a == "ask" || a == "any").unwrap_or(old_access.clone());
        let new_control = next_control(&self.cfg.control, &wire::text(&device, "control")).to_string();
        for line in history_for(&old_status, &old_access, &old_control, new_status, &new_access, &new_control) {
            self.hooks.history(&line);
        }
        {
            let mut s = self.shared.lock().unwrap();
            s.status = new_status.to_string();
            s.access = new_access;
            s.control = new_control;
        }
        if new_status == "active" {
            let (_ok, persist) = self.rules.apply(&body);
            if persist {
                if let Some(saved) = self.rules.save() {
                    self.hooks.rules_changed(&saved);
                }
            }
            self.consider_update(&body);
            self.consider_session(read_session(&body)).await;
        }
        schedule
    }

    fn set_state(&self, state: &str) {
        let changed = {
            let mut s = self.shared.lock().unwrap();
            let changed = s.state != state;
            s.state = state.to_string();
            changed
        };
        if changed {
            self.hooks.state(state);
        }
    }

    /// An offered update is checked against the project's key before anyone is told of it.
    fn consider_update(&self, body: &Value) {
        let Some(update) = body.get("update") else { return };
        let Ok(key) = release::release_key() else { return };
        let failed = self.shared.lock().unwrap().failed_updates.clone();
        if let Ok(note) = release::check_update(update, &self.cfg.identity.app_version, &failed, &key) {
            self.hooks.update_offered(&note);
        }
    }

    /// A session pointer starts a session, unless one for that id is already running. A pointer that went away ends the
    /// session the Mac was running for it (the relay has already ended it, and the next request would say 410).
    async fn consider_session(self: &Arc<Self>, pointer: Option<SessionPointer>) {
        let mut finished = None;
        {
            let mut s = self.shared.lock().unwrap();
            if let Some(r) = &s.session {
                if r.done.is_finished() {
                    finished = s.session.take();
                }
            }
        }
        if let Some(f) = finished {
            let _ = f.done.await;
        }
        let Some(p) = pointer else { return };
        let mut s = self.shared.lock().unwrap();
        if s.session.as_ref().is_some_and(|r| r.id == p.id) {
            return;
        }
        // A pointer to another session replaces the old one: the old session is over on the relay's side.
        if let Some(old) = s.session.take() {
            old.stop.set();
        }
        let stop = Stop::new();
        let svc = self.clone();
        let (pointer_id, task_stop) = (p.id.clone(), stop.clone());
        let done = tokio::spawn(async move {
            // The owner hears of the end as it happens, not at the next check-in (which may be hours away).
            if svc.clone().run_session(p, task_stop).await {
                svc.hooks.session(None);
            }
        });
        s.session = Some(RunningSession { id: pointer_id, stop, done });
    }

    /// Asks, declines or hosts one session. True when the session was hosted (so its end is worth telling).
    async fn run_session(self: Arc<Self>, p: SessionPointer, stop: Arc<Stop>) -> bool {
        let (access, control, accepted) = {
            let s = self.shared.lock().unwrap();
            (s.access.clone(), s.control.clone(), s.accepted == p.id)
        };
        let target = self.platform.session_target();
        let transport = match HttpTransport::new(&self.cfg.origin, &p.id, Auth::Device(self.cfg.key.clone())) {
            Ok(t) => Arc::new(t),
            Err(_) => return false,
        };
        let start = session::decide_start(p.ask, &access, &control, target, accepted);
        let decline = |reason: &'static str| {
            let transport = transport.clone();
            let stop = stop.clone();
            async move {
                // Said again every few seconds until the relay takes it, or the session is gone (a 4xx counts).
                while !session::send_decline(&*transport, reason).await {
                    tokio::select! {
                        _ = sleep(Duration::from_secs(5)) => {}
                        _ = stop.stopped() => return,
                    }
                }
            }
        };
        match start {
            Start::DeclineBusy => {
                decline("busy").await;
                return false;
            }
            Start::DeclineNobody => {
                decline("nobody").await;
                return false;
            }
            Start::Ask => {
                let yes = session::ask_person(self.platform.clone(), p.by.clone(), p.team.clone(), control == "full", stop.clone()).await;
                if stop.is_set() {
                    return false;
                }
                if !yes {
                    decline("declined").await;
                    return false;
                }
            }
            Start::Host => {}
        }
        // The person allowed it (or it needed no question): a restarted service rejoins without asking again.
        self.shared.lock().unwrap().accepted = p.id.clone();
        self.hooks.session_accepted(&p.id);
        self.hooks.session(Some(&p.by));
        let left = (p.expires_at - self.clock.unix_ms()).max(0);
        // The first connection may take until the session's own end. The relay's welcome then sets the real deadline.
        let startup = Duration::from_millis(left.clamp(600_000, 86_400_000) as u64);
        let mut cfg = SessionConfig::new(startup);
        cfg.end_reason = Some("owner".into());
        cfg.version = self.cfg.identity.app_version.clone();
        let ruled: Arc<dyn crate::rules::Ruled> = Arc::new(ServiceRuled { svc: self.clone() });
        let client = Client::new(transport, self.platform.clone(), Some(ruled), Arc::new(NoEvents), cfg, stop);
        let _ = client.run().await;
        true
    }

    /// The loop: check in, wait for the schedule, a ring or a refresh, and again. Runs until `stop()` or until the
    /// relay says this Mac was removed.
    pub async fn run(self: &Arc<Self>) {
        *self.bell.lock().unwrap() = Doorbell::start(&self.cfg.origin, &self.cfg.key, self.wake.clone(), self.cfg.doorbell.clone()).ok();
        let mut backoff = 0i64;
        let mut first = true;
        loop {
            if self.stop.is_set() {
                break;
            }
            if !first {
                let (status, up) = (self.shared.lock().unwrap().status.clone(), self.doorbell_connected());
                let delay = next_delay(self.last_schedule(), up, &status, backoff, &mut Self::jitter);
                tokio::select! {
                    _ = sleep(Duration::from_millis(delay.max(0) as u64)) => {}
                    _ = self.wake.notified() => {}
                    _ = self.catch_up.notified() => {}
                    _ = self.stop.stopped() => break,
                }
            }
            first = false;
            let schedule = self.check_in(&mut backoff).await;
            self.set_last_schedule(schedule);
            if schedule == Schedule::Stopped {
                break;
            }
        }
        let running = self.shared.lock().unwrap().session.take();
        if let Some(r) = running {
            r.stop.set();
            let _ = tokio::time::timeout(Duration::from_secs(20), r.done).await;
        }
        let bell = self.bell.lock().unwrap().take();
        if let Some(d) = bell {
            d.stop().await;
        }
    }

    fn last_schedule(&self) -> Schedule {
        *self.last.lock().unwrap()
    }

    fn set_last_schedule(&self, s: Schedule) {
        *self.last.lock().unwrap() = s;
    }
}

/// What a session asks of its service: the rules, and a check-in it can wait on.
struct ServiceRuled {
    svc: Arc<DeviceService>,
}

impl crate::rules::Ruled for ServiceRuled {
    fn state(&self) -> View {
        self.svc.rules.now()
    }

    fn catch_up(&self, wait_ms: u64, stop: &Stop) -> bool {
        let before = self.svc.rules.generation();
        self.svc.catch_up.notify_one();
        let until = std::time::Instant::now() + Duration::from_millis(wait_ms);
        while std::time::Instant::now() < until {
            if self.svc.rules.generation() != before {
                return true;
            }
            if stop.wait(Duration::from_millis(50)) {
                break;
            }
        }
        self.svc.rules.generation() != before
    }

    fn close_target(&self, frame: &Frame) -> Option<String> {
        self.svc.platform.close_target(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::one_shot;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    // ---- the answer map ---------------------------------------------------------------------------------------------

    #[test]
    fn a_status_and_body_map_to_the_pinned_outcomes() {
        let body = Some(json!({"protocol":1}));
        let err = |code: &str| Some(json!({"protocol":1,"error":{"code":code,"message":"why"}}));
        let r = |status, b| map_answer(status, b).result;
        assert_eq!(r(200, body.clone()), DeviceResult::Ok);
        assert_eq!(r(201, body.clone()), DeviceResult::Ok);
        assert_eq!(r(202, body.clone()), DeviceResult::Pending);
        // A 2xx with no readable body is unexpected: offline, so the caller retries.
        assert_eq!(map_answer(200, None).result, DeviceResult::Offline);
        assert_eq!((map_answer(200, None).status, map_answer(202, None).result), (0, DeviceResult::Offline));
        assert_eq!(r(401, err("device_unknown")), DeviceResult::Removed);
        assert_eq!(r(426, err("protocol_unsupported")), DeviceResult::UpdateNeeded);
        assert_eq!(r(404, err("code_invalid")), DeviceResult::CodeInvalid);
        assert_eq!(r(404, err("not_found")), DeviceResult::Refused);
        for status in [400, 403, 409, 413, 500, 503] {
            assert_eq!(r(status, err("x")), DeviceResult::Refused, "{status}");
        }
        let a = map_answer(409, err("device_limit"));
        assert_eq!((a.status, a.message.as_str()), (409, "why"));
        assert!(map_answer(201, body).is_ok() && !map_answer(500, None).is_ok());
    }

    #[test]
    fn what_a_check_in_came_to_decides_the_state_and_the_schedule() {
        use DeviceResult::*;
        assert_eq!(classify("active", Ok, "active"), ("active", Schedule::Normal));
        assert_eq!(classify("active", Ok, "pending"), ("pending", Schedule::Normal));
        assert_eq!(classify("pending", Ok, "active"), ("active", Schedule::Normal));
        assert_eq!(classify("active", Removed, ""), ("removed", Schedule::Stopped));
        assert_eq!(classify("pending", Removed, ""), ("expired", Schedule::Stopped));
        assert_eq!(classify("active", UpdateNeeded, ""), ("update_needed", Schedule::Update));
        for r in [Offline, Refused, CodeInvalid, Pending] {
            assert_eq!(classify("active", r, ""), ("offline", Schedule::Backoff), "{r:?}");
        }
    }

    // ---- the check-in schedule ------------------------------------------------------------------------------------------

    #[test]
    fn the_backoff_starts_at_a_minute_doubles_and_stops_at_fifteen() {
        let mut b = 0;
        let mut seen = vec![];
        for _ in 0..7 {
            b = next_backoff(b);
            seen.push(b / 1000);
        }
        assert_eq!(seen, vec![60, 120, 240, 480, 900, 900, 900]);
    }

    #[test]
    fn the_next_check_in_follows_the_doorbell_the_status_and_the_schedule() {
        let mut asked = vec![];
        let mut jitter = |max| {
            asked.push(max);
            max
        };
        // 5 minutes plus up to 30 s, with no doorbell, a pending Mac, or a doorbell that is down.
        assert_eq!(next_delay(Schedule::Normal, false, "active", 0, &mut jitter), 330_000);
        assert_eq!(next_delay(Schedule::Normal, true, "pending", 0, &mut jitter), 330_000);
        // 6 hours plus up to 10 minutes with the doorbell up and the Mac active.
        assert_eq!(next_delay(Schedule::Normal, true, "active", 0, &mut jitter), 6 * 3_600_000 + 600_000);
        // A backoff and a 426 keep their own, whatever the doorbell says.
        assert_eq!(next_delay(Schedule::Backoff, true, "active", 240_000, &mut jitter), 240_000);
        assert_eq!(next_delay(Schedule::Update, true, "active", 0, &mut jitter), 6 * 3_600_000);
        assert_eq!(asked, vec![30_000, 30_000, 600_000]);
        // With the lowest jitter it is the plain number.
        assert_eq!(next_delay(Schedule::Normal, false, "active", 0, &mut |_| 0), 300_000);
        assert_eq!(next_check_delay(&mut |_| 0), 300_000);
    }

    #[test]
    fn a_refresh_forces_a_check_in_at_most_every_thirty_seconds() {
        assert!(refresh_due(0, 30_000));
        assert!(!refresh_due(0, 29_999));
        assert!(refresh_due(i64::MIN / 2, 0), "the first one always goes");
    }

    #[test]
    fn the_history_notes_approval_and_changes_and_keeps_fifty_lines() {
        assert_eq!(history_for("pending", "ask", "full", "active", "ask", "full"), vec!["Your support team approved this PC."]);
        assert_eq!(
            history_for("active", "ask", "full", "active", "any", "limited"),
            vec!["Access set to connect any time.", "Control set to limited support."]
        );
        assert_eq!(
            history_for("active", "any", "limited", "active", "ask", "full"),
            vec!["Access set to ask each time.", "Control set to full control."]
        );
        assert!(history_for("active", "any", "full", "active", "any", "full").is_empty());
        let mut h: Vec<String> = (0..60).map(|i| i.to_string()).collect();
        trim_history(&mut h);
        assert_eq!((h.len(), h[0].as_str(), h[49].as_str()), (50, "10", "59"));
    }

    #[test]
    fn a_check_in_may_lower_full_control_to_limited_and_never_raise_it() {
        assert_eq!(next_control("full", "full"), "full");
        assert_eq!(next_control("full", "limited"), "limited");
        assert_eq!(next_control("limited", "full"), "limited");
        assert_eq!(next_control("limited", "limited"), "limited");
        assert_eq!(next_control("full", ""), "full");
    }

    #[test]
    fn the_session_pointer_is_read_strictly() {
        let id = "ab".repeat(32);
        let good =
            json!({"session": {"id": id, "by": "  tech@example.com \n", "team": "Acme\u{7}", "ask": false, "expires_at": 1_794_000_000_000i64}});
        let p = read_session(&good).unwrap();
        assert_eq!(
            (p.id.as_str(), p.by.as_str(), p.team.as_str(), p.ask, p.expires_at),
            (id.as_str(), "tech@example.com", "Acme", false, 1_794_000_000_000)
        );
        // Anything but exactly false asks.
        for ask in [json!(true), json!("false"), json!(0), Value::Null] {
            assert!(read_session(&json!({"session": {"id": id, "ask": ask}})).unwrap().ask, "{ask}");
        }
        assert!(read_session(&json!({"session": {"id": id}})).unwrap().ask);
        for bad in [
            json!({}),
            json!({"session": null}),
            json!({"session": "x"}),
            json!({"session": {"id": "short"}}),
            json!({"session": {"id": "AB".repeat(32)}}),
            json!({"session": {"ask": false}}),
        ] {
            assert!(read_session(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_os_text_is_what_the_relay_tells_a_mac_by() {
        assert_eq!(os_string("26.1", "25B78"), "macOS 26.1 (25B78)");
        assert!(os_string(&"9".repeat(200), "x").chars().count() == 100);
        assert!(os_string("14.0", "23A344").starts_with("macOS "), "src/release.js isMacOs is /^macOS /");
    }

    // ---- the link, against a socket ---------------------------------------------------------------------------------------

    #[tokio::test]
    async fn pairing_sends_the_code_and_the_macs_facts_and_reads_the_key() {
        let reply = br#"{"protocol":1,"status":"active","workspace":"default","device_id":"abcdefghijklmnopqrst","key":"smd1.default.abcdefghijklmnopqrst.SECRET"}"#.to_vec();
        let (origin, seen) = one_shot("HTTP/1.1 201 Created", reply, 0).await;
        let link = DeviceLink::new(&origin).unwrap();
        let id = Identity { os: os_string("26.1", "25B78"), machine: "Neo".into(), app_version: "1.0.0".into() };
        let p = pair_with_code(&link, "ABCDE-FGH23", "Front desk", "ask", "limited", &id).await.unwrap();
        assert_eq!(
            (p.status.as_str(), p.workspace.as_str(), p.device_id.as_str(), p.key.as_str(), p.confirm),
            ("active", "default", "abcdefghijklmnopqrst", "smd1.default.abcdefghijklmnopqrst.SECRET", None)
        );
        let req = seen.await.unwrap();
        let lower = req.to_lowercase();
        assert!(lower.starts_with("post /device/pair http/1.1"), "{req}");
        assert!(!lower.contains("authorization") && !lower.contains("\r\norigin:"));
        let body: Value = serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"protocol":1,"code":"ABCDE-FGH23","name":"Front desk","access":"ask","control":"limited","os":"macOS 26.1 (25B78)","machine":"Neo","app_version":"1.0.0"})
        );
    }

    #[tokio::test]
    async fn an_owners_request_is_pending_and_hands_back_the_six_digits() {
        let reply = br#"{"protocol":1,"status":"pending","workspace":"acme","device_id":"abcdefghijklmnopqrst","key":"smd1.acme.abcdefghijklmnopqrst.S","confirm":"482913","expires_at":1}"#.to_vec();
        let (origin, seen) = one_shot("HTTP/1.1 202 Accepted", reply, 0).await;
        let link = DeviceLink::new(&origin).unwrap();
        let id = Identity { os: "macOS 14.0 (23A344)".into(), machine: "M".into(), app_version: "1.0.0".into() };
        let p = pair_with_workspace(&link, "acme", "Mac", "any", "full", &id).await.unwrap();
        assert_eq!((p.status.as_str(), p.confirm.as_deref()), ("pending", Some("482913")));
        let req = seen.await.unwrap();
        let body: Value = serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!((body["workspace"].clone(), body.get("code").is_none()), (json!("acme"), true));
    }

    #[tokio::test]
    async fn a_refused_code_is_an_error_with_the_relays_words() {
        let reply = br#"{"protocol":1,"error":{"code":"code_invalid","message":"this code is not valid"}}"#.to_vec();
        let (origin, _h) = one_shot("HTTP/1.1 404 Not Found", reply, 0).await;
        let link = DeviceLink::new(&origin).unwrap();
        let id = Identity { os: "x".into(), machine: "y".into(), app_version: "1.0.0".into() };
        let e = pair_with_code(&link, "AAAAA-AAAAA", "n", "ask", "limited", &id).await.unwrap_err();
        assert_eq!((e.result, e.message.as_str()), (DeviceResult::CodeInvalid, "this code is not valid"));
    }

    #[tokio::test]
    async fn a_check_in_sends_the_key_as_a_bearer_and_the_protocol_in_the_body() {
        let (origin, seen) = one_shot("HTTP/1.1 200 OK", br#"{"protocol":1,"device":{"status":"active"}}"#.to_vec(), 0).await;
        let link = DeviceLink::new(&origin).unwrap();
        let a = link.hello("smd1.default.abcdefghijklmnopqrst.S", json!({"os":"macOS 26.1 (25B78)","machine":"M","app_version":"1.0.0"})).await;
        assert_eq!(a.result, DeviceResult::Ok);
        let req = seen.await.unwrap();
        assert!(req.to_lowercase().contains("authorization: bearer smd1.default.abcdefghijklmnopqrst.s"));
        assert!(req.starts_with("POST /device/hello HTTP/1.1"));
        assert!(req.ends_with(r#""protocol":1}"#) || req.contains(r#""protocol":1"#));
    }

    #[tokio::test]
    async fn a_dead_relay_is_offline_and_an_answer_over_the_cap_has_no_body() {
        let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", dead.local_addr().unwrap());
        drop(dead);
        let link = DeviceLink::new(&origin).unwrap();
        assert_eq!(link.hello("k", json!({})).await.result, DeviceResult::Offline);
        let (origin, _h) = one_shot("HTTP/1.1 200 OK", vec![b' '; wire::DEVICE_RESPONSE_MAX + 100], 0).await;
        let link = DeviceLink::new(&origin).unwrap();
        // 200 with nothing readable is unexpected, so offline.
        assert_eq!(link.hello("k", json!({})).await.result, DeviceResult::Offline);
        assert!(DeviceLink::new("http://relay.example.com").is_err());
        assert!(DeviceLink::new("https://relay.example.com/x").is_err());
    }

    // ---- the doorbell ---------------------------------------------------------------------------------------------------------

    #[test]
    fn a_ring_wakes_the_check_in_at_most_once_every_two_seconds_and_none_is_lost() {
        let mut g = RingGate::new(2_000);
        assert_eq!(g.offer(10_000), Ring::Now);
        assert_eq!(g.offer(10_500), Ring::Later(1_500), "it waits for the end of the gap");
        assert_eq!(g.offer(10_700), Ring::Queued);
        assert_eq!(g.offer(11_900), Ring::Queued);
        assert!(g.due(12_000));
        assert!(!g.due(12_001), "the queued wake is spent");
        // The gap runs from the queued wake.
        assert_eq!(g.offer(13_000), Ring::Later(1_000));
        assert!(g.due(14_000));
        assert_eq!(g.offer(16_000), Ring::Now);
        assert_eq!(RingGate::new(2_000).offer(0), Ring::Now, "the very first ring at time zero goes at once");
    }

    #[test]
    fn the_doorbell_reconnects_after_5_seconds_doubling_to_5_minutes() {
        let d = DoorbellConfig::default();
        assert_eq!((d.ping.as_secs(), d.pong.as_secs(), d.ring_gap.as_secs(), d.min_backoff.as_secs(), d.max_backoff.as_secs()), (30, 60, 2, 5, 300));
        let mut b = Duration::ZERO;
        let mut seen = vec![];
        for _ in 0..8 {
            b = doorbell_backoff(b, d.min_backoff, d.max_backoff);
            seen.push(b.as_secs());
        }
        assert_eq!(seen, vec![5, 10, 20, 40, 80, 160, 300, 300]);
        assert_eq!(FRAME_MAX, 1024);
    }

    fn fast() -> DoorbellConfig {
        DoorbellConfig {
            ping: Duration::from_millis(200),
            pong: Duration::from_secs(5),
            ring_gap: Duration::from_millis(100),
            connect: Duration::from_secs(5),
            min_backoff: Duration::from_millis(50),
            max_backoff: Duration::from_millis(200),
        }
    }

    type Seen = Arc<Mutex<Vec<(String, Vec<(String, String)>)>>>;

    /// Accepts one WebSocket and records its request line and headers.
    #[allow(clippy::result_large_err)]
    async fn accept_ws(listener: &TcpListener, seen: &Seen) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
        let (sock, _) = listener.accept().await.unwrap();
        let seen = seen.clone();
        tokio_tungstenite::accept_hdr_async(sock, move |req: &Request, resp: Response| {
            let headers = req.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
            seen.lock().unwrap().push((req.uri().to_string(), headers));
            Ok(resp)
        })
        .await
        .unwrap()
    }

    async fn bind() -> (TcpListener, String) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", l.local_addr().unwrap());
        (l, origin)
    }

    #[tokio::test]
    async fn the_doorbell_connects_as_the_relay_expects_and_a_ring_wakes_the_check_in() {
        let (listener, origin) = bind().await;
        let seen: Seen = Arc::default();
        let wake = Arc::new(Notify::new());
        let bell = Doorbell::start(&origin, "smd1.default.abcdefghijklmnopqrst.S", wake.clone(), fast()).unwrap();
        let mut ws = accept_ws(&listener, &seen).await;
        // The connect itself wakes the check-in.
        tokio::time::timeout(Duration::from_secs(2), wake.notified()).await.expect("a wake at connect");
        assert!(bell.connected());
        assert_eq!(bell.connections(), 1);
        // A ring: any text, whatever it says. Its content is never read.
        ws.send(Message::Text("{\"type\":\"ring\",\"junk\":[1,2,3]} and more".into())).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), wake.notified()).await.expect("a wake at the ring");
        let (uri, headers) = seen.lock().unwrap()[0].clone();
        assert_eq!(uri, "/device/ring?protocol=1");
        let h = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        assert_eq!(h("authorization").as_deref(), Some("Bearer smd1.default.abcdefghijklmnopqrst.S"));
        assert_eq!(h("origin"), None, "the relay refuses any Origin header");
        assert_eq!(h("upgrade").as_deref().map(str::to_lowercase).as_deref(), Some("websocket"));
        assert_eq!(h("sec-websocket-version").as_deref(), Some("13"));
        bell.stop().await;
    }

    #[tokio::test]
    async fn a_frame_over_1024_bytes_closes_the_connection_and_a_frame_of_1024_does_not() {
        let (listener, origin) = bind().await;
        let seen: Seen = Arc::default();
        let wake = Arc::new(Notify::new());
        let bell = Doorbell::start(&origin, "k", wake.clone(), fast()).unwrap();
        let mut first = accept_ws(&listener, &seen).await;
        first.send(Message::Text("x".repeat(1025).into())).await.unwrap();
        // The client drops it and comes back after its backoff.
        let mut second =
            tokio::time::timeout(Duration::from_secs(3), accept_ws(&listener, &seen)).await.expect("a reconnect after the oversized frame");
        assert!(bell.connections() >= 1);
        second.send(Message::Text("y".repeat(1024).into())).await.unwrap();
        // It stays: no third connection while we wait.
        let third = tokio::time::timeout(Duration::from_millis(700), listener.accept()).await;
        assert!(third.is_err(), "a frame of exactly 1,024 bytes is allowed");
        assert!(bell.connected());
        // A binary frame closes it too.
        second.send(Message::Binary(vec![1, 2, 3].into())).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), accept_ws(&listener, &seen)).await.expect("a reconnect after a binary frame");
        bell.stop().await;
    }

    #[tokio::test]
    async fn a_relay_that_goes_silent_is_given_up_on_after_the_pong_time() {
        let (listener, origin) = bind().await;
        let seen: Seen = Arc::default();
        let cfg = DoorbellConfig { ping: Duration::from_millis(100), pong: Duration::from_millis(500), ..fast() };
        let bell = Doorbell::start(&origin, "k", Arc::new(Notify::new()), cfg).unwrap();
        // The server accepts and then never reads, so it never answers a ping.
        let _silent = accept_ws(&listener, &seen).await;
        let started = std::time::Instant::now();
        let _second = tokio::time::timeout(Duration::from_secs(4), accept_ws(&listener, &seen)).await.expect("it reconnects");
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(450), "it waited for the pong time: {took:?}");
        assert!(took < Duration::from_secs(3), "{took:?}");
        bell.stop().await;
    }

    #[tokio::test]
    async fn a_relay_that_answers_pings_keeps_the_connection_and_gets_one_every_ping_time() {
        let (listener, origin) = bind().await;
        let seen: Seen = Arc::default();
        let cfg = DoorbellConfig { ping: Duration::from_millis(100), pong: Duration::from_millis(400), ..fast() };
        let bell = Doorbell::start(&origin, "k", Arc::new(Notify::new()), cfg).unwrap();
        let mut ws = accept_ws(&listener, &seen).await;
        let mut pings = 0;
        let until = tokio::time::Instant::now() + Duration::from_millis(1500);
        while let Ok(Some(Ok(m))) = tokio::time::timeout_at(until, ws.next()).await {
            if matches!(m, Message::Ping(_)) {
                pings += 1;
            }
        }
        assert!((8..=16).contains(&pings), "{pings} pings in 1.5 s at one per 100 ms");
        assert_eq!(bell.connections(), 1, "the connection lived past the 400 ms pong time");
        bell.stop().await;
    }

    #[tokio::test]
    async fn the_reconnect_wait_doubles_and_a_ring_resets_it() {
        let (listener, origin) = bind().await;
        let bell = Doorbell::start(&origin, "k", Arc::new(Notify::new()), fast()).unwrap();
        let mut times = vec![];
        // Three connections dropped before the handshake.
        for _ in 0..3 {
            let (sock, _) = listener.accept().await.unwrap();
            times.push(std::time::Instant::now());
            drop(sock);
        }
        let gaps: Vec<u128> = times.windows(2).map(|w| (w[1] - w[0]).as_millis()).collect();
        // 50 ms, then 100 ms: each with the time to connect and fail on top.
        assert!(gaps[0] >= 50 && gaps[0] < 300, "{gaps:?}");
        assert!(gaps[1] >= 100 && gaps[1] < 400, "{gaps:?}");
        // A good connection that gets a ring and then drops resets the wait to the minimum.
        let seen: Seen = Arc::default();
        let mut ws = accept_ws(&listener, &seen).await;
        ws.send(Message::Text("ring".into())).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(ws);
        let dropped = std::time::Instant::now();
        let (sock, _) = listener.accept().await.unwrap();
        let back = dropped.elapsed();
        drop(sock);
        assert!(back >= Duration::from_millis(40) && back < Duration::from_millis(180), "after a ring the wait is the minimum, not 200 ms: {back:?}");
        bell.stop().await;
    }

    #[tokio::test]
    async fn stopping_the_doorbell_ends_it_even_while_it_waits_to_reconnect() {
        let (listener, origin) = bind().await;
        let bell = Doorbell::start(&origin, "k", Arc::new(Notify::new()), DoorbellConfig { min_backoff: Duration::from_secs(60), ..fast() }).unwrap();
        let (sock, _) = listener.accept().await.unwrap();
        drop(sock);
        tokio::time::sleep(Duration::from_millis(100)).await;
        tokio::time::timeout(Duration::from_secs(2), bell.stop()).await.expect("stop returns at once");
    }
}

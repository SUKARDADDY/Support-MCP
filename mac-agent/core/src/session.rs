//! The session client: the long-poll loop that carries a technician's commands to the Mac and the results back
//! (docs/relay-v1-spec.md, "App sessions (HTTPS polling)"). It is `Client.Run` of src/agent-app.cs, with its numbers.
//!
//! Two lanes. The `cmd` lane takes run, put_file, get_file, power and programs. The `screen` lane takes screen and
//! control frames. At most one operation per lane is in flight, so a screenshot is served while a long command runs.
//! While a lane works the client keeps a poll parked that names the busy lanes. When a lane finishes the parked poll is
//! dropped and the result goes out at once.
//!
//! Who is asking is `Auth`: a saved Mac signs in with its device key (`Authorization: Bearer`), and a one-off session
//! with the key from its link (`X-Attach-Key`). The relay reads only one of them: given a Bearer header it treats the
//! request as a saved Mac's and forwards no attach key (src/app.js handleAgent).

use crate::platform::Platform;
use crate::rules::Ruled;
use crate::stop::Stop;
use crate::wire::{self, clean, number, text, Frame, Lane, AGENT_BODY_MAX};
use futures_util::FutureExt;
use serde_json::{json, Map, Value};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, Notify};
use tokio::time::{sleep, Instant};

/// Time limits of a request, from the Windows client: hello, poll and result 30 s, the closing `end` 3 s.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const END_TIMEOUT: Duration = Duration::from_secs(3);
/// After a network error the next try comes 3 s later, with no backoff.
pub const RETRY_DELAY: Duration = Duration::from_secs(3);
/// With both lanes busy nothing is parked. The client waits up to this long for a lane, then sends a busy poll as a
/// sign of life.
pub const BOTH_BUSY_WAIT: Duration = Duration::from_secs(2);
/// An operation that outlives the session gets this long to report before the client gives up on it.
pub const OP_JOIN: Duration = Duration::from_secs(15);
/// A repeated or busy frame is left alone for this long.
pub const REPEAT_WAIT: Duration = Duration::from_secs(1);
/// After a command starts, the client waits this long before it polls again, so a quick one is done by then.
pub const START_SETTLE: Duration = Duration::from_millis(100);
const DAY_MS: i64 = 86_400_000;

/// Who the requests are made as.
#[derive(Clone, Debug)]
pub enum Auth {
    /// A saved Mac: the device key (`smd1...`), sent as `Authorization: Bearer`.
    Device(String),
    /// A one-off session: the key of the support link, sent as `X-Attach-Key`.
    Attach(String),
}

/// A one-off session's credentials, as the support link's redeem answer gives them (PR 5).
#[derive(Clone, Debug)]
pub struct OneOff {
    pub sid: String,
    pub key: String,
}

impl OneOff {
    /// Both are 64 lowercase hex characters, as `ReadConfig` requires in src/agent-app.cs.
    pub fn new(sid: &str, key: &str) -> Result<OneOff, String> {
        if !wire::is_session_id(sid) || !wire::is_session_id(key) {
            return Err("Invalid session credentials.".to_string());
        }
        Ok(OneOff { sid: sid.to_string(), key: key.to_string() })
    }

    pub fn auth(&self) -> Auth {
        Auth::Attach(self.key.clone())
    }
}

/// An answer the relay gave: its status, and its JSON body when the status was 200.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Option<Value>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum NetError {
    /// No answer, or a server error: try again in 3 s.
    Offline(String),
    /// An answer this client cannot use (a 2xx that is not 200, a body that is too big or not JSON). The Windows
    /// client ends the session on these.
    Fatal(String),
}

/// One request to `/agent?sid=`. The seam the tests replace with a scripted relay.
pub trait Transport: Send + Sync + 'static {
    fn post(&self, body: &Value, timeout: Duration) -> impl Future<Output = Result<Reply, NetError>> + Send;
}

/// The real transport: reqwest on rustls, no redirects, no proxy surprises beyond the system's.
pub struct HttpTransport {
    client: reqwest::Client,
    url: String,
    auth: Auth,
}

impl HttpTransport {
    pub fn new(origin: &str, sid: &str, auth: Auth) -> Result<HttpTransport, String> {
        let origin = wire::check_origin(origin)?;
        if !wire::is_session_id(sid) {
            return Err("Invalid session credentials.".to_string());
        }
        crate::tls::init();
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
        Ok(HttpTransport { client, url: format!("{origin}/agent?sid={sid}"), auth })
    }
}

/// Reads a body up to `cap` bytes. Over the cap is an error, as in the Windows client.
async fn read_capped(mut response: reqwest::Response, cap: usize) -> Result<Vec<u8>, NetError> {
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| NetError::Offline(e.to_string()))? {
        if data.len() + chunk.len() > cap {
            return Err(NetError::Fatal("Support response too large.".to_string()));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

impl Transport for HttpTransport {
    async fn post(&self, body: &Value, timeout: Duration) -> Result<Reply, NetError> {
        let bytes = serde_json::to_vec(body).map_err(|e| NetError::Fatal(e.to_string()))?;
        let mut req = self.client.post(&self.url).header("content-type", "application/json").timeout(timeout).body(bytes);
        req = match &self.auth {
            Auth::Device(key) => req.header("authorization", format!("Bearer {key}")),
            Auth::Attach(key) => req.header("x-attach-key", key),
        };
        let response = req.send().await.map_err(|e| NetError::Offline(e.to_string()))?;
        let status = response.status().as_u16();
        if status == 200 {
            let data = read_capped(response, AGENT_BODY_MAX).await?;
            let body = serde_json::from_slice(&data).map_err(|_| NetError::Fatal("Invalid support response.".to_string()))?;
            return Ok(Reply { status, body: Some(body) });
        }
        if (200..400).contains(&status) {
            return Err(NetError::Fatal("Unexpected support server response.".to_string()));
        }
        Ok(Reply { status, body: None })
    }
}

/// What a session tells its owner while it runs. Every method has a do-nothing default.
pub trait Events: Send + Sync {
    /// The first welcome arrived.
    fn connected(&self) {}
    /// The link to the relay dropped (false) or came back (true).
    fn link(&self, _up: bool) {}
    /// Operations in flight, 0 to 2.
    fn busy(&self, _n: usize) {}
    /// A line for the corner window's log. Never holds file contents, typed text or images.
    fn log(&self, _line: &str) {}
}

pub struct NoEvents;
impl Events for NoEvents {}

#[derive(Clone, Debug)]
pub struct SessionConfig {
    /// The longest wait for the first welcome, from the pointer's own end or the link's startup window.
    pub startup: Duration,
    /// Sent in the closing `end` when the person at the Mac ended it ("owner").
    pub end_reason: Option<String>,
    /// The app version for the hello.
    pub version: String,
}

impl SessionConfig {
    pub fn new(startup: Duration) -> SessionConfig {
        SessionConfig { startup, end_reason: None, version: crate::VERSION.to_string() }
    }
}

/// How a session ended.
#[derive(Debug, PartialEq, Eq)]
pub enum SessionEnd {
    /// The relay ended it, or access was refused (401, 403, 409, 410): the technician ended it, it expired, or the Mac
    /// was removed. Quiet.
    Relay,
    /// `stop()` was called, or the startup or session deadline passed.
    Stopped,
    /// An answer this client cannot use.
    Failed(String),
}

enum Flow {
    Continue,
    /// The relay ended the session (an `end` answer).
    End,
    /// This side stopped it: the stop signal, or the session's deadline.
    Stopped,
}

enum StepError {
    /// 401, 403, 409 or 410.
    Ended,
    Net(NetError),
    /// 400 or 413 on a result.
    Rejected,
}

impl From<NetError> for StepError {
    fn from(e: NetError) -> Self {
        StepError::Net(e)
    }
}

#[derive(Default)]
struct LaneState {
    active_id: Option<String>,
    last_id: String,
    /// A finished operation's result message, waiting to be acknowledged.
    result: Option<Value>,
    /// The relay refused this lane's result, which was replaced by a plain error.
    rejected: bool,
}

impl LaneState {
    fn busy(&self) -> bool {
        self.active_id.is_some()
    }
}

/// How an operation is started on its own thread. The default is `std::thread`. A test can run it inline instead, so
/// that a clock it has paused cannot run ahead of an operation that is still finishing.
pub type Spawner = Arc<dyn Fn(Box<dyn FnOnce() + Send>) -> bool + Send + Sync>;

/// A thread per operation (not tokio's blocking pool: a stuck operation must never hold up the runtime's shutdown).
pub fn thread_spawner() -> Spawner {
    Arc::new(|work| std::thread::Builder::new().name("support-op".into()).spawn(work).is_ok())
}

/// The session client. `run` drives it to the end.
pub struct Client<T: Transport> {
    transport: Arc<T>,
    platform: Arc<dyn Platform>,
    ruled: Option<Arc<dyn Ruled>>,
    events: Arc<dyn Events>,
    cfg: SessionConfig,
    spawner: Spawner,
    stop: Arc<Stop>,
    wake: Arc<Notify>,
    driver: Mutex<String>,
    expires_unix_ms: AtomicI64,
    server_offset_ms: AtomicI64,
    /// True when the relay ended the session, so no closing `end` is sent.
    relay_ended: AtomicBool,
}

impl<T: Transport> Client<T> {
    pub fn new(
        transport: Arc<T>,
        platform: Arc<dyn Platform>,
        ruled: Option<Arc<dyn Ruled>>,
        events: Arc<dyn Events>,
        cfg: SessionConfig,
        stop: Arc<Stop>,
    ) -> Arc<Client<T>> {
        Self::with_spawner(transport, platform, ruled, events, cfg, stop, thread_spawner())
    }

    pub fn with_spawner(
        transport: Arc<T>,
        platform: Arc<dyn Platform>,
        ruled: Option<Arc<dyn Ruled>>,
        events: Arc<dyn Events>,
        cfg: SessionConfig,
        stop: Arc<Stop>,
        spawner: Spawner,
    ) -> Arc<Client<T>> {
        Arc::new(Client {
            spawner,
            transport,
            platform,
            ruled,
            events,
            cfg,
            stop,
            wake: Arc::new(Notify::new()),
            driver: Mutex::new(String::new()),
            expires_unix_ms: AtomicI64::new(0),
            server_offset_ms: AtomicI64::new(0),
            relay_ended: AtomicBool::new(false),
        })
    }

    /// Ends the session: the loop stops, and a closing `end` goes to the relay.
    pub fn stop(&self) {
        self.stop.set();
    }

    /// Ends a parked poll so the next one carries a fresh report.
    pub fn nudge(&self) {
        self.wake.notify_one();
    }

    /// Who drives the session now: the welcome's or the last poll's.
    pub fn driver(&self) -> String {
        self.driver.lock().unwrap().clone()
    }

    /// The session's end on this Mac's clock, Unix ms, 0 before the first welcome.
    pub fn expires_at_ms(&self) -> i64 {
        self.expires_unix_ms.load(Ordering::SeqCst)
    }

    /// The relay's clock minus this Mac's, in ms, from the welcome.
    pub fn server_offset_ms(&self) -> i64 {
        self.server_offset_ms.load(Ordering::SeqCst)
    }

    fn log(&self, line: &str) {
        self.events.log(line);
    }

    fn note_driver(&self, answer: &Value) {
        let d = clean(&text(answer, "driver"), 200);
        if !d.is_empty() {
            *self.driver.lock().unwrap() = d;
        }
    }

    fn unix_now_ms() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }

    /// One request, with the status codes read the way the Windows client reads them: 401, 403, 409 and 410 end the
    /// session quietly, 400 and 413 say a result is bad, and any other failure is a network error to retry.
    async fn send(&self, body: &Value, timeout: Duration) -> Result<Value, StepError> {
        let reply = self.transport.post(body, timeout).await?;
        match reply.status {
            200 => reply.body.ok_or_else(|| StepError::Net(NetError::Fatal("Invalid support response.".into()))),
            401 | 403 | 409 | 410 => Err(StepError::Ended),
            400 | 413 => Err(StepError::Rejected),
            s => Err(StepError::Net(NetError::Offline(format!("HTTP {s}")))),
        }
    }

    /// Sends one lane's result. Returns the relay's answer type: "ack" or "end". A result the relay refuses (400, 413)
    /// or that is over the size limit is replaced once by a plain error, which the relay always accepts. If even that is
    /// refused it is dropped, and the operator's call ends with the relay's own timeout.
    async fn send_result(&self, lane: &mut LaneState, generation: i64) -> Result<String, StepError> {
        loop {
            let message = lane.result.clone().unwrap_or(Value::Null);
            let too_big = serde_json::to_vec(&message).map_or(true, |b| b.len() > AGENT_BODY_MAX);
            let reject = if too_big {
                true
            } else {
                match self.send(&message, REQUEST_TIMEOUT).await {
                    Ok(answer) => return Ok(text(&answer, "type")),
                    Err(StepError::Rejected) => true,
                    Err(e) => return Err(e),
                }
            };
            if reject {
                if lane.rejected {
                    return Ok("ack".to_string());
                }
                lane.rejected = true;
                let id = lane.active_id.clone().unwrap_or_default();
                lane.result = Some(wire::rejected_result(&id, generation));
            }
        }
    }

    /// Waits for `d`, or for the stop signal. True when stopped.
    async fn pause(&self, d: Duration) -> bool {
        tokio::select! {
            _ = sleep(d) => false,
            _ = self.stop.stopped() => true,
        }
    }

    pub async fn run(self: &Arc<Self>) -> SessionEnd {
        let (done_tx, mut done_rx) = mpsc::unbounded_channel::<(Lane, Map<String, Value>)>();
        let mut lanes = [LaneState::default(), LaneState::default()];
        let mut generation: i64 = 0;
        let mut deadline = Instant::now() + self.cfg.startup.min(Duration::from_millis(DAY_MS as u64));
        let mut network_error = false;
        let mut end = SessionEnd::Stopped;
        let mut reported_busy = 0usize;

        'session: loop {
            if self.stop.is_set() {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            let step = self.step(&mut lanes, &mut generation, &mut deadline, &mut network_error, &mut done_rx, &done_tx, &mut reported_busy).await;
            match step {
                Ok(Flow::Continue) => {}
                Ok(Flow::End) => {
                    self.relay_ended.store(true, Ordering::SeqCst);
                    end = SessionEnd::Relay;
                    break 'session;
                }
                Ok(Flow::Stopped) => break 'session,
                Err(StepError::Ended) => {
                    self.relay_ended.store(true, Ordering::SeqCst);
                    end = SessionEnd::Relay;
                    break 'session;
                }
                Err(StepError::Rejected) => {
                    // 400 or 413 on a request that is not a result: nothing here can mend it.
                    end = SessionEnd::Failed("the relay refused a request".to_string());
                    break 'session;
                }
                Err(StepError::Net(NetError::Fatal(e))) => {
                    end = SessionEnd::Failed(e);
                    break 'session;
                }
                Err(StepError::Net(NetError::Offline(e))) => {
                    if !network_error {
                        self.log(&format!("Connection error: {e}"));
                        self.events.link(false);
                    }
                    network_error = true;
                    if self.pause(RETRY_DELAY).await {
                        break 'session;
                    }
                }
            }
        }

        // Closing: stop what is running, give it a moment to report, then say goodbye unless the relay ended it.
        self.stop.set();
        let waiting = lanes.iter().filter(|l| l.busy() && l.result.is_none()).count();
        let mut left = waiting;
        let join_until = Instant::now() + OP_JOIN;
        while left > 0 {
            match tokio::time::timeout_at(join_until, done_rx.recv()).await {
                Ok(Some(_)) => left -= 1,
                _ => break,
            }
        }
        if generation != 0 && !self.relay_ended.load(Ordering::SeqCst) {
            let mut bye = json!({ "type": "end", "generation": generation });
            if let Some(reason) = &self.cfg.end_reason {
                bye["reason"] = Value::String(reason.clone());
            }
            let _ = self.transport.post(&bye, END_TIMEOUT).await;
        }
        self.events.busy(0);
        end
    }

    #[allow(clippy::too_many_arguments)]
    async fn step(
        self: &Arc<Self>,
        lanes: &mut [LaneState; 2],
        generation: &mut i64,
        deadline: &mut Instant,
        network_error: &mut bool,
        done_rx: &mut mpsc::UnboundedReceiver<(Lane, Map<String, Value>)>,
        done_tx: &mpsc::UnboundedSender<(Lane, Map<String, Value>)>,
        reported_busy: &mut usize,
    ) -> Result<Flow, StepError> {
        if *generation == 0 {
            let hello = wire::hello(&self.platform.info(), &self.cfg.version);
            let welcome = self.send(&hello, REQUEST_TIMEOUT).await?;
            if text(&welcome, "type") != "welcome" {
                return Err(NetError::Fatal("Invalid support handshake.".to_string()).into());
            }
            *generation = number(&welcome, "generation");
            self.note_driver(&welcome);
            let expires = number(&welcome, "expires_at");
            let mut now = number(&welcome, "server_time");
            if now == 0 {
                now = Self::unix_now_ms();
            }
            // The relay reports deadlines on its own clock.
            self.server_offset_ms.store(now - Self::unix_now_ms(), Ordering::SeqCst);
            let remaining = (expires - now).clamp(0, DAY_MS);
            *deadline = Instant::now() + Duration::from_millis(remaining as u64);
            self.expires_unix_ms.store(Self::unix_now_ms() + remaining, Ordering::SeqCst);
            self.log("Connected.");
            self.events.connected();
        }

        // A permit left by an operation that finished before this point is spent here, then the finished operations are
        // read. An operation that finishes after this wakes the next poll instead.
        let _ = self.wake.notified().now_or_never();
        while let Ok((lane, map)) = done_rx.try_recv() {
            let state = &mut lanes[lane.index()];
            let id = state.active_id.clone().unwrap_or_default();
            state.result = Some(wire::result_message(&id, *generation, map));
        }
        for lane in Lane::ALL {
            let state = &mut lanes[lane.index()];
            if state.result.is_some() {
                let answer = self.send_result(state, *generation).await?;
                if answer == "end" {
                    return Ok(Flow::End);
                }
                if answer != "ack" {
                    return Err(NetError::Fatal("Result not acknowledged.".to_string()).into());
                }
                state.last_id = state.active_id.take().unwrap_or_default();
                state.result = None;
                state.rejected = false;
                self.report_busy(lanes, reported_busy);
            }
        }

        if lanes[0].busy() && lanes[1].busy() {
            // The relay answers a poll at once when no lane is free, so do not spin on it. Wait for a lane, and poll every
            // 2 s: that keeps the session marked alive and notices an operator end or an expiry within about 2 s.
            tokio::select! {
                _ = self.wake.notified() => return Ok(Flow::Continue),
                _ = sleep(BOTH_BUSY_WAIT) => {}
                _ = self.stop.stopped() => return Ok(Flow::Stopped),
            }
        }

        // While one lane works, keep polling for the other, so screen operations reach the client during a long command.
        // A finishing lane drops the parked poll through `wake`.
        let busy_lanes: Vec<&str> = Lane::ALL.iter().filter(|l| lanes[l.index()].busy()).map(|l| l.name()).collect();
        let paused = self.platform.paused_until_ms().map(|ms| ms + self.server_offset_ms());
        let poll = json!({
            "type": "poll", "generation": *generation, "busy": lanes[0].busy(), "busy_lanes": busy_lanes,
            "desktop": self.platform.desktop().as_str(), "paused_until": paused,
        });
        let started = Instant::now();
        let answer = tokio::select! {
            biased;
            _ = self.stop.stopped() => return Ok(Flow::Stopped),
            _ = self.wake.notified() => return Ok(Flow::Continue),
            _ = tokio::time::sleep_until(*deadline) => { self.stop.set(); return Ok(Flow::Stopped); }
            r = self.send(&poll, REQUEST_TIMEOUT) => r?,
        };
        self.note_driver(&answer);
        if *network_error {
            *network_error = false;
            self.log("Connection restored.");
            self.events.link(true);
        }
        let kind = text(&answer, "type");
        match kind.as_str() {
            "end" => return Ok(Flow::End),
            "idle" => {
                // An older relay answers a poll at once while a command runs: do not spin on it. (With both lanes busy the
                // wait at the top of the step already spaces the polls 2 s apart, so it is not doubled here.)
                let one_busy = lanes[0].busy() != lanes[1].busy();
                if one_busy && started.elapsed() < Duration::from_secs(1) {
                    tokio::select! {
                        _ = self.wake.notified() => {}
                        _ = sleep(BOTH_BUSY_WAIT) => {}
                        _ = self.stop.stopped() => return Ok(Flow::Stopped),
                    }
                }
                return Ok(Flow::Continue);
            }
            _ => {}
        }
        let frame = Frame::parse(&answer).map_err(|_| NetError::Fatal("Invalid support operation.".to_string()))?;
        let state = &mut lanes[frame.lane.index()];
        if state.busy() || frame.id == state.last_id {
            // The relay sent a frame again, or one for a busy lane: leave it.
            self.pause(REPEAT_WAIT).await;
            return Ok(Flow::Continue);
        }
        self.log(&frame.describe());
        state.active_id = Some(frame.id.clone());
        self.report_busy(lanes, reported_busy);
        self.spawn(frame, done_tx);
        self.pause(START_SETTLE).await;
        Ok(Flow::Continue)
    }

    fn report_busy(&self, lanes: &[LaneState; 2], reported: &mut usize) {
        let n = lanes.iter().filter(|l| l.busy()).count();
        if n != *reported {
            *reported = n;
            self.events.busy(n);
        }
    }

    /// Starts the operation on its own thread. The result goes to `done_tx` first and the wake comes after, so a woken loop always finds it.
    fn spawn(&self, frame: Frame, done_tx: &mpsc::UnboundedSender<(Lane, Map<String, Value>)>) {
        let platform = self.platform.clone();
        let ruled = self.ruled.clone();
        let stop = self.stop.clone();
        let wake = self.wake.clone();
        let tx = done_tx.clone();
        let lane = frame.lane;
        let work = move || {
            let ctx = crate::ops::Ctx { platform: &*platform, ruled: ruled.as_deref(), stop: &stop };
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| crate::ops::execute(&frame, &ctx)));
            let map = result.unwrap_or_else(|_| wire::error_result("the operation failed"));
            let _ = tx.send((lane, map));
            wake.notify_one();
        };
        if !(self.spawner)(Box::new(work)) {
            // No thread to run it on: the lane must still answer, or it would stay busy for ever.
            let _ = done_tx.send((lane, wire::error_result("could not start the operation")));
            self.wake.notify_one();
        }
    }
}

/// Says no to a session before any hello: the person declined, nobody was there to ask, or the Mac was busy. Returns
/// true when the relay took it (200) or the session is already gone (a 4xx). False on no answer or a server error, so
/// the caller sends it again while the pointer stays. Only a saved Mac's session accepts this today (a one-off link's
/// decline arrives with PR 5).
pub async fn send_decline<T: Transport>(transport: &T, reason: &str) -> bool {
    match transport.post(&json!({ "type": "decline", "reason": reason }), REQUEST_TIMEOUT).await {
        Ok(reply) => reply.status == 200 || (400..500).contains(&reply.status),
        Err(_) => false,
    }
}

/// What a new session does. It asks when the session says so or this Mac's own access is "ask". With nobody signed in,
/// only a full-control Mac set to any time runs (at the login window), and anything that would ask, or a limited Mac,
/// is declined as nobody. `accepted`: the person already allowed this session (a restarted service rejoins it).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Start {
    Host,
    Ask,
    DeclineNobody,
    DeclineBusy,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Target {
    /// Someone is signed in at the console.
    Console,
    /// Nobody is signed in.
    Nobody,
    /// The Mac cannot tell whom to ask.
    Busy,
}

pub fn decide_start(session_asks: bool, access: &str, control: &str, target: Target, accepted: bool) -> Start {
    let ask = session_asks || access != "any";
    match target {
        Target::Busy => Start::DeclineBusy,
        Target::Nobody => {
            if ask || control != "full" {
                Start::DeclineNobody
            } else {
                Start::Host
            }
        }
        Target::Console => {
            if ask && !accepted {
                Start::Ask
            } else {
                Start::Host
            }
        }
    }
}

/// Asks the person on a worker thread, and waits at most the 120 s they have plus a 15 s margin. No answer is no.
pub async fn ask_person(platform: Arc<dyn Platform>, by: String, team: String, full: bool, session_stop: Arc<Stop>) -> bool {
    let limit = Duration::from_millis(crate::platform::ASK_MS + crate::platform::ASK_MARGIN_MS);
    // The question has its own signal: it is closed when the session stops or when the time is up.
    let question = Stop::new();
    let watcher = tokio::spawn({
        let (question, session_stop) = (question.clone(), session_stop.clone());
        async move {
            session_stop.stopped().await;
            question.set();
        }
    });
    let (tx, rx) = tokio::sync::oneshot::channel();
    let spawned = std::thread::Builder::new().name("support-ask".into()).spawn({
        let question = question.clone();
        move || {
            let _ = tx.send(platform.ask(&by, &team, full, &question));
        }
    });
    let answer = match (spawned, tokio::time::timeout(limit, rx).await) {
        (Ok(_), Ok(Ok(yes))) => yes,
        // No answer in time, or the question failed: that is no.
        _ => false,
    };
    question.set();
    watcher.abort();
    answer && !session_stop.is_set()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::RunOutput;
    use crate::files::FileChunk;
    use crate::keys::KeyCombo;
    use crate::platform::{Desktop, Image, RunRequest, ScreenOutput, FAKE_SCREEN_JPEG};
    use crate::wire::{Control, HostInfo, ScreenAction};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Condvar;

    // ---- a scripted relay, on a clock the test controls ------------------------------------------------------------

    enum Step {
        Reply(u16, Value),
        Net(NetError),
        After(Duration, Box<Step>),
        Hang,
    }

    type Handler = Box<dyn FnMut(&Value) -> Step + Send>;

    struct Fake {
        handler: Mutex<Handler>,
        log: Mutex<Vec<(Duration, Value)>>,
        start: Instant,
        /// Requests dropped before they were answered: a parked poll the client gave up on.
        aborted: AtomicUsize,
    }

    impl Fake {
        fn new(handler: impl FnMut(&Value) -> Step + Send + 'static) -> Arc<Fake> {
            Arc::new(Fake { handler: Mutex::new(Box::new(handler)), log: Mutex::new(vec![]), start: Instant::now(), aborted: AtomicUsize::new(0) })
        }

        fn types(&self) -> Vec<String> {
            self.log.lock().unwrap().iter().map(|(_, v)| text(v, "type")).collect()
        }

        fn of_type(&self, t: &str) -> Vec<(Duration, Value)> {
            self.log.lock().unwrap().iter().filter(|(_, v)| text(v, "type") == t).cloned().collect()
        }
    }

    struct Guard<'a>(&'a AtomicUsize, bool);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            if !self.1 {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    fn run_step(step: Step) -> std::pin::Pin<Box<dyn Future<Output = Result<Reply, NetError>> + Send>> {
        Box::pin(async move {
            match step {
                Step::Reply(status, body) => Ok(Reply { status, body: (status == 200).then_some(body) }),
                Step::Net(e) => Err(e),
                Step::After(d, inner) => {
                    sleep(d).await;
                    run_step(*inner).await
                }
                Step::Hang => std::future::pending().await,
            }
        })
    }

    impl Transport for Fake {
        async fn post(&self, body: &Value, timeout: Duration) -> Result<Reply, NetError> {
            self.log.lock().unwrap().push((self.start.elapsed(), body.clone()));
            let step = (self.handler.lock().unwrap())(body);
            let mut guard = Guard(&self.aborted, false);
            let out = match tokio::time::timeout(timeout, run_step(step)).await {
                Ok(r) => r,
                Err(_) => Err(NetError::Offline("timed out".into())),
            };
            guard.1 = true;
            out
        }
    }

    // ---- a platform that can hold an operation until the test lets it go ----------------------------------------------

    #[derive(Clone, Default)]
    struct Gate(Arc<(Mutex<bool>, Condvar)>);
    impl Gate {
        /// Lets the held operation go and gives its thread real time to report. The test clock is paused, so it would
        /// otherwise run on while that thread is still finishing.
        fn open_and_settle(&self) {
            self.open();
            std::thread::sleep(Duration::from_millis(150));
        }
        fn wait(&self) {
            let (m, cv) = &*self.0;
            let g = cv.wait_while(m.lock().unwrap(), |open| !*open).unwrap();
            drop(g);
        }
        fn open(&self) {
            *self.0 .0.lock().unwrap() = true;
            self.0 .1.notify_all();
        }
    }

    #[derive(Default)]
    struct Stub {
        run_gate: Option<Gate>,
        screen_gate: Option<Gate>,
        runs: AtomicUsize,
        screens: AtomicUsize,
        huge_list: bool,
    }

    impl Platform for Stub {
        fn info(&self) -> HostInfo {
            HostInfo { machine: "Neo".into(), user: "ariel".into(), elevated: false, control: Control::Normal, uia: false }
        }
        fn run(&self, req: &RunRequest, _stop: &Stop) -> Result<RunOutput, String> {
            self.runs.fetch_add(1, Ordering::SeqCst);
            if let Some(g) = &self.run_gate {
                g.wait();
            }
            Ok(RunOutput { exit_code: Some(0), stdout: req.command.clone().into_bytes(), ..Default::default() })
        }
        fn put_file(&self, _: &str, d: &[u8], _: bool) -> Result<usize, String> {
            Ok(d.len())
        }
        fn get_file(&self, _: &str, _: u64, _: usize) -> Result<FileChunk, String> {
            Err("no".into())
        }
        fn screen(&self, _: &ScreenAction, _: &[KeyCombo], _: &Stop) -> Result<ScreenOutput, String> {
            self.screens.fetch_add(1, Ordering::SeqCst);
            if let Some(g) = &self.screen_gate {
                g.wait();
            }
            Ok(ScreenOutput {
                image: Some(Image { bytes: FAKE_SCREEN_JPEG.to_vec(), mime: "image/jpeg", width: 1280, height: 800 }),
                display: 0,
                displays: 1,
                desktop: Desktop::Default,
                text: None,
            })
        }
        fn programs(&self, _: &Frame) -> Result<Value, String> {
            Ok(if self.huge_list { json!({ "installed": [], "running": [], "pad": "x".repeat(800_000) }) } else { json!({}) })
        }
    }

    fn welcome(generation: i64, remaining_ms: i64) -> Step {
        Step::Reply(
            200,
            json!({ "type": "welcome", "generation": generation, "expires_at": 1_000_000 + remaining_ms, "server_time": 1_000_000, "driver": "tech@example.com" }),
        )
    }
    fn idle() -> Step {
        Step::Reply(200, json!({ "type": "idle" }))
    }
    fn ack() -> Step {
        Step::Reply(200, json!({ "type": "ack" }))
    }
    fn end() -> Step {
        Step::Reply(200, json!({ "type": "end" }))
    }
    fn run_frame(id: &str, command: &str) -> Step {
        Step::Reply(200, json!({ "type": "run", "id": id, "lane": "cmd", "command": command, "timeout_s": 30, "as": "user" }))
    }
    fn screen_frame(id: &str) -> Step {
        Step::Reply(200, json!({ "type": "screen", "id": id, "lane": "screen", "action": { "name": "screenshot", "display": 0 } }))
    }
    fn parked() -> Step {
        // The relay holds a poll for 25 s, then answers idle.
        Step::After(Duration::from_secs(25), Box::new(idle()))
    }

    /// Runs the operation where it is called. The paused test clock cannot then run ahead of a thread that is still
    /// finishing. Only for platforms that do not wait for anything.
    fn inline() -> Spawner {
        Arc::new(|work| {
            work();
            true
        })
    }

    fn client(fake: &Arc<Fake>, platform: Arc<dyn Platform>, startup_s: u64) -> (Arc<Client<Fake>>, Arc<Stop>) {
        client_with(fake, platform, startup_s, inline())
    }

    fn client_with(fake: &Arc<Fake>, platform: Arc<dyn Platform>, startup_s: u64, spawner: Spawner) -> (Arc<Client<Fake>>, Arc<Stop>) {
        let stop = Stop::new();
        let mut cfg = SessionConfig::new(Duration::from_secs(startup_s));
        cfg.end_reason = Some("owner".into());
        (Client::with_spawner(fake.clone(), platform, None, Arc::new(NoEvents), cfg, stop.clone(), spawner), stop)
    }

    // ---- the tests --------------------------------------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn a_command_goes_in_and_its_result_comes_out_then_the_relay_ends_it() {
        let mut stage = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(7, 60_000),
            "poll" => {
                stage += 1;
                match stage {
                    1 => run_frame("r1", "hi"),
                    2 => parked(),
                    _ => end(),
                }
            }
            "result" => ack(),
            _ => Step::Reply(400, Value::Null),
        });
        let (c, _stop) = client(&fake, Arc::new(Stub::default()), 60);
        // The second poll is parked until the result wakes the loop, so the third is the end.
        let ended = c.run().await;
        assert_eq!(ended, SessionEnd::Relay);
        let types = fake.types();
        assert_eq!(types[0], "hello");
        assert!(types.contains(&"result".to_string()), "{types:?}");
        let hello = &fake.of_type("hello")[0].1;
        assert_eq!(
            (hello["agent"].clone(), hello["caps"].clone(), hello["control"].clone(), hello["version"].clone()),
            (json!("macos-app-1"), json!(["screen", "lanes"]), json!("normal"), json!(crate::VERSION))
        );
        let result = &fake.of_type("result")[0].1;
        assert_eq!(
            (result["id"].clone(), result["generation"].clone(), result["ok"].clone(), result["exit_code"].clone()),
            (json!("r1"), json!(7), json!(true), json!(0))
        );
        assert_eq!(wire::unb64(result["stdout_b64"].as_str().unwrap()).unwrap(), b"hi");
        // The relay ended it, so the client says no goodbye.
        assert!(fake.of_type("end").is_empty());
        assert_eq!(c.driver(), "tech@example.com");
        assert_ne!(c.server_offset_ms(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_screenshot_is_served_while_a_command_runs_and_the_command_result_goes_out_at_once() {
        let run_gate = Gate::default();
        let platform = Arc::new(Stub { run_gate: Some(run_gate.clone()), ..Default::default() });
        let mut polls = 0;
        let mut results = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(3, 600_000),
            "poll" => {
                polls += 1;
                match polls {
                    1 => run_frame("slow", "x"),
                    2 => screen_frame("shot"),
                    _ if results >= 2 => end(),
                    _ => parked(),
                }
            }
            "result" => {
                results += 1;
                ack()
            }
            _ => Step::Reply(400, Value::Null),
        });
        let (c, _stop) = client_with(&fake, platform.clone(), 600, thread_spawner());
        let task = tokio::spawn({
            let c = c.clone();
            async move { c.run().await }
        });
        // Let the screenshot finish while the command is still held.
        while fake.of_type("result").is_empty() {
            // Real time for the operation's thread, then a little of the paused clock.
            std::thread::sleep(Duration::from_millis(20));
            sleep(Duration::from_millis(50)).await;
        }
        let polls_so_far = fake.of_type("poll");
        let second = &polls_so_far[1].1;
        assert_eq!(second["busy_lanes"], json!(["cmd"]), "a poll while the command runs names the busy lane");
        assert_eq!(second["busy"], true);
        let first_result = fake.of_type("result")[0].1.clone();
        assert_eq!(first_result["id"], "shot");
        assert!(first_result["image_b64"].as_str().unwrap().starts_with("/9j/"));
        // A poll is parked now. Let the command finish: the parked poll is dropped and the result goes out at once.
        sleep(Duration::from_secs(5)).await;
        let released_at = fake.start.elapsed();
        let aborted_before = fake.aborted.load(Ordering::SeqCst);
        run_gate.open_and_settle();
        assert_eq!(task.await.unwrap(), SessionEnd::Relay);
        let slow = fake.of_type("result").into_iter().find(|(_, v)| v["id"] == "slow").unwrap();
        assert!(slow.0 - released_at < Duration::from_secs(2), "the result waited {:?} for a poll to end", slow.0 - released_at);
        assert!(fake.aborted.load(Ordering::SeqCst) > aborted_before, "the parked poll was dropped, not left to run out its 25 s");
        assert_eq!(platform.runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_frame_the_relay_sends_twice_runs_once() {
        let platform = Arc::new(Stub::default());
        let mut polls = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(1, 600_000),
            "poll" => {
                polls += 1;
                match polls {
                    1 | 3 => run_frame("same", "once"),
                    2 => Step::After(Duration::from_secs(1), Box::new(idle())),
                    4 => run_frame("other", "twice"),
                    5 => parked(),
                    _ => end(),
                }
            }
            "result" => ack(),
            _ => Step::Reply(400, Value::Null),
        });
        let (c, _stop) = client(&fake, platform.clone(), 600);
        assert_eq!(c.run().await, SessionEnd::Relay);
        assert_eq!(platform.runs.load(Ordering::SeqCst), 2, "same ran once, other ran once");
        let ids: Vec<Value> = fake.of_type("result").iter().map(|(_, v)| v["id"].clone()).collect();
        assert_eq!(ids, vec![json!("same"), json!("other")]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_frame_for_a_lane_that_is_busy_is_left_alone() {
        let gate = Gate::default();
        let platform = Arc::new(Stub { run_gate: Some(gate.clone()), ..Default::default() });
        let mut polls = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(1, 600_000),
            "poll" => {
                polls += 1;
                match polls {
                    1 => run_frame("first", "a"),
                    2 => run_frame("second", "b"),
                    3 | 4 => parked(),
                    _ => end(),
                }
            }
            "result" => ack(),
            _ => Step::Reply(400, Value::Null),
        });
        let (c, _stop) = client_with(&fake, platform.clone(), 600, thread_spawner());
        let task = tokio::spawn({
            let c = c.clone();
            async move { c.run().await }
        });
        std::thread::sleep(Duration::from_millis(150));
        sleep(Duration::from_secs(10)).await;
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(platform.runs.load(Ordering::SeqCst), 1, "the second run was not started while the first held the lane");
        gate.open_and_settle();
        assert_eq!(task.await.unwrap(), SessionEnd::Relay);
        assert_eq!(fake.of_type("result").len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn with_both_lanes_busy_no_poll_parks_and_the_client_polls_every_two_seconds() {
        let (rg, sg) = (Gate::default(), Gate::default());
        let platform = Arc::new(Stub { run_gate: Some(rg.clone()), screen_gate: Some(sg.clone()), ..Default::default() });
        let mut polls = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(1, 600_000),
            "poll" => {
                polls += 1;
                match polls {
                    1 => run_frame("a", "x"),
                    2 => screen_frame("b"),
                    // Every lane busy: the relay answers at once with idle. With a lane free it parks the poll.
                    _ if m["busy_lanes"].as_array().map_or(0, Vec::len) == 2 => idle(),
                    _ => parked(),
                }
            }
            "result" => ack(),
            _ => Step::Reply(400, Value::Null),
        });
        let (c, stop) = client_with(&fake, platform, 600, thread_spawner());
        let task = tokio::spawn({
            let c = c.clone();
            async move { c.run().await }
        });
        sleep(Duration::from_secs(1)).await;
        let before = fake.of_type("poll").len();
        sleep(Duration::from_secs(10)).await;
        let busy_polls: Vec<_> = fake.of_type("poll").into_iter().filter(|(_, v)| v["busy_lanes"] == json!(["cmd", "screen"])).collect();
        let during = fake.of_type("poll").len() - before;
        assert!((4..=6).contains(&during), "{during} polls in 10 s with both lanes busy");
        assert!(busy_polls.len() >= 4);
        for pair in busy_polls.windows(2) {
            let gap = pair[1].0 - pair[0].0;
            assert!(gap >= Duration::from_millis(1900) && gap <= Duration::from_millis(2300), "gap {gap:?}");
        }
        rg.open_and_settle();
        sg.open_and_settle();
        sleep(Duration::from_secs(1)).await;
        stop.set();
        let _ = task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_result_the_relay_refuses_is_replaced_once_with_a_plain_error() {
        for refusal in [413u16, 400] {
            let mut refused = 0;
            let mut polls = 0;
            let fake = Fake::new(move |m| match text(m, "type").as_str() {
                "hello" => welcome(4, 600_000),
                "poll" => {
                    polls += 1;
                    match polls {
                        1 => run_frame("big", "x"),
                        2 => parked(),
                        _ => end(),
                    }
                }
                "result" => {
                    refused += 1;
                    // The first (real) result is refused. The plain replacement is accepted.
                    if refused == 1 {
                        Step::Reply(refusal, Value::Null)
                    } else {
                        ack()
                    }
                }
                _ => Step::Reply(400, Value::Null),
            });
            let (c, _s) = client(&fake, Arc::new(Stub::default()), 600);
            assert_eq!(c.run().await, SessionEnd::Relay);
            let results = fake.of_type("result");
            assert_eq!(results.len(), 2, "{refusal}");
            assert_eq!(results[0].1["ok"], true);
            let mut keys: Vec<_> = results[1].1.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            assert_eq!(keys, ["error", "generation", "id", "ok", "type"]);
            assert_eq!(
                (results[1].1["error"].clone(), results[1].1["id"].clone(), results[1].1["generation"].clone()),
                (json!("result rejected by relay"), json!("big"), json!(4))
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn when_even_the_replacement_is_refused_it_is_dropped_and_the_lane_carries_on() {
        let platform = Arc::new(Stub::default());
        let mut polls = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(1, 600_000),
            "poll" => {
                polls += 1;
                match polls {
                    1 => run_frame("a", "x"),
                    2 => parked(),
                    3 => run_frame("b", "y"),
                    4 => parked(),
                    _ => end(),
                }
            }
            "result" if m["id"] == "a" => Step::Reply(413, Value::Null),
            "result" => ack(),
            _ => Step::Reply(400, Value::Null),
        });
        let (c, _s) = client(&fake, platform.clone(), 600);
        assert_eq!(c.run().await, SessionEnd::Relay);
        // a: real result, replacement, nothing more. b ran after, so the lane was free again.
        let a: Vec<_> = fake.of_type("result").into_iter().filter(|(_, v)| v["id"] == "a").collect();
        assert_eq!(a.len(), 2);
        assert_eq!(platform.runs.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_result_over_750000_bytes_is_replaced_without_being_sent() {
        let platform = Arc::new(Stub { huge_list: true, ..Default::default() });
        let mut polls = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(2, 600_000),
            "poll" => {
                polls += 1;
                match polls {
                    1 => Step::Reply(200, json!({"type":"programs","id":"list","lane":"cmd","action":"list"})),
                    2 => parked(),
                    _ => end(),
                }
            }
            "result" => ack(),
            _ => Step::Reply(400, Value::Null),
        });
        // A saved Mac's session, so `programs` list is allowed.
        struct AllowAll;
        impl Ruled for AllowAll {
            fn state(&self) -> crate::rules::View {
                crate::rules::View { doc: Default::default(), tag: String::new(), stale: false, timed: true, now_s: 1, hours: Default::default() }
            }
            fn catch_up(&self, _: u64, _: &Stop) -> bool {
                true
            }
            fn close_target(&self, _: &Frame) -> Option<String> {
                None
            }
        }
        let stop = Stop::new();
        let c = Client::with_spawner(
            fake.clone(),
            platform,
            Some(Arc::new(AllowAll)),
            Arc::new(NoEvents),
            SessionConfig::new(Duration::from_secs(600)),
            stop,
            inline(),
        );
        assert_eq!(c.run().await, SessionEnd::Relay);
        let results = fake.of_type("result");
        assert_eq!(
            results.len(),
            1,
            "the oversized one never went out: {:?}",
            fake.log.lock().unwrap().iter().map(|(t, v)| (t.as_millis(), v.to_string().chars().take(80).collect::<String>())).collect::<Vec<_>>()
        );
        assert_eq!(results[0].1["error"], "result rejected by relay");
    }

    #[tokio::test(start_paused = true)]
    async fn a_server_error_on_a_result_is_retried_unchanged_three_seconds_later() {
        let mut polls = 0;
        let mut posts = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(1, 600_000),
            "poll" => {
                polls += 1;
                match polls {
                    1 => run_frame("r", "x"),
                    2 => parked(),
                    _ => end(),
                }
            }
            "result" => {
                posts += 1;
                if posts == 1 {
                    Step::Reply(500, Value::Null)
                } else {
                    ack()
                }
            }
            _ => Step::Reply(400, Value::Null),
        });
        let (c, _s) = client(&fake, Arc::new(Stub::default()), 600);
        assert_eq!(c.run().await, SessionEnd::Relay);
        let results = fake.of_type("result");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].1, results[1].1, "the same result, not a replacement");
        let gap = results[1].0 - results[0].0;
        assert!(gap >= Duration::from_secs(3) && gap < Duration::from_millis(3500), "{gap:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn access_refusals_end_the_client_quietly_and_other_errors_are_retried_every_three_seconds() {
        for status in [401u16, 403, 409, 410] {
            let fake = Fake::new(move |m| match text(m, "type").as_str() {
                "hello" => welcome(1, 600_000),
                _ => Step::Reply(status, Value::Null),
            });
            let (c, _s) = client(&fake, Arc::new(Stub::default()), 600);
            assert_eq!(c.run().await, SessionEnd::Relay, "{status}");
            assert!(fake.of_type("end").is_empty(), "no goodbye after {status}");
            assert_eq!(fake.of_type("poll").len(), 1);
        }
        // A 500 on the poll is retried every 3 s, with no backoff.
        let mut polls = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(1, 600_000),
            _ => {
                polls += 1;
                if polls <= 4 {
                    Step::Reply(500, Value::Null)
                } else {
                    end()
                }
            }
        });
        let (c, _s) = client(&fake, Arc::new(Stub::default()), 600);
        assert_eq!(c.run().await, SessionEnd::Relay);
        let at: Vec<Duration> = fake.of_type("poll").iter().map(|(t, _)| *t).collect();
        assert_eq!(at.len(), 5);
        for pair in at.windows(2) {
            let gap = pair[1] - pair[0];
            assert!(gap >= Duration::from_secs(3) && gap < Duration::from_millis(3200), "{gap:?}");
        }
        // A dropped connection is the same.
        let mut n = 0;
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(1, 600_000),
            _ => {
                n += 1;
                if n == 1 {
                    Step::Net(NetError::Offline("reset".into()))
                } else {
                    end()
                }
            }
        });
        let (c, _s) = client(&fake, Arc::new(Stub::default()), 600);
        assert_eq!(c.run().await, SessionEnd::Relay);
        assert_eq!(fake.of_type("poll").len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn an_answer_the_client_cannot_use_ends_it() {
        let bad: Vec<Step> = vec![
            Step::Reply(200, json!({ "type": "dance", "id": "x" })),
            Step::Reply(200, json!({ "type": "run", "command": "x" })),
            Step::Net(NetError::Fatal("too big".into())),
        ];
        for step in bad {
            let mut step = Some(step);
            let fake = Fake::new(move |m| match text(m, "type").as_str() {
                "hello" => welcome(1, 600_000),
                _ => step.take().unwrap_or_else(end),
            });
            let (c, _s) = client(&fake, Arc::new(Stub::default()), 600);
            assert!(matches!(c.run().await, SessionEnd::Failed(_)));
            // It had said hello, so it says goodbye.
            assert_eq!(fake.of_type("end").len(), 1);
        }
        // A handshake that is not a welcome.
        let fake = Fake::new(|_| Step::Reply(200, json!({ "type": "idle" })));
        let (c, _s) = client(&fake, Arc::new(Stub::default()), 600);
        assert_eq!(c.run().await, SessionEnd::Failed("Invalid support handshake.".into()));
        assert!(fake.of_type("end").is_empty(), "never attached, so no goodbye");
    }

    #[tokio::test(start_paused = true)]
    async fn the_startup_window_ends_a_client_that_never_connects() {
        let fake = Fake::new(|_| Step::Net(NetError::Offline("down".into())));
        let (c, _s) = client(&fake, Arc::new(Stub::default()), 10);
        let started = Instant::now();
        assert_eq!(c.run().await, SessionEnd::Stopped);
        let took = started.elapsed();
        assert!(took >= Duration::from_secs(10) && took < Duration::from_secs(14), "{took:?}");
        assert!(fake.of_type("end").is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn the_sessions_end_time_comes_from_the_welcome_and_the_goodbye_carries_the_reason() {
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(9, 20_000),
            "poll" => parked(),
            _ => ack(),
        });
        let (c, _s) = client(&fake, Arc::new(Stub::default()), 600);
        let started = Instant::now();
        assert_eq!(c.run().await, SessionEnd::Stopped);
        let took = started.elapsed();
        assert!(took >= Duration::from_secs(20) && took < Duration::from_secs(22), "{took:?}");
        let bye = fake.of_type("end");
        assert_eq!(bye.len(), 1);
        assert_eq!((bye[0].1["generation"].clone(), bye[0].1["reason"].clone()), (json!(9), json!("owner")));
        assert!(c.expires_at_ms() > 0);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_ends_a_parked_poll_and_says_goodbye() {
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(2, 600_000),
            "poll" => Step::Hang,
            _ => ack(),
        });
        let (c, stop) = client(&fake, Arc::new(Stub::default()), 600);
        let task = tokio::spawn({
            let c = c.clone();
            async move { c.run().await }
        });
        sleep(Duration::from_secs(5)).await;
        stop.set();
        assert_eq!(task.await.unwrap(), SessionEnd::Stopped);
        assert_eq!(fake.of_type("end").len(), 1);
        assert_eq!(fake.aborted.load(Ordering::SeqCst), 1, "the parked poll was dropped");
    }

    #[tokio::test(start_paused = true)]
    async fn the_poll_reports_the_desktop_and_a_pause() {
        let fake = Fake::new(move |m| match text(m, "type").as_str() {
            "hello" => welcome(1, 600_000),
            "poll" => end(),
            _ => ack(),
        });
        let (c, _s) = client(&fake, Arc::new(Stub::default()), 600);
        c.run().await;
        let poll = &fake.of_type("poll")[0].1;
        assert_eq!(
            (poll["generation"].clone(), poll["busy"].clone(), poll["busy_lanes"].clone(), poll["desktop"].clone(), poll["paused_until"].clone()),
            (json!(1), json!(false), json!([]), json!("default"), Value::Null)
        );
    }

    // ---- the real transport, against a server on loopback --------------------------------------------------------------

    use crate::testutil::one_shot;
    use tokio::net::TcpListener;

    const SID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[tokio::test]
    async fn a_saved_mac_sends_its_device_key_as_a_bearer_and_no_attach_key() {
        let (origin, seen) = one_shot("HTTP/1.1 200 OK", br#"{"type":"idle"}"#.to_vec(), 0).await;
        let t = HttpTransport::new(&origin, SID, Auth::Device("smd1.default.abcdefghijklmnopqrst.secret".into())).unwrap();
        let reply = t.post(&json!({"type":"poll","generation":1}), Duration::from_secs(5)).await.unwrap();
        assert_eq!((reply.status, reply.body.unwrap()["type"].clone()), (200, json!("idle")));
        let req = seen.await.unwrap().to_lowercase();
        assert!(req.starts_with(&format!("post /agent?sid={SID} http/1.1")), "{req}");
        assert!(req.contains("authorization: bearer smd1.default.abcdefghijklmnopqrst.secret"));
        assert!(!req.contains("x-attach-key"));
        assert!(!req.contains("\r\norigin:"), "the relay refuses any Origin header");
        assert!(req.contains("content-type: application/json"));
        assert!(req.ends_with(r#"{"generation":1,"type":"poll"}"#), "{req}");
    }

    #[tokio::test]
    async fn a_one_off_session_sends_its_link_key_as_x_attach_key_and_no_bearer() {
        let one = OneOff::new(SID, &"ab".repeat(32)).unwrap();
        let (origin, seen) = one_shot("HTTP/1.1 200 OK", br#"{"type":"idle"}"#.to_vec(), 0).await;
        let t = HttpTransport::new(&origin, &one.sid, one.auth()).unwrap();
        t.post(&json!({"type":"hello"}), Duration::from_secs(5)).await.unwrap();
        let req = seen.await.unwrap().to_lowercase();
        assert!(req.contains(&format!("x-attach-key: {}", "ab".repeat(32))));
        assert!(!req.contains("authorization"));
        assert!(!req.contains("\r\norigin:"));
    }

    #[test]
    fn one_off_credentials_must_be_64_lowercase_hex_each() {
        assert!(OneOff::new(SID, SID).is_ok());
        assert!(OneOff::new("short", SID).is_err());
        assert!(OneOff::new(SID, &"AB".repeat(32)).is_err());
        assert!(HttpTransport::new("http://relay.example.com", SID, Auth::Attach("k".into())).is_err(), "plain http is for loopback only");
        assert!(HttpTransport::new("https://relay.example.com/path", SID, Auth::Attach("k".into())).is_err());
        assert!(HttpTransport::new("https://relay.example.com", "nothex", Auth::Attach("k".into())).is_err());
    }

    #[tokio::test]
    async fn the_real_transport_reads_statuses_the_way_the_client_needs() {
        for (line, expect) in [
            ("HTTP/1.1 401 Unauthorized", 401u16),
            ("HTTP/1.1 410 Gone", 410),
            ("HTTP/1.1 413 Payload Too Large", 413),
            ("HTTP/1.1 500 Internal Server Error", 500),
        ] {
            let (origin, _h) = one_shot(line, b"{}".to_vec(), 0).await;
            let t = HttpTransport::new(&origin, SID, Auth::Attach("k".into())).unwrap();
            let r = t.post(&json!({}), Duration::from_secs(5)).await.unwrap();
            assert_eq!((r.status, r.body.is_none()), (expect, true));
        }
        // A redirect is not followed and not understood: the client ends.
        let (origin, _h) = one_shot("HTTP/1.1 302 Found", b"{}".to_vec(), 0).await;
        let t = HttpTransport::new(&origin, SID, Auth::Attach("k".into())).unwrap();
        assert!(matches!(t.post(&json!({}), Duration::from_secs(5)).await, Err(NetError::Fatal(_))));
        // A 200 that is not JSON ends it too.
        let (origin, _h) = one_shot("HTTP/1.1 200 OK", b"not json".to_vec(), 0).await;
        let t = HttpTransport::new(&origin, SID, Auth::Attach("k".into())).unwrap();
        assert!(matches!(t.post(&json!({}), Duration::from_secs(5)).await, Err(NetError::Fatal(_))));
        // An answer over 750,000 bytes is refused.
        let (origin, _h) = one_shot("HTTP/1.1 200 OK", vec![b' '; AGENT_BODY_MAX + 1], 0).await;
        let t = HttpTransport::new(&origin, SID, Auth::Attach("k".into())).unwrap();
        assert_eq!(t.post(&json!({}), Duration::from_secs(5)).await.unwrap_err(), NetError::Fatal("Support response too large.".into()));
        // Nobody listening, and nobody answering in time: offline, to retry.
        let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", dead.local_addr().unwrap());
        drop(dead);
        let t = HttpTransport::new(&origin, SID, Auth::Attach("k".into())).unwrap();
        assert!(matches!(t.post(&json!({}), Duration::from_secs(5)).await, Err(NetError::Offline(_))));
        let (origin, _h) = one_shot("HTTP/1.1 200 OK", b"{}".to_vec(), 2_000).await;
        let t = HttpTransport::new(&origin, SID, Auth::Attach("k".into())).unwrap();
        assert!(matches!(t.post(&json!({}), Duration::from_millis(200)).await, Err(NetError::Offline(_))));
    }

    // ---- asking, declining, starting ---------------------------------------------------------------------------------------

    #[test]
    fn a_new_session_asks_declines_or_hosts_as_the_windows_service_does() {
        use Start::*;
        use Target::*;
        // (session asks, access, control, target, accepted) -> start
        let table = [
            (true, "any", "full", Console, false, Ask),
            (false, "ask", "full", Console, false, Ask),
            (false, "any", "full", Console, false, Host),
            (true, "any", "full", Console, true, Host),
            (false, "ask", "limited", Console, true, Host),
            (false, "any", "limited", Console, false, Host),
            (false, "any", "full", Nobody, false, Host),
            (true, "any", "full", Nobody, false, DeclineNobody),
            (false, "ask", "full", Nobody, false, DeclineNobody),
            (false, "any", "limited", Nobody, false, DeclineNobody),
            (false, "any", "full", Busy, false, DeclineBusy),
            (true, "ask", "limited", Busy, true, DeclineBusy),
        ];
        for (asks, access, control, target, accepted, expect) in table {
            assert_eq!(decide_start(asks, access, control, target, accepted), expect, "{asks} {access} {control} {target:?} {accepted}");
        }
    }

    #[tokio::test]
    async fn a_decline_counts_as_sent_on_200_or_any_4xx_and_is_resent_otherwise() {
        for (status, sent) in [(200u16, true), (400, true), (401, true), (410, true), (500, false), (503, false)] {
            let fake = Fake::new(move |_| Step::Reply(status, json!({"type":"end"})));
            assert_eq!(send_decline(&*fake, "declined").await, sent, "{status}");
            assert_eq!(fake.log.lock().unwrap()[0].1, json!({"type":"decline","reason":"declined"}));
        }
        let fake = Fake::new(|_| Step::Net(NetError::Offline("x".into())));
        assert!(!send_decline(&*fake, "nobody").await);
    }

    struct Asker {
        answer: bool,
        hold: bool,
        asked: AtomicUsize,
    }
    impl Platform for Asker {
        fn info(&self) -> HostInfo {
            Stub::default().info()
        }
        fn run(&self, _: &RunRequest, _: &Stop) -> Result<RunOutput, String> {
            Err("x".into())
        }
        fn put_file(&self, _: &str, _: &[u8], _: bool) -> Result<usize, String> {
            Err("x".into())
        }
        fn get_file(&self, _: &str, _: u64, _: usize) -> Result<FileChunk, String> {
            Err("x".into())
        }
        fn screen(&self, _: &ScreenAction, _: &[KeyCombo], _: &Stop) -> Result<ScreenOutput, String> {
            Err("x".into())
        }
        fn ask(&self, _: &str, _: &str, _: bool, stop: &Stop) -> bool {
            self.asked.fetch_add(1, Ordering::SeqCst);
            if self.hold {
                stop.wait(Duration::from_secs(3600));
                return true;
            }
            self.answer
        }
    }

    #[tokio::test]
    async fn the_persons_answer_is_the_answer() {
        let yes = Arc::new(Asker { answer: true, hold: false, asked: AtomicUsize::new(0) });
        assert!(ask_person(yes.clone(), "a".into(), "t".into(), false, Stop::new()).await);
        assert_eq!(yes.asked.load(Ordering::SeqCst), 1);
        let no = Arc::new(Asker { answer: false, hold: false, asked: AtomicUsize::new(0) });
        assert!(!ask_person(no, "a".into(), "t".into(), false, Stop::new()).await);
    }

    #[tokio::test(start_paused = true)]
    async fn no_answer_in_135_seconds_is_no() {
        // Nobody answers: the person's 120 s and the 15 s margin pass, and that is no, even if the question later says yes.
        let silent = Arc::new(Asker { answer: true, hold: true, asked: AtomicUsize::new(0) });
        let started = Instant::now();
        assert!(!ask_person(silent.clone(), "a".into(), "t".into(), true, Stop::new()).await);
        let took = started.elapsed();
        assert!(took >= Duration::from_secs(135) && took < Duration::from_secs(136), "{took:?}");
        // A session that is stopped meanwhile never counts a yes.
        let stop = Stop::new();
        let s2 = stop.clone();
        tokio::spawn(async move {
            sleep(Duration::from_secs(5)).await;
            s2.set();
        });
        assert!(!ask_person(silent, "a".into(), "t".into(), true, stop).await);
    }
}

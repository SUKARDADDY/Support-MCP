//! The root service's socket: who may connect (`peer`), what they may say (`ipc`), and the helpers that registered.
//!
//! Every connection is checked before its first byte is read. A peer that fails the check, sends a malformed frame,
//! a message it may not send, or nothing for too long, is dropped without an answer. A request link answers each
//! request with the status (or the setup or uninstall outcome). A helper link carries the service's requests to the
//! helper and the helper's replies and ticks back; only the helper of the person at the console (or the login
//! window's, as root, while nobody is signed in) can register, and a newer registration for the same session
//! replaces the older one.

use crate::frame::{self, FrameError};
use crate::ipc::{self, FromHelper, HelperSession, Opening, Request, SetupRequest, Tick, ToHelper};
use crate::peer::{self, Inspector, Peer};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use support_core::stop::Stop;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

/// A new connection must send its first frame within this long.
pub const OPENING_IDLE: Duration = Duration::from_secs(10);
/// A request link may wait this long between requests.
pub const REQUEST_IDLE: Duration = Duration::from_secs(60);
/// A helper ticks every second; one silent for this long is gone.
pub const HELPER_IDLE: Duration = Duration::from_secs(10);
/// A tick older than this does not count (the helper is busy or stuck).
pub const TICK_FRESH: Duration = Duration::from_secs(5);
pub const MAX_CONNECTIONS: usize = 32;
pub const MAX_PER_UID: usize = 6;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the service does for a request. The server has checked who asks; `peer` says who it was.
pub trait Api: Send + Sync + 'static {
    fn status(&self) -> Map<String, Value>;
    fn refresh(&self);
    fn allow_any_time(&self);
    fn end_session(&self);
    fn setup(self: Arc<Self>, req: SetupRequest, peer: Peer) -> BoxFuture<'static, Map<String, Value>>;
    fn uninstall(self: Arc<Self>, auth: [u8; ipc::AUTH_LEN], peer: Peer) -> BoxFuture<'static, Map<String, Value>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperError {
    /// No helper for that session.
    None,
    /// The helper's link closed before it answered.
    Gone,
    Timeout,
    Stopped,
}

/// One registered helper.
pub struct HelperConn {
    conn: u64,
    pub uid: u32,
    pub session: HelperSession,
    out: mpsc::UnboundedSender<Map<String, Value>>,
    pending: Mutex<HashMap<u64, std::sync::mpsc::Sender<Map<String, Value>>>>,
    tick: Mutex<Option<(Tick, Instant)>>,
    closed: AtomicBool,
}

impl HelperConn {
    /// The last tick, when it is fresh.
    pub fn tick(&self) -> Option<Tick> {
        self.tick.lock().unwrap().filter(|(_, at)| at.elapsed() < TICK_FRESH).map(|(t, _)| t)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

/// The helpers that registered, one per uid (0 is the login window's).
#[derive(Default)]
pub struct Helpers {
    by_uid: Mutex<HashMap<u32, Arc<HelperConn>>>,
    next_id: AtomicU64,
}

impl Helpers {
    pub fn new() -> Arc<Helpers> {
        Arc::new(Helpers { by_uid: Mutex::default(), next_id: AtomicU64::new(1) })
    }

    pub fn get(&self, uid: u32) -> Option<Arc<HelperConn>> {
        self.by_uid.lock().unwrap().get(&uid).filter(|h| !h.is_closed()).cloned()
    }

    fn register(&self, h: Arc<HelperConn>) {
        if let Some(old) = self.by_uid.lock().unwrap().insert(h.uid, h) {
            old.closed.store(true, Ordering::SeqCst);
            // Its pending requests learn it is gone; its link is dropped when its reader next looks.
            old.pending.lock().unwrap().clear();
        }
    }

    fn unregister(&self, h: &HelperConn) {
        let mut map = self.by_uid.lock().unwrap();
        if map.get(&h.uid).is_some_and(|cur| cur.conn == h.conn) {
            map.remove(&h.uid);
        }
    }

    /// Sends one request to the helper of `uid` and waits for its answer. Blocking: it runs on a command's thread.
    /// When `stop` is set first, the helper is told to cancel.
    pub fn request(&self, uid: u32, make: impl FnOnce(u64) -> ToHelper, timeout: Duration, stop: &Stop) -> Result<Map<String, Value>, HelperError> {
        let h = self.get(uid).ok_or(HelperError::None)?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = std::sync::mpsc::channel();
        h.pending.lock().unwrap().insert(id, tx);
        if h.out.send(ipc::to_helper_message(&make(id))).is_err() {
            h.pending.lock().unwrap().remove(&id);
            return Err(HelperError::Gone);
        }
        let until = Instant::now() + timeout;
        let result = loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(body) => break Ok(body),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break Err(HelperError::Gone),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            if stop.is_set() {
                let _ = h.out.send(ipc::to_helper_message(&ToHelper::Cancel { id }));
                break Err(HelperError::Stopped);
            }
            if Instant::now() >= until {
                let _ = h.out.send(ipc::to_helper_message(&ToHelper::Cancel { id }));
                break Err(HelperError::Timeout);
            }
            if h.is_closed() {
                break Err(HelperError::Gone);
            }
        };
        h.pending.lock().unwrap().remove(&id);
        result
    }
}

pub struct Server {
    inspector: Arc<dyn Inspector>,
    api: Arc<dyn Api>,
    pub helpers: Arc<Helpers>,
    expected_exe: String,
    open: AtomicUsize,
    per_uid: Mutex<HashMap<u32, usize>>,
    next_conn: AtomicU64,
}

/// Counts a connection while it lives.
struct Slot<'a> {
    server: &'a Server,
    uid: Option<u32>,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.server.open.fetch_sub(1, Ordering::SeqCst);
        if let Some(uid) = self.uid {
            let mut m = self.server.per_uid.lock().unwrap();
            if let Some(n) = m.get_mut(&uid) {
                *n -= 1;
                if *n == 0 {
                    m.remove(&uid);
                }
            }
        }
    }
}

impl Server {
    pub fn new(inspector: Arc<dyn Inspector>, api: Arc<dyn Api>, helpers: Arc<Helpers>, expected_exe: &str) -> Arc<Server> {
        Arc::new(Server {
            inspector,
            api,
            helpers,
            expected_exe: expected_exe.to_string(),
            open: AtomicUsize::new(0),
            per_uid: Mutex::default(),
            next_conn: AtomicU64::new(1),
        })
    }

    /// Accepts connections until `stop`.
    pub async fn serve(self: Arc<Self>, listener: UnixListener, stop: Arc<Stop>) {
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        let me = self.clone();
                        tokio::spawn(async move { me.handle(stream).await });
                    }
                }
                _ = stop.stopped() => return,
            }
        }
    }

    async fn handle(self: Arc<Self>, stream: UnixStream) {
        if self.open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.open.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let mut slot = Slot { server: &self, uid: None };
        // The peer is read from the kernel before anything it sent is looked at.
        let fd = stream.as_raw_fd();
        let inspector = self.inspector.clone();
        let Ok(Ok(facts)) = tokio::task::spawn_blocking(move || inspector.inspect(fd)).await else { return };
        let console = self.inspector.console_uid();
        let Ok(peer) = peer::decide(&facts, &self.expected_exe, console) else { return };
        {
            let mut m = self.per_uid.lock().unwrap();
            let n = m.entry(peer.uid()).or_insert(0);
            if *n >= MAX_PER_UID {
                return;
            }
            *n += 1;
            slot.uid = Some(peer.uid());
        }
        let (mut rd, mut wr) = stream.into_split();
        let Ok(first) = frame::read(&mut rd, Some(OPENING_IDLE)).await else { return };
        match ipc::read_opening(&first) {
            Some(Opening::Helper(session)) => {
                if !peer::may_serve(peer, session, self.inspector.console_uid()) {
                    return;
                }
                self.helper_link(peer, session, rd, wr).await;
            }
            Some(Opening::Request(r)) => {
                let mut next = Some(r);
                while let Some(r) = next.take() {
                    let answer = self.answer(r, peer).await;
                    if frame::write(&mut wr, &answer).await.is_err() {
                        return;
                    }
                    match frame::read(&mut rd, Some(REQUEST_IDLE)).await {
                        Ok(m) => next = ipc::read_request(&m),
                        Err(_) => return,
                    }
                }
            }
            None => {}
        }
        drop(slot);
    }

    async fn answer(&self, r: Request, peer: Peer) -> Map<String, Value> {
        match r {
            Request::Status => {}
            Request::Refresh => self.api.refresh(),
            Request::AllowAnyTime => self.api.allow_any_time(),
            Request::EndSession => {
                if peer::may_end_session(peer, self.inspector.console_uid()) {
                    self.api.end_session();
                }
            }
            Request::Setup(s) => return self.api.clone().setup(s, peer).await,
            Request::Uninstall { auth } => return self.api.clone().uninstall(auth, peer).await,
        }
        self.api.status()
    }

    async fn helper_link(
        &self,
        peer: Peer,
        session: HelperSession,
        mut rd: tokio::net::unix::OwnedReadHalf,
        mut wr: tokio::net::unix::OwnedWriteHalf,
    ) {
        let (tx, mut rx) = mpsc::unbounded_channel::<Map<String, Value>>();
        let h = Arc::new(HelperConn {
            conn: self.next_conn.fetch_add(1, Ordering::SeqCst),
            uid: peer.uid(),
            session,
            out: tx,
            pending: Mutex::default(),
            tick: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        self.helpers.register(h.clone());
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if frame::write(&mut wr, &m).await.is_err() {
                    break;
                }
            }
        });
        loop {
            if h.is_closed() {
                break;
            }
            let m = match frame::read(&mut rd, Some(HELPER_IDLE)).await {
                Ok(m) => m,
                Err(FrameError::Idle) | Err(_) => break,
            };
            // The person may have switched away: a helper serves only while its session is at the console.
            if !peer::may_serve(peer, session, self.inspector.console_uid()) {
                break;
            }
            match ipc::read_from_helper(&m) {
                Some(FromHelper::Tick(t)) => *h.tick.lock().unwrap() = Some((t, Instant::now())),
                Some(FromHelper::Reply { id, body }) => {
                    // A reply to a request that timed out or was cancelled has nobody waiting: dropped.
                    if let Some(tx) = h.pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(body);
                    }
                }
                None => break,
            }
        }
        h.closed.store(true, Ordering::SeqCst);
        h.pending.lock().unwrap().clear();
        self.helpers.unregister(&h);
        writer.abort();
    }
}

/// Makes the socket's folder (root's, 0755, not a link) and binds the socket in it (0666), replacing a stale one.
/// `owner` is the uid the folder must belong to: 0 in the service, the test's own uid in tests.
pub fn bind(dir: &Path, socket: &Path, owner: u32) -> Result<UnixListener, String> {
    match std::fs::symlink_metadata(dir) {
        Ok(m) => {
            if !m.file_type().is_dir() || m.uid() != owner {
                return Err(format!("{} is not a folder of uid {owner}", dir.display()));
            }
            if m.mode() & 0o7777 != 0o755 {
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            }
        }
        Err(_) => {
            std::fs::create_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
    }
    if std::fs::symlink_metadata(socket).is_ok() {
        std::fs::remove_file(socket).map_err(|e| format!("{}: {e}", socket.display()))?;
    }
    let listener = UnixListener::bind(socket).map_err(|e| format!("{}: {e}", socket.display()))?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o666)).map_err(|e| e.to_string())?;
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peer::PeerFacts;
    use serde_json::json;
    use std::sync::atomic::AtomicU32;

    const BIN: &str = "/Applications/Support.app/Contents/MacOS/support";

    /// Every connection gets the facts set here.
    struct FakeInspector {
        facts: Mutex<PeerFacts>,
        console: Mutex<Option<u32>>,
        inspected: AtomicU32,
    }

    impl Inspector for FakeInspector {
        fn inspect(&self, _fd: std::os::fd::RawFd) -> Result<PeerFacts, String> {
            self.inspected.fetch_add(1, Ordering::SeqCst);
            Ok(self.facts.lock().unwrap().clone())
        }
        fn console_uid(&self) -> Option<u32> {
            *self.console.lock().unwrap()
        }
    }

    #[derive(Default)]
    struct FakeApi {
        log: Mutex<Vec<String>>,
    }

    impl Api for FakeApi {
        fn status(&self) -> Map<String, Value> {
            json!({"state":"active"}).as_object().unwrap().clone()
        }
        fn refresh(&self) {
            self.log.lock().unwrap().push("refresh".into());
        }
        fn allow_any_time(&self) {
            self.log.lock().unwrap().push("any".into());
        }
        fn end_session(&self) {
            self.log.lock().unwrap().push("end".into());
        }
        fn setup(self: Arc<Self>, req: SetupRequest, peer: Peer) -> BoxFuture<'static, Map<String, Value>> {
            self.log.lock().unwrap().push(format!("setup {} {:?}", req.name, peer));
            Box::pin(async { json!({"ok":true}).as_object().unwrap().clone() })
        }
        fn uninstall(self: Arc<Self>, _auth: [u8; 32], peer: Peer) -> BoxFuture<'static, Map<String, Value>> {
            self.log.lock().unwrap().push(format!("uninstall {peer:?}"));
            Box::pin(async { json!({"ok":false,"error":"no"}).as_object().unwrap().clone() })
        }
    }

    struct Rig {
        dir: std::path::PathBuf,
        sock: std::path::PathBuf,
        inspector: Arc<FakeInspector>,
        api: Arc<FakeApi>,
        server: Arc<Server>,
        stop: Arc<Stop>,
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            self.stop.set();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn me() -> u32 {
        // SAFETY: a getter.
        unsafe { libc::getuid() }
    }

    async fn rig(name: &str) -> Rig {
        // A short folder: a socket path is at most 104 bytes on a Mac, and its temp folder is long.
        let dir = std::path::PathBuf::from(format!("/tmp/smcp-sock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sock = dir.join("helper.sock");
        let listener = bind(&dir, &sock, me()).unwrap();
        let inspector = Arc::new(FakeInspector {
            facts: Mutex::new(PeerFacts { pid: 400, uid: 501, exe: Some(BIN.into()), code_path: Some(BIN.into()), signature_ok: true }),
            console: Mutex::new(Some(501)),
            inspected: AtomicU32::new(0),
        });
        let api = Arc::new(FakeApi::default());
        let server = Server::new(inspector.clone(), api.clone(), Helpers::new(), BIN);
        let stop = Stop::new();
        tokio::spawn(server.clone().serve(listener, stop.clone()));
        Rig { dir, sock, inspector, api, server, stop }
    }

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    /// Sends frames and returns what came back before the server closed or went quiet.
    async fn exchange(sock: &Path, frames: &[Vec<u8>]) -> Vec<Map<String, Value>> {
        let mut s = UnixStream::connect(sock).await.unwrap();
        let mut out = vec![];
        for f in frames {
            use tokio::io::AsyncWriteExt;
            if s.write_all(f).await.is_err() {
                break;
            }
            match frame::read(&mut s, Some(Duration::from_millis(500))).await {
                Ok(m) => out.push(m),
                Err(_) => break,
            }
        }
        out
    }

    fn enc(v: Value) -> Vec<u8> {
        frame::encode(&obj(v)).unwrap()
    }

    #[tokio::test]
    async fn the_socket_folder_and_socket_have_the_pinned_modes() {
        let r = rig("modes").await;
        assert_eq!(std::fs::metadata(&r.dir).unwrap().mode() & 0o7777, 0o755);
        assert_eq!(std::fs::metadata(&r.sock).unwrap().mode() & 0o777, 0o666);
        // A link in the folder's place is refused, and so is a folder of someone else.
        let link = r.dir.with_extension("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&r.dir, &link).unwrap();
        assert!(bind(&link, &link.join("s.sock"), me()).is_err());
        std::fs::remove_file(&link).unwrap();
        assert!(bind(&r.dir, &r.dir.join("x.sock"), me() + 1).is_err());
    }

    #[tokio::test]
    async fn a_verified_peer_gets_answers_to_its_requests() {
        let r = rig("ok").await;
        let got = exchange(&r.sock, &[enc(json!({"type":"status"})), enc(json!({"type":"refresh"})), enc(json!({"type":"allow_any_time"}))]).await;
        assert_eq!(got.len(), 3);
        assert_eq!(got[0]["state"], "active");
        assert_eq!(*r.api.log.lock().unwrap(), vec!["refresh", "any"]);
    }

    #[tokio::test]
    async fn a_peer_that_fails_any_check_gets_nothing() {
        let r = rig("refused").await;
        type Change = Box<dyn Fn(&mut PeerFacts)>;
        let cases: Vec<Change> = vec![
            Box::new(|f| f.signature_ok = false),
            Box::new(|f| f.exe = Some("/tmp/support".into())),
            Box::new(|f| f.code_path = None),
            Box::new(|f| f.uid = 502),
        ];
        for change in cases {
            let mut f = PeerFacts { pid: 400, uid: 501, exe: Some(BIN.into()), code_path: Some(BIN.into()), signature_ok: true };
            change(&mut f);
            *r.inspector.facts.lock().unwrap() = f;
            assert!(exchange(&r.sock, &[enc(json!({"type":"status"}))]).await.is_empty());
        }
        assert!(r.api.log.lock().unwrap().is_empty());
        assert!(r.inspector.inspected.load(Ordering::SeqCst) >= 4, "each connection was inspected");
    }

    #[tokio::test]
    async fn a_malformed_or_unknown_frame_closes_the_link_without_an_answer() {
        let r = rig("malformed").await;
        let mut huge = ((frame::FRAME_MAX + 1) as u32).to_be_bytes().to_vec();
        huge.extend(b"{}");
        for bad in [
            enc(json!({"type":"nope"})),
            enc(json!({"type":"status","extra":true})),
            enc(json!({"type":"reply","id":1,"body":{}})),
            enc(json!({"type":"tick","screen":true,"accessibility":true,"customer_ago_ms":0,"locked":false})),
            vec![0, 0, 0, 2, b'[', b']'],
            vec![0, 0, 0, 0],
            huge,
        ] {
            assert!(exchange(&r.sock, &[bad]).await.is_empty());
        }
        // A good request, then a bad one: the first is answered, then the link closes.
        let got = exchange(&r.sock, &[enc(json!({"type":"status"})), enc(json!({"type":"set_ask"})), enc(json!({"type":"status"}))]).await;
        assert_eq!(got.len(), 1);
    }

    #[tokio::test]
    async fn end_session_counts_only_from_the_person_at_the_console_or_root() {
        let r = rig("end").await;
        exchange(&r.sock, &[enc(json!({"type":"end_session"}))]).await;
        assert_eq!(*r.api.log.lock().unwrap(), vec!["end"]);
        // Root (sudo) may too.
        r.inspector.facts.lock().unwrap().uid = 0;
        exchange(&r.sock, &[enc(json!({"type":"end_session"}))]).await;
        assert_eq!(r.api.log.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn setup_and_uninstall_reach_the_service_with_who_asked() {
        let r = rig("setup").await;
        let auth = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let got = exchange(
            &r.sock,
            &[
                enc(json!({"type":"setup","auth":auth,"link":"https://x/install","name":"Mac","access":"ask","control":"full"})),
                enc(json!({"type":"uninstall","auth":auth})),
            ],
        )
        .await;
        assert_eq!((got[0]["ok"].clone(), got[1]["ok"].clone()), (json!(true), json!(false)));
        assert_eq!(*r.api.log.lock().unwrap(), vec!["setup Mac ConsoleUser(501)", "uninstall ConsoleUser(501)"]);
    }

    /// A fake helper: registers, ticks, and answers each screen request with its id.
    async fn fake_helper(sock: &Path, session: &str) -> tokio::task::JoinHandle<Vec<Map<String, Value>>> {
        let mut s = UnixStream::connect(sock).await.unwrap();
        frame::write(&mut s, &obj(json!({"type":"helper","session":session}))).await.unwrap();
        tokio::spawn(async move {
            let mut seen = vec![];
            let tick = ipc::tick_message(&Tick { screen: true, accessibility: true, customer_ago_ms: -1, locked: false });
            let _ = frame::write(&mut s, &tick).await;
            while let Ok(m) = frame::read(&mut s, Some(Duration::from_secs(3))).await {
                seen.push(m.clone());
                match ipc::read_to_helper(&m) {
                    Some(ToHelper::Screen { id, .. }) => {
                        let body = obj(json!({"ok":false,"error":format!("answer {id}")}));
                        if frame::write(&mut s, &ipc::reply_message(id, body)).await.is_err() {
                            break;
                        }
                    }
                    Some(ToHelper::Ask { .. }) => {} // never answers
                    Some(_) => {}
                    None => break,
                }
            }
            seen
        })
    }

    async fn wait_for(f: impl Fn() -> bool) {
        for _ in 0..100 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out");
    }

    #[tokio::test]
    async fn a_helper_registers_ticks_and_answers_requests() {
        let r = rig("helper").await;
        let task = fake_helper(&r.sock, "aqua").await;
        let helpers = r.server.helpers.clone();
        wait_for(|| helpers.get(501).and_then(|h| h.tick()).is_some()).await;
        let h2 = helpers.clone();
        let answer = tokio::task::spawn_blocking(move || {
            let stop = Stop::new();
            h2.request(501, |id| ToHelper::Screen { id, action: json!({"name":"screenshot"}) }, Duration::from_secs(2), &stop)
        })
        .await
        .unwrap()
        .unwrap();
        assert!(answer["error"].as_str().unwrap().starts_with("answer "));
        // An ask it never answers times out, and the helper is told to cancel it.
        let h3 = helpers.clone();
        let e = tokio::task::spawn_blocking(move || {
            let stop = Stop::new();
            h3.request(501, |id| ToHelper::Ask { id, by: "D".into(), team: "T".into(), full: false }, Duration::from_millis(200), &stop)
        })
        .await
        .unwrap();
        assert_eq!(e.unwrap_err(), HelperError::Timeout);
        // No helper for another uid.
        let stop = Stop::new();
        assert_eq!(helpers.request(502, |id| ToHelper::Cancel { id }, Duration::from_millis(10), &stop).unwrap_err(), HelperError::None);
        r.stop.set();
        drop(r);
        let seen = task.await.unwrap();
        assert!(seen.iter().any(|m| m["type"] == "cancel"), "{seen:?}");
    }

    #[tokio::test]
    async fn only_the_console_persons_helper_or_root_at_the_login_window_registers() {
        let r = rig("who").await;
        // Root claims a person's session: refused.
        r.inspector.facts.lock().unwrap().uid = 0;
        let mut s = UnixStream::connect(&r.sock).await.unwrap();
        frame::write(&mut s, &obj(json!({"type":"helper","session":"aqua"}))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(r.server.helpers.get(0).is_none());
        // Root at the login window while someone is signed in: refused. Once nobody is: accepted.
        let _a = fake_helper(&r.sock, "loginwindow").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(r.server.helpers.get(0).is_none());
        *r.inspector.console.lock().unwrap() = None;
        let _b = fake_helper(&r.sock, "loginwindow").await;
        let helpers = r.server.helpers.clone();
        wait_for(|| helpers.get(0).is_some()).await;
        assert_eq!(helpers.get(0).unwrap().session, HelperSession::LoginWindow);
    }

    #[tokio::test]
    async fn a_helper_whose_person_left_the_console_is_dropped() {
        let r = rig("switch").await;
        let _task = fake_helper(&r.sock, "aqua").await;
        let helpers = r.server.helpers.clone();
        wait_for(|| helpers.get(501).is_some()).await;
        // Another person comes to the console; at the helper's next frame its link closes.
        *r.inspector.console.lock().unwrap() = Some(502);
        let h = helpers.get(501).unwrap();
        let _ = h.out.send(ipc::to_helper_message(&ToHelper::Screen { id: 99, action: json!({"name":"screenshot"}) }));
        wait_for(|| helpers.get(501).is_none()).await;
    }

    #[tokio::test]
    async fn a_newer_helper_replaces_the_older_and_the_older_link_is_closed() {
        let r = rig("replace").await;
        let first = fake_helper(&r.sock, "aqua").await;
        let helpers = r.server.helpers.clone();
        wait_for(|| helpers.get(501).is_some()).await;
        let old = helpers.get(501).unwrap();
        let _second = fake_helper(&r.sock, "aqua").await;
        wait_for(|| helpers.get(501).is_some_and(|h| !Arc::ptr_eq(&h, &old))).await;
        assert!(old.is_closed());
        drop(first);
    }

    #[tokio::test]
    async fn connections_per_uid_are_capped() {
        let r = rig("cap").await;
        let mut held = vec![];
        for _ in 0..MAX_PER_UID {
            let mut s = UnixStream::connect(&r.sock).await.unwrap();
            frame::write(&mut s, &obj(json!({"type":"status"}))).await.unwrap();
            frame::read(&mut s, Some(Duration::from_secs(1))).await.unwrap();
            held.push(s);
        }
        assert!(exchange(&r.sock, &[enc(json!({"type":"status"}))]).await.is_empty(), "one more is refused");
        held.pop();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(exchange(&r.sock, &[enc(json!({"type":"status"}))]).await.len(), 1);
    }
}

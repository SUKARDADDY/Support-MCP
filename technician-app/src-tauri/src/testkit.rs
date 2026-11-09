// Test doubles for the core's tests: a tiny HTTP server that plays the relay (and its
// authorize page), and helpers to build a store with an account in it. Compiled for tests only.
use crate::relay::{AccountEvents, RetryPolicy};
use crate::seal::DevSealer;
use crate::store::{now_ms, StoredAccount, Store, Tokens};
use serde_json::Value;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone, Debug)]
pub struct Req {
    pub method: String,
    /// The path and query, as sent.
    pub target: String,
    /// Header names in lower case.
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Req {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }

    pub fn query(&self, key: &str) -> Option<String> {
        let q = self.target.split_once('?')?.1;
        url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
    }

    pub fn form(&self, key: &str) -> Option<String> {
        url::form_urlencoded::parse(self.body.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
    }

    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub delay_ms: u64,
}

impl Resp {
    pub fn json(status: u16, v: Value) -> Resp {
        Resp { status, headers: vec![("content-type".into(), "application/json".into())], body: v.to_string(), delay_ms: 0 }
    }

    pub fn text(status: u16, body: &str) -> Resp {
        Resp { status, headers: vec![("content-type".into(), "application/octet-stream".into())], body: body.to_string(), delay_ms: 0 }
    }

    pub fn header(mut self, k: &str, v: &str) -> Resp {
        self.headers.push((k.into(), v.into()));
        self
    }

    pub fn after(mut self, ms: u64) -> Resp {
        self.delay_ms = ms;
        self
    }
}

pub struct FakeServer {
    pub addr: SocketAddr,
    requests: Arc<Mutex<Vec<Req>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeServer {
    pub async fn start(handler: impl Fn(&Req) -> Resp + Send + Sync + 'static) -> FakeServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests: Arc<Mutex<Vec<Req>>> = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(handler);
        let log = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let handler = handler.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let Some(req) = read_request(&mut sock).await else { return };
                    log.lock().unwrap().push(req.clone());
                    let resp = handler(&req);
                    if resp.delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(resp.delay_ms)).await;
                    }
                    let mut out = format!("HTTP/1.1 {} X\r\ncontent-length: {}\r\nconnection: close\r\n", resp.status, resp.body.len());
                    for (k, v) in &resp.headers {
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    out.push_str("\r\n");
                    out.push_str(&resp.body);
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        FakeServer { addr, requests, task }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    pub fn seen(&self) -> Vec<Req> {
        self.requests.lock().unwrap().clone()
    }

    pub fn count(&self, path: &str) -> usize {
        self.seen().iter().filter(|r| r.path() == path).count()
    }
}

async fn read_request(sock: &mut tokio::net::TcpStream) -> Option<Req> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let mut headers = HashMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Req { method, target, headers, body: String::from_utf8_lossy(&body).to_string() })
}

/// Counts the sign-outs the core reports.
#[derive(Default)]
pub struct Events {
    pub signed_out: Mutex<Vec<String>>,
}

impl AccountEvents for Events {
    fn signed_out(&self, account_id: &str) {
        self.signed_out.lock().unwrap().push(account_id.to_string());
    }
}

pub const FAST: RetryPolicy = RetryPolicy { retries: 3, base: Duration::from_millis(1), cap: Duration::from_millis(5) };

pub fn temp_dir(name: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("support-test-{name}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn tokens(access: &str, refresh: &str, expires_in_ms: i64) -> Tokens {
    Tokens { access: access.into(), refresh: refresh.into(), expires_at_ms: (now_ms() as i64 + expires_in_ms) as u64 }
}

/// A store holding one account for `relay` and team "default", signed in with `tokens`.
/// Returns the store and the account's id.
pub fn store_with_account(name: &str, relay: &str, tokens: &Tokens) -> (Arc<Store>, String) {
    let store = Arc::new(Store::open(&temp_dir(name), Arc::new(DevSealer)).unwrap());
    let account = StoredAccount {
        id: String::new(),
        relay: relay.to_string(),
        team: "default".into(),
        team_name: Some("Default".into()),
        email: None,
        client_id: "client-1".into(),
        token_endpoint: format!("{relay}/oauth/token"),
        sealed: None,
    };
    store.put_account(account, tokens).unwrap();
    let id = store.accounts()[0].id.clone();
    (store, id)
}

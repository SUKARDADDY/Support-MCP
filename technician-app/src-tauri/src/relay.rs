// The relay client. Every call to the relay is made here, from the Rust core, never from the
// web view: the relay refuses a request that carries an Origin header, and reqwest sends none.
//
// One AccountClient is one sign-in (a relay address and a team). It adds the bearer token,
// refreshes it before it ends, and applies the rules for what a failure means:
//   503 (and a network failure)  the relay is busy or out of reach: try again, keep the sign-in
//   401, or invalid_grant on a refresh  the relay no longer accepts it: sign out
//   anything else  an error to show, with the relay's own words
use crate::error::{CoreError, CoreResult, Msg};
use crate::store::{now_ms, Store, Tokens};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How soon before an access token ends it is refreshed.
const REFRESH_SKEW_MS: u64 = 60_000;

/// How long signing out waits for the relay to confirm the revocation.
const REVOKE_TIMEOUT: Duration = Duration::from_secs(5);

/// The MCP tools the screens may call. No tool that clicks, types or runs a command is here:
/// the app is view only, and the core enforces it whatever the screens ask for. Tasks are
/// started and controlled through the team API (route_allowed), not through agent_start.
pub const TOOLS: &[&str] = &[
    "device_list",
    "device_connect",
    "session_create",
    "session_list",
    "session_status",
    "session_end",
    "screenshot",
    // Read only: the team's models and the month's cost, for starting a task.
    "agent_status",
];

#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    pub retries: u32,
    pub base: Duration,
    pub cap: Duration,
}

impl RetryPolicy {
    pub const NORMAL: RetryPolicy = RetryPolicy { retries: 3, base: Duration::from_secs(1), cap: Duration::from_secs(5) };

    fn delay(&self, attempt: u32, retry_after: Option<u64>) -> Duration {
        let wanted = match retry_after {
            Some(s) => Duration::from_secs(s),
            None => self.base * 2u32.saturating_pow(attempt),
        };
        wanted.min(self.cap)
    }
}

/// What the core tells the rest of the app about an account.
pub trait AccountEvents: Send + Sync {
    /// The relay refused this sign-in for good.
    fn signed_out(&self, account_id: &str);
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolImage {
    pub mime: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolOutput {
    /// The tool's JSON text (or { "text": ... } when it was not JSON).
    pub data: Value,
    /// The picture of a screenshot.
    pub image: Option<ToolImage>,
}

pub struct AccountClient {
    pub id: String,
    pub relay: String,
    pub team: String,
    client_id: String,
    token_endpoint: String,
    http: reqwest::Client,
    store: Arc<Store>,
    events: Arc<dyn AccountEvents>,
    retry: RetryPolicy,
    // One refresh at a time: the relay rotates the refresh token, so two at once would
    // spend the same one twice.
    refresh_lock: tokio::sync::Mutex<()>,
    signed_out: Mutex<bool>,
}

/// The shared HTTP client: no redirects (a token must not follow one), a short connect
/// timeout, and no Origin header (reqwest never adds one).
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(format!("Support-technician-app/{}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("the HTTP client builds")
}

/// A relay address as the app stores it: `https://host[:port]`, or `http://` for a
/// loopback address (a relay under `wrangler dev`). Anything else is refused.
pub fn normalize_relay(input: &str) -> CoreResult<String> {
    let text = input.trim();
    let text = if text.contains("://") { text.to_string() } else { format!("https://{text}") };
    let url = url::Url::parse(&text).map_err(|_| CoreError::invalid(Msg::NotRelayAddress))?;
    let host = url.host_str().ok_or_else(|| CoreError::invalid(Msg::NotRelayAddress))?.to_ascii_lowercase();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(CoreError::invalid(Msg::RelayHttps)),
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !(url.path() == "/" || url.path().is_empty()) {
        return Err(CoreError::invalid(Msg::RelayAddressOnly));
    }
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Ok(format!("{}://{host}{port}", url.scheme()))
}

/// A team slug as the relay writes them.
pub fn valid_team(team: &str) -> bool {
    (1..=40).contains(&team.len()) && team.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_id(s: &str) -> bool {
    s.len() == 20 && s.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

/// Which relay routes the screens may reach through `relay_request`, after the team's
/// `/app/w/<team>` prefix. `path` may carry a query. Everything else is refused here.
pub fn route_allowed(method: &str, path: &str) -> bool {
    let (path, query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path, None),
    };
    if let Some(q) = query {
        let ok = !q.is_empty()
            && q.split('&').all(|pair| {
                let Some((k, v)) = pair.split_once('=') else { return false };
                ["after", "limit", "site", "status", "customer", "wait_s"].contains(&k)
                    && v.len() <= 64
                    && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
            });
        if !ok || method != "GET" {
            return false;
        }
    }
    if !path.starts_with('/') {
        return false;
    }
    let segs: Vec<&str> = path[1..].split('/').collect();
    if segs.iter().any(|s| s.is_empty()) {
        return false;
    }
    let s = segs.as_slice();
    match (method, s) {
        ("GET", ["api"]) => true,
        ("GET", ["api", "devices" | "customers" | "sites" | "fields"]) => true,
        ("GET" | "PATCH", ["api", "devices", id]) => is_id(id),
        ("GET" | "POST", ["api", "pairing"]) => true,
        ("GET" | "POST", ["api", "agent", "tasks"]) => true,
        ("GET", ["api", "agent", "tasks", id]) => is_id(id),
        ("GET", ["api", "agent", "tasks", id, "frame"]) => is_id(id),
        ("POST", ["api", "agent", "tasks", id, "pause" | "resume" | "stop"]) => is_id(id),
        ("GET", ["teams"]) => true,
        ("GET" | "PATCH", ["notifications", "settings"]) => true,
        _ => false,
    }
}

/// The relay's own error answer, as the core's error.
pub fn relay_error(status: u16, body: &str) -> CoreError {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let (code, message) = match &parsed {
        Some(v) if v["error"].is_object() => (
            v["error"]["code"].as_str().unwrap_or("error").to_string(),
            v["error"]["message"].as_str().unwrap_or("The relay refused the request.").to_string(),
        ),
        Some(v) if v["error"].is_string() => (
            v["error"].as_str().unwrap_or("error").to_string(),
            v["error_description"].as_str().unwrap_or("The relay refused the request.").to_string(),
        ),
        _ => ("error".to_string(), format!("The relay answered {status}.")),
    };
    CoreError::Relay { status, code: clip(&code, 60), message: clip(&message, 300) }
}

fn clip(s: &str, n: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(n).collect()
}

fn retry_after(resp: &reqwest::Response) -> Option<u64> {
    resp.headers().get("retry-after")?.to_str().ok()?.trim().parse().ok()
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

/// The tokens of a successful /oauth/token answer.
pub fn tokens_from_answer(body: &str, old_refresh: Option<&str>) -> CoreResult<Tokens> {
    let a: TokenAnswer = serde_json::from_str(body).map_err(|_| CoreError::other(Msg::RelayAnswerUnclear))?;
    let refresh = a.refresh_token.or_else(|| old_refresh.map(str::to_string)).ok_or_else(|| CoreError::other(Msg::NoRefreshToken))?;
    Ok(Tokens { access: a.access_token, refresh, expires_at_ms: now_ms() + a.expires_in.unwrap_or(3600) * 1000 })
}

impl AccountClient {
    pub fn new(
        store: Arc<Store>,
        http: reqwest::Client,
        events: Arc<dyn AccountEvents>,
        id: &str,
        retry: RetryPolicy,
    ) -> CoreResult<AccountClient> {
        let a = store.account(id).ok_or_else(|| CoreError::invalid(Msg::NoAccount))?;
        Ok(AccountClient {
            id: a.id,
            relay: a.relay,
            team: a.team,
            client_id: a.client_id,
            token_endpoint: a.token_endpoint,
            http,
            store,
            events,
            retry,
            refresh_lock: tokio::sync::Mutex::new(()),
            signed_out: Mutex::new(false),
        })
    }

    pub fn is_signed_out(&self) -> bool {
        *self.signed_out.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn url(&self, path: &str) -> String {
        format!("{}/app/w/{}{}", self.relay, self.team, path)
    }

    fn resource(&self) -> String {
        format!("{}/app/w/{}", self.relay, self.team)
    }

    // The relay refused this sign-in: drop the tokens and tell the app, once.
    fn sign_out(&self) {
        let mut flag = self.signed_out.lock().unwrap_or_else(|p| p.into_inner());
        if !*flag {
            *flag = true;
            let _ = self.store.clear_tokens(&self.id);
            self.events.signed_out(&self.id);
        }
    }

    async fn access_token(&self) -> CoreResult<String> {
        let tokens = self.store.tokens(&self.id).ok_or(CoreError::SignedOut)?;
        if tokens.expires_at_ms > now_ms() + REFRESH_SKEW_MS {
            return Ok(tokens.access);
        }
        self.refresh(&tokens.access).await
    }

    /// Refreshes the sign-in unless another call already has since `stale` was read.
    /// Returns the access token to use.
    async fn refresh(&self, stale: &str) -> CoreResult<String> {
        let _one = self.refresh_lock.lock().await;
        let current = self.store.tokens(&self.id).ok_or(CoreError::SignedOut)?;
        if current.access != stale {
            return Ok(current.access);
        }
        let mut attempt = 0;
        loop {
            let sent = self
                .http
                .post(&self.token_endpoint)
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", current.refresh.as_str()),
                    ("client_id", self.client_id.as_str()),
                    ("resource", self.resource().as_str()),
                ])
                .send()
                .await;
            let resp = match sent {
                Ok(r) => r,
                Err(e) => return Err(e.into()),
            };
            let status = resp.status().as_u16();
            let wait = retry_after(&resp);
            let body = resp.text().await.unwrap_or_default();
            match status {
                200 => {
                    let tokens = tokens_from_answer(&body, Some(&current.refresh))?;
                    self.store.set_tokens(&self.id, &tokens)?;
                    return Ok(tokens.access);
                }
                503 => {
                    if attempt >= self.retry.retries {
                        return Err(CoreError::Unavailable(Msg::RelayBusy));
                    }
                    tokio::time::sleep(self.retry.delay(attempt, wait)).await;
                    attempt += 1;
                }
                401 => {
                    self.sign_out();
                    return Err(CoreError::SignedOut);
                }
                400 if serde_json::from_str::<Value>(&body).map(|v| v["error"] == "invalid_grant").unwrap_or(false) => {
                    self.sign_out();
                    return Err(CoreError::SignedOut);
                }
                // Any other answer is not proof the sign-in is gone, so it stays.
                _ => return Err(CoreError::Unavailable(Msg::RenewFailed)),
            }
        }
    }

    /// Asks the relay to revoke this sign-in (RFC 7009, at the token endpoint the relay serves
    /// for refreshing too). Revoking the refresh token ends the whole grant on the relay, the
    /// access token with it. Best effort and short: true when the relay confirmed, false when
    /// it was unreachable or refused, so signing out on this PC never waits on the relay.
    pub async fn revoke(&self) -> bool {
        let Some(tokens) = self.store.tokens(&self.id) else { return false };
        let sent = self
            .http
            .post(&self.token_endpoint)
            .timeout(REVOKE_TIMEOUT)
            .form(&[("token", tokens.refresh.as_str()), ("token_type_hint", "refresh_token"), ("client_id", self.client_id.as_str())])
            .send()
            .await;
        matches!(sent, Ok(r) if r.status().is_success())
    }

    /// Calls a relay route (`path` follows `/app/w/<team>`, such as `/api/devices`) and
    /// returns its JSON answer (null for an empty one). `timeout` replaces the default
    /// for a held-open call.
    pub async fn request(&self, method: Method, path: &str, body: Option<&Value>, timeout: Option<Duration>) -> CoreResult<Value> {
        let mut access = self.access_token().await?;
        let mut refreshed = false;
        let mut attempt = 0;
        loop {
            let mut req = self.http.request(method.clone(), self.url(path)).bearer_auth(&access);
            if let Some(t) = timeout {
                req = req.timeout(t);
            }
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req.send().await?;
            let status = resp.status().as_u16();
            let wait = retry_after(&resp);
            let text = resp.text().await.unwrap_or_default();
            match status {
                200..=299 => {
                    return if text.trim().is_empty() { Ok(Value::Null) } else { serde_json::from_str(&text).map_err(|_| CoreError::other(Msg::RelayAnswerUnclear)) };
                }
                401 => {
                    // The token was refused. Renew once and try again; a second refusal is final.
                    if refreshed {
                        self.sign_out();
                        return Err(CoreError::SignedOut);
                    }
                    access = self.refresh(&access).await?;
                    refreshed = true;
                }
                503 => {
                    if attempt >= self.retry.retries {
                        return Err(CoreError::Unavailable(Msg::RelayBusy));
                    }
                    tokio::time::sleep(self.retry.delay(attempt, wait)).await;
                    attempt += 1;
                }
                _ => return Err(relay_error(status, &text)),
            }
        }
    }

    /// Calls one MCP tool through the app's own /mcp address.
    pub async fn tool(&self, name: &str, args: Value) -> CoreResult<ToolOutput> {
        let rpc = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } });
        let answer = self.request(Method::POST, "/mcp", Some(&rpc), None).await?;
        parse_tool_answer(&answer)
    }
}

/// An MCP answer: an image block, if any, then the tool's JSON text.
pub fn parse_tool_answer(answer: &Value) -> CoreResult<ToolOutput> {
    if let Some(err) = answer.get("error") {
        return Err(CoreError::Tool(clip(err["message"].as_str().unwrap_or(Msg::ToolFailed.text()), 400)));
    }
    let result = &answer["result"];
    let blocks = result["content"].as_array().ok_or_else(|| CoreError::other(Msg::RelayAnswerUnclear))?;
    let mut text: Option<&str> = None;
    let mut image = None;
    for b in blocks {
        match b["type"].as_str() {
            Some("text") => text = b["text"].as_str(),
            Some("image") => {
                if let (Some(data), Some(mime)) = (b["data"].as_str(), b["mimeType"].as_str()) {
                    image = Some(ToolImage { mime: mime.to_string(), data: data.to_string() });
                }
            }
            _ => {}
        }
    }
    if result["isError"].as_bool() == Some(true) {
        return Err(CoreError::Tool(clip(text.unwrap_or(Msg::ToolFailed.text()), 400)));
    }
    let data = match text {
        Some(t) => serde_json::from_str(t).unwrap_or_else(|_| json!({ "text": t })),
        None => Value::Null,
    };
    Ok(ToolOutput { data, image })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn token_ok(access: &str, refresh: &str) -> Resp {
        Resp::json(200, json!({ "access_token": access, "refresh_token": refresh, "expires_in": 3600, "token_type": "bearer" }))
    }

    async fn client(server_url: &str, t: Tokens) -> (Arc<AccountClient>, Arc<Store>, Arc<Events>, String) {
        let (store, id) = store_with_account("relay", server_url, &t);
        let events = Arc::new(Events::default());
        let c = AccountClient::new(store.clone(), http_client(), events.clone(), &id, FAST).unwrap();
        (Arc::new(c), store, events, id)
    }

    #[test]
    fn relay_addresses_are_normalised_and_unsafe_ones_refused() {
        assert_eq!(normalize_relay("support.example.com").unwrap(), "https://support.example.com");
        assert_eq!(normalize_relay(" https://Support.Example.com/ ").unwrap(), "https://support.example.com");
        assert_eq!(normalize_relay("https://relay.example:8443").unwrap(), "https://relay.example:8443");
        assert_eq!(normalize_relay("http://127.0.0.1:8787").unwrap(), "http://127.0.0.1:8787");
        assert_eq!(normalize_relay("http://localhost:8787/").unwrap(), "http://localhost:8787");
        for bad in ["http://relay.example", "ftp://relay.example", "https://relay.example/mcp", "https://user:pw@relay.example", "https://relay.example?x=1", "https://relay.example#f", "", "not a url at all"] {
            assert!(normalize_relay(bad).is_err(), "{bad}");
        }
        assert!(valid_team("default") && valid_team("acme-2"));
        assert!(!valid_team("") && !valid_team("Acme") && !valid_team("a/b") && !valid_team(&"a".repeat(41)));
    }

    #[test]
    fn only_the_routes_the_screens_use_are_allowed() {
        let id = "abcdefghijklmnopqrst";
        let yes = [
            ("GET", "/api".to_string()),
            ("GET", "/api/devices".into()),
            ("GET", "/api/devices?status=active&limit=100&after=".to_string() + id),
            ("GET", format!("/api/devices/{id}")),
            ("PATCH", format!("/api/devices/{id}")),
            ("GET", "/api/sites".into()),
            ("GET", "/api/customers?limit=50".into()),
            ("GET", "/api/fields".into()),
            ("POST", "/api/pairing".into()),
            ("GET", "/api/pairing".into()),
            ("GET", "/api/agent/tasks".into()),
            ("POST", "/api/agent/tasks".into()),
            ("GET", format!("/api/agent/tasks/{id}?wait_s=25")),
            ("GET", format!("/api/agent/tasks/{id}/frame")),
            ("POST", format!("/api/agent/tasks/{id}/stop")),
            ("POST", format!("/api/agent/tasks/{id}/pause")),
            ("POST", format!("/api/agent/tasks/{id}/resume")),
            ("GET", "/teams".into()),
            ("GET", "/notifications/settings".into()),
            ("PATCH", "/notifications/settings".into()),
        ];
        for (m, p) in &yes {
            assert!(route_allowed(m, p), "{m} {p}");
        }
        let no = [
            ("GET", "/api/members".to_string()),
            ("GET", "/api/roles".into()),
            ("GET", "/api/audit".into()),
            ("POST", "/api/stop".into()),
            ("GET", "/api/agent".into()),
            ("GET", "/api/agent/models".into()),
            ("DELETE", format!("/api/devices/{id}")),
            ("DELETE", format!("/api/pairing/{id}")),
            ("POST", "/api/devices".into()),
            ("GET", "/notifications".into()),
            ("GET", "/mcp".into()),
            ("POST", "/mcp".into()),
            ("GET", "/api/devices/not-an-id".into()),
            ("GET", "/api/devices/../members".into()),
            ("GET", "/api//devices".into()),
            ("GET", "api/devices".into()),
            ("GET", "/api/devices?evil=1".into()),
            ("GET", "/api/devices?status=a b".into()),
            ("POST", "/api/agent/tasks?wait_s=1".into()),
            ("GET", format!("/api/agent/tasks/{id}/kill")),
            ("GET", "https://evil.example/api".into()),
        ];
        for (m, p) in &no {
            assert!(!route_allowed(m, p), "{m} {p}");
        }
    }

    #[test]
    fn the_tool_list_has_nothing_that_clicks_types_or_runs() {
        for banned in ["click", "type_text", "type_secret", "press_key", "run", "put_file", "get_file", "send_sas", "block_input", "request_full_control", "ui_act", "move_mouse", "drag", "scroll", "agent_start", "agent_control"] {
            assert!(!TOOLS.contains(&banned), "{banned}");
        }
        assert!(TOOLS.contains(&"screenshot") && TOOLS.contains(&"device_list"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_call_carries_the_bearer_token_and_never_an_origin_header() {
        let server = FakeServer::start(|_| Resp::json(200, json!({ "ok": true }))).await;
        let (c, _s, _e, _id) = client(&server.url(), tokens("tok-a", "ref-a", 3_600_000)).await;
        let out = c.request(Method::GET, "/api/devices", None, None).await.unwrap();
        assert_eq!(out["ok"], true);
        c.request(Method::PATCH, "/notifications/settings", Some(&json!({ "events": {} })), None).await.unwrap();
        let seen = server.seen();
        assert_eq!(seen.len(), 2);
        for r in &seen {
            assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer tok-a"));
            assert!(!r.headers.contains_key("origin"), "no Origin header, ever");
            assert!(r.target.starts_with("/app/w/default/"));
        }
        assert_eq!(seen[1].headers.get("content-type").map(String::as_str), Some("application/json"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_401_refreshes_once_and_retries_with_the_rotated_token() {
        let server = FakeServer::start(|r| match (r.path(), r.headers.get("authorization").map(String::as_str)) {
            ("/oauth/token", _) => {
                assert_eq!(r.form("grant_type").as_deref(), Some("refresh_token"));
                assert_eq!(r.form("refresh_token").as_deref(), Some("ref-a"));
                assert_eq!(r.form("client_id").as_deref(), Some("client-1"));
                assert!(r.form("resource").unwrap().ends_with("/app/w/default"));
                token_ok("tok-b", "ref-b")
            }
            (_, Some("Bearer tok-b")) => Resp::json(200, json!({ "ok": true })),
            _ => Resp::json(401, json!({ "error": "invalid_token" })),
        })
        .await;
        let (c, store, events, id) = client(&server.url(), tokens("tok-a", "ref-a", 3_600_000)).await;
        assert_eq!(c.request(Method::GET, "/api", None, None).await.unwrap()["ok"], true);
        let t = store.tokens(&id).unwrap();
        assert_eq!((t.access.as_str(), t.refresh.as_str()), ("tok-b", "ref-b"));
        assert!(events.signed_out.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_401_signs_out_and_keeps_the_account() {
        let server = FakeServer::start(|r| match r.path() {
            "/oauth/token" => token_ok("tok-b", "ref-b"),
            _ => Resp::json(401, json!({ "error": "invalid_token" })),
        })
        .await;
        let (c, store, events, id) = client(&server.url(), tokens("tok-a", "ref-a", 3_600_000)).await;
        let err = c.request(Method::GET, "/api", None, None).await.unwrap_err();
        assert!(matches!(err, CoreError::SignedOut));
        assert_eq!(store.tokens(&id), None);
        assert_eq!(store.accounts().len(), 1, "the account stays so the person can sign in again");
        assert_eq!(events.signed_out.lock().unwrap().len(), 1);
        // Later calls fail at once and do not report again.
        assert!(matches!(c.request(Method::GET, "/api", None, None).await.unwrap_err(), CoreError::SignedOut));
        assert_eq!(events.signed_out.lock().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn invalid_grant_and_a_401_on_refresh_sign_out() {
        for (status, body) in [(400, json!({ "error": "invalid_grant", "error_description": "gone" })), (401, json!({ "error": "invalid_client" }))] {
            let server = FakeServer::start(move |_| Resp::json(status, body.clone())).await;
            let (c, store, events, id) = client(&server.url(), tokens("tok-a", "ref-a", -1000)).await;
            assert!(matches!(c.request(Method::GET, "/api", None, None).await.unwrap_err(), CoreError::SignedOut), "{status}");
            assert_eq!(store.tokens(&id), None);
            assert_eq!(events.signed_out.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_503_on_refresh_is_retried_and_never_signs_out() {
        let n = Arc::new(AtomicUsize::new(0));
        let counter = n.clone();
        let server = FakeServer::start(move |r| {
            if r.path() == "/oauth/token" {
                if counter.fetch_add(1, Ordering::SeqCst) < 2 {
                    return Resp::json(503, json!({ "error": "temporarily_unavailable" })).header("retry-after", "30");
                }
                return token_ok("tok-b", "ref-b");
            }
            Resp::json(200, json!({ "ok": true }))
        })
        .await;
        let (c, store, _e, id) = client(&server.url(), tokens("tok-a", "ref-a", -1000)).await;
        c.request(Method::GET, "/api", None, None).await.unwrap();
        assert_eq!(n.load(Ordering::SeqCst), 3);
        assert_eq!(store.tokens(&id).unwrap().access, "tok-b");

        // Busy for good: an error to show, and the sign-in is still there.
        let busy = FakeServer::start(|_| Resp::json(503, json!({ "error": "temporarily_unavailable" }))).await;
        let (c2, store2, events2, id2) = client(&busy.url(), tokens("tok-a", "ref-a", -1000)).await;
        let err = c2.request(Method::GET, "/api", None, None).await.unwrap_err();
        assert!(matches!(err, CoreError::Unavailable(_)));
        assert_eq!(busy.count("/oauth/token"), 4, "one try and three retries");
        assert!(store2.tokens(&id2).is_some());
        assert!(events2.signed_out.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn other_refresh_failures_keep_the_sign_in() {
        for status in [500u16, 400, 404, 429] {
            let server = FakeServer::start(move |_| Resp::json(status, json!({ "error": "invalid_request" }))).await;
            let (c, store, events, id) = client(&server.url(), tokens("tok-a", "ref-a", -1000)).await;
            assert!(matches!(c.request(Method::GET, "/api", None, None).await.unwrap_err(), CoreError::Unavailable(_)), "{status}");
            assert!(store.tokens(&id).is_some(), "{status}");
            assert!(events.signed_out.lock().unwrap().is_empty());
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_503_on_a_call_is_retried_then_reported_without_signing_out() {
        let n = Arc::new(AtomicUsize::new(0));
        let counter = n.clone();
        let server = FakeServer::start(move |_| {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                Resp::json(503, json!({ "error": "temporarily_unavailable" }))
            } else {
                Resp::json(200, json!({ "ok": 1 }))
            }
        })
        .await;
        let (c, _s, _e, _i) = client(&server.url(), tokens("tok-a", "ref-a", 3_600_000)).await;
        assert_eq!(c.request(Method::GET, "/api", None, None).await.unwrap()["ok"], 1);

        let busy = FakeServer::start(|_| Resp::json(503, json!({ "error": "temporarily_unavailable" }))).await;
        let (c2, store2, events2, id2) = client(&busy.url(), tokens("tok-a", "ref-a", 3_600_000)).await;
        assert!(matches!(c2.request(Method::GET, "/api", None, None).await.unwrap_err(), CoreError::Unavailable(_)));
        assert!(store2.tokens(&id2).is_some());
        assert!(events2.signed_out.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_network_failure_is_unavailable_and_keeps_the_sign_in() {
        // Nothing listens here.
        let (c, store, events, id) = client("http://127.0.0.1:9", tokens("tok-a", "ref-a", 3_600_000)).await;
        assert!(matches!(c.request(Method::GET, "/api", None, None).await.unwrap_err(), CoreError::Unavailable(_)));
        assert!(store.tokens(&id).is_some());
        assert!(events.signed_out.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn calls_at_the_same_moment_share_one_refresh() {
        let server = FakeServer::start(|r| {
            if r.path() == "/oauth/token" {
                // Slow enough that every call is waiting on it.
                return token_ok("tok-b", "ref-b").after(80);
            }
            Resp::json(200, json!({ "ok": true }))
        })
        .await;
        let (c, _s, _e, _i) = client(&server.url(), tokens("tok-a", "ref-a", -1000)).await;
        let calls: Vec<_> = (0..6)
            .map(|_| {
                let c = c.clone();
                tokio::spawn(async move { c.request(Method::GET, "/api", None, None).await })
            })
            .collect();
        for call in calls {
            call.await.unwrap().unwrap();
        }
        assert_eq!(server.count("/oauth/token"), 1, "the rotating refresh token is spent once");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_relays_own_errors_come_through_with_their_words() {
        let server = FakeServer::start(|_| Resp::json(403, json!({ "error": { "code": "second_factor", "message": "a second factor is required" } }))).await;
        let (c, store, _e, id) = client(&server.url(), tokens("tok-a", "ref-a", 3_600_000)).await;
        match c.request(Method::GET, "/api", None, None).await.unwrap_err() {
            CoreError::Relay { status, code, message } => {
                assert_eq!((status, code.as_str(), message.as_str()), (403, "second_factor", "a second factor is required"));
            }
            other => panic!("{other:?}"),
        }
        assert!(store.tokens(&id).is_some(), "a 403 is not a sign-out");
        let e = relay_error(404, "{\"error\":{\"code\":\"no_frame\",\"message\":\"none\"}}");
        assert_eq!((e.code(), e.status()), ("no_frame", Some(404)));
        assert_eq!(relay_error(500, "<html>").code(), "error");
    }

    #[test]
    fn a_screenshot_answer_gives_the_picture_and_the_json() {
        let answer = json!({ "jsonrpc": "2.0", "id": 1, "result": { "content": [
            { "type": "image", "data": "QUJD", "mimeType": "image/jpeg" },
            { "type": "text", "text": "{\"width\":1280,\"height\":800}" },
        ] } });
        let out = parse_tool_answer(&answer).unwrap();
        assert_eq!(out.image.as_ref().unwrap().mime, "image/jpeg");
        assert_eq!(out.image.as_ref().unwrap().data, "QUJD");
        assert_eq!(out.data["width"], 1280);
        // A plain tool answer is one JSON text block.
        let plain = json!({ "result": { "content": [{ "type": "text", "text": "{\"devices\":[]}" }] } });
        let out = parse_tool_answer(&plain).unwrap();
        assert!(out.image.is_none());
        assert!(out.data["devices"].is_array());
        let text = json!({ "result": { "content": [{ "type": "text", "text": "not json" }] } });
        assert_eq!(parse_tool_answer(&text).unwrap().data["text"], "not json");
    }

    #[test]
    fn a_tool_error_keeps_the_tools_text() {
        let busy = json!({ "result": { "isError": true, "content": [{ "type": "text", "text": "agent busy; wait for the current operation" }] } });
        match parse_tool_answer(&busy).unwrap_err() {
            CoreError::Tool(m) => assert_eq!(m, "agent busy; wait for the current operation"),
            other => panic!("{other:?}"),
        }
        let rpc = json!({ "error": { "code": -32601, "message": "method not found" } });
        assert!(matches!(parse_tool_answer(&rpc).unwrap_err(), CoreError::Tool(_)));
        assert!(parse_tool_answer(&json!({ "result": {} })).is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_tool_call_posts_json_rpc_to_the_apps_mcp_address() {
        let server = FakeServer::start(|r| {
            assert_eq!(r.method, "POST");
            assert_eq!(r.path(), "/app/w/default/mcp");
            let body = r.json();
            assert_eq!(body["method"], "tools/call");
            assert_eq!(body["params"]["name"], "device_list");
            Resp::json(200, json!({ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"devices\":[{\"id\":\"x\"}]}" }] } }))
        })
        .await;
        let (c, _s, _e, _i) = client(&server.url(), tokens("tok-a", "ref-a", 3_600_000)).await;
        let out = c.tool("device_list", json!({})).await.unwrap();
        assert_eq!(out.data["devices"][0]["id"], "x");
    }
}
